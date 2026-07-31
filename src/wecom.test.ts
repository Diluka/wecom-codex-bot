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
  createSafeSdkLogger,
  createWeComClient,
  normalizeTextFrame,
  type WeComClientLike,
  WeComGateway,
} from "./wecom.ts";

type Listener = (...args: unknown[]) => void;

class FakeClient implements WeComClientLike {
  readonly listeners = new Map<string, Listener[]>();
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
    assertEquals(normalizeTextFrame(textFrame()), {
      chatType: "group",
      conversationKey: "group:room-1",
      chatId: "room-1",
      senderUserId: "alice",
      msgId: "msg-1",
      text: "hello",
    });
  });

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
        text: "hello",
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
      onText: () => {},
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

  it("routes text once and all non-text messages to one callback", async () => {
    const client = new FakeClient();
    const texts: string[] = [];
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
      onText: (message) => {
        texts.push(message.text);
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
    client.emit("message", textFrame({ msgtype: "image", text: undefined }));
    client.emit("message", textFrame({ msgtype: "voice", text: undefined }));
    await Promise.resolve();
    await Promise.resolve();

    assertEquals(texts, ["hello"]);
    assertEquals(unsupported, [
      {
        type: "image",
        conversationKey: "group:room-1",
        msgId: "msg-1",
      },
      {
        type: "voice",
        conversationKey: "group:room-1",
        msgId: "msg-1",
      },
    ]);
    assertEquals(errors, []);
    gateway.disconnect();
  });

  it("awaits successful replies and catches failed replies", async () => {
    const client = new FakeClient();
    const errors: Error[] = [];
    const gateway = new WeComGateway({
      botId: "bot",
      secret: "secret",
      client,
      onText: () => {},
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

  it("redacts the actual bot secret from every reply", async () => {
    const client = new FakeClient();
    const gateway = new WeComGateway({
      botId: "bot",
      secret: "actual-$ecret",
      client,
      onText: () => {},
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
      text: { content: "leak [REDACTED]" },
    });
    assertEquals(client.streams[0].content, "leak [REDACTED]");
  });

  it("treats kicked-off and exhausted connection errors as fatal", async () => {
    const client = new FakeClient();
    const fatals: Error[] = [];
    new WeComGateway({
      botId: "bot",
      secret: "secret",
      client,
      onText: () => {},
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

  it("uses an SDK logger that drops message bodies and redacts retained logs", () => {
    const entries: Array<{ level: string; message: string }> = [];
    const logger = createSafeSdkLogger(
      "actual-$ecret",
      (level, message) => entries.push({ level, message }),
    );
    logger.debug(
      'body={"text":{"content":"private chat actual-$ecret"}}',
      { body: { text: { content: "private chat actual-$ecret" } } },
    );
    logger.warn("connection warning actual-$ecret", {
      body: { text: { content: "private chat" } },
    });

    assertEquals(entries, [{
      level: "warn",
      message: "connection warning [REDACTED]",
    }]);
  });
});
