import { assertEquals, assertMatch } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  type ChatOutput,
  type CodexPort,
  type CodexTurnHandle,
  ConversationOrchestrator,
  type ConversationOrchestratorOptions,
  type OrchestratorState,
  type RoutedMessage,
  type RoutedText,
  type TurnOutcome,
} from "./orchestrator.ts";

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
  onProgress: (text: string) => void;
  turnId: string;
  resolve: (outcome: TurnOutcome) => void;
}

class FakeCodex implements CodexPort {
  ready = true;
  generation = 1;
  readonly starts: StartedTurn[] = [];
  readonly startTurnGates: Promise<void>[] = [];
  readonly startTurnErrors: Error[] = [];
  readonly interrupts: Array<{ threadId: string; turnId: string }> = [];
  readonly resumed: string[] = [];
  readonly interruptGates: Promise<void>[] = [];
  readonly interruptErrors: Error[] = [];
  threadSequence = 0;
  turnSequence = 0;
  startTurnAttempts = 0;

  startThread(): Promise<string> {
    return Promise.resolve(`thread-${++this.threadSequence}`);
  }

  resumeThread(threadId: string): Promise<void> {
    this.resumed.push(threadId);
    return Promise.resolve();
  }

  async startTurn(
    threadId: string,
    prompt: string,
    onProgress: (text: string) => void,
  ): Promise<CodexTurnHandle> {
    this.startTurnAttempts++;
    const gate = this.startTurnGates.shift();
    if (gate) await gate;
    const error = this.startTurnErrors.shift();
    if (error) throw error;
    const { promise, resolve } = Promise.withResolvers<TurnOutcome>();
    const turnId = `turn-${++this.turnSequence}`;
    this.starts.push({ threadId, prompt, onProgress, turnId, resolve });
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
  failNextProgressFinish = false;

  send(message: RoutedMessage, text: string, final = false): Promise<void> {
    this.sent.push({ msgId: message.msgId, text, final });
    const error = this.sendErrors.shift();
    if (error) return Promise.reject(error);
    return Promise.resolve();
  }

  startProgress(message: RoutedText) {
    const entry = {
      msgId: message.msgId,
      chunks: [] as string[],
      finished: false,
    };
    this.progress.push(entry);
    return Promise.resolve({
      append: (text: string) => entry.chunks.push(text),
      finish: () => {
        entry.finished = true;
        if (this.failNextProgressFinish) {
          this.failNextProgressFinish = false;
          return Promise.reject(new Error("progress finish failed"));
        }
        return Promise.resolve();
      },
    });
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
  const orchestrator = new ConversationOrchestrator({
    state,
    codex,
    output,
    workspace: "/workspace",
    ...extraOptions,
  } as ConversationOrchestratorOptions);
  return { state, codex, output, orchestrator };
}

describe("ConversationOrchestrator", () => {
  it("binds a conversation and includes the actual sender in every turn", async () => {
    const { codex, orchestrator, state, output } = setup();
    const running = orchestrator.handleText(
      message("group:engineering", "m1", "检查测试", "bob"),
    );
    await waitFor(() => codex.starts.length === 1);

    assertEquals(codex.starts[0].threadId, "thread-1");
    assertMatch(codex.starts[0].prompt, /sender_userid: bob/);
    assertMatch(codex.starts[0].prompt, /conversation_key: group:engineering/);
    codex.starts[0].onProgress("正在检查");
    codex.starts[0].resolve({ status: "completed", finalAnswer: "测试正常" });
    await running;

    assertEquals(
      state.getConversation("group:engineering")?.threadId,
      "thread-1",
    );
    assertEquals(output.progress[0].chunks.includes("正在检查"), true);
    assertEquals(
      output.progress[0].chunks.includes("[turn completed]\n"),
      true,
    );
    assertEquals(output.sent.at(-1), {
      msgId: "m1",
      text: "测试正常",
      final: true,
    });
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
