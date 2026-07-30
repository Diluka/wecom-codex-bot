import {
  type Logger,
  type StreamReplyBody,
  WSClient,
  type WsFrameHeaders,
} from "@wecom/aibot-node-sdk";
import { redactSecrets } from "./output.ts";

export type ChatType = "single" | "group";
export type ConversationKey = `single:${string}` | `group:${string}`;

export interface InboundMessage {
  chatType: ChatType;
  conversationKey: ConversationKey;
  /** Group chatid, or the peer userid for a single chat. */
  chatId: string;
  senderUserId: string;
  msgId: string;
}

export interface InboundText extends InboundMessage {
  text: string;
}

type Listener = (...args: unknown[]) => void;
type MaybePromise<T> = T | Promise<T>;
type SdkLogLevel = "info" | "warn" | "error";

function sdkLog(level: SdkLogLevel, message: string): void {
  const logger = level === "info"
    ? console.info
    : level === "warn"
    ? console.warn
    : console.error;
  logger(`[wecom-sdk] ${message}`);
}

export function createSafeSdkLogger(
  secret: string,
  write: (level: SdkLogLevel, message: string) => void = sdkLog,
): Logger {
  const record = (level: SdkLogLevel, message: string): void => {
    write(level, redactSecrets(message, [secret]));
  };

  return {
    // SDK debug messages include complete callback frames and chat bodies.
    debug: () => {},
    info: (message) => record("info", message),
    warn: (message) => record("warn", message),
    error: (message) => record("error", message),
  };
}

export interface WeComClientLike {
  on(event: string, listener: Listener): unknown;
  connect(): unknown;
  disconnect(): void;
  reply(frame: unknown, body: unknown, cmd?: string): Promise<unknown>;
  replyStream(
    frame: unknown,
    streamId: string,
    content: string,
    finish?: boolean,
  ): Promise<unknown>;
}

export interface WeComGatewayOptions {
  botId: string;
  secret: string;
  client?: WeComClientLike;
  onText: (message: InboundText, frame: unknown) => MaybePromise<void>;
  onUnsupported: (
    message: InboundMessage,
    frame: unknown,
    messageType: string,
  ) => MaybePromise<void>;
  onFatal: (error: Error) => MaybePromise<void>;
  onReady?: () => MaybePromise<void>;
  onError?: (error: Error) => void;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredId(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

export function conversationKey(
  chatType: ChatType,
  chatId: string | undefined,
  senderUserId: string,
): ConversationKey {
  if (senderUserId.trim().length === 0) {
    throw new TypeError("sender userid must be a non-empty string");
  }
  if (chatType === "single") return `single:${senderUserId}`;
  if (typeof chatId !== "string" || chatId.trim().length === 0) {
    throw new TypeError("group chatid must be a non-empty string");
  }
  return `group:${chatId}`;
}

export function normalizeMessageFrame(frame: unknown): InboundMessage {
  const root = asRecord(frame, "frame");
  const body = asRecord(root.body, "frame.body");
  const msgId = requiredId(body, "msgid", "body.msgid");
  const from = asRecord(body.from, "body.from");
  const senderUserId = requiredId(from, "userid", "body.from.userid");
  if (body.chattype !== "single" && body.chattype !== "group") {
    throw new TypeError("body.chattype must be single or group");
  }
  const chatType = body.chattype;
  const groupChatId = chatType === "group"
    ? requiredId(body, "chatid", "body.chatid")
    : undefined;
  return {
    chatType,
    conversationKey: conversationKey(chatType, groupChatId, senderUserId),
    chatId: groupChatId ?? senderUserId,
    senderUserId,
    msgId,
  };
}

export function normalizeTextFrame(frame: unknown): InboundText {
  const root = asRecord(frame, "frame");
  const body = asRecord(root.body, "frame.body");
  if (body.msgtype !== "text") {
    throw new TypeError("frame must contain a text message");
  }
  const text = asRecord(body.text, "body.text");
  if (typeof text.content !== "string") {
    throw new TypeError("body.text.content must be a string");
  }

  return {
    ...normalizeMessageFrame(frame),
    text: text.content,
  };
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function errorCode(error: Error): unknown {
  return (error as Error & { code?: unknown }).code;
}

function redactReplyValue(value: unknown, secret: string): unknown {
  if (typeof value === "string") return redactSecrets(value, [secret]);
  if (Array.isArray(value)) {
    return value.map((item) => redactReplyValue(item, secret));
  }
  if (typeof value !== "object" || value === null) return value;

  const redacted: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    redacted[key] = redactReplyValue(item, secret);
  }
  return redacted;
}

/** Adapts the WeCom WebSocket SDK to normalized bot messages and replies. */
export class WeComGateway {
  readonly client: WeComClientLike;
  #ready = false;
  readonly #options: WeComGatewayOptions;

  constructor(options: WeComGatewayOptions) {
    this.#options = options;
    this.client = options.client ?? (new WSClient({
      botId: options.botId,
      secret: options.secret,
      logger: createSafeSdkLogger(options.secret),
    }) as unknown as WeComClientLike);
    this.#registerListeners();
  }

  get ready(): boolean {
    return this.#ready;
  }

  connect(): this {
    this.#ready = false;
    this.client.connect();
    return this;
  }

  disconnect(): void {
    this.#ready = false;
    this.client.disconnect();
  }

  async reply(
    frame: WsFrameHeaders | unknown,
    body: StreamReplyBody | Record<string, unknown>,
    cmd?: string,
  ): Promise<boolean> {
    try {
      await this.client.reply(
        frame,
        redactReplyValue(body, this.#options.secret),
        cmd,
      );
      return true;
    } catch (error) {
      this.#report(error);
      return false;
    }
  }

  async replyStream(
    frame: WsFrameHeaders | unknown,
    streamId: string,
    content: string,
    finish = false,
  ): Promise<boolean> {
    try {
      // Deliberately omit msg_item and template-card arguments: the official
      // long-connection protocol only supports the plain stream body here.
      await this.client.replyStream(
        frame,
        streamId,
        redactSecrets(content, [this.#options.secret]),
        finish,
      );
      return true;
    } catch (error) {
      this.#report(error);
      return false;
    }
  }

  #registerListeners(): void {
    this.client.on("authenticated", () => {
      this.#ready = true;
      this.#dispatch(this.#options.onReady);
    });
    this.client.on("disconnected", () => {
      this.#ready = false;
    });
    this.client.on("message", (frame) => this.#handleMessage(frame));
    this.client.on("event.disconnected_event", () => {
      this.#ready = false;
      this.#dispatch(
        this.#options.onFatal,
        new Error(
          "Received disconnected_event: another connection replaced this bot",
        ),
      );
    });
    this.client.on("error", (value) => {
      const error = toError(value);
      const code = errorCode(error);
      if (
        code === "WS_AUTH_FAILURE_EXHAUSTED" ||
        code === "WS_RECONNECT_EXHAUSTED"
      ) {
        this.#ready = false;
        this.#dispatch(this.#options.onFatal, error);
      } else {
        this.#report(error);
      }
    });
  }

  #handleMessage(frame: unknown): void {
    try {
      const root = asRecord(frame, "frame");
      const body = asRecord(root.body, "frame.body");
      if (typeof body.msgtype !== "string" || body.msgtype.length === 0) {
        throw new TypeError("body.msgtype must be a non-empty string");
      }
      if (body.msgtype === "text") {
        this.#dispatch(this.#options.onText, normalizeTextFrame(frame), frame);
      } else {
        this.#dispatch(
          this.#options.onUnsupported,
          normalizeMessageFrame(frame),
          frame,
          body.msgtype,
        );
      }
    } catch (error) {
      this.#report(error);
    }
  }

  #dispatch<Args extends unknown[]>(
    callback: ((...args: Args) => MaybePromise<void>) | undefined,
    ...args: Args
  ): void {
    if (!callback) return;
    try {
      void Promise.resolve(callback(...args)).catch((error) => {
        this.#report(error);
      });
    } catch (error) {
      this.#report(error);
    }
  }

  #report(value: unknown): void {
    this.#options.onError?.(toError(value));
  }
}
