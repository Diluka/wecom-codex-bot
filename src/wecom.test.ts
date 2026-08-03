import {
  assertEquals,
  assertInstanceOf,
  assertMatch,
  assertThrows,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { WSClient } from "@wecom/aibot-node-sdk";
import {
  conversationKey,
  createSdkLogger,
  createWeComClient,
  type InboundUserMessage,
  normalizeUserMessageFrame,
  type WeComClientLike,
  WeComGateway,
} from "./wecom.ts";

type Listener = (...args: unknown[]) => void;

class FakeClient implements WeComClientLike {
  readonly listeners = new Map<string, Listener[]>();
  readonly downloadCalls: Array<{ url: string; aesKey?: string }> = [];
  readonly replies: Array<{ frame: unknown; body: unknown; cmd?: string }> = [];
  readonly streams: Array<{
    frame: unknown;
    streamId: string;
    content: string;
    finish: boolean;
  }> = [];
  connectCount = 0;
  disconnectCount = 0;
  replyFailure?: Error;
  downloadResult = new Uint8Array();

  on(event: string, listener: Listener): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }

  connect(): this {
    this.connectCount++;
    return this;
  }

  disconnect(): void {
    this.disconnectCount++;
  }

  async downloadFile(
    url: string,
    aesKey?: string,
  ): Promise<{ buffer: Uint8Array; filename?: string }> {
    await Promise.resolve();
    this.downloadCalls.push({ url, aesKey });
    return { buffer: this.downloadResult };
  }

  async reply(frame: unknown, body: unknown, cmd?: string): Promise<unknown> {
    await Promise.resolve();
    if (this.replyFailure) throw this.replyFailure;
    this.replies.push({ frame, body, cmd });
    return {};
  }

  async replyStream(
    frame: unknown,
    streamId: string,
    content: string,
    finish = false,
  ): Promise<unknown> {
    await Promise.resolve();
    if (this.replyFailure) throw this.replyFailure;
    this.streams.push({ frame, streamId, content, finish });
    return {};
  }
}

function textFrame(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    cmd: "aibot_msg_callback",
    headers: { req_id: "req-1" },
    body: {
      msgid: "msg-1",
      msgtype: "text",
      chattype: "group",
      chatid: "room-1",
      from: { userid: "alice" },
      text: { content: "hello" },
      ...overrides,
    },
  };
}

describe("WeCom message normalization", () => {
  it("binds groups by chat id and singles by sender", () => {
    assertEquals(
      conversationKey("group", "room-1", "alice"),
      "group:room-1",
    );
    assertEquals(
      conversationKey("single", undefined, "alice"),
      "single:alice",
    );
  });

  it("rejects a group without chatid", () => {
    assertThrows(
      () => conversationKey("group", undefined, "alice"),
      TypeError,
      "chatid",
    );
  });

  it("preserves group sender identity", () => {
    assertEquals(normalizeUserMessageFrame(textFrame()), {
      chatType: "group",
      conversationKey: "group:room-1",
      chatId: "room-1",
      senderUserId: "alice",
      msgId: "msg-1",
      messageType: "text",
      text: "hello",
      content: [{ type: "text", text: "hello" }],
      quoteImages: [],
    });
  });

  it("normalizes image and mixed content without changing item order", () => {
    assertEquals(
      normalizeUserMessageFrame(textFrame({
        msgtype: "mixed",
        text: undefined,
        mixed: {
          msg_item: [
            { msgtype: "text", text: { content: "before" } },
            {
              msgtype: "image",
              image: {
                url: "https://example.invalid/one",
                aeskey: "key-1",
              },
            },
            { msgtype: "text", text: { content: "after" } },
          ],
        },
      })),
      {
        chatType: "group",
        conversationKey: "group:room-1",
        chatId: "room-1",
        senderUserId: "alice",
        msgId: "msg-1",
        messageType: "mixed",
        content: [
          { type: "text", text: "before" },
          {
            type: "image",
            image: {
              url: "https://example.invalid/one",
              aesKey: "key-1",
            },
          },
          { type: "text", text: "after" },
        ],
        quoteImages: [],
      },
    );
  });

  it("keeps an image without the SDK-optional AES key routable", () => {
    const normalized = normalizeUserMessageFrame(textFrame({
      msgtype: "image",
      text: undefined,
      image: { url: "https://example.invalid/image" },
    }));

    assertEquals(normalized.messageType, "image");
    assertEquals(normalized.content, [{
      type: "image",
      image: { url: "https://example.invalid/image" },
    }]);
  });

  it("preserves quote JSON and extracts only known quote image structures", () => {
    const quote = {
      msgtype: "mixed",
      mixed: {
        msg_item: [
          { msgtype: "text", text: { content: "quoted" } },
          {
            msgtype: "image",
            image: {
              url: "https://example.invalid/quoted",
              aeskey: "quote-key",
            },
          },
        ],
      },
      future_field: {
        image: { url: "do-not-scan", aeskey: "do-not-scan" },
      },
    };

    const normalized = normalizeUserMessageFrame(textFrame({ quote }));
    assertEquals(normalized.quote, quote);
    assertEquals(normalized.quoteImages, [{
      url: "https://example.invalid/quoted",
      aesKey: "quote-key",
    }]);
  });

  it("rejects malformed mixed content", () => {
    assertThrows(
      () =>
        normalizeUserMessageFrame(textFrame({
          msgtype: "mixed",
          text: undefined,
          mixed: {},
        })),
      TypeError,
      "mixed",
    );
  });

  it("rejects unknown mixed item message types", () => {
    assertThrows(
      () =>
        normalizeUserMessageFrame(textFrame({
          msgtype: "mixed",
          text: undefined,
          mixed: { msg_item: [{ msgtype: "file", file: {} }] },
        })),
      TypeError,
      "msgtype",
    );
  });

  it("derives the single target from sender userid", () => {
    assertEquals(
      normalizeUserMessageFrame(textFrame({
        chattype: "single",
        chatid: undefined,
        from: { userid: "bob" },
      })),
      {
        chatType: "single",
        conversationKey: "single:bob",
        chatId: "bob",
        senderUserId: "bob",
        msgId: "msg-1",
        messageType: "text",
        text: "hello",
        content: [{ type: "text", text: "hello" }],
        quoteImages: [],
      },
    );
  });

  for (
    const [name, overrides, expected] of [
      ["msgid", { msgid: "" }, "msgid"],
      ["sender", { from: {} }, "userid"],
      ["group chatid", { chatid: "" }, "chatid"],
      ["text body", { text: {} }, "text.content"],
      ["chat type", { chattype: "other" }, "chattype"],
    ] as const
  ) {
    it(`rejects missing or invalid ${name}`, () => {
      assertThrows(
        () => normalizeUserMessageFrame(textFrame(overrides)),
        TypeError,
        expected,
      );
    });
  }
});

describe("WeComGateway", () => {
  it("calls onReady only after authenticated", () => {
    const client = new FakeClient();
    let readyCount = 0;
    const gateway = new WeComGateway({
      botId: "bot",
      secret: "secret",
      client,
      onMessage: () => {},
      onUnsupported: () => {},
      onFatal: () => {},
      onReady: () => {
        readyCount++;
      },
    });

    gateway.connect();
    assertEquals(readyCount, 0);
    client.emit("connected");
    assertEquals(readyCount, 0);
    client.emit("authenticated");
    assertEquals(readyCount, 1);
    client.emit("disconnected", "network lost");
    assertEquals(readyCount, 1);
    gateway.disconnect();
    assertEquals(client.connectCount, 1);
    assertEquals(client.disconnectCount, 1);
  });

  it("routes supported messages and keeps unsupported messages separate", async () => {
    const client = new FakeClient();
    const messages: InboundUserMessage[] = [];
    const unsupported: Array<{
      type: string;
      conversationKey: string;
      msgId: string;
    }> = [];
    const errors: Error[] = [];
    const gateway = new WeComGateway({
      botId: "bot",
      secret: "secret",
      client,
      onMessage: (message) => {
        messages.push(message);
      },
      onUnsupported: (message, _frame, type) => {
        unsupported.push({
          type,
          conversationKey: message.conversationKey,
          msgId: message.msgId,
        });
      },
      onFatal: () => {},
      onError: (error) => {
        errors.push(error);
      },
    });

    client.emit("message", textFrame());
    client.emit(
      "message",
      textFrame({
        msgtype: "image",
        text: undefined,
        image: {
          url: "https://example.invalid/image",
          aeskey: "key-1",
        },
      }),
    );
    client.emit("message", textFrame({ msgtype: "voice", text: undefined }));
    await Promise.resolve();
    await Promise.resolve();

    assertEquals(messages.map((message) => message.messageType), [
      "text",
      "image",
    ]);
    assertEquals(unsupported, [
      {
        type: "voice",
        conversationKey: "group:room-1",
        msgId: "msg-1",
      },
    ]);
    assertEquals(errors, []);
    gateway.disconnect();
  });

  it("downloads with the image URL and AES key", async () => {
    const client = new FakeClient();
    client.downloadResult = new Uint8Array([0xff, 0xd8, 0xff]);
    const gateway = new WeComGateway({
      botId: "bot",
      secret: "secret",
      client,
      onMessage: () => {},
      onUnsupported: () => {},
      onFatal: () => {},
    });

    assertEquals(
      await gateway.downloadImage({
        url: "https://example.invalid/image",
        aesKey: "key-1",
      }),
      new Uint8Array([0xff, 0xd8, 0xff]),
    );
    assertEquals(client.downloadCalls, [{
      url: "https://example.invalid/image",
      aesKey: "key-1",
    }]);
  });

  it("awaits successful replies and catches failed replies", async () => {
    const client = new FakeClient();
    const errors: Error[] = [];
    const gateway = new WeComGateway({
      botId: "bot",
      secret: "secret",
      client,
      onMessage: () => {},
      onUnsupported: () => {},
      onFatal: () => {},
      onError: (error) => {
        errors.push(error);
      },
    });
    const frame = { headers: { req_id: "req-1" } };

    assertEquals(
      await gateway.reply(frame, {
        msgtype: "text",
        text: { content: "ok" },
      }),
      true,
    );
    assertEquals(
      await gateway.replyStream(frame, "stream-1", "working", false),
      true,
    );
    assertEquals(client.streams, [{
      frame,
      streamId: "stream-1",
      content: "working",
      finish: false,
    }]);

    client.replyFailure = new Error("reply failed");
    assertEquals(
      await gateway.replyStream(frame, "stream-1", "done", true),
      false,
    );
    assertEquals(errors.length, 1);
    assertMatch(errors[0].message, /reply failed/);
  });

  it("forwards reply content without inspecting values", async () => {
    const client = new FakeClient();
    const gateway = new WeComGateway({
      botId: "bot",
      secret: "actual-$ecret",
      client,
      onMessage: () => {},
      onUnsupported: () => {},
      onFatal: () => {},
    });
    const frame = { headers: { req_id: "req-1" } };

    await gateway.reply(frame, {
      msgtype: "text",
      text: { content: "leak actual-$ecret" },
    });
    await gateway.replyStream(
      frame,
      "stream-1",
      "leak actual-$ecret",
      false,
    );

    assertEquals(client.replies[0].body, {
      msgtype: "text",
      text: { content: "leak actual-$ecret" },
    });
    assertEquals(client.streams[0].content, "leak actual-$ecret");
  });

  it("treats kicked-off and exhausted connection errors as fatal", async () => {
    const client = new FakeClient();
    const fatals: Error[] = [];
    new WeComGateway({
      botId: "bot",
      secret: "secret",
      client,
      onMessage: () => {},
      onUnsupported: () => {},
      onFatal: (error) => {
        fatals.push(error);
      },
    });

    client.emit("event.disconnected_event", textFrame());
    await Promise.resolve();
    assertEquals(fatals.length, 1);
    assertMatch(fatals[0].message, /disconnected_event/);

    const exhausted = Object.assign(new Error("reconnect exhausted"), {
      code: "WS_RECONNECT_EXHAUSTED",
    });
    client.emit("error", exhausted);
    await Promise.resolve();
    assertEquals(fatals.length, 2);
    assertEquals(fatals[1], exhausted);
  });

  it("constructs the SDK client through the production factory", () => {
    assertInstanceOf(createWeComClient("bot", "secret"), WSClient);
  });

  it("forwards every SDK log level without inspecting messages", () => {
    const entries: Array<{ level: string; message: string }> = [];
    const logger = createSdkLogger((level, message) =>
      entries.push({ level, message })
    );
    logger.debug("callback actual-$ecret");
    logger.info("connected actual-$ecret");
    logger.warn("connection actual-$ecret");
    logger.error("failed actual-$ecret");

    assertEquals(entries, [
      {
        level: "debug",
        message: "callback actual-$ecret",
      },
      {
        level: "info",
        message: "connected actual-$ecret",
      },
      {
        level: "warn",
        message: "connection actual-$ecret",
      },
      {
        level: "error",
        message: "failed actual-$ecret",
      },
    ]);
  });
});
