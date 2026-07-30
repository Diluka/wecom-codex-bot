import { assert, assertEquals, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { WeComChatOutput } from "./chat-output.ts";
import type { RoutedText } from "./orchestrator.ts";
import { ConversationSendQueue, TRUNCATION_MARKER } from "./output.ts";

function message(msgId = "m1"): RoutedText {
  return {
    chatType: "single",
    conversationKey: "single:alice",
    chatId: "alice",
    senderUserId: "alice",
    msgId,
    text: "hello",
    frame: { req: msgId },
  };
}

class FakeGateway {
  readonly streams: Array<{
    frame: unknown;
    id: string;
    content: string;
    finish: boolean;
  }> = [];
  readonly replies: Array<{ frame: unknown; body: unknown }> = [];
  streamGate?: Promise<void>;
  streamResult = true;
  replyResult = true;
  replyError?: Error;

  async replyStream(
    frame: unknown,
    id: string,
    content: string,
    finish: boolean,
  ): Promise<boolean> {
    this.streams.push({ frame, id, content, finish });
    await this.streamGate;
    return this.streamResult;
  }

  reply(frame: unknown, body: unknown): Promise<boolean> {
    this.replies.push({ frame, body });
    if (this.replyError) return Promise.reject(this.replyError);
    return Promise.resolve(this.replyResult);
  }
}

describe("WeComChatOutput", () => {
  it("creates a progress stream and redacts its content", async () => {
    const gateway = new FakeGateway();
    const output = new WeComChatOutput({ gateway, secrets: ["secret-value"] });
    const progress = await output.startProgress(message());

    progress.append("running secret-value");
    await progress.finish();

    assertEquals(gateway.streams.length, 1);
    assertEquals(gateway.streams[0].finish, true);
    assertEquals(gateway.streams[0].content, "running [REDACTED]");
  });

  it("sends final Markdown in at most four UTF-8-safe chunks", async () => {
    const gateway = new FakeGateway();
    const output = new WeComChatOutput({ gateway, secrets: [] });

    await output.send(message(), "你".repeat(30_000), true);

    assertEquals(gateway.replies.length, 4);
    const bodies = gateway.replies.map(({ body }) =>
      body as { msgtype: string; markdown: { content: string } }
    );
    assert(bodies.every((body) => body.msgtype === "markdown"));
    assert(bodies.at(-1)!.markdown.content.endsWith(TRUNCATION_MARKER));
    assert(
      bodies.every((body) =>
        new TextEncoder().encode(body.markdown.content).byteLength <= 18 * 1024
      ),
    );
  });

  it("uses reserved sends for all final Markdown chunks", async () => {
    const gateway = new FakeGateway();
    const queue = new ConversationSendQueue({
      now: () => 0,
      wait: () => Promise.reject(new Error("regular limiter was used")),
    });
    const output = new WeComChatOutput({ gateway, queue, secrets: [] });
    for (let index = 0; index < 24; index++) {
      await output.send(message(`regular-${index}`), "regular");
    }

    await output.send(message("final"), "你".repeat(30_000), true);

    assertEquals(gateway.replies.length, 28);
    const finalReplies = gateway.replies.slice(24).map(({ body }) =>
      body as { markdown: { content: string } }
    );
    assertEquals(finalReplies.length, 4);
    assert(finalReplies.at(-1)!.markdown.content.endsWith(TRUNCATION_MARKER));
  });

  it("rejects a direct Markdown reply that the gateway returns as false", async () => {
    const gateway = new FakeGateway();
    gateway.replyResult = false;
    const errors: Error[] = [];
    const output = new WeComChatOutput({
      gateway,
      secrets: [],
      onError: (error) => errors.push(error),
    });

    await assertRejects(
      () => output.send(message(), "status"),
      Error,
      "Enterprise WeChat Markdown reply failed",
    );
    assertEquals(errors.length, 1);
    assertEquals(errors[0].message, "Enterprise WeChat Markdown reply failed");
  });

  it("rejects a final Markdown reply when the gateway throws", async () => {
    const gateway = new FakeGateway();
    gateway.replyError = new Error("gateway reply crashed");
    const errors: Error[] = [];
    const output = new WeComChatOutput({
      gateway,
      secrets: [],
      onError: (error) => errors.push(error),
    });

    await assertRejects(
      () => output.send(message(), "final answer", true),
      Error,
      "gateway reply crashed",
    );
    assertEquals(errors.length, 1);
    assertEquals(errors[0].message, "gateway reply crashed");
  });

  it("serializes direct replies behind an in-flight stream send", async () => {
    const gateway = new FakeGateway();
    const gate = Promise.withResolvers<void>();
    gateway.streamGate = gate.promise;
    const output = new WeComChatOutput({ gateway, secrets: [] });
    const progress = await output.startProgress(message());
    progress.append("working");

    const finishing = progress.finish();
    await Promise.resolve();
    const direct = output.send(message("m2"), "status");
    await Promise.resolve();
    await Promise.resolve();
    assertEquals(gateway.replies.length, 0);

    gate.resolve();
    await Promise.all([finishing, direct]);
    assertEquals(gateway.replies.length, 1);
  });

  it("rejects progress finish when the final stream frame cannot be sent", async () => {
    const gateway = new FakeGateway();
    gateway.streamResult = false;
    const output = new WeComChatOutput({
      gateway,
      secrets: [],
      streamControllerOptions: { maxFinishAttempts: 1 },
    });
    const progress = await output.startProgress(message());
    progress.append("working");

    await assertRejects(
      () => progress.finish(),
      Error,
      "finish Enterprise WeChat progress stream",
    );
  });

  it("rejects finishAll when a shutdown stream cannot be finished", async () => {
    const gateway = new FakeGateway();
    gateway.streamResult = false;
    const output = new WeComChatOutput({
      gateway,
      secrets: [],
      streamControllerOptions: { maxFinishAttempts: 1 },
    });
    const progress = await output.startProgress(message());
    progress.append("working");

    await assertRejects(
      () => output.finishAll(),
      Error,
      "finish Enterprise WeChat progress streams during shutdown",
    );
  });

  it("waits for every shutdown stream before reporting a failure", async () => {
    const secondGate = Promise.withResolvers<void>();
    const firstError = Promise.withResolvers<void>();
    const gateway = {
      reply: () => Promise.resolve(true),
      replyStream: async (frame: unknown) => {
        if ((frame as { req?: string }).req === "m1") return false;
        await secondGate.promise;
        return true;
      },
    };
    const output = new WeComChatOutput({
      gateway,
      secrets: [],
      onError: () => firstError.resolve(),
      streamControllerOptions: { maxFinishAttempts: 1 },
    });
    const first = await output.startProgress(message("m1"));
    const second = await output.startProgress(message("m2"));
    first.append("first");
    second.append("second");

    const finishing = output.finishAll();
    let settled = false;
    void finishing.then(
      () => settled = true,
      () => settled = true,
    );
    await firstError.promise;
    await drainMicrotasks();
    assertEquals(settled, false);

    secondGate.resolve();
    await assertRejects(
      () => finishing,
      Error,
      "finish Enterprise WeChat progress streams during shutdown",
    );
  });

  it("cancels a rate-limited regular reply during shutdown", async () => {
    let now = 0;
    const waitStarted = Promise.withResolvers<void>();
    const waitGate = Promise.withResolvers<void>();
    const queue = new ConversationSendQueue({
      now: () => now,
      wait: () => {
        waitStarted.resolve();
        return waitGate.promise;
      },
    });
    const gateway = new FakeGateway();
    const output = new WeComChatOutput({ gateway, queue, secrets: [] });
    for (let index = 0; index < 24; index++) {
      await output.send(message(`regular-${index}`), "regular");
    }

    const waiting = output.send(message("waiting"), "must not send");
    let outcome = "pending";
    const observed = waiting.then(
      () => outcome = "fulfilled",
      () => outcome = "rejected",
    );
    await waitStarted.promise;
    output.beginShutdown();
    await drainMicrotasks();

    assertEquals(outcome, "rejected");
    await output.finishAll();
    now = 60_000;
    waitGate.resolve();
    await observed;
    await drainMicrotasks();
    assertEquals(gateway.replies.length, 24);
  });

  it("finishes critical streams before completely closing the queue", async () => {
    const gateway = new FakeGateway();
    const output = new WeComChatOutput({ gateway, secrets: [] });
    const progress = await output.startProgress(message());
    progress.append("working");

    await output.finishAll();

    assertEquals(gateway.streams.length, 1);
    assertEquals(gateway.streams[0].finish, true);
    await assertRejects(
      () => output.send(message("after-close"), "too late", true),
      Error,
      "rate limit is exhausted",
    );
    assertEquals(gateway.replies.length, 0);
  });

  it("does not append a transport-owned shutdown status", async () => {
    const gateway = new FakeGateway();
    const output = new WeComChatOutput({ gateway, secrets: [] });
    const progress = await output.startProgress(message());
    progress.append("working");

    await output.finishAll();

    assertEquals(gateway.streams[0].content, "working");
  });
});

async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index++) await Promise.resolve();
}
