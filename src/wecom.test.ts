import {
  assertEquals,
  assertInstanceOf,
  assertMatch,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { WSClient } from "@wecom/aibot-node-sdk";
import {
  conversationKey,
  createSdkLogger,
  createWeComClient,
  type InboundUserMessage,
  normalizeTextFrame,
  normalizeUserMessageFrame,
  type WeComClientLike,
  WeComGateway,
} from "./wecom.ts";

type Listener = (...args: unknown[]) => void;

class FakeClient implements WeComClientLike {
  readonly listeners = new Map<string, Listener[]>();
  readonly downloadCalls: Array<{ url: string; aesKey: string }> = [];
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
    aesKey: string,
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

function imageBody(url = "https://example.invalid/image", aeskey = "key-1") {
  return { image: { url, aeskey }, text: undefined };
}

function gatewayWith(client: FakeClient): WeComGateway {
  return new WeComGateway({
    botId: "bot",
    secret: "secret",
    client,
    onMessage: () => {},
    onUnsupported: () => {},
    onFatal: () => {},
  });
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
    assertEquals(normalizeTextFrame(textFrame()), {
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
              status: "valid",
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

  it("keeps malformed image fields routable as an invalid reference", () => {
    const normalized = normalizeUserMessageFrame(textFrame({
      msgtype: "image",
      text: undefined,
      image: { url: "", aeskey: 42 },
    }));

    assertEquals(normalized.messageType, "image");
    assertEquals(normalized.content, [{
      type: "image",
      image: { status: "invalid" },
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
    assertStrictEquals(normalized.quote, quote);
    assertEquals(normalized.quoteImages, [{
      status: "valid",
      url: "https://example.invalid/quoted",
      aesKey: "quote-key",
    }]);
  });

  for (
    const [name, mixed] of [
      ["missing mixed container", undefined],
      ["non-object mixed container", []],
      ["missing mixed items", {}],
      ["non-array mixed items", { msg_item: {} }],
    ] as const
  ) {
    it(`rejects ${name}`, () => {
      assertThrows(
        () =>
          normalizeUserMessageFrame(textFrame({
            msgtype: "mixed",
            text: undefined,
            mixed,
          })),
        TypeError,
        "mixed",
      );
    });
  }

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

  for (
    const [name, image] of [
      ["missing URL", { aeskey: "key-1" }],
      ["blank URL", { url: "  ", aeskey: "key-1" }],
      ["non-string URL", { url: 42, aeskey: "key-1" }],
      ["missing AES key", { url: "https://example.invalid/image" }],
      ["blank AES key", {
        url: "https://example.invalid/image",
        aeskey: "  ",
      }],
      ["non-string AES key", {
        url: "https://example.invalid/image",
        aeskey: 42,
      }],
    ] as const
  ) {
    it(`normalizes an image with ${name} as an invalid reference`, () => {
      assertEquals(
        normalizeUserMessageFrame(textFrame({
          msgtype: "image",
          text: undefined,
          image,
        })).content,
        [{ type: "image", image: { status: "invalid" } }],
      );
    });
  }

  it("preserves complete quoted content without filtering fields", () => {
    const quote = {
      msgtype: "mixed",
      mixed: {
        msg_item: [
          { msgtype: "text", text: { content: "quoted text" } },
          {
            msgtype: "image",
            image: {
              url: "https://example.invalid/image",
              aeskey: "quote-key",
            },
          },
        ],
      },
      future_field: { nested: true },
    };

    const normalized = normalizeTextFrame(
      textFrame({ quote }),
    ) as unknown as Record<string, unknown>;

    assertEquals(normalized.quote, quote);
  });

  it("derives the single target from sender userid", () => {
    assertEquals(
      normalizeTextFrame(textFrame({
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
      ["message type", { msgtype: "image" }, "text message"],
    ] as const
  ) {
    it(`rejects missing or invalid ${name}`, () => {
      assertThrows(
        () => normalizeTextFrame(textFrame(overrides)),
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
      textFrame({ msgtype: "image", ...imageBody() }),
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

  it("uses only the generic message listener and dispatches each supported frame once", async () => {
    const client = new FakeClient();
    const messages: InboundUserMessage[] = [];
    const gateway = new WeComGateway({
      botId: "bot",
      secret: "secret",
      client,
      onMessage: (message) => {
        messages.push(message);
      },
      onUnsupported: () => {},
      onFatal: () => {},
    });

    client.emit(
      "message",
      textFrame({ msgtype: "image", ...imageBody() }),
    );
    client.emit(
      "message.image",
      textFrame({ msgtype: "image", ...imageBody() }),
    );
    await Promise.resolve();

    assertEquals(messages.length, 1);
    assertEquals(client.listeners.has("message.image"), false);
    gateway.disconnect();
  });

  it("downloads only valid references and always supplies the AES key", async () => {
    const client = new FakeClient();
    client.downloadResult = new Uint8Array([0xff, 0xd8, 0xff]);
    const gateway = gatewayWith(client);

    assertEquals(
      await gateway.downloadImage({
        status: "valid",
        url: "https://example.invalid/image",
        aesKey: "key-1",
      }),
      new Uint8Array([0xff, 0xd8, 0xff]),
    );
    assertEquals(client.downloadCalls, [{
      url: "https://example.invalid/image",
      aesKey: "key-1",
    }]);
    await assertRejects(
      () => gateway.downloadImage({ status: "invalid" }),
      TypeError,
      "valid image reference",
    );
    assertEquals(client.downloadCalls.length, 1);
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
