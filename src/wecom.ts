import {
  type Logger,
  type StreamReplyBody,
  WSClient,
  type WsFrameHeaders,
} from "@wecom/aibot-node-sdk";

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

export interface InboundImageReference {
  readonly url: string;
  readonly aesKey?: string;
}

export type InboundContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly image: InboundImageReference };

interface InboundUserMessageBase extends InboundMessage {
  readonly content: readonly InboundContentPart[];
  readonly quote?: unknown;
  readonly quoteImages: readonly InboundImageReference[];
}

export interface InboundText extends InboundUserMessageBase {
  readonly messageType: "text";
  readonly text: string;
}

export interface InboundImage extends InboundUserMessageBase {
  readonly messageType: "image";
}

export interface InboundMixed extends InboundUserMessageBase {
  readonly messageType: "mixed";
}

export type InboundUserMessage = InboundText | InboundImage | InboundMixed;

type Listener = (...args: unknown[]) => void;
type MaybePromise<T> = T | Promise<T>;
export type SdkLogLevel = "debug" | "info" | "warn" | "error";

export function createSdkLogger(
  write: (level: SdkLogLevel, message: string) => void = () => {},
): Logger {
  const record = (level: SdkLogLevel, message: string): void => {
    write(level, message);
  };

  return {
    debug: (message) => record("debug", message),
    info: (message) => record("info", message),
    warn: (message) => record("warn", message),
    error: (message) => record("error", message),
  };
}

export function createWeComClient(
  botId: string,
  secret: string,
  onSdkLog?: (level: SdkLogLevel, message: string) => void,
): WeComClientLike {
  return new WSClient({
    botId,
    secret,
    logger: createSdkLogger(onSdkLog),
  }) as unknown as WeComClientLike;
}

export interface WeComClientLike {
  on(event: string, listener: Listener): unknown;
  connect(): unknown;
  disconnect(): void;
  downloadFile(url: string, aesKey?: string): Promise<{
    buffer: Uint8Array;
    filename?: string;
  }>;
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
  onMessage: (
    message: InboundUserMessage,
    frame: unknown,
  ) => MaybePromise<void>;
  onUnsupported: (
    message: InboundMessage,
    frame: unknown,
    messageType: string,
  ) => MaybePromise<void>;
  onFatal: (error: Error) => MaybePromise<void>;
  onReady?: () => MaybePromise<void>;
  onError?: (error: Error) => void;
  onSdkLog?: (level: SdkLogLevel, message: string) => void;
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

function normalizeImageReference(value: unknown): InboundImageReference {
  const image = asRecord(value, "image");
  const url = requiredId(image, "url", "image.url");
  if (image.aeskey === undefined) return { url };
  if (typeof image.aeskey !== "string" || image.aeskey.trim().length === 0) {
    throw new TypeError("image.aeskey must be a non-empty string");
  }
  return { url, aesKey: image.aeskey };
}

function normalizeTextPart(
  value: unknown,
  label: string,
): { readonly type: "text"; readonly text: string } {
  const text = asRecord(value, label);
  if (typeof text.content !== "string") {
    throw new TypeError(`${label}.content must be a string`);
  }
  return { type: "text", text: text.content };
}

function normalizeMixedParts(value: unknown): readonly InboundContentPart[] {
  const mixed = asRecord(value, "body.mixed");
  if (!Array.isArray(mixed.msg_item)) {
    throw new TypeError("body.mixed.msg_item must be an array");
  }
  return mixed.msg_item.map((value, index) => {
    const item = asRecord(value, `body.mixed.msg_item[${index}]`);
    if (item.msgtype === "text") {
      return normalizeTextPart(
        item.text,
        `body.mixed.msg_item[${index}].text`,
      );
    }
    if (item.msgtype === "image") {
      return { type: "image", image: normalizeImageReference(item.image) };
    }
    throw new TypeError(
      `body.mixed.msg_item[${index}].msgtype must be text or image`,
    );
  });
}

function extractQuoteImages(quote: unknown): readonly InboundImageReference[] {
  if (typeof quote !== "object" || quote === null || Array.isArray(quote)) {
    return [];
  }
  const record = quote as Record<string, unknown>;
  if (record.msgtype === "image") {
    return [normalizeImageReference(record.image)];
  }
  if (record.msgtype !== "mixed") return [];
  if (
    typeof record.mixed !== "object" || record.mixed === null ||
    Array.isArray(record.mixed)
  ) {
    return [];
  }
  const items = (record.mixed as Record<string, unknown>).msg_item;
  if (!Array.isArray(items)) return [];
  return items.flatMap((value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return [];
    }
    const item = value as Record<string, unknown>;
    return item.msgtype === "image"
      ? [normalizeImageReference(item.image)]
      : [];
  });
}

export function normalizeUserMessageFrame(frame: unknown): InboundUserMessage {
  const message = normalizeMessageFrame(frame);
  const root = asRecord(frame, "frame");
  const body = asRecord(root.body, "frame.body");
  const quoteFields = body.quote === undefined
    ? { quoteImages: [] }
    : { quote: body.quote, quoteImages: extractQuoteImages(body.quote) };

  if (body.msgtype === "text") {
    const part = normalizeTextPart(body.text, "body.text");
    return {
      ...message,
      messageType: "text",
      text: part.text,
      content: [part],
      ...quoteFields,
    };
  }
  if (body.msgtype === "image") {
    return {
      ...message,
      messageType: "image",
      content: [{
        type: "image",
        image: normalizeImageReference(body.image),
      }],
      ...quoteFields,
    };
  }
  if (body.msgtype === "mixed") {
    return {
      ...message,
      messageType: "mixed",
      content: normalizeMixedParts(body.mixed),
      ...quoteFields,
    };
  }
  throw new TypeError("frame must contain a text, image, or mixed message");
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function errorCode(error: Error): unknown {
  return (error as Error & { code?: unknown }).code;
}

/** Adapts the WeCom WebSocket SDK to normalized bot messages and replies. */
export class WeComGateway {
  readonly #client: WeComClientLike;
  readonly #options: WeComGatewayOptions;

  constructor(options: WeComGatewayOptions) {
    this.#options = options;
    this.#client = options.client ?? createWeComClient(
      options.botId,
      options.secret,
      options.onSdkLog,
    );
    this.#registerListeners();
  }

  connect(): this {
    this.#client.connect();
    return this;
  }

  disconnect(): void {
    this.#client.disconnect();
  }

  async downloadImage(
    reference: InboundImageReference,
  ): Promise<Uint8Array> {
    const { buffer } = await this.#client.downloadFile(
      reference.url,
      reference.aesKey,
    );
    return buffer;
  }

  async reply(
    frame: WsFrameHeaders | unknown,
    body: StreamReplyBody | Record<string, unknown>,
    cmd?: string,
  ): Promise<boolean> {
    try {
      await this.#client.reply(frame, body, cmd);
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
      await this.#client.replyStream(
        frame,
        streamId,
        content,
        finish,
      );
      return true;
    } catch (error) {
      this.#report(error);
      return false;
    }
  }

  #registerListeners(): void {
    this.#client.on("authenticated", () => {
      this.#dispatch(this.#options.onReady);
    });
    this.#client.on("message", (frame) => this.#handleMessage(frame));
    this.#client.on("event.disconnected_event", () => {
      this.#dispatch(
        this.#options.onFatal,
        new Error(
          "Received disconnected_event: another connection replaced this bot",
        ),
      );
    });
    this.#client.on("error", (value) => {
      const error = toError(value);
      const code = errorCode(error);
      if (
        code === "WS_AUTH_FAILURE_EXHAUSTED" ||
        code === "WS_RECONNECT_EXHAUSTED"
      ) {
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
      if (["text", "image", "mixed"].includes(body.msgtype)) {
        this.#dispatch(
          this.#options.onMessage,
          normalizeUserMessageFrame(frame),
          frame,
        );
        return;
      }
      this.#dispatch(
        this.#options.onUnsupported,
        normalizeMessageFrame(frame),
        frame,
        body.msgtype,
      );
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
