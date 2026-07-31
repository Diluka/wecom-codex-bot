import { assert, assertEquals, assertMatch } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  ConversationSendQueue,
  ProgressBuffer,
  redactSecrets,
  splitUtf8,
  StreamController,
  type TimerApi,
  TRUNCATION_MARKER,
  utf8Tail,
  WeComSink,
} from "./output.ts";

const encoder = new TextEncoder();

interface ScheduledTimer {
  at: number;
  callback: () => void | Promise<void>;
}

class FakeTimers implements TimerApi {
  now = 0;
  #nextId = 1;
  readonly #timers = new Map<number, ScheduledTimer>();

  setTimeout(
    callback: () => void | Promise<void>,
    delayMs: number,
  ): unknown {
    const id = this.#nextId++;
    this.#timers.set(id, { at: this.now + delayMs, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  async advance(delayMs: number): Promise<void> {
    const target = this.now + delayMs;
    while (true) {
      const next = [...this.#timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((left, right) => left[1].at - right[1].at)[0];
      if (!next) break;
      const [id, timer] = next;
      this.#timers.delete(id);
      this.now = timer.at;
      await timer.callback();
    }
    this.now = target;
  }
}

interface SendCall {
  key: string;
  frame: unknown;
  streamId: string;
  content: string;
  finish: boolean;
}

function recordingSink(calls: SendCall[]): WeComSink {
  return new WeComSink({
    send: (frame, streamId, content, finish) => {
      calls.push({
        key: String((frame as { key?: string }).key ?? ""),
        frame,
        streamId,
        content,
        finish,
      });
      return Promise.resolve();
    },
  });
}

function rateLimitedQueue(
  clock: { now: number; waits: number[] },
): ConversationSendQueue {
  const Queue = ConversationSendQueue as unknown as new (
    options: {
      now: () => number;
      wait: (delayMs: number) => Promise<void>;
    },
  ) => ConversationSendQueue;
  return new Queue({
    now: () => clock.now,
    wait: (delayMs) => {
      clock.waits.push(delayMs);
      clock.now += delayMs;
      return Promise.resolve();
    },
  });
}

describe("UTF-8 output helpers", () => {
  it("keeps a valid UTF-8 tail without splitting a code point", () => {
    const result = utf8Tail("ab你🙂cd", 7);

    assertEquals(result, "🙂cd");
    assert(encoder.encode(result).byteLength <= 7);
    assertEquals(result.includes("�"), false);
  });

  it("splits at UTF-8 byte limits without corrupting Unicode", () => {
    const parts = splitUtf8("你好吗世界呀", 9, 4);

    assertEquals(parts, ["你好吗", "世界呀"]);
    for (const part of parts) {
      assert(encoder.encode(part).byteLength <= 9);
      assertEquals(part.includes("�"), false);
    }
  });

  it("limits final output to four parts and marks truncation", () => {
    const parts = splitUtf8("你".repeat(100), 48, 4);

    assertEquals(parts.length, 4);
    assert(parts[3].endsWith(TRUNCATION_MARKER));
    for (const part of parts) assert(encoder.encode(part).byteLength <= 48);
  });

  it("redacts actual secret values literally and longest first", () => {
    assertEquals(
      redactSecrets("tokens: abc$123 and abc", ["abc", "abc$123", ""]),
      "tokens: [REDACTED] and [REDACTED]",
    );
  });

  it("ProgressBuffer rolls its tail and redacts a secret across appends", () => {
    const progress = new ProgressBuffer({
      maxBytes: 32,
      secrets: ["top-secret"],
    });

    progress.append("old-content-that-will-roll ");
    progress.append("top-");
    progress.append("secret latest🙂");

    assertEquals(progress.snapshot().includes("top-secret"), false);
    assert(progress.snapshot().includes("[REDACTED]"));
    assert(progress.snapshot().endsWith(" latest🙂"));
    assert(encoder.encode(progress.snapshot()).byteLength <= 32);
  });
});

describe("WeComSink", () => {
  it("skips a progress flush at the reserved limit and finishes its buffer", async () => {
    const clock = { now: 0, waits: [] as number[] };
    const queue = rateLimitedQueue(clock);
    for (let index = 0; index < 24; index++) {
      await queue.enqueue("single:a", () => Promise.resolve());
    }

    const calls: SendCall[] = [];
    const timers = new FakeTimers();
    const controller = new StreamController({
      conversationKey: "single:a",
      frame: { key: "single:a" },
      sink: new WeComSink({
        queue,
        send: (frame, streamId, content, finish) => {
          calls.push({
            key: String((frame as { key?: string }).key ?? ""),
            frame,
            streamId,
            content,
            finish,
          });
          return Promise.resolve();
        },
      }),
      timers,
      streamIdFactory: () => "stream-1",
    });

    controller.append("buffered progress");
    await timers.advance(2_500);
    assertEquals(calls, []);

    assertEquals(await controller.finish(), true);
    assertEquals(calls.length, 1);
    assertEquals(calls[0].finish, true);
    assertEquals(calls[0].content, "buffered progress");
  });

  it("reserves six of the 30 per minute sends for critical frames", async () => {
    const clock = { now: 0, waits: [] as number[] };
    const calls: boolean[] = [];
    const sink = new WeComSink({
      queue: rateLimitedQueue(clock),
      send: (_frame, _streamId, _content, finish) => {
        calls.push(finish);
        return Promise.resolve();
      },
    });

    for (let index = 0; index < 24; index++) {
      assertEquals(
        await sink.send("single:a", {}, `stream-${index}`, "work", false),
        true,
      );
    }
    assertEquals(
      await sink.send("single:a", {}, "stream-skipped", "work", false),
      false,
    );
    for (let index = 0; index < 6; index++) {
      assertEquals(
        await sink.send("single:a", {}, `critical-${index}`, "done", true),
        true,
      );
    }
    assertEquals(
      await sink.send("single:a", {}, "critical-overflow", "done", true),
      false,
    );

    assertEquals(clock.waits, []);
    assertEquals(calls.length, 30);
    assertEquals(calls.at(-1), true);
  });

  it("reserves 100 of the 1000 per hour sends for critical frames", async () => {
    const clock = { now: 0, waits: [] as number[] };
    const queue = rateLimitedQueue(clock);
    let calls = 0;

    for (let index = 0; index < 901; index++) {
      await queue.enqueue("group:room", () => {
        calls++;
        return Promise.resolve();
      });
    }

    assertEquals(calls, 901);
    assertEquals(clock.now, 60 * 60_000);
    assertEquals(clock.waits.at(-1), 23 * 60_000);
  });

  it("does not let a regular hour-limit wait block a critical send", async () => {
    let now = 0;
    const waitGate = Promise.withResolvers<void>();
    const waitStarted = Promise.withResolvers<number>();
    const queue = new ConversationSendQueue({
      now: () => now,
      wait: (delayMs) => {
        waitStarted.resolve(delayMs);
        return waitGate.promise;
      },
    });
    for (let minute = 0; minute < 60; minute++) {
      for (let index = 0; index < 15; index++) {
        await queue.enqueue("group:room", () => Promise.resolve());
      }
      if (minute < 59) now += 60_000;
    }

    const events: string[] = [];
    const regular = queue.enqueue("group:room", () => {
      events.push("regular");
      return Promise.resolve();
    });
    assertEquals(await waitStarted.promise, 60_000);

    const critical = await queue.enqueueCritical("group:room", () => {
      events.push("critical");
      return Promise.resolve("sent");
    });
    assertEquals(critical, { accepted: true, value: "sent" });
    assertEquals(events, ["critical"]);

    now = 60 * 60_000;
    waitGate.resolve();
    await regular;
    assertEquals(events, ["critical", "regular"]);
  });

  it("shares ordering with non-stream sends in the same conversation", async () => {
    const queue = new ConversationSendQueue();
    const events: string[] = [];
    const gate = Promise.withResolvers<void>();
    const sink = new WeComSink({
      queue,
      send: async () => {
        events.push("stream-start");
        await gate.promise;
        events.push("stream-end");
      },
    });

    const stream = sink.send("single:a", {}, "stream-1", "work", false);
    const direct = queue.enqueue("single:a", () => {
      events.push("direct");
      return Promise.resolve();
    });
    await Promise.resolve();
    await Promise.resolve();
    assertEquals(events, ["stream-start"]);

    gate.resolve();
    await Promise.all([stream, direct]);
    assertEquals(events, ["stream-start", "stream-end", "direct"]);
  });

  it("serializes sends within one conversation but not across conversations", async () => {
    const starts: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const sink = new WeComSink({
      send: async (_frame, streamId) => {
        starts.push(streamId);
        if (streamId === "a-1") await firstBlocked;
      },
    });

    const first = sink.send("single:a", {}, "a-1", "one", true);
    const second = sink.send("single:a", {}, "a-2", "two", true);
    const other = sink.send("single:b", {}, "b-1", "other", true);
    await Promise.resolve();
    await Promise.resolve();

    assertEquals(starts, ["a-1", "b-1"]);
    releaseFirst?.();
    await Promise.all([first, second, other]);
    assertEquals(starts, ["a-1", "b-1", "a-2"]);
  });

  it("awaits and catches sender failures", async () => {
    const errors: Error[] = [];
    const sink = new WeComSink({
      send: async () => {
        await Promise.resolve();
        throw new Error("send failed");
      },
      onError: (error) => errors.push(error),
    });

    assertEquals(await sink.send("single:a", {}, "s-1", "hello", false), false);
    assertEquals(errors.length, 1);
    assertMatch(errors[0].message, /send failed/);
  });
});

describe("StreamController", () => {
  it("finishes during shutdown when a pending non-critical flush holds the send queue", async () => {
    const queue = new ConversationSendQueue();
    const flushStarted = Promise.withResolvers<void>();
    const flushGate = Promise.withResolvers<void>();
    const calls: boolean[] = [];
    const sink = new WeComSink({
      queue,
      send: async (_frame, _streamId, _content, finish) => {
        calls.push(finish);
        if (!finish) {
          flushStarted.resolve();
          await flushGate.promise;
        }
      },
    });
    const controller = new StreamController({
      conversationKey: "single:alice",
      frame: { key: "single:alice" },
      sink,
      streamIdFactory: () => "stream-1",
    });
    controller.append("working");

    const flushing = controller.flush();
    await flushStarted.promise;
    queue.beginShutdown();
    const finishing = controller.finish();
    let finishedWithinMicrotasks: boolean | undefined;
    void finishing.then((finished) => {
      finishedWithinMicrotasks = finished;
    });
    try {
      for (let index = 0; index < 20; index++) await Promise.resolve();
      assertEquals(finishedWithinMicrotasks, true);
    } finally {
      flushGate.resolve();
    }
    const [flushed, finished] = await Promise.all([flushing, finishing]);

    assertEquals(flushed, false);
    assertEquals(finished, true);
    assertEquals(calls, [false, true]);
  });

  it("coalesces updates for 2.5 seconds and keeps one stream id", async () => {
    const calls: SendCall[] = [];
    const timers = new FakeTimers();
    const controller = new StreamController({
      conversationKey: "group:room",
      frame: { key: "group:room" },
      sink: recordingSink(calls),
      timers,
      streamIdFactory: () => "stream-1",
    });

    controller.append("first ");
    controller.append("second");
    await timers.advance(2_499);
    assertEquals(calls, []);
    await timers.advance(1);
    assertEquals(
      calls.map(({ streamId, content, finish }) => ({
        streamId,
        content,
        finish,
      })),
      [{ streamId: "stream-1", content: "first second", finish: false }],
    );

    controller.append(" third");
    await timers.advance(2_500);
    assertEquals(calls[1].streamId, "stream-1");
    assertEquals(calls[1].content, "first second third");
  });

  it("finishes a stream after nine minutes and opens a continuation", async () => {
    const calls: SendCall[] = [];
    const timers = new FakeTimers();
    const ids = ["stream-1", "stream-2"];
    const controller = new StreamController({
      conversationKey: "group:room",
      frame: { key: "group:room" },
      sink: recordingSink(calls),
      timers,
      streamIdFactory: () => ids.shift() ?? "unexpected",
    });

    controller.append("working");
    await timers.advance(2_500);
    await timers.advance(9 * 60_000 - 2_500);

    assertEquals(calls[1], {
      key: "group:room",
      frame: { key: "group:room" },
      streamId: "stream-1",
      content: "working",
      finish: true,
    });
    assertEquals(calls[2].streamId, "stream-2");
    assertEquals(calls[2].finish, false);
    assertMatch(calls[2].content, /continues/i);
  });

  it("uses reserved sends for both rotation frames at the regular limit", async () => {
    const clock = { now: 0, waits: [] as number[] };
    const queue = rateLimitedQueue(clock);
    for (let index = 0; index < 24; index++) {
      await queue.enqueue("group:room", () => Promise.resolve());
    }

    const calls: SendCall[] = [];
    const timers = new FakeTimers();
    const ids = ["stream-1", "stream-2"];
    const controller = new StreamController({
      conversationKey: "group:room",
      frame: { key: "group:room" },
      sink: new WeComSink({
        queue,
        send: (frame, streamId, content, finish) => {
          calls.push({
            key: String((frame as { key?: string }).key ?? ""),
            frame,
            streamId,
            content,
            finish,
          });
          return Promise.resolve();
        },
      }),
      timers,
      streamIdFactory: () => ids.shift() ?? "unexpected",
    });

    controller.append("working");
    await timers.advance(9 * 60_000);

    assertEquals(
      calls.map(({ streamId, finish }) => ({ streamId, finish })),
      [
        { streamId: "stream-1", finish: true },
        { streamId: "stream-2", finish: false },
      ],
    );
    assertEquals(clock.waits, []);
  });

  it("moves deltas appended during rotation into the continuation stream", async () => {
    const calls: SendCall[] = [];
    const timers = new FakeTimers();
    const finishGate = Promise.withResolvers<void>();
    const finishStarted = Promise.withResolvers<void>();
    const ids = ["stream-1", "stream-2"];
    const sink = new WeComSink({
      send: async (frame, streamId, content, finish) => {
        calls.push({
          key: String((frame as { key?: string }).key ?? ""),
          frame,
          streamId,
          content,
          finish,
        });
        if (streamId === "stream-1" && finish) {
          finishStarted.resolve();
          await finishGate.promise;
        }
      },
    });
    const controller = new StreamController({
      conversationKey: "group:room",
      frame: { key: "group:room" },
      sink,
      timers,
      streamIdFactory: () => ids.shift() ?? "unexpected",
    });

    controller.append("before rotation");
    const rotating = timers.advance(9 * 60_000);
    await finishStarted.promise;
    controller.append(" during rotation");
    finishGate.resolve();
    await rotating;

    assertEquals(calls[1].streamId, "stream-1");
    assertEquals(calls[1].finish, true);
    assertEquals(calls[2].streamId, "stream-2");
    assertMatch(calls[2].content, /during rotation/);
  });

  it("finishes each stream once when finish races with rotation", async () => {
    const calls: SendCall[] = [];
    const timers = new FakeTimers();
    const rotationGate = Promise.withResolvers<void>();
    const rotationStarted = Promise.withResolvers<void>();
    const ids = ["stream-1", "stream-2"];
    const sink = new WeComSink({
      send: async (frame, streamId, content, finish) => {
        calls.push({
          key: String((frame as { key?: string }).key ?? ""),
          frame,
          streamId,
          content,
          finish,
        });
        if (streamId === "stream-1" && finish) {
          rotationStarted.resolve();
          await rotationGate.promise;
        }
      },
    });
    const controller = new StreamController({
      conversationKey: "group:room",
      frame: { key: "group:room" },
      sink,
      timers,
      streamIdFactory: () => ids.shift() ?? "unexpected",
    });

    controller.append("working");
    const rotating = timers.advance(9 * 60_000);
    await rotationStarted.promise;
    const finishing = controller.finish(" final result");
    rotationGate.resolve();
    assertEquals(await finishing, true);
    await rotating;

    const finishedCalls = calls.filter(({ finish }) => finish);
    assertEquals(
      finishedCalls.map(({ streamId }) => streamId),
      ["stream-1", "stream-2"],
    );
    assertMatch(finishedCalls[1].content, /final result/);
    assertEquals(
      calls.filter(({ streamId }) => streamId === "stream-2").length,
      1,
    );
  });

  it("keeps the old stream and retries rotation after its finish send fails", async () => {
    const calls: SendCall[] = [];
    const timers = new FakeTimers();
    const ids = ["stream-1", "stream-2"];
    let rejectNextFinish = true;
    const sink = new WeComSink({
      send: (frame, streamId, content, finish) => {
        calls.push({
          key: String((frame as { key?: string }).key ?? ""),
          frame,
          streamId,
          content,
          finish,
        });
        if (finish && rejectNextFinish) {
          rejectNextFinish = false;
          return Promise.reject(new Error("temporary ack failure"));
        }
        return Promise.resolve();
      },
    });
    const controller = new StreamController({
      conversationKey: "group:room",
      frame: { key: "group:room" },
      sink,
      timers,
      streamIdFactory: () => ids.shift() ?? "unexpected",
    });

    controller.append("working");
    await timers.advance(9 * 60_000);

    assertEquals(calls.length, 2);
    assertEquals(calls[1].streamId, "stream-1");
    assertEquals(calls[1].finish, true);

    controller.append(" newer");
    await timers.advance(2_499);
    assertEquals(calls.length, 2);
    await timers.advance(1);

    assertEquals(calls[2].streamId, "stream-1");
    assertEquals(calls[2].content, "working newer");
    assertEquals(calls[2].finish, true);
    assertEquals(calls[3].streamId, "stream-2");
    assertEquals(calls[3].finish, false);
    assertMatch(calls[3].content, /continues/i);
  });

  it("stops automatic rotation after three consecutive failures", async () => {
    const calls: SendCall[] = [];
    const timers = new FakeTimers();
    const sink = new WeComSink({
      send: (frame, streamId, content, finish) => {
        calls.push({
          key: String((frame as { key?: string }).key ?? ""),
          frame,
          streamId,
          content,
          finish,
        });
        return finish
          ? Promise.reject(new Error("persistent rotation failure"))
          : Promise.resolve();
      },
    });
    const controller = new StreamController({
      conversationKey: "group:room",
      frame: { key: "group:room" },
      sink,
      timers,
      streamIdFactory: () => "stream-1",
    });

    controller.append("working");
    await timers.advance(9 * 60_000);
    await timers.advance(2_500);
    await timers.advance(2_500);
    assertEquals(calls.filter(({ finish }) => finish).length, 3);

    await timers.advance(2_500);
    assertEquals(calls.filter(({ finish }) => finish).length, 3);
    assertEquals(
      calls.filter(({ finish }) => finish).map(({ streamId }) => streamId),
      ["stream-1", "stream-1", "stream-1"],
    );
  });

  it("cancels timers and finishes the current stream explicitly", async () => {
    const calls: SendCall[] = [];
    const timers = new FakeTimers();
    const controller = new StreamController({
      conversationKey: "single:alice",
      frame: { key: "single:alice" },
      sink: recordingSink(calls),
      timers,
      streamIdFactory: () => "stream-1",
    });

    controller.append("working");
    assertEquals(await controller.finish(" done"), true);
    await timers.advance(10 * 60_000);

    assertEquals(calls.length, 1);
    assertEquals(calls[0].content, "working done");
    assertEquals(calls[0].finish, true);
  });

  it("retries an explicit finish twice before succeeding", async () => {
    const timers = new FakeTimers();
    let attempts = 0;
    const sink = new WeComSink({
      send: (_frame, _streamId, _content, finish) => {
        if (finish && ++attempts < 3) {
          return Promise.reject(new Error("temporary finish failure"));
        }
        return Promise.resolve();
      },
    });
    const controller = new StreamController({
      conversationKey: "single:alice",
      frame: {},
      sink,
      timers,
      streamIdFactory: () => "stream-1",
    });
    controller.append("final result");

    const finishing = controller.finish();
    await drainMicrotasks();
    assertEquals(attempts, 1);

    await timers.advance(2_499);
    assertEquals(attempts, 1);
    await timers.advance(1);
    await drainMicrotasks();
    assertEquals(attempts, 2);

    await timers.advance(2_500);
    await drainMicrotasks();
    assertEquals(attempts, 3);
    assertEquals(await finishing, true);
  });

  it("returns false after the bounded finish attempts are exhausted", async () => {
    const timers = new FakeTimers();
    let attempts = 0;
    const sink = new WeComSink({
      send: () => {
        attempts++;
        return Promise.reject(new Error("persistent finish failure"));
      },
    });
    const controller = new StreamController({
      conversationKey: "single:alice",
      frame: {},
      sink,
      timers,
      retryDelayMs: 100,
      maxFinishAttempts: 3,
      streamIdFactory: () => "stream-1",
    });
    controller.append("final result");

    const finishing = controller.finish();
    await drainMicrotasks();
    await timers.advance(100);
    await drainMicrotasks();
    await timers.advance(100);
    await drainMicrotasks();

    assertEquals(await finishing, false);
    assertEquals(attempts, 3);
    await timers.advance(10_000);
    assertEquals(attempts, 3);
  });
});

async function drainMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index++) await Promise.resolve();
}
