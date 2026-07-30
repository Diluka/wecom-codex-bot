import { assertEquals, assertMatch, assertStrictEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";

import type {
  AppServerProcessStatus,
  CodexAppServerCallbacks,
  CodexAppServerOptions,
} from "./codex-app-server.ts";
import {
  CodexRuntime,
  type CodexRuntimeClient,
  type CodexRuntimeClientFactory,
} from "./codex-runtime.ts";
import type { ActivityEvent } from "./activity-event.ts";

const EXITED: AppServerProcessStatus = {
  success: false,
  code: 1,
  signal: null,
};

class FakeClient implements CodexRuntimeClient {
  callbacks: CodexAppServerCallbacks = {};
  readonly startedThreads: string[] = [];
  readonly resumedThreads: string[] = [];
  readonly startedTurns: Array<{ threadId: string; prompt: string }> = [];
  readonly interruptedTurns: Array<{ threadId: string; turnId: string }> = [];
  readonly turnIds: Array<string | Promise<string>> = [];
  closeCalls = 0;

  startThread(): Promise<string> {
    const threadId = `thread-${this.startedThreads.length + 1}`;
    this.startedThreads.push(threadId);
    return Promise.resolve(threadId);
  }

  resumeThread(threadId: string): Promise<string> {
    this.resumedThreads.push(threadId);
    return Promise.resolve(threadId);
  }

  async startTurn(threadId: string, prompt: string): Promise<string> {
    this.startedTurns.push({ threadId, prompt });
    const next = this.turnIds.shift();
    return await (next ?? `turn-${this.startedTurns.length}`);
  }

  interrupt(threadId: string, turnId: string): Promise<void> {
    this.interruptedTurns.push({ threadId, turnId });
    return Promise.resolve();
  }

  close(): Promise<AppServerProcessStatus> {
    this.closeCalls++;
    this.callbacks.onExit?.({ success: true, code: 0, signal: null });
    return Promise.resolve({ success: true, code: 0, signal: null });
  }

  exit(status: AppServerProcessStatus = EXITED): void {
    this.callbacks.onExit?.(status);
  }
}

class FakeFactory {
  readonly calls: CodexAppServerOptions[] = [];
  readonly queue: Array<FakeClient | Error> = [];

  readonly create: CodexRuntimeClientFactory = (options) => {
    this.calls.push(options);
    const next = this.queue.shift();
    if (!next) return Promise.reject(new Error("fake factory queue is empty"));
    if (next instanceof Error) return Promise.reject(next);
    next.callbacks = options.callbacks ?? {};
    return Promise.resolve(next);
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  const { promise, resolve } = Promise.withResolvers<T>();
  return { promise, resolve };
}

async function waitFor(
  predicate: () => boolean,
  description: string,
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${description}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function runtimeWith(
  factory: FakeFactory,
  overrides: Partial<ConstructorParameters<typeof CodexRuntime>[0]> = {},
): CodexRuntime {
  return new CodexRuntime({
    workspace: "/workspace/project",
    clientFactory: factory.create,
    delay: async () => {},
    ...overrides,
  });
}

describe("CodexRuntime", () => {
  it("starts one client and implements the Codex port operations", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    client.turnIds.push("turn-9");
    factory.queue.push(client);
    const runtime = runtimeWith(factory);

    assertEquals(runtime.ready, false);
    assertEquals(runtime.generation, 0);
    await runtime.start();
    assertEquals(runtime.ready, true);
    assertEquals(runtime.generation, 1);
    assertEquals(factory.calls[0].cwd, "/workspace/project");

    assertEquals(await runtime.startThread(), "thread-1");
    await runtime.resumeThread("thread-existing");
    const handle = await runtime.startTurn(
      "thread-existing",
      "检查测试",
      () => {},
    );
    assertEquals(handle.turnId, "turn-9");
    await runtime.interruptTurn("thread-existing", "turn-9");
    assertEquals(client.resumedThreads, ["thread-existing"]);
    assertEquals(client.startedTurns, [{
      threadId: "thread-existing",
      prompt: "检查测试",
    }]);
    assertEquals(client.interruptedTurns, [{
      threadId: "thread-existing",
      turnId: "turn-9",
    }]);

    client.callbacks.onTurnCompleted?.({
      threadId: "thread-existing",
      turnId: "turn-9",
      status: "completed",
      error: null,
      finalMessage: "测试通过",
    });
    assertEquals(await handle.completion, {
      status: "completed",
      finalAnswer: "测试通过",
      error: null,
    });
    await runtime.stop();
  });

  it("routes interleaved notifications by both thread and turn", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    client.turnIds.push("same-turn", "same-turn");
    factory.queue.push(client);
    const runtime = runtimeWith(factory);
    await runtime.start();

    const firstProgress: ActivityEvent[] = [];
    const secondProgress: ActivityEvent[] = [];
    const first = await runtime.startTurn(
      "thread-a",
      "first",
      (activity) => {
        firstProgress.push(activity);
      },
    );
    const second = await runtime.startTurn(
      "thread-b",
      "second",
      (activity) => {
        secondProgress.push(activity);
      },
    );

    client.callbacks.onNotification?.({
      method: "item/reasoning/summaryTextDelta",
      params: {
        threadId: "thread-b",
        turnId: "same-turn",
        delta: "B summary\n",
      },
    });
    client.callbacks.onNotification?.({
      method: "item/reasoning/summaryTextDelta",
      params: {
        threadId: "thread-a",
        turnId: "same-turn",
        delta: "A summary\n",
      },
    });

    assertEquals(firstProgress, [{
      tag: "CONTENT",
      body: "A summary\n",
      threadId: "thread-a",
      turnId: "same-turn",
      delivery: "progress",
    }]);
    assertEquals(secondProgress, [{
      tag: "CONTENT",
      body: "B summary\n",
      threadId: "thread-b",
      turnId: "same-turn",
      delivery: "progress",
    }]);

    client.callbacks.onTurnCompleted?.({
      threadId: "thread-b",
      turnId: "same-turn",
      status: "completed",
      error: null,
      finalMessage: "B",
    });
    client.callbacks.onTurnCompleted?.({
      threadId: "thread-a",
      turnId: "same-turn",
      status: "interrupted",
      error: { message: "superseded" },
    });
    assertEquals(await first.completion, {
      status: "interrupted",
      error: "superseded",
    });
    assertEquals(await second.completion, {
      status: "completed",
      finalAnswer: "B",
      error: null,
    });
    await runtime.stop();
  });

  it("replays progress and completion that arrive before the turn RPC response", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    const turnResponse = deferred<string>();
    client.turnIds.push(turnResponse.promise);
    factory.queue.push(client);
    const runtime = runtimeWith(factory);
    await runtime.start();

    const progress: ActivityEvent[] = [];
    const starting = runtime.startTurn(
      "thread-early",
      "work",
      (activity) => {
        progress.push(activity);
      },
    );
    await waitFor(() => client.startedTurns.length === 1, "pending turn RPC");
    client.callbacks.onNotification?.({
      method: "item/commandExecution/outputDelta",
      params: {
        threadId: "thread-early",
        turnId: "turn-early",
        delta: "early stdout\n",
      },
    });
    client.callbacks.onTurnCompleted?.({
      threadId: "thread-early",
      turnId: "turn-early",
      status: "completed",
      error: null,
      finalMessage: "early answer",
    });
    turnResponse.resolve("turn-early");

    const handle = await starting;
    assertEquals(progress, [{
      tag: "TOOL_RESULT",
      body: "early stdout\n",
      threadId: "thread-early",
      turnId: "turn-early",
      delivery: "progress",
    }]);
    assertEquals(await handle.completion, {
      status: "completed",
      finalAnswer: "early answer",
      error: null,
    });
    await runtime.stop();
  });

  it("replays raw early activity events, including direct user input, in arrival order", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    const turnResponse = deferred<string>();
    client.turnIds.push(turnResponse.promise);
    factory.queue.push(client);
    const runtime = runtimeWith(factory);
    await runtime.start();

    const activities: unknown[] = [];
    const starting = runtime.startTurn(
      "thread-early",
      "work",
      (activity) => {
        activities.push(activity);
      },
    );
    await waitFor(() => client.startedTurns.length === 1, "pending turn RPC");

    client.callbacks.onNotification?.({
      method: "item/reasoning/summaryTextDelta",
      params: {
        threadId: "thread-early",
        turnId: "turn-early",
        delta: "early summary",
      },
    });
    client.callbacks.onRequestUserInput?.({
      threadId: "thread-early",
      turnId: "turn-early",
      itemId: "input-1",
      questions: [{
        header: "实现方式",
        question: "请选择下一步",
        options: [{ label: "直接实现", description: "继续修改代码" }],
      }],
    });
    turnResponse.resolve("turn-early");

    const handle = await starting;
    assertEquals(activities, [
      {
        tag: "CONTENT",
        body: "early summary",
        threadId: "thread-early",
        turnId: "turn-early",
        delivery: "progress",
      },
      {
        tag: "CONTENT",
        body: [
          "Codex 需要用户输入",
          "",
          "### 实现方式",
          "",
          "请选择下一步",
          "",
          "- **直接实现**：继续修改代码",
          "",
          "请直接发送下一条文本继续。",
        ].join("\n"),
        threadId: "thread-early",
        turnId: "turn-early",
        itemId: "input-1",
        delivery: "direct",
      },
    ]);
    client.callbacks.onTurnCompleted?.({
      threadId: "thread-early",
      turnId: "turn-early",
      status: "interrupted",
      error: null,
    });
    await handle.completion;
    await runtime.stop();
  });

  it("forwards only safe raw activity notifications", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    client.turnIds.push("turn-filter");
    factory.queue.push(client);
    const runtime = runtimeWith(factory);
    await runtime.start();
    const activities: ActivityEvent[] = [];
    const handle = await runtime.startTurn(
      "thread-filter",
      "work",
      (activity) => {
        activities.push(activity);
      },
    );

    for (
      const [method, params] of [
        ["item/reasoning/textDelta", { delta: "private reasoning" }],
        ["item/agentMessage/delta", { delta: "draft answer" }],
        ["future/unknown", { delta: "unknown" }],
        ["item/reasoning/summaryTextDelta", { delta: "safe summary" }],
        [
          "item/completed",
          {
            item: {
              type: "agentMessage",
              phase: "commentary",
              text: "safe commentary",
            },
          },
        ],
      ] as const
    ) {
      client.callbacks.onNotification?.({
        method,
        params: {
          threadId: "thread-filter",
          turnId: "turn-filter",
          ...params,
        },
      });
    }

    assertEquals(activities, [
      {
        tag: "CONTENT",
        body: "safe summary",
        threadId: "thread-filter",
        turnId: "turn-filter",
        delivery: "progress",
      },
      {
        tag: "CONTENT",
        summary: "Codex",
        body: "safe commentary",
        threadId: "thread-filter",
        turnId: "turn-filter",
        delivery: "progress",
      },
    ]);
    client.callbacks.onTurnCompleted?.({
      threadId: "thread-filter",
      turnId: "turn-filter",
      status: "completed",
      error: null,
    });
    await handle.completion;
    await runtime.stop();
  });

  it("ignores adapter TURN notifications so completion owns terminal state", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    client.turnIds.push("turn-terminal");
    factory.queue.push(client);
    const runtime = runtimeWith(factory);
    await runtime.start();

    const activities: ActivityEvent[] = [];
    const handle = await runtime.startTurn(
      "thread-terminal",
      "work",
      (activity) => {
        activities.push(activity);
      },
    );
    client.callbacks.onNotification?.({
      method: "turn/started",
      params: {
        threadId: "thread-terminal",
        turn: { id: "turn-terminal", status: "in_progress" },
      },
    });
    client.callbacks.onNotification?.({
      method: "turn/completed",
      params: {
        threadId: "thread-terminal",
        turn: { id: "turn-terminal", status: "completed" },
      },
    });

    assertEquals(activities, []);
    client.callbacks.onTurnCompleted?.({
      threadId: "thread-terminal",
      turnId: "turn-terminal",
      status: "completed",
      error: null,
      finalMessage: "final answer",
    });
    assertEquals(await handle.completion, {
      status: "completed",
      finalAnswer: "final answer",
      error: null,
    });
    await runtime.stop();
  });

  it("reports rejected activity callbacks without an unhandled rejection", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    client.turnIds.push("turn-diagnostic");
    factory.queue.push(client);
    const diagnostics: string[] = [];
    const runtime = runtimeWith(factory, {
      onDiagnostic: (message) => {
        diagnostics.push(message);
      },
    });
    await runtime.start();
    const handle = await runtime.startTurn(
      "thread-diagnostic",
      "work",
      () => Promise.reject(new Error("activity callback rejected")),
    );

    client.callbacks.onNotification?.({
      method: "item/reasoning/summaryTextDelta",
      params: {
        threadId: "thread-diagnostic",
        turnId: "turn-diagnostic",
        delta: "safe summary",
      },
    });
    await waitFor(
      () => diagnostics.length === 1,
      "activity callback diagnostic",
    );

    assertMatch(
      diagnostics[0],
      /Codex activity callback failed: activity callback rejected/,
    );
    client.callbacks.onTurnCompleted?.({
      threadId: "thread-diagnostic",
      turnId: "turn-diagnostic",
      status: "interrupted",
      error: null,
    });
    await handle.completion;
    await runtime.stop();
  });

  it("drops late activity after a completed turn instead of replaying it", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    client.turnIds.push("turn-reused", "turn-reused");
    factory.queue.push(client);
    const runtime = runtimeWith(factory);
    await runtime.start();

    const first = await runtime.startTurn("thread-reused", "first", () => {});
    client.callbacks.onTurnCompleted?.({
      threadId: "thread-reused",
      turnId: "turn-reused",
      status: "completed",
      error: null,
    });
    await first.completion;
    client.callbacks.onNotification?.({
      method: "item/reasoning/summaryTextDelta",
      params: {
        threadId: "thread-reused",
        turnId: "turn-reused",
        delta: "late summary",
      },
    });

    const replayed: ActivityEvent[] = [];
    const second = await runtime.startTurn(
      "thread-reused",
      "second",
      (activity) => {
        replayed.push(activity);
      },
    );
    assertEquals(replayed, []);
    client.callbacks.onTurnCompleted?.({
      threadId: "thread-reused",
      turnId: "turn-reused",
      status: "completed",
      error: null,
    });
    await second.completion;
    await runtime.stop();
  });

  it("does not buffer late activity for a completed key while a reused turn RPC is pending", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    const secondResponse = deferred<string>();
    client.turnIds.push("turn-reused", secondResponse.promise);
    factory.queue.push(client);
    const runtime = runtimeWith(factory);
    await runtime.start();

    const first = await runtime.startTurn("thread-reused", "first", () => {});
    client.callbacks.onTurnCompleted?.({
      threadId: "thread-reused",
      turnId: "turn-reused",
      status: "completed",
      error: null,
    });
    await first.completion;

    const activities: ActivityEvent[] = [];
    const starting = runtime.startTurn(
      "thread-reused",
      "second",
      (activity) => {
        activities.push(activity);
      },
    );
    await waitFor(() => client.startedTurns.length === 2, "reused turn RPC");
    client.callbacks.onNotification?.({
      method: "item/reasoning/summaryTextDelta",
      params: {
        threadId: "thread-reused",
        turnId: "turn-reused",
        delta: "late summary",
      },
    });
    secondResponse.resolve("turn-reused");

    const second = await starting;
    assertEquals(activities, []);
    client.callbacks.onTurnCompleted?.({
      threadId: "thread-reused",
      turnId: "turn-reused",
      status: "completed",
      error: null,
    });
    await second.completion;
    await runtime.stop();
  });

  it("clears pending-start state after restart before a replacement turn begins", async () => {
    const factory = new FakeFactory();
    const crashed = new FakeClient();
    const replacement = new FakeClient();
    const firstResponse = deferred<string>();
    crashed.turnIds.push(firstResponse.promise);
    replacement.turnIds.push("turn-late");
    factory.queue.push(crashed, replacement);
    const runtime = runtimeWith(factory, { delay: async () => {} });
    await runtime.start();

    const starting = runtime.startTurn("thread-pending", "first", () => {});
    await waitFor(() => crashed.startedTurns.length === 1, "pending turn RPC");
    crashed.exit();
    await waitFor(() => runtime.ready && runtime.generation === 2, "restart");
    replacement.callbacks.onNotification?.({
      method: "item/reasoning/summaryTextDelta",
      params: {
        threadId: "thread-pending",
        turnId: "turn-late",
        delta: "must not buffer",
      },
    });

    const activities: ActivityEvent[] = [];
    const recovered = await runtime.startTurn(
      "thread-pending",
      "second",
      (activity) => {
        activities.push(activity);
      },
    );
    assertEquals(activities, []);
    replacement.callbacks.onTurnCompleted?.({
      threadId: "thread-pending",
      turnId: "turn-late",
      status: "completed",
      error: null,
    });
    await recovered.completion;

    firstResponse.resolve("turn-old");
    const original = await starting;
    assertEquals(original.turnId, "turn-old");
    assertEquals(await original.completion, { status: "runtime_lost" });
    await runtime.stop();
  });

  it("preserves replacement early events when an old generation turn RPC resolves late", async () => {
    const factory = new FakeFactory();
    const crashed = new FakeClient();
    const replacement = new FakeClient();
    const originalResponse = deferred<string>();
    const replacementResponse = deferred<string>();
    crashed.turnIds.push(originalResponse.promise);
    replacement.turnIds.push(replacementResponse.promise);
    factory.queue.push(crashed, replacement);
    const runtime = runtimeWith(factory, { delay: async () => {} });
    await runtime.start();

    const originalStarting = runtime.startTurn(
      "thread-generation-race",
      "original",
      () => {},
    );
    await waitFor(() => crashed.startedTurns.length === 1, "original turn RPC");
    crashed.exit();
    await waitFor(() => runtime.ready && runtime.generation === 2, "restart");

    const activities: ActivityEvent[] = [];
    const replacementStarting = runtime.startTurn(
      "thread-generation-race",
      "replacement",
      (activity) => {
        activities.push(activity);
      },
    );
    await waitFor(
      () => replacement.startedTurns.length === 1,
      "replacement turn RPC",
    );
    replacement.callbacks.onNotification?.({
      method: "item/reasoning/summaryTextDelta",
      params: {
        threadId: "thread-generation-race",
        turnId: "turn-reused-across-generations",
        delta: "replacement early summary",
      },
    });
    replacement.callbacks.onTurnCompleted?.({
      threadId: "thread-generation-race",
      turnId: "turn-reused-across-generations",
      status: "completed",
      error: null,
      finalMessage: "replacement answer",
    });

    originalResponse.resolve("turn-reused-across-generations");
    const original = await originalStarting;
    const originalOutcome = await original.completion;

    replacementResponse.resolve("turn-reused-across-generations");
    const recovered = await replacementStarting;
    const replacementOutcome = await Promise.race([
      recovered.completion,
      Promise.resolve({ status: "still_pending" } as const),
    ]);
    await runtime.stop();

    assertEquals(originalOutcome, { status: "runtime_lost" });
    assertEquals(activities, [{
      tag: "CONTENT",
      body: "replacement early summary",
      threadId: "thread-generation-race",
      turnId: "turn-reused-across-generations",
      delivery: "progress",
    }]);
    assertEquals(replacementOutcome, {
      status: "completed",
      finalAnswer: "replacement answer",
      error: null,
    });
  });

  it("replays early activity for a reused key after restart clears terminal state", async () => {
    const factory = new FakeFactory();
    const crashed = new FakeClient();
    const replacement = new FakeClient();
    const replacementResponse = deferred<string>();
    crashed.turnIds.push("turn-reused");
    replacement.turnIds.push(replacementResponse.promise);
    factory.queue.push(crashed, replacement);
    const runtime = runtimeWith(factory, { delay: async () => {} });
    await runtime.start();

    const first = await runtime.startTurn("thread-reused", "first", () => {});
    crashed.exit();
    assertEquals(await first.completion, { status: "runtime_lost" });
    await waitFor(() => runtime.ready && runtime.generation === 2, "restart");

    const activities: ActivityEvent[] = [];
    const starting = runtime.startTurn(
      "thread-reused",
      "second",
      (activity) => {
        activities.push(activity);
      },
    );
    await waitFor(
      () => replacement.startedTurns.length === 1,
      "replacement turn RPC",
    );
    replacement.callbacks.onNotification?.({
      method: "item/reasoning/summaryTextDelta",
      params: {
        threadId: "thread-reused",
        turnId: "turn-reused",
        delta: "new generation early summary",
      },
    });
    replacementResponse.resolve("turn-reused");

    const second = await starting;
    assertEquals(activities, [{
      tag: "CONTENT",
      body: "new generation early summary",
      threadId: "thread-reused",
      turnId: "turn-reused",
      delivery: "progress",
    }]);
    replacement.callbacks.onTurnCompleted?.({
      threadId: "thread-reused",
      turnId: "turn-reused",
      status: "completed",
      error: null,
    });
    await second.completion;
    await runtime.stop();
  });

  it("marks active turns runtime_lost after a crash and never replays them", async () => {
    const factory = new FakeFactory();
    const crashed = new FakeClient();
    const replacement = new FakeClient();
    crashed.turnIds.push("turn-lost");
    factory.queue.push(crashed, replacement);
    const delays: number[] = [];
    const runtime = runtimeWith(factory, {
      delay: (milliseconds) => {
        delays.push(milliseconds);
        return Promise.resolve();
      },
    });
    await runtime.start();
    const handle = await runtime.startTurn(
      "thread-lost",
      "do not replay",
      () => {},
    );

    crashed.exit();
    assertEquals(await handle.completion, { status: "runtime_lost" });
    await waitFor(() => runtime.ready, "runtime restart");
    assertEquals(delays, [1_000]);
    assertEquals(runtime.generation, 2);
    assertEquals(crashed.startedTurns.length, 1);
    assertEquals(replacement.startedTurns.length, 0);
    await runtime.stop();
  });

  it("starts a new restart round when a replacement exits before restart settles", async () => {
    const initial = new FakeClient();
    const replacement = new FakeClient();
    const recovered = new FakeClient();
    const clients = [initial, replacement, recovered];
    const factoryCalls: CodexAppServerOptions[] = [];
    const clientFactory: CodexRuntimeClientFactory = (options) => {
      factoryCalls.push(options);
      const client = clients.shift();
      if (!client) return Promise.reject(new Error("no fake client"));
      client.callbacks = options.callbacks ?? {};
      if (client === replacement) {
        const exitWhenPublished = () => {
          if (runtime.ready) replacement.exit();
          else queueMicrotask(exitWhenPublished);
        };
        queueMicrotask(exitWhenPublished);
      }
      return Promise.resolve(client);
    };
    const delays: number[] = [];
    const runtime = new CodexRuntime({
      workspace: "/workspace/project",
      clientFactory,
      delay: (milliseconds) => {
        delays.push(milliseconds);
        return Promise.resolve();
      },
    });
    await runtime.start();

    initial.exit();
    await waitFor(() => factoryCalls.length === 3, "second restart round");

    assertEquals(runtime.ready, true);
    assertEquals(runtime.generation, 3);
    assertEquals(delays, [1_000, 1_000]);
    await runtime.stop();
  });

  it("uses bounded exponential backoff and reports the fifth restart failure", async () => {
    const factory = new FakeFactory();
    const crashed = new FakeClient();
    factory.queue.push(
      crashed,
      new Error("restart 1"),
      new Error("restart 2"),
      new Error("restart 3"),
      new Error("restart 4"),
      new Error("restart 5"),
    );
    const delays: number[] = [];
    const fatal = deferred<Error>();
    const runtime = runtimeWith(factory, {
      delay: (milliseconds) => {
        delays.push(milliseconds);
        return Promise.resolve();
      },
      onFatal: (error) => fatal.resolve(error),
    });
    await runtime.start();

    crashed.exit();
    const error = await fatal.promise;
    assertEquals(delays, [1_000, 2_000, 4_000, 8_000, 16_000]);
    assertEquals(factory.calls.length, 6);
    assertEquals(runtime.ready, false);
    assertEquals(runtime.generation, 1);
    assertEquals(error.message, "restart 5");
    await runtime.stop();
  });

  it("does not restart when close triggers onExit during stop", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    factory.queue.push(client);
    const delays: number[] = [];
    const runtime = runtimeWith(factory, {
      delay: (milliseconds) => {
        delays.push(milliseconds);
        return Promise.resolve();
      },
    });
    await runtime.start();

    await runtime.stop();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals(runtime.ready, false);
    assertEquals(client.closeCalls, 1);
    assertEquals(factory.calls.length, 1);
    assertEquals(delays, []);
    assertStrictEquals(client.callbacks.onExit !== undefined, true);
  });

  it("cancels an in-flight restart delay immediately on stop", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    const replacement = new FakeClient();
    factory.queue.push(client, replacement);
    const delayStarted = deferred<void>();
    const delayCancelled = deferred<void>();
    const runtime = runtimeWith(factory, {
      delay: (_milliseconds, signal) => {
        delayStarted.resolve();
        return new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => {
            delayCancelled.resolve();
            resolve();
          }, { once: true });
        });
      },
    });
    await runtime.start();

    client.exit();
    await delayStarted.promise;
    await runtime.stop();
    await delayCancelled.promise;
    await new Promise((resolve) => setTimeout(resolve, 0));

    assertEquals(runtime.ready, false);
    assertEquals(factory.calls.length, 1);
    assertEquals(replacement.closeCalls, 0);
  });
});
