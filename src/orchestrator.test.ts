import { assertEquals, assertMatch } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  type ChatOutput,
  type CodexPort,
  type CodexTurnHandle,
  ConversationOrchestrator,
  type ConversationOrchestratorOptions,
  type OrchestratorState,
  type RequestStatusEvent,
  type RoutedMessage,
  type RoutedText,
  type TurnOutcome,
} from "./orchestrator.ts";
import type { ActivityEvent } from "./activity-event.ts";
import { WeComChatOutput } from "./chat-output.ts";
import { OUTPUT_TAGS, type OutputSettings } from "./output-settings.ts";
import { ConversationSendQueue } from "./output.ts";

function message(
  conversationKey: `single:${string}` | `group:${string}`,
  msgId: string,
  content: string,
  senderUserId = "alice",
): RoutedText {
  const group = conversationKey.startsWith("group:");
  return {
    chatType: group ? "group" : "single",
    chatId: group ? conversationKey.slice(6) : senderUserId,
    conversationKey,
    senderUserId,
    msgId,
    text: content,
    frame: { id: msgId },
  };
}

function outputSettings(
  level: OutputSettings["level"] = "full",
): OutputSettings {
  return {
    level,
    levels: Object.fromEntries(
      OUTPUT_TAGS.map((tag) => [tag, level]),
    ) as OutputSettings["levels"],
    label: "show",
    labels: Object.fromEntries(
      OUTPUT_TAGS.map((tag) => [tag, "show"]),
    ) as OutputSettings["labels"],
    toolFormat: "individual",
  };
}

class FakeState implements OrchestratorState {
  readonly claimed = new Set<string>();
  failNextBegin = false;
  failNextFinish = false;
  readonly records = new Map<string, {
    conversationKey: string;
    chatType: "single" | "group";
    threadId: string;
    activeTurnId: string | null;
    lastStatus: string;
    lastError: string | null;
  }>();

  claimMessage(msgId: string): boolean {
    if (this.claimed.has(msgId)) return false;
    this.claimed.add(msgId);
    return true;
  }

  getConversation(key: string) {
    return this.records.get(key) ?? null;
  }

  bindConversation(
    conversationKey: string,
    chatType: "single" | "group",
    threadId: string,
  ) {
    const record = {
      conversationKey,
      chatType,
      threadId,
      activeTurnId: null,
      lastStatus: "idle",
      lastError: null,
    };
    this.records.set(conversationKey, record);
    return record;
  }

  beginTurn(key: string, turnId: string) {
    if (this.failNextBegin) {
      this.failNextBegin = false;
      throw new Error("beginTurn failed");
    }
    const record = this.records.get(key)!;
    record.activeTurnId = turnId;
    record.lastStatus = "in_progress";
    return record;
  }

  finishTurn(
    key: string,
    _turnId: string,
    status: string,
    error?: string | null,
  ) {
    if (this.failNextFinish) {
      this.failNextFinish = false;
      throw new Error("finishTurn failed");
    }
    const record = this.records.get(key)!;
    record.activeTurnId = null;
    record.lastStatus = status;
    record.lastError = error ?? null;
    return record;
  }
}

interface StartedTurn {
  threadId: string;
  prompt: string;
  onActivity: (event: ActivityEvent) => void | Promise<void>;
  turnId: string;
  resolve: (outcome: TurnOutcome) => void;
}

class FakeCodex implements CodexPort {
  ready = true;
  generation = 1;
  readonly starts: StartedTurn[] = [];
  readonly startThreadGates: Promise<void>[] = [];
  readonly startThreadErrors: Error[] = [];
  readonly startTurnGates: Promise<void>[] = [];
  readonly startTurnErrors: Error[] = [];
  readonly interrupts: Array<{ threadId: string; turnId: string }> = [];
  readonly resumed: string[] = [];
  readonly resumeThreadGates: Promise<void>[] = [];
  readonly resumeThreadErrors: Error[] = [];
  readonly interruptGates: Promise<void>[] = [];
  readonly interruptErrors: Error[] = [];
  threadSequence = 0;
  turnSequence = 0;
  startThreadAttempts = 0;
  startTurnAttempts = 0;

  async startThread(): Promise<string> {
    this.startThreadAttempts++;
    const gate = this.startThreadGates.shift();
    if (gate) await gate;
    const error = this.startThreadErrors.shift();
    if (error) throw error;
    return `thread-${++this.threadSequence}`;
  }

  async resumeThread(threadId: string): Promise<void> {
    this.resumed.push(threadId);
    const gate = this.resumeThreadGates.shift();
    if (gate) await gate;
    const error = this.resumeThreadErrors.shift();
    if (error) throw error;
  }

  async startTurn(
    threadId: string,
    prompt: string,
    onActivity: (event: ActivityEvent) => void | Promise<void>,
  ): Promise<CodexTurnHandle> {
    this.startTurnAttempts++;
    const gate = this.startTurnGates.shift();
    if (gate) await gate;
    const error = this.startTurnErrors.shift();
    if (error) throw error;
    const { promise, resolve } = Promise.withResolvers<TurnOutcome>();
    const turnId = `turn-${++this.turnSequence}`;
    this.starts.push({ threadId, prompt, onActivity, turnId, resolve });
    return { turnId, completion: promise };
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    this.interrupts.push({ threadId, turnId });
    const gate = this.interruptGates.shift();
    if (gate) await gate;
    const error = this.interruptErrors.shift();
    if (error) throw error;
  }
}

class FakeOutput implements ChatOutput {
  readonly sent: Array<{ msgId: string; text: string; final: boolean }> = [];
  readonly progress: Array<
    { msgId: string; chunks: string[]; finished: boolean }
  > = [];
  readonly sendErrors: Error[] = [];
  readonly lateProgressAppends: Array<{ msgId: string; text: string }> = [];
  readonly startProgressGates: Promise<void>[] = [];
  startProgressAttempts = 0;
  failNextProgressFinish = false;

  send(message: RoutedMessage, text: string, final = false): Promise<void> {
    this.sent.push({ msgId: message.msgId, text, final });
    const error = this.sendErrors.shift();
    if (error) return Promise.reject(error);
    return Promise.resolve();
  }

  async startProgress(message: RoutedText) {
    this.startProgressAttempts++;
    const gate = this.startProgressGates.shift();
    if (gate) await gate;
    const entry = {
      msgId: message.msgId,
      chunks: [] as string[],
      finished: false,
    };
    this.progress.push(entry);
    return {
      append: (text: string) => {
        if (entry.finished) {
          this.lateProgressAppends.push({ msgId: message.msgId, text });
          return;
        }
        entry.chunks.push(text);
      },
      finish: () => {
        entry.finished = true;
        if (this.failNextProgressFinish) {
          this.failNextProgressFinish = false;
          return Promise.reject(new Error("progress finish failed"));
        }
        return Promise.resolve();
      },
      detach: () => {},
    };
  }
}

class PendingFinalOutput extends FakeOutput {
  readonly finalStarted = Promise.withResolvers<void>();
  readonly finalGate = Promise.withResolvers<void>();

  override send(
    message: RoutedMessage,
    text: string,
    final = false,
  ): Promise<void> {
    this.sent.push({ msgId: message.msgId, text, final });
    const error = this.sendErrors.shift();
    if (error) return Promise.reject(error);
    if (final) {
      this.finalStarted.resolve();
      return this.finalGate.promise;
    }
    return Promise.resolve();
  }
}

class PendingProgressFinishOutput extends FakeOutput {
  readonly finishStarted = Promise.withResolvers<void>();
  readonly finishGate = Promise.withResolvers<void>();

  override async startProgress(message: RoutedText) {
    const progress = await super.startProgress(message);
    return {
      ...progress,
      finish: async () => {
        this.finishStarted.resolve();
        await this.finishGate.promise;
        await progress.finish();
      },
    };
  }
}

class FinalSendThenHookOutput extends FakeOutput {
  onFinalThen?: () => void;

  override send(
    message: RoutedMessage,
    text: string,
    final = false,
  ): Promise<void> {
    this.sent.push({ msgId: message.msgId, text, final });
    const sent = Promise.resolve();
    if (!final) return sent;

    const hook = this.onFinalThen;
    return {
      then: ((onfulfilled, onrejected) => {
        const result = sent.then(onfulfilled, onrejected);
        hook?.();
        return result;
      }) as Promise<void>["then"],
      catch: sent.catch.bind(sent),
      finally: sent.finally.bind(sent),
      [Symbol.toStringTag]: "Promise",
    } as Promise<void>;
  }
}

class QueueBlockedOutput implements ChatOutput {
  readonly directStarted = Promise.withResolvers<void>();
  readonly directGate = Promise.withResolvers<void>();
  readonly afterShutdownGate = Promise.withResolvers<void>();
  afterShutdownWaiters = 0;
  readonly progress: Array<
    { msgId: string; chunks: string[]; finished: boolean }
  > = [];
  readonly lateProgressAppends: Array<{ msgId: string; text: string }> = [];
  readonly #queue = new ConversationSendQueue();

  async send(message: RoutedMessage): Promise<void> {
    try {
      await this.#queue.enqueue(message.conversationKey, async () => {
        this.directStarted.resolve();
        await this.directGate.promise;
      });
    } catch {
      // Keep the ChatOutput callback pending after its queue slot is released.
      this.afterShutdownWaiters++;
      await this.afterShutdownGate.promise;
    }
  }

  startProgress(message: RoutedText) {
    const entry = {
      msgId: message.msgId,
      chunks: [] as string[],
      finished: false,
    };
    this.progress.push(entry);
    return Promise.resolve({
      append: (text: string) => {
        if (entry.finished) {
          this.lateProgressAppends.push({ msgId: message.msgId, text });
          return;
        }
        entry.chunks.push(text);
      },
      finish: async () => {
        const attempt = await this.#queue.enqueueCritical(
          message.conversationKey,
          () => {
            entry.finished = true;
            return Promise.resolve();
          },
        );
        if (!attempt.accepted) {
          throw new Error("progress finish was not accepted");
        }
      },
      detach: () => {},
    });
  }

  beginShutdown(): void {
    this.#queue.beginShutdown();
  }
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("condition was not reached");
}

function setup(extraOptions: Record<string, unknown> = {}) {
  const state = new FakeState();
  const codex = new FakeCodex();
  const output = new FakeOutput();
  const requestEvents: RequestStatusEvent[] = [];
  let currentTime = 1_000;
  const orchestrator = new ConversationOrchestrator({
    state,
    codex,
    output,
    workspace: "/workspace",
    onRequestStatus: (event) => requestEvents.push(event),
    now: () => currentTime,
    summarizeRequest: (text) => `summary:${text}`,
    ...extraOptions,
  } as ConversationOrchestratorOptions);
  return {
    state,
    codex,
    output,
    orchestrator,
    requestEvents,
    advanceTime: (milliseconds: number) => currentTime += milliseconds,
  };
}

describe("ConversationOrchestrator", () => {
  it("emits request status events through a completed request", async () => {
    const { advanceTime, codex, orchestrator, requestEvents } = setup();
    const running = orchestrator.handleText(
      message("group:engineering", "m1", "check tests", "bob"),
    );
    await waitFor(() => codex.starts.length === 1);

    advanceTime(25);
    codex.starts[0].resolve({ status: "completed", finalAnswer: "done" });
    await running;

    assertEquals(requestEvents.map(({ state }) => state), [
      "received",
      "queued",
      "thread_starting",
      "thread_started",
      "thread_ready",
      "turn_starting",
      "running",
      "turn_completed",
      "reply_sending",
      "reply_sent",
      "completed",
    ]);
    for (const event of requestEvents) {
      assertEquals(
        {
          chatType: event.chatType,
          chatId: event.chatId,
          userId: event.userId,
          msgId: event.msgId,
        },
        {
          chatType: "group",
          chatId: "engineering",
          userId: "bob",
          msgId: "m1",
        },
      );
      assertEquals(
        event.summary,
        event.state === "received" ? "summary:check tests" : undefined,
      );
    }
    for (
      const state of [
        "thread_started",
        "thread_ready",
      ] as const
    ) {
      assertEquals(
        requestEvents.find((event) => event.state === state)?.threadId,
        "thread-1",
      );
    }
    for (
      const state of [
        "running",
        "turn_completed",
        "reply_sending",
        "reply_sent",
        "completed",
      ] as const
    ) {
      const event = requestEvents.find((candidate) =>
        candidate.state === state
      );
      assertEquals(event?.threadId, "thread-1");
      assertEquals(event?.turnId, "turn-1");
    }
    assertEquals(requestEvents.at(-1)?.elapsedMs, 25);
  });

  it("emits received and duplicate_ignored for duplicate ordinary text", async () => {
    const { codex, orchestrator, requestEvents } = setup();
    const first = orchestrator.handleText(
      message("single:alice", "m1", "work"),
    );
    await waitFor(() => codex.starts.length === 1);
    const duplicateStart = requestEvents.length;

    await orchestrator.handleText(message("single:alice", "m1", "work"));

    assertEquals(
      requestEvents.slice(duplicateStart).map(({ state }) => state),
      ["received", "duplicate_ignored"],
    );
    assertEquals(requestEvents.at(-1)?.elapsedMs, 0);
    codex.starts[0].resolve({ status: "completed", finalAnswer: "done" });
    await first;
  });

  it("terminalizes a runtime-unavailable reply after sending it", async () => {
    const times = [1_000, 975];
    const { codex, orchestrator, requestEvents } = setup({
      now: () => times.shift() ?? 975,
    });
    codex.ready = false;

    await orchestrator.handleText(message("single:alice", "m1", "work"));

    assertEquals(requestEvents.map(({ state }) => state), [
      "received",
      "runtime_unavailable",
      "reply_sending",
      "reply_sent",
      "completed",
    ]);
    assertEquals(requestEvents.at(-1)?.reason, "runtime_unavailable");
    assertEquals(requestEvents.at(-1)?.elapsedMs, 0);
    assertEquals(
      requestEvents.some(({ state }) => state === "failed"),
      false,
    );
  });

  it("excludes commands and unsupported messages but treats unknown commands as requests", async () => {
    const { codex, orchestrator, requestEvents } = setup();

    await orchestrator.handleText(message("single:alice", "help", "/help"));
    await orchestrator.handleText(
      message("single:alice", "status", "/status"),
    );
    await orchestrator.handleText(message("single:alice", "new", "/new"));
    await orchestrator.handleUnsupported(
      message("single:alice", "image", ""),
      "image",
    );
    assertEquals(requestEvents, []);

    const unknown = orchestrator.handleText(
      message("single:alice", "m1", "/unknown"),
    );
    await waitFor(() => codex.starts.length === 1);
    assertEquals(requestEvents[0].state, "received");
    codex.starts[0].resolve({ status: "completed" });
    await unknown;
  });

  it("isolates request status callback failures from errors and draining", async () => {
    const reported: Error[] = [];
    const { codex, orchestrator, output } = setup({
      onError: (error: Error) => reported.push(error),
      onRequestStatus: () => {
        throw new Error("request observer failed");
      },
    });
    const running = orchestrator.handleText(
      message("single:alice", "m1", "work"),
    );
    await waitFor(() => codex.starts.length === 1);

    codex.starts[0].resolve({ status: "completed", finalAnswer: "done" });
    await running;

    assertEquals(output.sent.at(-1)?.text, "done");
    assertEquals(reported, []);
  });

  it("isolates request summarizer failures from errors and draining", async () => {
    const reported: Error[] = [];
    const { codex, orchestrator, output, requestEvents } = setup({
      onError: (error: Error) => reported.push(error),
      summarizeRequest: () => {
        throw new Error("summary failed");
      },
    });
    const running = orchestrator.handleText(
      message("single:alice", "m1", "work"),
    );
    await waitFor(() => codex.starts.length === 1);

    codex.starts[0].resolve({ status: "completed", finalAnswer: "done" });
    await running;

    assertEquals("summary" in requestEvents[0], false);
    assertEquals(requestEvents.at(-1)?.state, "completed");
    assertEquals(output.sent.at(-1)?.text, "done");
    assertEquals(reported, []);
  });

  it("uses the default grapheme-safe request summary only for received", async () => {
    const { codex, orchestrator, requestEvents } = setup({
      summarizeRequest: undefined,
    });
    const running = orchestrator.handleText(
      message("single:alice", "m1", "👩🏽‍💻e\u0301abcdefghij"),
    );
    await waitFor(() => codex.starts.length === 1);
    codex.starts[0].resolve({ status: "completed" });
    await running;

    assertEquals(
      requestEvents.filter((event) => event.summary !== undefined).map(
        ({ state, summary }) => ({ state, summary }),
      ),
      [{ state: "received", summary: "👩🏽‍💻e\u0301abcdefgh…" }],
    );
  });

  it("terminalizes pre-turn work superseded by the latest pending request", async () => {
    const startGate = Promise.withResolvers<void>();
    const { advanceTime, codex, orchestrator, requestEvents } = setup();
    codex.startThreadGates.push(startGate.promise);
    const first = orchestrator.handleText(
      message("single:alice", "m1", "first"),
    );
    await waitFor(() => codex.startThreadAttempts === 1);

    advanceTime(10);
    const second = orchestrator.handleText(
      message("single:alice", "m2", "second"),
    );
    startGate.resolve();
    await waitFor(() => codex.starts.length === 1);
    codex.starts[0].resolve({ status: "completed", finalAnswer: "done" });
    await Promise.all([first, second]);

    const firstEvents = requestEvents.filter(({ msgId }) => msgId === "m1");
    assertEquals(firstEvents.map(({ state }) => state), [
      "received",
      "queued",
      "thread_starting",
      "superseded",
    ]);
    assertEquals(firstEvents.at(-1)?.replacedByMsgId, "m2");
    assertEquals(firstEvents.at(-1)?.elapsedMs, 10);
    assertEquals(
      firstEvents.some((event) =>
        "requestId" in event || "correlationId" in event
      ),
      false,
    );
    assertEquals(
      requestEvents.filter(({ msgId, state }) =>
        msgId === "m2" && state === "queued"
      ).length,
      1,
    );
  });

  it("records one active interruption trigger and the real terminal outcome", async () => {
    const { codex, orchestrator, requestEvents } = setup();
    const first = orchestrator.handleText(
      message("single:alice", "m1", "first"),
    );
    await waitFor(() => codex.starts.length === 1);
    const second = orchestrator.handleText(
      message("single:alice", "m2", "second"),
    );
    await waitFor(() => codex.interrupts.length === 1);

    codex.starts[0].resolve({ status: "interrupted" });
    await waitFor(() => codex.starts.length === 2);
    codex.starts[1].resolve({ status: "completed", finalAnswer: "done" });
    await Promise.all([first, second]);

    const firstEvents = requestEvents.filter(({ msgId }) => msgId === "m1");
    const interruption = firstEvents.filter(({ state }) =>
      state === "interrupt_requested"
    );
    assertEquals(interruption.length, 1);
    assertEquals(interruption[0].triggerMsgId, "m2");
    assertEquals(interruption[0].threadId, "thread-1");
    assertEquals(interruption[0].turnId, "turn-1");
    assertEquals(firstEvents.slice(-3).map(({ state }) => state), [
      "turn_completed",
      "reply_skipped",
      "interrupted",
    ]);
    assertEquals(firstEvents.at(-2)?.reason, "superseded");
  });

  it("terminalizes pre-turn work reset by /new without command identifiers", async () => {
    const startGate = Promise.withResolvers<void>();
    const { codex, orchestrator, requestEvents } = setup();
    codex.startThreadGates.push(startGate.promise);
    const first = orchestrator.handleText(
      message("single:alice", "m1", "work"),
    );
    await waitFor(() => codex.startThreadAttempts === 1);
    const resetting = orchestrator.handleText(
      message("single:alice", "reset-command", "/new"),
    );

    startGate.resolve();
    await Promise.all([first, resetting]);

    assertEquals(
      requestEvents.filter(({ msgId }) => msgId === "reset-command"),
      [],
    );
    const terminal = requestEvents.find(({ state }) => state === "superseded");
    assertEquals(terminal?.msgId, "m1");
    assertEquals(terminal?.reason, "reset");
    assertEquals(terminal?.replacedByMsgId, undefined);
    assertEquals(terminal?.triggerMsgId, undefined);
  });

  it("terminalizes pending work discarded during shutdown", async () => {
    const { codex, orchestrator, requestEvents } = setup();
    const first = orchestrator.handleText(
      message("single:alice", "m1", "first"),
    );
    await waitFor(() => codex.starts.length === 1);
    const second = orchestrator.handleText(
      message("single:alice", "m2", "second"),
    );
    await waitFor(() => codex.interrupts.length === 1);

    const stopping = orchestrator.interruptAll();
    codex.starts[0].resolve({ status: "interrupted" });
    await Promise.all([first, second, stopping]);

    const terminal = requestEvents.find(({ msgId, state }) =>
      msgId === "m2" && state === "shutdown_discarded"
    );
    assertEquals(terminal?.reason, "shutdown");
    assertEquals(
      requestEvents.filter(({ msgId, state }) =>
        msgId === "m2" && [
          "completed",
          "failed",
          "interrupted",
          "runtime_lost",
        ].includes(state)
      ),
      [],
    );
  });

  it("reports active and pending counts across all conversation slots", async () => {
    const { codex, orchestrator, requestEvents } = setup();
    const first = orchestrator.handleText(
      message("single:alice", "m1", "one"),
    );
    const second = orchestrator.handleText(
      message("group:room", "m2", "two", "bob"),
    );
    await waitFor(() => codex.starts.length === 2);
    const pending = orchestrator.handleText(
      message("single:alice", "m3", "three"),
    );
    await waitFor(() => codex.interrupts.length === 1);

    codex.starts[0].resolve({ status: "interrupted" });
    codex.starts[1].resolve({ status: "completed", finalAnswer: "two done" });
    await waitFor(() => codex.starts.length === 3);
    codex.starts[2].resolve({ status: "completed", finalAnswer: "three done" });
    await Promise.all([first, second, pending]);

    const secondRunning = requestEvents.find(({ msgId, state }) =>
      msgId === "m2" && state === "running"
    );
    const pendingQueued = requestEvents.find(({ msgId, state }) =>
      msgId === "m3" && state === "queued"
    );
    assertEquals(secondRunning?.activeCount, 2);
    assertEquals(secondRunning?.pendingCount, 0);
    assertEquals(pendingQueued?.activeCount, 2);
    assertEquals(pendingQueued?.pendingCount, 1);
  });

  it("counts non-terminal pre-turn work as active across conversations", async () => {
    const firstGate = Promise.withResolvers<void>();
    const secondGate = Promise.withResolvers<void>();
    const { codex, orchestrator, requestEvents } = setup();
    codex.startThreadGates.push(firstGate.promise, secondGate.promise);

    const first = orchestrator.handleText(
      message("single:alice", "m1", "one"),
    );
    await waitFor(() => codex.startThreadAttempts === 1);
    const second = orchestrator.handleText(
      message("group:room", "m2", "two", "bob"),
    );
    await waitFor(() => codex.startThreadAttempts === 2);

    const firstStarting = requestEvents.find(({ msgId, state }) =>
      msgId === "m1" && state === "thread_starting"
    );
    const secondReceived = requestEvents.find(({ msgId, state }) =>
      msgId === "m2" && state === "received"
    );
    const secondStarting = requestEvents.find(({ msgId, state }) =>
      msgId === "m2" && state === "thread_starting"
    );
    assertEquals(
      [firstStarting?.activeCount, firstStarting?.pendingCount],
      [1, 0],
    );
    assertEquals(
      [secondReceived?.activeCount, secondReceived?.pendingCount],
      [1, 0],
    );
    assertEquals(
      [secondStarting?.activeCount, secondStarting?.pendingCount],
      [2, 0],
    );

    firstGate.resolve();
    secondGate.resolve();
    await waitFor(() => codex.starts.length === 2);
    for (const started of codex.starts) {
      started.resolve({ status: "completed" });
    }
    await Promise.all([first, second]);
  });

  it("emits resume boundaries for a persisted thread", async () => {
    const { codex, orchestrator, requestEvents, state } = setup();
    state.bindConversation("single:alice", "single", "thread-existing");
    const running = orchestrator.handleText(
      message("single:alice", "m1", "work"),
    );
    await waitFor(() => codex.starts.length === 1);
    codex.starts[0].resolve({ status: "completed", finalAnswer: "done" });
    await running;

    assertEquals(requestEvents.slice(2, 5).map(({ state }) => state), [
      "thread_resuming",
      "thread_resumed",
      "thread_ready",
    ]);
    for (const state of ["thread_resuming", "thread_resumed"] as const) {
      assertEquals(
        requestEvents.find((event) => event.state === state)?.threadId,
        "thread-existing",
      );
    }
  });

  it("emits a reply boundary then failed when startThread fails", async () => {
    const { codex, orchestrator, requestEvents } = setup();
    codex.startThreadErrors.push(new Error("startThread failed"));

    await orchestrator.handleText(message("single:alice", "m1", "work"));

    assertEquals(requestEvents.map(({ state }) => state), [
      "received",
      "queued",
      "thread_starting",
      "reply_sending",
      "reply_sent",
      "failed",
    ]);
    assertEquals(requestEvents.at(-1)?.error, "startThread failed");
    assertEquals(requestEvents.at(-1)?.threadId, undefined);
    assertEquals(requestEvents.at(-1)?.turnId, undefined);
    assertEquals(requestEvents.at(-1)?.activeCount, 0);
  });

  it("emits a reply boundary then failed when resumeThread fails", async () => {
    const { codex, orchestrator, requestEvents, state } = setup();
    state.bindConversation("single:alice", "single", "thread-existing");
    codex.resumeThreadErrors.push(new Error("resumeThread failed"));

    await orchestrator.handleText(message("single:alice", "m1", "work"));

    assertEquals(requestEvents.map(({ state }) => state), [
      "received",
      "queued",
      "thread_resuming",
      "reply_sending",
      "reply_sent",
      "failed",
    ]);
    assertEquals(requestEvents.at(-1)?.error, "resumeThread failed");
    assertEquals(requestEvents.at(-1)?.threadId, "thread-existing");
    assertEquals(requestEvents.at(-1)?.turnId, undefined);
  });

  it("emits a reply boundary then failed when startTurn fails", async () => {
    const { codex, orchestrator, requestEvents } = setup();
    codex.startTurnErrors.push(new Error("startTurn failed"));

    await orchestrator.handleText(message("single:alice", "m1", "work"));

    assertEquals(requestEvents.slice(-4).map(({ state }) => state), [
      "turn_starting",
      "reply_sending",
      "reply_sent",
      "failed",
    ]);
    assertEquals(requestEvents.at(-1)?.error, "startTurn failed");
    assertEquals(requestEvents.at(-1)?.threadId, "thread-1");
    assertEquals(requestEvents.at(-1)?.turnId, undefined);
  });

  it("skips a missing completed answer before the terminal state", async () => {
    const { codex, orchestrator, requestEvents } = setup();
    const running = orchestrator.handleText(
      message("single:alice", "m1", "work"),
    );
    await waitFor(() => codex.starts.length === 1);
    codex.starts[0].resolve({ status: "completed" });
    await running;

    assertEquals(requestEvents.slice(-3).map(({ state }) => state), [
      "turn_completed",
      "reply_skipped",
      "completed",
    ]);
    assertEquals(requestEvents.at(-2)?.reason, "no_final_answer");
  });

  it("terminalizes runtime_lost after the skipped reply boundary", async () => {
    const { codex, orchestrator, requestEvents } = setup();
    const running = orchestrator.handleText(
      message("single:alice", "m1", "work"),
    );
    await waitFor(() => codex.starts.length === 1);
    codex.starts[0].resolve({
      status: "runtime_lost",
      error: "runtime exited",
    });
    await running;

    assertEquals(requestEvents.slice(-3).map(({ state }) => state), [
      "turn_completed",
      "reply_skipped",
      "runtime_lost",
    ]);
    assertEquals(requestEvents.at(-1)?.error, "runtime exited");
  });

  it("does not convert Codex activity into request states", async () => {
    const { codex, orchestrator, requestEvents } = setup();
    const running = orchestrator.handleText(
      message("single:alice", "m1", "work"),
    );
    await waitFor(() => codex.starts.length === 1);
    const statesBeforeActivity = requestEvents.map(({ state }) => state);

    await codex.starts[0].onActivity({
      tag: "CONTENT",
      body: "progress",
      delivery: "progress",
    });
    assertEquals(requestEvents.map(({ state }) => state), statesBeforeActivity);

    codex.starts[0].resolve({ status: "completed" });
    await running;
  });

  it("emits one logical interruption across retries and preserves the first trigger", async () => {
    const { codex, orchestrator, requestEvents } = setup({
      interruptRetryDelaysMs: [0],
    });
    codex.interruptErrors.push(new Error("temporary interrupt failure"));
    const first = orchestrator.handleText(
      message("single:alice", "m1", "first"),
    );
    await waitFor(() => codex.starts.length === 1);
    const second = orchestrator.handleText(
      message("single:alice", "m2", "second"),
    );
    const third = orchestrator.handleText(
      message("single:alice", "m3", "third"),
    );
    await waitFor(() => codex.interrupts.length === 2);

    codex.starts[0].resolve({ status: "interrupted" });
    await waitFor(() => codex.starts.length === 2);
    codex.starts[1].resolve({ status: "completed", finalAnswer: "done" });
    await Promise.all([first, second, third]);

    const interruption = requestEvents.filter(({ msgId, state }) =>
      msgId === "m1" && state === "interrupt_requested"
    );
    assertEquals(interruption.length, 1);
    assertEquals(interruption[0].triggerMsgId, "m2");
  });

  it("does not retry an interrupt after the turn enters reply phase", async () => {
    const interruptGate = Promise.withResolvers<void>();
    const output = new PendingProgressFinishOutput();
    const { codex, orchestrator, requestEvents } = setup({
      output,
      interruptRetryDelaysMs: [0],
    });
    codex.interruptGates.push(interruptGate.promise);
    const first = orchestrator.handleText(
      message("single:alice", "m1", "first"),
    );
    await waitFor(() => codex.starts.length === 1);
    const second = orchestrator.handleText(
      message("single:alice", "m2", "second"),
    );
    await waitFor(() => codex.interrupts.length === 1);

    codex.starts[0].resolve({ status: "completed", finalAnswer: "first done" });
    await output.finishStarted.promise;

    const retryScheduled = Promise.withResolvers<() => void>();
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((callback: () => void) => {
      retryScheduled.resolve(callback);
      return 0;
    }) as unknown as typeof setTimeout;
    let runRetry: (() => void) | undefined;
    try {
      interruptGate.reject(new Error("interrupt failed after completion"));
      runRetry = await Promise.race([
        retryScheduled.promise,
        new Promise<undefined>((resolve) => {
          originalSetTimeout(() => resolve(undefined), 0);
        }),
      ]);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
    runRetry?.();
    const interruptCallsAfterRetry = codex.interrupts.length;

    output.finishGate.resolve();
    await waitFor(() => codex.starts.length === 2);
    codex.starts[1].resolve({ status: "completed" });
    await Promise.all([first, second]);

    assertEquals(interruptCallsAfterRetry, 1);
    assertEquals(runRetry, undefined);
    assertEquals(
      requestEvents.filter(({ msgId, state }) =>
        msgId === "m1" && state === "interrupt_requested"
      ).length,
      1,
    );
    assertEquals(
      output.progress[0].chunks.some((chunk) =>
        chunk.includes("interrupt failed")
      ),
      false,
    );
  });

  it("does not run a scheduled interrupt retry after entering reply phase", async () => {
    const interruptGate = Promise.withResolvers<void>();
    const output = new PendingProgressFinishOutput();
    const { codex, orchestrator, requestEvents } = setup({
      output,
      interruptRetryDelaysMs: [0],
    });
    codex.interruptGates.push(interruptGate.promise);
    const first = orchestrator.handleText(
      message("single:alice", "m1", "first"),
    );
    await waitFor(() => codex.starts.length === 1);
    const second = orchestrator.handleText(
      message("single:alice", "m2", "second"),
    );
    await waitFor(() => codex.interrupts.length === 1);

    const retryScheduled = Promise.withResolvers<() => void>();
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((callback: () => void) => {
      retryScheduled.resolve(callback);
      return 0;
    }) as unknown as typeof setTimeout;
    let runRetry: () => void;
    try {
      interruptGate.reject(new Error("interrupt failed during turn"));
      runRetry = await retryScheduled.promise;
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
    assertEquals(typeof runRetry, "function");
    assertEquals(codex.interrupts.length, 1);

    codex.starts[0].resolve({ status: "completed", finalAnswer: "first done" });
    await output.finishStarted.promise;
    const eventsBeforeRetry = requestEvents.filter(({ msgId }) =>
      msgId === "m1"
    );
    const progressBeforeRetry = [...output.progress[0].chunks];

    runRetry();
    const interruptCallsAfterRetry = codex.interrupts.length;
    const eventsAfterRetry = requestEvents.filter(({ msgId }) =>
      msgId === "m1"
    );
    const progressAfterRetry = [...output.progress[0].chunks];

    output.finishGate.resolve();
    await waitFor(() => codex.starts.length === 2);
    codex.starts[1].resolve({ status: "completed" });
    await Promise.all([first, second]);

    assertEquals(interruptCallsAfterRetry, 1);
    assertEquals(eventsAfterRetry, eventsBeforeRetry);
    assertEquals(progressAfterRetry, progressBeforeRetry);
    assertEquals(
      eventsAfterRetry.filter(({ state }) => state === "interrupt_requested")
        .length,
      1,
    );
  });

  it("terminalizes a runtime-unavailable reply send failure", async () => {
    const { codex, orchestrator, output, requestEvents } = setup();
    codex.ready = false;
    output.sendErrors.push(new Error("reply failed"));

    const result = await orchestrator.handleText(
      message("single:alice", "m1", "work"),
    ).then(() => null, (error) => error);

    assertMatch(String(result), /reply failed/);
    assertEquals(requestEvents.map(({ state }) => state), [
      "received",
      "runtime_unavailable",
      "reply_sending",
      "failed",
    ]);
    assertEquals(requestEvents.at(-1)?.error, "reply failed");
  });

  it("terminalizes a final reply send failure without a fallback reply", async () => {
    const { codex, orchestrator, output, requestEvents } = setup();
    const running = orchestrator.handleText(
      message("single:alice", "m1", "work"),
    );
    await waitFor(() => codex.starts.length === 1);
    output.sendErrors.push(new Error("final reply failed"));
    codex.starts[0].resolve({ status: "completed", finalAnswer: "done" });
    await running;

    assertEquals(requestEvents.slice(-3).map(({ state }) => state), [
      "turn_completed",
      "reply_sending",
      "failed",
    ]);
    assertEquals(requestEvents.at(-1)?.error, "final reply failed");
    assertEquals(output.sent, [{ msgId: "m1", text: "done", final: true }]);
  });

  it("keeps an in-flight final reply terminally accurate when newer work arrives", async () => {
    const output = new PendingFinalOutput();
    const { codex, orchestrator, requestEvents } = setup({ output });
    const first = orchestrator.handleText(
      message("single:alice", "m1", "first"),
    );
    await waitFor(() => codex.starts.length === 1);
    codex.starts[0].resolve({ status: "completed", finalAnswer: "first done" });
    await output.finalStarted.promise;

    const second = orchestrator.handleText(
      message("single:alice", "m2", "second"),
    );
    output.finalGate.resolve();
    await waitFor(() => codex.starts.length === 2);
    codex.starts[1].resolve({ status: "completed" });
    await Promise.all([first, second]);

    const firstEvents = requestEvents.filter(({ msgId }) => msgId === "m1");
    assertEquals(firstEvents.slice(-4).map(({ state }) => state), [
      "turn_completed",
      "reply_sending",
      "reply_sent",
      "completed",
    ]);
    assertEquals(codex.interrupts, []);
  });

  it("records a sent reply when send settles before shutdown force", async () => {
    const output = new FinalSendThenHookOutput();
    const { codex, orchestrator, requestEvents } = setup({
      output,
      shutdownGraceMs: 0,
    });
    const running = orchestrator.handleText(
      message("single:alice", "m1", "work"),
    );
    await waitFor(() => codex.starts.length === 1);

    let stopping: Promise<void> | undefined;
    output.onFinalThen = () => {
      // Settle send first, then force shutdown before its await resumes.
      const originalSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = ((callback: () => void) => {
        queueMicrotask(callback);
        return 0;
      }) as unknown as typeof setTimeout;
      try {
        stopping = orchestrator.interruptAll();
      } finally {
        globalThis.setTimeout = originalSetTimeout;
      }
    };
    codex.starts[0].resolve({ status: "completed", finalAnswer: "done" });
    await running;
    if (!stopping) throw new Error("final send hook did not run");
    await stopping;

    assertEquals(requestEvents.slice(-4).map(({ state }) => state), [
      "turn_completed",
      "reply_sending",
      "reply_sent",
      "completed",
    ]);
  });

  it("finishes the completed reply before starting work queued during progress finish", async () => {
    const output = new PendingProgressFinishOutput();
    const { codex, orchestrator, requestEvents } = setup({ output });
    const first = orchestrator.handleText(
      message("single:alice", "m1", "first"),
    );
    await waitFor(() => codex.starts.length === 1);
    codex.starts[0].resolve({ status: "completed", finalAnswer: "first done" });
    await output.finishStarted.promise;

    const second = orchestrator.handleText(
      message("single:alice", "m2", "second"),
    );
    output.finishGate.resolve();
    await waitFor(() => codex.starts.length === 2);
    codex.starts[1].resolve({ status: "completed" });
    await Promise.all([first, second]);

    const firstEvents = requestEvents.filter(({ msgId }) => msgId === "m1");
    assertEquals(firstEvents.slice(-4).map(({ state }) => state), [
      "turn_completed",
      "reply_sending",
      "reply_sent",
      "completed",
    ]);
    assertEquals(codex.interrupts, []);
  });

  it("queues new work while a start failure reply is pending", async () => {
    const output = new PendingFinalOutput();
    const { codex, orchestrator, requestEvents } = setup({ output });
    codex.startThreadErrors.push(new Error("startThread failed"));
    const first = orchestrator.handleText(
      message("single:alice", "m1", "first"),
    );
    await output.finalStarted.promise;

    const second = orchestrator.handleText(
      message("single:alice", "m2", "second"),
    );
    output.finalGate.resolve();
    await waitFor(() => codex.starts.length === 1);
    codex.starts[0].resolve({ status: "completed" });
    await Promise.all([first, second]);

    const firstEvents = requestEvents.filter(({ msgId }) => msgId === "m1");
    assertEquals(firstEvents.slice(-4).map(({ state }) => state), [
      "thread_starting",
      "reply_sending",
      "reply_sent",
      "failed",
    ]);
  });

  it("does not interrupt a failed startTurn while its progress is finishing", async () => {
    const output = new PendingProgressFinishOutput();
    const { codex, orchestrator, requestEvents } = setup({ output });
    codex.startTurnErrors.push(new Error("startTurn failed"));
    const first = orchestrator.handleText(
      message("single:alice", "m1", "first"),
    );
    await output.finishStarted.promise;

    const second = orchestrator.handleText(
      message("single:alice", "m2", "second"),
    );
    output.finishGate.resolve();
    await waitFor(() => codex.starts.length === 1);
    codex.starts[0].resolve({ status: "completed" });
    await Promise.all([first, second]);

    const firstEvents = requestEvents.filter(({ msgId }) => msgId === "m1");
    assertEquals(
      firstEvents.some(({ state }) => state === "interrupt_requested"),
      false,
    );
    assertEquals(firstEvents.slice(-4).map(({ state }) => state), [
      "turn_starting",
      "reply_sending",
      "reply_sent",
      "failed",
    ]);
  });

  it("keeps a forced final reply terminal and ignores its late rejection", async () => {
    const output = new PendingFinalOutput();
    const { codex, orchestrator, requestEvents } = setup({
      output,
      shutdownGraceMs: 1,
    });
    const running = orchestrator.handleText(
      message("single:alice", "m1", "work"),
    );
    await waitFor(() => codex.starts.length === 1);
    codex.starts[0].resolve({ status: "completed", finalAnswer: "done" });
    await output.finalStarted.promise;

    await Promise.all([running, orchestrator.interruptAll()]);
    const terminalEvents = [...requestEvents];
    assertEquals(terminalEvents.slice(-4).map(({ state }) => state), [
      "turn_completed",
      "reply_sending",
      "reply_skipped",
      "completed",
    ]);
    assertEquals(terminalEvents.at(-2)?.reason, "shutdown");

    output.finalGate.reject(new Error("late final reply failure"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(requestEvents, terminalEvents);
  });

  it("discards ordinary text received after shutdown starts", async () => {
    const { orchestrator, requestEvents } = setup();
    await orchestrator.interruptAll();

    await orchestrator.handleText(message("single:alice", "m1", "work"));

    assertEquals(requestEvents.map(({ state }) => state), [
      "received",
      "shutdown_discarded",
    ]);
    assertEquals(requestEvents.at(-1)?.reason, "shutdown");
  });

  it("discards pre-turn work on shutdown without logging a late thread ID", async () => {
    const startGate = Promise.withResolvers<void>();
    const { codex, orchestrator, requestEvents } = setup({
      shutdownGraceMs: 1,
    });
    codex.startThreadGates.push(startGate.promise);
    const running = orchestrator.handleText(
      message("single:alice", "m1", "work"),
    );
    await waitFor(() => codex.startThreadAttempts === 1);

    await orchestrator.interruptAll();
    await running;
    const terminalEvents = [...requestEvents];
    startGate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    assertEquals(terminalEvents.map(({ state }) => state), [
      "received",
      "queued",
      "thread_starting",
      "shutdown_discarded",
    ]);
    assertEquals(terminalEvents.at(-1)?.threadId, undefined);
    assertEquals(requestEvents, terminalEvents);
  });

  it("terminalizes a forced turn start without backfilling its late turn ID", async () => {
    const startGate = Promise.withResolvers<void>();
    const { codex, orchestrator, requestEvents } = setup({
      shutdownGraceMs: 1,
    });
    codex.startTurnGates.push(startGate.promise);
    const running = orchestrator.handleText(
      message("single:alice", "m1", "work"),
    );
    await waitFor(() => codex.startTurnAttempts === 1);

    await orchestrator.interruptAll();
    await running;
    const eventsAtTerminal = [...requestEvents];
    startGate.resolve();
    await waitFor(() => codex.starts.length === 1);
    await waitFor(() => codex.interrupts.length === 1);
    codex.starts[0].resolve({ status: "interrupted" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assertEquals(eventsAtTerminal.slice(-3).map(({ state }) => state), [
      "interrupt_requested",
      "reply_skipped",
      "runtime_lost",
    ]);
    assertEquals(eventsAtTerminal.at(-1)?.threadId, "thread-1");
    assertEquals(eventsAtTerminal.at(-1)?.turnId, undefined);
    assertEquals(requestEvents, eventsAtTerminal);
  });

  it("records turn completion before reporting beginTurn persistence failure", async () => {
    const { codex, orchestrator, requestEvents, state } = setup();
    state.failNextBegin = true;
    const running = orchestrator.handleText(
      message("single:alice", "m1", "work"),
    );
    await waitFor(() => codex.starts.length === 1);
    await waitFor(() => codex.interrupts.length === 1);
    codex.starts[0].resolve({ status: "interrupted" });
    await running;

    assertEquals(requestEvents.slice(-5).map(({ state }) => state), [
      "interrupt_requested",
      "turn_completed",
      "reply_sending",
      "reply_sent",
      "failed",
    ]);
    assertEquals(requestEvents.at(-1)?.error, "beginTurn failed");
  });

  it("does not backfill turnId on an interruption emitted before startTurn returns", async () => {
    const startGate = Promise.withResolvers<void>();
    const { codex, orchestrator, requestEvents } = setup();
    codex.startTurnGates.push(startGate.promise);
    const first = orchestrator.handleText(
      message("single:alice", "m1", "first"),
    );
    await waitFor(() => codex.startTurnAttempts === 1);
    const second = orchestrator.handleText(
      message("single:alice", "m2", "second"),
    );

    startGate.resolve();
    await waitFor(() => codex.starts.length === 1);
    await waitFor(() => codex.interrupts.length === 1);
    codex.starts[0].resolve({ status: "interrupted" });
    await waitFor(() => codex.starts.length === 2);
    codex.starts[1].resolve({ status: "completed", finalAnswer: "done" });
    await Promise.all([first, second]);

    const interruption = requestEvents.filter(({ msgId, state }) =>
      msgId === "m1" && state === "interrupt_requested"
    );
    assertEquals(interruption.length, 1);
    assertEquals(interruption[0].threadId, "thread-1");
    assertEquals(interruption[0].turnId, undefined);
    assertEquals(interruption[0].triggerMsgId, "m2");
  });

  it("does not start terminalized pre-turn work after progress setup settles", async () => {
    const progressGate = Promise.withResolvers<void>();
    const { codex, orchestrator, output } = setup();
    output.startProgressGates.push(progressGate.promise);
    const first = orchestrator.handleText(
      message("single:alice", "m1", "first"),
    );
    await waitFor(() => output.startProgressAttempts === 1);
    const second = orchestrator.handleText(
      message("single:alice", "m2", "second"),
    );

    progressGate.resolve();
    await waitFor(() => codex.starts.length === 1);
    const startedSupersededWork = codex.starts[0].prompt.includes("msgid: m1");
    if (startedSupersededWork) {
      codex.starts[0].resolve({ status: "interrupted" });
      await waitFor(() => codex.starts.length === 2);
      codex.starts[1].resolve({ status: "completed", finalAnswer: "done" });
    } else {
      codex.starts[0].resolve({ status: "completed", finalAnswer: "done" });
    }
    await Promise.all([first, second]);

    assertEquals(startedSupersededWork, false);
    assertEquals(codex.starts.length, 1);
    assertMatch(codex.starts[0].prompt, /msgid: m2/);
  });

  it("binds a conversation and includes the actual sender in every turn", async () => {
    const { codex, orchestrator, state, output } = setup();
    const running = orchestrator.handleText(
      message("group:engineering", "m1", "检查测试", "bob"),
    );
    await waitFor(() => codex.starts.length === 1);

    assertEquals(codex.starts[0].threadId, "thread-1");
    assertMatch(codex.starts[0].prompt, /sender_userid: bob/);
    assertMatch(codex.starts[0].prompt, /conversation_key: group:engineering/);
    await codex.starts[0].onActivity({
      tag: "CONTENT",
      body: "正在检查",
      delivery: "progress",
    });
    codex.starts[0].resolve({ status: "completed", finalAnswer: "测试正常" });
    await running;

    assertEquals(
      state.getConversation("group:engineering")?.threadId,
      "thread-1",
    );
    assertEquals(output.progress[0].chunks, [
      "[queue] 已提交给 Codex",
      "\n",
      "[turn] started",
      "\n",
      "[content] 正在检查",
      "\n",
      "[turn] completed",
    ]);
    assertEquals(output.sent.at(-1), {
      msgId: "m1",
      text: "测试正常",
      final: true,
    });
  });

  it("separates consecutive progress events in the final stream text", async () => {
    const state = new FakeState();
    const codex = new FakeCodex();
    const streams: Array<{ content: string; finish: boolean }> = [];
    const output = new WeComChatOutput({
      secrets: [],
      gateway: {
        reply: () => Promise.resolve(true),
        replyStream: (_frame, _streamId, content, finish = false) => {
          streams.push({ content, finish });
          return Promise.resolve(true);
        },
      },
    });
    const orchestrator = new ConversationOrchestrator({
      state,
      codex,
      output,
      workspace: "/workspace",
    });
    const running = orchestrator.handleText(
      message("single:alice", "m1", "work"),
    );
    await waitFor(() => codex.starts.length === 1);

    await codex.starts[0].onActivity({
      tag: "CONTENT",
      body: "first line\n",
      delivery: "progress",
    });
    await codex.starts[0].onActivity({
      tag: "CONTENT",
      body: "second line",
      delivery: "progress",
    });
    codex.starts[0].resolve({ status: "completed" });
    await running;

    assertEquals(streams, [{
      content: [
        "[queue] 已提交给 Codex",
        "[turn] started",
        "[content] first line",
        "[content] second line",
        "[turn] completed",
      ].join("\n"),
      finish: true,
    }]);
  });

  it("routes direct user input and final answers when every output level is off", async () => {
    const { codex, orchestrator, output } = setup({
      outputSettings: outputSettings("off"),
    });
    const running = orchestrator.handleText(
      message("single:alice", "m1", "work"),
    );
    await waitFor(() => codex.starts.length === 1);

    await codex.starts[0].onActivity({
      tag: "CONTENT",
      body: "Codex 需要用户输入\n\n请补充范围。",
      delivery: "direct",
    });
    await waitFor(() => output.sent.length === 1);
    codex.starts[0].resolve({ status: "completed", finalAnswer: "final" });
    await running;

    assertEquals(output.progress[0].chunks, []);
    assertEquals(output.sent, [
      {
        msgId: "m1",
        text: "Codex 需要用户输入\n\n请补充范围。",
        final: false,
      },
      { msgId: "m1", text: "final", final: true },
    ]);
  });

  it("keeps help, status, unsupported notices, and start failures direct when levels are off", async () => {
    const { codex, orchestrator, output } = setup({
      outputSettings: outputSettings("off"),
    });
    codex.startTurnErrors.push(new Error("start failed"));

    await orchestrator.handleText(message("single:alice", "help", "/help"));
    await orchestrator.handleText(message("single:alice", "status", "/status"));
    await orchestrator.handleUnsupported(
      message("single:alice", "image", ""),
      "image",
    );
    await orchestrator.handleText(message("single:alice", "work", "work"));

    assertEquals(output.progress[0].chunks, []);
    assertMatch(
      output.sent.find((entry) => entry.msgId === "help")!.text,
      /\/new/,
    );
    assertMatch(
      output.sent.find((entry) => entry.msgId === "status")!.text,
      /idle/,
    );
    assertMatch(
      output.sent.find((entry) => entry.msgId === "image")!.text,
      /暂不支持/,
    );
    assertMatch(
      output.sent.find((entry) => entry.msgId === "work")!.text,
      /任务启动失败：start failed/,
    );
  });

  it("interrupts an active turn and only runs the latest pending message", async () => {
    const { codex, orchestrator } = setup();
    const first = orchestrator.handleText(
      message("single:alice", "m1", "first"),
    );
    await waitFor(() => codex.starts.length === 1);

    const second = orchestrator.handleText(
      message("single:alice", "m2", "second"),
    );
    const third = orchestrator.handleText(
      message("single:alice", "m3", "third"),
    );
    await waitFor(() => codex.interrupts.length === 1);
    assertEquals(codex.interrupts, [{
      threadId: "thread-1",
      turnId: "turn-1",
    }]);

    codex.starts[0].resolve({ status: "interrupted" });
    await waitFor(() => codex.starts.length === 2);
    assertMatch(codex.starts[1].prompt, /msgid: m3/);
    assertEquals(codex.starts[1].prompt.includes("msgid: m2"), false);

    codex.starts[1].resolve({ status: "completed", finalAnswer: "third done" });
    await Promise.all([first, second, third]);
  });

  it("retries a failed interrupt while a newer message is pending", async () => {
    const { codex, orchestrator } = setup({
      interruptRetryDelaysMs: [0],
    });
    codex.interruptErrors.push(new Error("temporary interrupt failure"));
    const first = orchestrator.handleText(
      message("single:alice", "m1", "first"),
    );
    await waitFor(() => codex.starts.length === 1);

    const second = orchestrator.handleText(
      message("single:alice", "m2", "second"),
    );
    await waitFor(() => codex.interrupts.length === 2);
    assertEquals(codex.interrupts, [
      { threadId: "thread-1", turnId: "turn-1" },
      { threadId: "thread-1", turnId: "turn-1" },
    ]);

    codex.starts[0].resolve({ status: "interrupted" });
    await waitFor(() => codex.starts.length === 2);
    codex.starts[1].resolve({ status: "completed", finalAnswer: "done" });
    await Promise.all([first, second]);
  });

  it("runs different conversations concurrently", async () => {
    const { codex, orchestrator } = setup();
    const single = orchestrator.handleText(
      message("single:alice", "m1", "one"),
    );
    const group = orchestrator.handleText(
      message("group:g1", "m2", "two", "bob"),
    );
    await waitFor(() => codex.starts.length === 2);

    assertEquals(new Set(codex.starts.map((turn) => turn.threadId)).size, 2);
    codex.starts.forEach((turn) =>
      turn.resolve({ status: "completed", finalAnswer: "done" })
    );
    await Promise.all([single, group]);
  });

  it("resumes a persisted thread again after the App Server generation changes", async () => {
    const { codex, orchestrator, state } = setup();
    state.bindConversation("single:alice", "single", "thread-existing");

    const first = orchestrator.handleText(message("single:alice", "m1", "one"));
    await waitFor(() => codex.starts.length === 1);
    codex.starts[0].resolve({ status: "completed", finalAnswer: "done" });
    await first;
    assertEquals(codex.resumed, ["thread-existing"]);

    codex.generation = 2;
    const second = orchestrator.handleText(
      message("single:alice", "m2", "two"),
    );
    await waitFor(() => codex.starts.length === 2);
    codex.starts[1].resolve({ status: "completed", finalAnswer: "done" });
    await second;

    assertEquals(codex.resumed, ["thread-existing", "thread-existing"]);
  });

  it("deduplicates msgid before invoking Codex", async () => {
    const { codex, orchestrator } = setup();
    const first = orchestrator.handleText(
      message("single:alice", "same", "one"),
    );
    await waitFor(() => codex.starts.length === 1);
    await orchestrator.handleText(message("single:alice", "same", "one"));
    assertEquals(codex.starts.length, 1);
    codex.starts[0].resolve({ status: "completed", finalAnswer: "done" });
    await first;
  });

  it("deduplicates unsupported messages and replies through ChatOutput", async () => {
    const { codex, orchestrator, output } = setup();
    const image = message("group:room-1", "image-1", "", "alice");

    await orchestrator.handleUnsupported(image, "image");
    await orchestrator.handleUnsupported(image, "image");

    assertEquals(codex.starts.length, 0);
    assertEquals(output.sent.length, 1);
    assertMatch(output.sent[0].text, /暂不支持.*image/);
  });

  it("handles help and status without interrupting the active turn", async () => {
    const { codex, orchestrator, output } = setup();
    const running = orchestrator.handleText(
      message("single:alice", "m1", "work"),
    );
    await waitFor(() => codex.starts.length === 1);

    await orchestrator.handleText(message("single:alice", "m2", "/help"));
    await orchestrator.handleText(message("single:alice", "m3", "/status"));
    assertEquals(codex.interrupts.length, 0);
    assertMatch(
      output.sent.find((entry) => entry.msgId === "m2")!.text,
      /\/new/,
    );
    assertMatch(
      output.sent.find((entry) => entry.msgId === "m3")!.text,
      /in_progress/,
    );

    codex.starts[0].resolve({ status: "completed", finalAnswer: "done" });
    await running;
  });

  it("queues /new behind an interrupted turn and replaces its thread binding", async () => {
    const { codex, orchestrator, state } = setup();
    const running = orchestrator.handleText(
      message("single:alice", "m1", "work"),
    );
    await waitFor(() => codex.starts.length === 1);

    const resetting = orchestrator.handleText(
      message("single:alice", "m2", "/new"),
    );
    await waitFor(() => codex.interrupts.length === 1);
    codex.starts[0].resolve({ status: "interrupted" });
    await Promise.all([running, resetting]);

    assertEquals(state.getConversation("single:alice")?.threadId, "thread-2");
    assertEquals(codex.starts.length, 1);
  });

  it("continues draining pending work when /new replies cannot be sent", async () => {
    const { codex, orchestrator, output } = setup();
    output.sendErrors.push(
      new Error("reset acknowledgement failed"),
      new Error("reset failure notification failed"),
    );

    const resetResult = orchestrator.handleText(
      message("single:alice", "m1", "/new"),
    ).then(() => null, (error) => error);
    const pendingResult = orchestrator.handleText(
      message("single:alice", "m2", "work"),
    ).then(() => null, (error) => error);

    await waitFor(() => codex.starts.length === 1);
    assertMatch(codex.starts[0].prompt, /msgid: m2/);
    codex.starts[0].resolve({ status: "completed", finalAnswer: "done" });
    assertEquals(await Promise.all([resetResult, pendingResult]), [null, null]);
  });

  it("does not report a bound /new thread as failed when its acknowledgement fails", async () => {
    const { orchestrator, output, state } = setup();
    output.sendErrors.push(new Error("reset acknowledgement failed"));

    await orchestrator.handleText(
      message("single:alice", "m1", "/new"),
    );

    assertEquals(state.getConversation("single:alice")?.threadId, "thread-1");
    assertEquals(output.sent.length, 1);
    assertMatch(output.sent[0].text, /已新建 Codex 会话/);
  });

  it("waits for interrupted turns to reach terminal state during shutdown", async () => {
    const { codex, orchestrator } = setup();
    const running = orchestrator.handleText(
      message("single:alice", "m1", "work"),
    );
    await waitFor(() => codex.starts.length === 1);

    let stopped = false;
    const stopping = orchestrator.interruptAll().then(() => {
      stopped = true;
    });
    await waitFor(() => codex.interrupts.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(stopped, false);

    codex.starts[0].resolve({ status: "interrupted" });
    await Promise.all([running, stopping]);
    assertEquals(stopped, true);
  });

  it("bounds shutdown while an initial startThread RPC never settles", async () => {
    const startGate = Promise.withResolvers<void>();
    const { codex, orchestrator, state } = setup({ shutdownGraceMs: 1 });
    codex.startThreadGates.push(startGate.promise);
    const running = orchestrator.handleText(
      message("single:alice", "m1", "work"),
    );
    await waitFor(() => codex.startThreadAttempts === 1);

    const stopping = orchestrator.interruptAll();
    const stoppedWithinDeadline = await Promise.race([
      stopping.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 20)),
    ]);

    if (!stoppedWithinDeadline) startGate.resolve();
    await Promise.all([running, stopping]);
    assertEquals(stoppedWithinDeadline, true);
    assertEquals(state.getConversation("single:alice"), null);

    startGate.reject(new Error("late startThread failure"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(state.getConversation("single:alice"), null);
  });

  it("does not bind a startThread result that arrives after shutdown begins", async () => {
    const startGate = Promise.withResolvers<void>();
    const { codex, orchestrator, state } = setup({ shutdownGraceMs: 50 });
    codex.startThreadGates.push(startGate.promise);
    const running = orchestrator.handleText(
      message("single:alice", "m1", "work"),
    );
    await waitFor(() => codex.startThreadAttempts === 1);

    const stopping = orchestrator.interruptAll();
    startGate.resolve();
    await Promise.all([running, stopping]);

    assertEquals(state.getConversation("single:alice"), null);
    assertEquals(codex.starts.length, 0);
  });

  it("bounds shutdown while a resumeThread RPC never settles", async () => {
    const resumeGate = Promise.withResolvers<void>();
    const { codex, orchestrator, state } = setup({ shutdownGraceMs: 1 });
    state.bindConversation("single:alice", "single", "thread-existing");
    codex.resumeThreadGates.push(resumeGate.promise);
    const running = orchestrator.handleText(
      message("single:alice", "m1", "work"),
    );
    await waitFor(() => codex.resumed.length === 1);

    const stopping = orchestrator.interruptAll();
    const stoppedWithinDeadline = await Promise.race([
      stopping.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 20)),
    ]);

    if (!stoppedWithinDeadline) resumeGate.resolve();
    await Promise.all([running, stopping]);
    assertEquals(stoppedWithinDeadline, true);
    assertEquals(codex.starts.length, 0);
    assertEquals(
      state.getConversation("single:alice")?.threadId,
      "thread-existing",
    );

    resumeGate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(codex.starts.length, 0);
  });

  it("bounds shutdown while a /new startThread RPC never settles", async () => {
    const startGate = Promise.withResolvers<void>();
    const { codex, orchestrator, state } = setup({ shutdownGraceMs: 1 });
    codex.startThreadGates.push(startGate.promise);
    const resetting = orchestrator.handleText(
      message("single:alice", "m1", "/new"),
    );
    await waitFor(() => codex.startThreadAttempts === 1);

    const stopping = orchestrator.interruptAll();
    const stoppedWithinDeadline = await Promise.race([
      stopping.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 20)),
    ]);

    if (!stoppedWithinDeadline) startGate.resolve();
    await Promise.all([resetting, stopping]);
    assertEquals(stoppedWithinDeadline, true);
    assertEquals(state.getConversation("single:alice"), null);

    startGate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(state.getConversation("single:alice"), null);
  });

  it("bounds shutdown and finishAll while a critical progress finish never settles", async () => {
    const finishStarted = Promise.withResolvers<void>();
    const finishGate = Promise.withResolvers<void>();
    const outputErrors: Error[] = [];
    const state = new FakeState();
    const codex = new FakeCodex();
    const output = new WeComChatOutput({
      secrets: [],
      onError: (error) => outputErrors.push(error),
      streamControllerOptions: { maxFinishAttempts: 1 },
      gateway: {
        reply: () => Promise.resolve(true),
        replyStream: async () => {
          finishStarted.resolve();
          await finishGate.promise;
          return true;
        },
      },
    });
    const orchestrator = new ConversationOrchestrator({
      state,
      codex,
      output,
      workspace: "/workspace",
      shutdownGraceMs: 1,
    });
    const running = orchestrator.handleText(
      message("single:alice", "m1", "work"),
    );
    await waitFor(() => codex.starts.length === 1);
    codex.starts[0].resolve({ status: "completed" });
    await finishStarted.promise;

    const interrupting = orchestrator.interruptAll();
    output.beginShutdown();
    const stopping = interrupting.then(() => output.finishAll());
    const stoppedWithinDeadline = await Promise.race([
      stopping.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 20)),
    ]);

    if (stoppedWithinDeadline) {
      finishGate.reject(new Error("late progress finish failure"));
      await waitFor(() => outputErrors.length === 1);
    } else {
      finishGate.resolve();
    }
    await Promise.all([running, stopping]);
    assertEquals(stoppedWithinDeadline, true);
    assertEquals(
      state.getConversation("single:alice")?.lastStatus,
      "completed",
    );
    assertEquals(
      outputErrors.map((error) => error.message),
      ["late progress finish failure"],
    );
  });

  it("forces shutdown past a pending terminal final reply", async () => {
    const state = new FakeState();
    const codex = new FakeCodex();
    const output = new PendingFinalOutput();
    const orchestrator = new ConversationOrchestrator({
      state,
      codex,
      output,
      workspace: "/workspace",
      shutdownGraceMs: 1,
    });
    const running = orchestrator.handleText(
      message("single:alice", "m1", "work"),
    );
    await waitFor(() => codex.starts.length === 1);
    codex.starts[0].resolve({ status: "completed", finalAnswer: "done" });
    await output.finalStarted.promise;

    const stopping = orchestrator.interruptAll();
    const stoppedWithinDeadline = await Promise.race([
      stopping.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 20)),
    ]);

    // Keep the old implementation from leaving this test with a live drain.
    if (!stoppedWithinDeadline) output.finalGate.resolve();
    await Promise.all([running, stopping]);

    assertEquals(stoppedWithinDeadline, true);
    assertEquals(output.progress[0].finished, true);
    assertEquals(
      state.getConversation("single:alice")?.lastStatus,
      "completed",
    );
  });

  it("forces shutdown past a pending start-failure fallback", async () => {
    const state = new FakeState();
    const codex = new FakeCodex();
    const output = new PendingFinalOutput();
    const orchestrator = new ConversationOrchestrator({
      state,
      codex,
      output,
      workspace: "/workspace",
      shutdownGraceMs: 1,
    });
    codex.startTurnErrors.push(new Error("start failed"));
    const running = orchestrator.handleText(
      message("single:alice", "m1", "work"),
    );
    await output.finalStarted.promise;

    const stopping = orchestrator.interruptAll();
    const stoppedWithinDeadline = await Promise.race([
      stopping.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 20)),
    ]);

    // Keep the old implementation from leaving this test with a live drain.
    if (!stoppedWithinDeadline) output.finalGate.resolve();
    await Promise.all([running, stopping]);

    assertEquals(stoppedWithinDeadline, true);
    assertEquals(output.progress[0].finished, true);
    assertMatch(output.sent[0].text, /任务启动失败：start failed/);
  });

  it("propagates a direct activity send error before shutdown", async () => {
    const { codex, orchestrator, output } = setup();
    const running = orchestrator.handleText(
      message("single:alice", "m1", "work"),
    );
    await waitFor(() => codex.starts.length === 1);
    output.sendErrors.push(new Error("direct send failed"));

    const result = await Promise.resolve(codex.starts[0].onActivity({
      tag: "CONTENT",
      body: "Codex needs input",
      delivery: "direct",
    })).then(
      () => null,
      (error) => error,
    );

    assertMatch(String(result), /direct send failed/);
    codex.starts[0].resolve({ status: "interrupted" });
    await running;
  });

  it("settles a direct activity callback while its sender remains pending after force", async () => {
    const state = new FakeState();
    const codex = new FakeCodex();
    const output = new QueueBlockedOutput();
    const orchestrator = new ConversationOrchestrator({
      state,
      codex,
      output,
      workspace: "/workspace",
      shutdownGraceMs: 1,
    });
    const running = orchestrator.handleText(
      message("single:alice", "m1", "work"),
    );
    await waitFor(() => codex.starts.length === 1);

    const direct = codex.starts[0].onActivity({
      tag: "CONTENT",
      body: "Codex needs input",
      delivery: "direct",
    });
    void Promise.resolve(direct).catch(() => {});
    await output.directStarted.promise;

    const stopping = orchestrator.interruptAll();
    output.beginShutdown();
    const stoppedWithinDeadline = await Promise.race([
      stopping.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 20)),
    ]);
    const directResult = await Promise.race([
      Promise.resolve(direct).then(
        () => "resolved" as const,
        () => "rejected" as const,
      ),
      new Promise<"pending">((resolve) =>
        setTimeout(() => resolve("pending"), 20)
      ),
    ]);
    await waitFor(() => output.afterShutdownWaiters === 1);

    if (!stoppedWithinDeadline) output.directGate.resolve();
    if (directResult === "pending") output.afterShutdownGate.resolve();
    codex.starts[0].resolve({ status: "interrupted" });
    await Promise.all([running, stopping]);

    assertEquals(stoppedWithinDeadline, true);
    assertEquals(directResult, "resolved");
    assertEquals(output.afterShutdownWaiters, 1);
    assertEquals(output.progress[0].finished, true);
    await codex.starts[0].onActivity({
      tag: "CONTENT",
      body: "late activity",
      delivery: "progress",
    });
    assertEquals(output.lateProgressAppends, []);
  });

  it("finishes shutdown when start RPC never settles and only interrupts a late handle once", async () => {
    const startGate = Promise.withResolvers<void>();
    const { codex, orchestrator, output } = setup({ shutdownGraceMs: 1 });
    codex.startTurnGates.push(startGate.promise);
    const running = orchestrator.handleText(
      message("single:alice", "m1", "work"),
    );
    await waitFor(() => codex.startTurnAttempts === 1);

    const stopping = orchestrator.interruptAll();
    const stoppedWithinDeadline = await Promise.race([
      stopping.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 20)),
    ]);

    // Keep the old implementation from leaving this test with a live drain.
    if (!stoppedWithinDeadline) {
      startGate.resolve();
      await waitFor(() => codex.starts.length === 1);
      codex.starts[0].resolve({ status: "interrupted" });
    }
    await Promise.all([running, stopping]);

    assertEquals(stoppedWithinDeadline, true);
    assertEquals(
      output.progress[0].chunks.includes("[shutdown] shutting down"),
      true,
    );
    assertEquals(
      output.progress[0].chunks.includes("[turn] started"),
      false,
    );
    assertEquals(
      output.progress[0].chunks.includes("[turn] runtime_lost"),
      true,
    );
    assertEquals(output.progress[0].finished, true);

    startGate.resolve();
    await waitFor(() => codex.starts.length === 1);
    await waitFor(() => codex.interrupts.length === 1);
    assertEquals(codex.interrupts, [{
      threadId: "thread-1",
      turnId: "turn-1",
    }]);

    const terminalChunks = [...output.progress[0].chunks];
    await codex.starts[0].onActivity({
      tag: "CONTENT",
      body: "late activity",
      delivery: "progress",
    });
    codex.starts[0].resolve({ status: "interrupted" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(output.progress[0].chunks, terminalChunks);
  });

  it("renders shutdown through the active pipeline and rejects late activity after finish", async () => {
    const { codex, orchestrator, output } = setup();
    const running = orchestrator.handleText(
      message("single:alice", "m1", "work"),
    );
    await waitFor(() => codex.starts.length === 1);

    const stopping = orchestrator.interruptAll();
    await waitFor(() => codex.interrupts.length === 1);
    codex.starts[0].resolve({ status: "interrupted" });
    await Promise.all([running, stopping]);

    await codex.starts[0].onActivity({
      tag: "CONTENT",
      body: "late activity",
      delivery: "progress",
    });
    assertEquals(output.progress[0].chunks, [
      "[queue] 已提交给 Codex",
      "\n",
      "[turn] started",
      "\n",
      "[shutdown] shutting down",
      "\n",
      "[turn] interrupted",
    ]);
    assertEquals(output.lateProgressAppends, []);
  });

  it("filters shutdown only through its output level", async () => {
    const settings = outputSettings();
    settings.levels.SHUTDOWN = "off";
    const { codex, orchestrator, output } = setup({ outputSettings: settings });
    const running = orchestrator.handleText(
      message("single:alice", "m1", "work"),
    );
    await waitFor(() => codex.starts.length === 1);

    const stopping = orchestrator.interruptAll();
    await waitFor(() => codex.interrupts.length === 1);
    codex.starts[0].resolve({ status: "interrupted" });
    await Promise.all([running, stopping]);

    assertEquals(
      output.progress[0].chunks.includes("[shutdown] shutting down"),
      false,
    );
  });

  it("respects the shutdown label setting without changing its visibility", async () => {
    const settings = outputSettings();
    settings.labels.SHUTDOWN = "hide";
    const { codex, orchestrator, output } = setup({ outputSettings: settings });
    const running = orchestrator.handleText(
      message("single:alice", "m1", "work"),
    );
    await waitFor(() => codex.starts.length === 1);

    const stopping = orchestrator.interruptAll();
    await waitFor(() => codex.interrupts.length === 1);
    codex.starts[0].resolve({ status: "interrupted" });
    await Promise.all([running, stopping]);

    assertEquals(output.progress[0].chunks.includes("shutting down"), true);
    assertEquals(
      output.progress[0].chunks.includes("[shutdown] shutting down"),
      false,
    );
  });

  it("bounds shutdown when an interrupted turn never reaches terminal state", async () => {
    const { codex, orchestrator, output, state } = setup({
      shutdownGraceMs: 1,
    });
    const running = orchestrator.handleText(
      message("single:alice", "m1", "work"),
    );
    await waitFor(() => codex.starts.length === 1);

    const stopping = orchestrator.interruptAll();
    const stoppedWithinDeadline = await Promise.race([
      stopping.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 20)),
    ]);

    if (!stoppedWithinDeadline) {
      codex.starts[0].resolve({ status: "interrupted" });
    }
    await Promise.all([running, stopping]);
    assertEquals(stoppedWithinDeadline, true);
    assertEquals(output.progress[0].finished, true);
    assertEquals(
      state.getConversation("single:alice")?.lastStatus,
      "runtime_lost",
    );
  });

  it("rejects new work while the App Server is unavailable", async () => {
    const { codex, orchestrator, output } = setup();
    codex.ready = false;
    await orchestrator.handleText(message("single:alice", "m1", "work"));

    assertEquals(codex.starts.length, 0);
    assertMatch(output.sent[0].text, /暂不可用/);
  });

  it("interrupts and clears a started turn when beginTurn persistence fails", async () => {
    const { codex, orchestrator, output, state } = setup();
    state.failNextBegin = true;

    const running = orchestrator.handleText(
      message("single:alice", "m1", "work"),
    );
    await waitFor(() => codex.starts.length === 1);
    await waitFor(() => codex.interrupts.length === 1);
    codex.starts[0].resolve({ status: "interrupted" });
    await running;

    assertEquals(codex.interrupts, [{
      threadId: "thread-1",
      turnId: "turn-1",
    }]);
    assertEquals(output.progress[0].finished, true);
    assertEquals(
      output.progress[0].chunks.includes("[turn] interrupted"),
      true,
    );
    assertMatch(output.sent.at(-1)!.text, /beginTurn failed/);
  });

  it("waits for a turn with failed begin persistence before starting pending work", async () => {
    const interruptGate = Promise.withResolvers<void>();
    const { codex, orchestrator, output, state } = setup({
      interruptRetryDelaysMs: [0],
    });
    state.failNextBegin = true;
    codex.interruptGates.push(interruptGate.promise);
    codex.interruptErrors.push(new Error("delayed interrupt failure"));

    const firstResult = orchestrator.handleText(
      message("single:alice", "m1", "first"),
    ).then(() => null, (error) => error);
    await waitFor(() => codex.starts.length === 1);
    await waitFor(() => codex.interrupts.length === 1);

    const secondResult = orchestrator.handleText(
      message("single:alice", "m2", "second"),
    ).then(() => null, (error) => error);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const startsBeforeCompletion = codex.starts.length;
    const progressFinishedBeforeCompletion = output.progress[0].finished;

    interruptGate.resolve();
    let interruptRetried = true;
    try {
      await waitFor(() => codex.interrupts.length === 2);
    } catch {
      interruptRetried = false;
    }

    codex.starts[0].resolve({ status: "interrupted" });
    if (codex.starts.length === 1) {
      await waitFor(() => codex.starts.length === 2);
    }
    codex.starts[1].resolve({ status: "completed", finalAnswer: "done" });
    assertEquals(await Promise.all([firstResult, secondResult]), [null, null]);
    assertEquals(startsBeforeCompletion, 1);
    assertEquals(progressFinishedBeforeCompletion, false);
    assertEquals(interruptRetried, true);
  });

  it("reports finishTurn failures but still sends the final answer and clears active", async () => {
    const reported: Error[] = [];
    const { codex, orchestrator, output, state } = setup({
      onError: (error: Error) => {
        reported.push(error);
        throw new Error("error reporter failed");
      },
    });
    state.failNextFinish = true;
    const first = orchestrator.handleText(
      message("single:alice", "m1", "first"),
    );
    await waitFor(() => codex.starts.length === 1);
    codex.starts[0].resolve({ status: "completed", finalAnswer: "done" });
    await first;

    const second = orchestrator.handleText(
      message("single:alice", "m2", "second"),
    );
    await waitFor(() => codex.starts.length === 2);

    assertEquals(codex.interrupts, []);
    assertEquals(output.sent.find((entry) => entry.msgId === "m1"), {
      msgId: "m1",
      text: "done",
      final: true,
    });
    assertEquals(reported.map((error) => error.message), ["finishTurn failed"]);
    codex.starts[1].resolve({ status: "completed", finalAnswer: "done" });
    await second;
  });

  it("continues draining pending work when a failure notification cannot be sent", async () => {
    const startGate = Promise.withResolvers<void>();
    const { codex, orchestrator, output } = setup();
    codex.startTurnGates.push(startGate.promise);
    codex.startTurnErrors.push(new Error("startTurn failed"));
    const firstResult = orchestrator.handleText(
      message("single:alice", "m1", "first"),
    ).then(() => null, (error) => error);
    await waitFor(() => codex.startTurnAttempts === 1);

    const secondResult = orchestrator.handleText(
      message("single:alice", "m2", "second"),
    ).then(() => null, (error) => error);
    output.sendErrors.push(new Error("failure notification failed"));
    startGate.resolve();

    await waitFor(() => codex.starts.length === 1);
    assertMatch(codex.starts[0].prompt, /msgid: m2/);
    codex.starts[0].resolve({ status: "completed", finalAnswer: "done" });
    assertEquals(await Promise.all([firstResult, secondResult]), [null, null]);
  });

  it("persists terminal state and sends the final answer when progress finish fails", async () => {
    const { codex, orchestrator, output, state } = setup();
    output.failNextProgressFinish = true;
    const running = orchestrator.handleText(
      message("single:alice", "m1", "work"),
    );
    await waitFor(() => codex.starts.length === 1);

    codex.starts[0].resolve({ status: "completed", finalAnswer: "done" });
    await running;

    assertEquals(state.getConversation("single:alice")?.activeTurnId, null);
    assertEquals(
      state.getConversation("single:alice")?.lastStatus,
      "completed",
    );
    assertEquals(output.sent, [{ msgId: "m1", text: "done", final: true }]);
  });
});
