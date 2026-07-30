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

    const firstProgress: string[] = [];
    const secondProgress: string[] = [];
    const first = await runtime.startTurn(
      "thread-a",
      "first",
      (text) => firstProgress.push(text),
    );
    const second = await runtime.startTurn(
      "thread-b",
      "second",
      (text) => secondProgress.push(text),
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

    assertEquals(firstProgress, ["A summary\n"]);
    assertEquals(secondProgress, ["B summary\n"]);

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

    const progress: string[] = [];
    const starting = runtime.startTurn(
      "thread-early",
      "work",
      (text) => progress.push(text),
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
    assertEquals(progress, ["early stdout\n"]);
    assertEquals(await handle.completion, {
      status: "completed",
      finalAnswer: "early answer",
      error: null,
    });
    await runtime.stop();
  });

  it("only forwards notifications accepted by the renderer", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    client.turnIds.push("turn-filter");
    factory.queue.push(client);
    const runtime = runtimeWith(factory);
    await runtime.start();
    const progress: string[] = [];
    const handle = await runtime.startTurn(
      "thread-filter",
      "work",
      (text) => progress.push(text),
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

    assertEquals(progress, [
      "safe summary",
      "\n[Codex] safe commentary\n",
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

  it("uses a turn-local reference count when merging matching tool calls", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    client.turnIds.push("turn-merged");
    factory.queue.push(client);
    const runtime = runtimeWith(factory, {
      progressSettings: {
        intermediateOutput: "merge_same_tool",
        statusDetail: "verbose",
      },
    });
    await runtime.start();

    const progress: string[] = [];
    const handle = await runtime.startTurn(
      "thread-merged",
      "work",
      (text) => progress.push(text),
    );
    const notification = (method: string, item: Record<string, unknown>) => {
      client.callbacks.onNotification?.({
        method,
        params: { threadId: "thread-merged", turnId: "turn-merged", item },
      });
    };

    notification("item/started", {
      id: "command-1",
      type: "commandExecution",
      command: "deno test",
    });
    notification("item/started", {
      id: "command-2",
      type: "commandExecution",
      command: "deno test",
    });
    client.callbacks.onNotification?.({
      method: "item/commandExecution/outputDelta",
      params: {
        threadId: "thread-merged",
        turnId: "turn-merged",
        delta: "ignored",
      },
    });
    notification("item/completed", {
      id: "command-1",
      type: "commandExecution",
      command: "deno test",
      status: "completed",
      exitCode: 0,
    });
    notification("item/completed", {
      id: "command-2",
      type: "commandExecution",
      command: "deno test",
      status: "completed",
      exitCode: 0,
    });

    assertEquals(progress, [
      "\n$ deno test\n",
      "[command completed, exit 0]\n",
    ]);
    client.callbacks.onTurnCompleted?.({
      threadId: "thread-merged",
      turnId: "turn-merged",
      status: "completed",
      error: null,
    });
    await handle.completion;
    await runtime.stop();
  });

  it("filters early notifications before replay and still forwards input prompts", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    const turnResponse = deferred<string>();
    client.turnIds.push(turnResponse.promise);
    factory.queue.push(client);
    const runtime = runtimeWith(factory, {
      progressSettings: {
        intermediateOutput: "none",
        statusDetail: "none",
      },
    });
    await runtime.start();

    const progress: string[] = [];
    const starting = runtime.startTurn(
      "thread-hidden",
      "work",
      (text) => progress.push(text),
    );
    await waitFor(() => client.startedTurns.length === 1, "pending turn RPC");
    client.callbacks.onNotification?.({
      method: "item/reasoning/summaryTextDelta",
      params: {
        threadId: "thread-hidden",
        turnId: "turn-hidden",
        delta: "hidden summary",
      },
    });
    client.callbacks.onRequestUserInput?.({
      threadId: "thread-hidden",
      turnId: "turn-hidden",
      questions: [{ header: "需要信息", question: "请补充范围" }],
    });
    turnResponse.resolve("turn-hidden");

    const handle = await starting;
    assertEquals(progress.length, 1);
    assertMatch(progress[0], /Codex 需要用户输入/);
    assertMatch(progress[0], /请补充范围/);
    client.callbacks.onTurnCompleted?.({
      threadId: "thread-hidden",
      turnId: "turn-hidden",
      status: "interrupted",
      error: null,
    });
    await handle.completion;
    await runtime.stop();
  });

  it("releases cached tool identities after an App Server restart", async () => {
    const factory = new FakeFactory();
    const crashed = new FakeClient();
    const replacement = new FakeClient();
    crashed.turnIds.push("turn-reused");
    replacement.turnIds.push("turn-reused");
    factory.queue.push(crashed, replacement);
    const runtime = runtimeWith(factory, {
      delay: async () => {},
      progressSettings: {
        intermediateOutput: "merge_same_tool",
        statusDetail: "verbose",
      },
    });
    await runtime.start();

    const firstProgress: string[] = [];
    const first = await runtime.startTurn(
      "thread-reused",
      "first",
      (text) => firstProgress.push(text),
    );
    crashed.callbacks.onNotification?.({
      method: "item/started",
      params: {
        threadId: "thread-reused",
        turnId: "turn-reused",
        item: {
          id: "command-1",
          type: "commandExecution",
          command: "deno test",
        },
      },
    });
    assertEquals(firstProgress, ["\n$ deno test\n"]);

    crashed.exit();
    assertEquals(await first.completion, { status: "runtime_lost" });
    await waitFor(() => runtime.ready && runtime.generation === 2, "restart");

    const secondProgress: string[] = [];
    const second = await runtime.startTurn(
      "thread-reused",
      "second",
      (text) => secondProgress.push(text),
    );
    replacement.callbacks.onNotification?.({
      method: "item/started",
      params: {
        threadId: "thread-reused",
        turnId: "turn-reused",
        item: {
          id: "command-1",
          type: "commandExecution",
          command: "deno test",
        },
      },
    });
    assertEquals(secondProgress, ["\n$ deno test\n"]);
    replacement.callbacks.onTurnCompleted?.({
      threadId: "thread-reused",
      turnId: "turn-reused",
      status: "completed",
      error: null,
    });
    await second.completion;
    await runtime.stop();
  });

  it("renders requestUserInput questions and options as readable Markdown", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    client.turnIds.push("turn-input");
    factory.queue.push(client);
    const runtime = runtimeWith(factory);
    await runtime.start();
    const progress: string[] = [];
    const handle = await runtime.startTurn(
      "thread-input",
      "work",
      (text) => progress.push(text),
    );

    client.callbacks.onRequestUserInput?.({
      threadId: "thread-input",
      turnId: "turn-input",
      questions: [{
        id: "strategy",
        header: "实现方式",
        question: "请选择下一步",
        options: [
          { label: "直接实现", description: "继续修改代码" },
          { label: "先调查", description: "只读取现状" },
        ],
      }],
    });

    const markdown = progress.join("");
    assertMatch(markdown, /Codex 需要用户输入/);
    assertMatch(markdown, /实现方式/);
    assertMatch(markdown, /请选择下一步/);
    assertMatch(markdown, /直接实现.*继续修改代码/);
    assertMatch(markdown, /先调查.*只读取现状/);
    client.callbacks.onTurnCompleted?.({
      threadId: "thread-input",
      turnId: "turn-input",
      status: "interrupted",
      error: null,
    });
    await handle.completion;
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
