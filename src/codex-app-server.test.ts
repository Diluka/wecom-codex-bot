import { deepStrictEqual, equal, match, ok, rejects } from "node:assert/strict";
import { assertEquals, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";

import {
  type AppServerProcess,
  type AppServerProcessStatus,
  classifyAppServerMessage,
  CodexAppServerClient,
  selectFinalAgentMessage,
  type SpawnAppServer,
} from "./codex-app-server.ts";

type JsonObject = Record<string, unknown>;

class FakeAppServerProcess implements AppServerProcess {
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly status: Promise<AppServerProcessStatus>;
  readonly received: JsonObject[] = [];
  readonly killSignals: string[] = [];
  onClientMessage?: (message: JsonObject) => void;

  #stdoutController!: ReadableStreamDefaultController<Uint8Array>;
  #stderrController!: ReadableStreamDefaultController<Uint8Array>;
  #resolveStatus!: (status: AppServerProcessStatus) => void;
  #inputBuffer = "";
  #exited = false;
  readonly #exitOnStdinClose: boolean;
  readonly #exitOnKill: boolean;

  constructor(
    options: { exitOnStdinClose?: boolean; exitOnKill?: boolean } = {},
  ) {
    this.#exitOnStdinClose = options.exitOnStdinClose ?? true;
    this.#exitOnKill = options.exitOnKill ?? true;
    this.stdout = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#stdoutController = controller;
      },
    });
    this.stderr = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#stderrController = controller;
      },
    });
    this.status = new Promise((resolve) => {
      this.#resolveStatus = resolve;
    });
    this.stdin = new WritableStream<Uint8Array>({
      write: (chunk) => this.#receive(chunk),
      close: () => {
        if (this.#exitOnStdinClose) {
          this.exit({ success: true, code: 0, signal: null });
        }
      },
      abort: () => {
        this.exit({ success: false, code: 1, signal: null });
      },
    });
  }

  kill(signal: string = "SIGTERM"): void {
    this.killSignals.push(signal);
    if (this.#exitOnKill) {
      this.exit({ success: false, code: 128, signal });
    }
  }

  send(message: JsonObject): void {
    if (this.#exited) throw new Error("fake process has exited");
    this.#stdoutController.enqueue(
      new TextEncoder().encode(`${JSON.stringify(message)}\n`),
    );
  }

  sendStderr(text: string): void {
    if (this.#exited) throw new Error("fake process has exited");
    this.#stderrController.enqueue(new TextEncoder().encode(text));
  }

  exit(status: AppServerProcessStatus): void {
    if (this.#exited) return;
    this.#exited = true;
    this.#stdoutController.close();
    this.#stderrController.close();
    this.#resolveStatus(status);
  }

  #receive(chunk: Uint8Array): void {
    this.#inputBuffer += new TextDecoder().decode(chunk);
    while (true) {
      const newline = this.#inputBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#inputBuffer.slice(0, newline);
      this.#inputBuffer = this.#inputBuffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as JsonObject;
      this.received.push(message);
      this.onClientMessage?.(message);
    }
  }
}

function createSpawn(
  fake: FakeAppServerProcess,
  calls: Array<{ command: string; options: Deno.CommandOptions }> = [],
  handler?: (message: JsonObject) => void,
): SpawnAppServer {
  fake.onClientMessage = (message) => {
    if (message.method === "initialize") {
      fake.send({
        id: message.id,
        result: {
          userAgent: "fake/0.144.6",
          codexHome: "/tmp/codex",
          platformFamily: "unix",
          platformOs: "linux",
        },
      });
      return;
    }
    handler?.(message);
  };

  return (command, options) => {
    calls.push({ command, options });
    return fake;
  };
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
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) Deno.env.delete(name);
  else Deno.env.set(name, value);
}

describe("CodexAppServerClient", () => {
  it("classifies messages by checking method before id", () => {
    equal(
      classifyAppServerMessage({ method: "server/call", id: 1, result: {} }),
      "serverRequest",
    );
    equal(
      classifyAppServerMessage({ method: "turn/completed", params: {} }),
      "notification",
    );
    equal(classifyAppServerMessage({ id: 1, result: {} }), "response");
    equal(classifyAppServerMessage({ value: true }), "unknown");
  });

  it("spawns stdio App Server, strips bot secrets, and handshakes", async () => {
    const oldBotId = Deno.env.get("BOT_ID");
    const oldBotSecret = Deno.env.get("BOT_SECRET");
    Deno.env.set("BOT_ID", "bot-id-secret");
    Deno.env.set("BOT_SECRET", "bot-secret-value");

    const fake = new FakeAppServerProcess();
    const calls: Array<{ command: string; options: Deno.CommandOptions }> = [];
    let client: CodexAppServerClient | undefined;
    try {
      client = await CodexAppServerClient.start({
        cwd: "/workspace/project",
        spawn: createSpawn(fake, calls),
      });
      await waitFor(
        () => fake.received.some((message) => message.method === "initialized"),
        "initialized notification",
      );

      equal(calls.length, 1);
      equal(calls[0].command, "codex");
      deepStrictEqual(calls[0].options.args, ["app-server", "--stdio"]);
      equal(calls[0].options.cwd, "/workspace/project");
      equal(calls[0].options.clearEnv, true);
      equal(calls[0].options.env?.BOT_ID, undefined);
      equal(calls[0].options.env?.BOT_SECRET, undefined);
      deepStrictEqual(fake.received[0], {
        method: "initialize",
        id: 1,
        params: {
          clientInfo: {
            name: "wecom_codex_bot",
            title: "WeCom Codex Bot",
            version: "0.1.0",
          },
          capabilities: {
            experimentalApi: true,
            requestAttestation: false,
          },
        },
      });
      deepStrictEqual(fake.received[1], { method: "initialized" });
    } finally {
      restoreEnv("BOT_ID", oldBotId);
      restoreEnv("BOT_SECRET", oldBotSecret);
      await client?.close();
    }
  });

  it("uses increasing RPC ids and only the allowed thread and turn overrides", async () => {
    const fake = new FakeAppServerProcess();
    const client = await CodexAppServerClient.start({
      cwd: "/workspace/project",
      spawn: createSpawn(fake, [], (message) => {
        if (message.method === "thread/start") {
          fake.send({
            id: message.id,
            result: { thread: { id: "thread-new" } },
          });
        } else if (message.method === "thread/resume") {
          fake.send({
            id: message.id,
            result: {
              thread: {
                id: message.params && (message.params as JsonObject).threadId,
              },
            },
          });
        } else if (message.method === "turn/start") {
          fake.send({ id: message.id, result: { turn: { id: "turn-new" } } });
        } else if (message.method === "turn/interrupt") {
          fake.send({ id: message.id, result: {} });
        }
      }),
    });

    try {
      equal(await client.startThread(), "thread-new");
      equal(await client.resumeThread("thread-existing"), "thread-existing");
      equal(await client.startTurn("thread-existing", "Run tests"), "turn-new");
      await client.interrupt("thread-existing", "turn-new");

      const requests = fake.received.filter((message) => "id" in message);
      deepStrictEqual(requests.map((request) => request.id), [1, 2, 3, 4, 5]);
      deepStrictEqual(requests[1], {
        method: "thread/start",
        id: 2,
        params: { cwd: "/workspace/project" },
      });
      deepStrictEqual(requests[2], {
        method: "thread/resume",
        id: 3,
        params: { threadId: "thread-existing", cwd: "/workspace/project" },
      });
      deepStrictEqual(requests[3], {
        method: "turn/start",
        id: 4,
        params: {
          threadId: "thread-existing",
          input: [{ type: "text", text: "Run tests", text_elements: [] }],
          cwd: "/workspace/project",
          effort: "ultra",
        },
      });
      deepStrictEqual(requests[4], {
        method: "turn/interrupt",
        id: 5,
        params: { threadId: "thread-existing", turnId: "turn-new" },
      });
    } finally {
      await client.close();
    }
  });

  it("correlates pending RPC responses by id even out of order", async () => {
    const fake = new FakeAppServerProcess();
    const client = await CodexAppServerClient.start({
      cwd: "/workspace/project",
      spawn: createSpawn(fake),
    });

    try {
      const started = client.startThread();
      const resumed = client.resumeThread("thread-existing");
      await waitFor(() => fake.received.length >= 4, "concurrent RPC requests");
      const startRequest = fake.received.find((message) =>
        message.method === "thread/start"
      )!;
      const resumeRequest = fake.received.find((message) =>
        message.method === "thread/resume"
      )!;

      fake.send({
        id: resumeRequest.id,
        result: { thread: { id: "resumed" } },
      });
      fake.send({ id: startRequest.id, result: { thread: { id: "started" } } });

      deepStrictEqual(await Promise.all([started, resumed]), [
        "started",
        "resumed",
      ]);
    } finally {
      await client.close();
    }
  });

  it("exposes scoped notification ids and selects the authoritative final message", async () => {
    const fake = new FakeAppServerProcess();
    const observed: Array<{ name: string; value: unknown }> = [];
    const client = await CodexAppServerClient.start({
      cwd: "/workspace/project",
      spawn: createSpawn(fake),
      callbacks: {
        onThreadStarted: (event) =>
          observed.push({ name: "thread", value: event }),
        onTurnStarted: (event) => observed.push({ name: "turn", value: event }),
        onAgentMessageDelta: (event) =>
          observed.push({ name: "delta", value: event }),
        onItemCompleted: (event) =>
          observed.push({ name: "item", value: event }),
        onTurnCompleted: (event) =>
          observed.push({ name: "completed", value: event }),
      },
    });

    try {
      fake.send({ method: "future/unknown", params: { ignored: true } });
      fake.send({
        method: "thread/started",
        params: { thread: { id: "thread-1" } },
      });
      fake.send({
        method: "turn/started",
        params: { threadId: "thread-1", turn: { id: "turn-1" } },
      });
      fake.send({
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "item-1",
          delta: "partial",
        },
      });
      fake.send({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            id: "item-1",
            text: "comment",
            phase: "commentary",
          },
        },
      });
      fake.send({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            type: "agentMessage",
            id: "item-2",
            text: "answer",
            phase: "final_answer",
          },
        },
      });
      fake.send({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed", error: null },
        },
      });

      await waitFor(
        () => observed.some((entry) => entry.name === "completed"),
        "turn completion callback",
      );
      deepStrictEqual(
        observed.find((entry) => entry.name === "thread")?.value,
        {
          threadId: "thread-1",
        },
      );
      deepStrictEqual(observed.find((entry) => entry.name === "turn")?.value, {
        threadId: "thread-1",
        turnId: "turn-1",
      });
      deepStrictEqual(observed.find((entry) => entry.name === "delta")?.value, {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "item-1",
        delta: "partial",
      });
      deepStrictEqual(
        observed.find((entry) => entry.name === "completed")?.value,
        {
          threadId: "thread-1",
          turnId: "turn-1",
          status: "completed",
          error: null,
          finalMessage: "answer",
        },
      );

      equal(
        selectFinalAgentMessage([
          { text: "first final", phase: "final_answer" },
          { text: "later commentary", phase: "commentary" },
          { text: "last final", phase: "final_answer" },
        ]),
        "last final",
      );
      equal(
        selectFinalAgentMessage([
          { text: "first", phase: null },
          { text: "last", phase: "commentary" },
        ]),
        "last",
      );
    } finally {
      await client.close();
    }
  });

  it("forwards known and unknown notifications to the generic callback", async () => {
    const fake = new FakeAppServerProcess();
    const notifications: Array<{
      method: string;
      params: Record<string, unknown>;
    }> = [];
    const client = await CodexAppServerClient.start({
      cwd: "/workspace/project",
      spawn: createSpawn(fake),
      callbacks: {
        onNotification: (notification) => notifications.push(notification),
      },
    });

    try {
      fake.send({
        method: "item/reasoning/summaryTextDelta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "reasoning-1",
          delta: "summary",
        },
      });
      fake.send({
        method: "item/commandExecution/outputDelta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "command-1",
          delta: "stdout",
        },
      });
      fake.send({
        method: "future/notification",
        params: { value: 1 },
      });

      await waitFor(
        () => notifications.length === 3,
        "generic notification callbacks",
      );
      deepStrictEqual(
        notifications.map((notification) => notification.method),
        [
          "item/reasoning/summaryTextDelta",
          "item/commandExecution/outputDelta",
          "future/notification",
        ],
      );
      deepStrictEqual(notifications[0].params, {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "reasoning-1",
        delta: "summary",
      });
      deepStrictEqual(notifications[1].params, {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-1",
        delta: "stdout",
      });
    } finally {
      await client.close();
    }
  });

  it("fails server requests closed and interrupts on requestUserInput", async () => {
    const fake = new FakeAppServerProcess();
    const userInputEvents: unknown[] = [];
    const diagnostics: string[] = [];
    const client = await CodexAppServerClient.start({
      cwd: "/workspace/project",
      spawn: createSpawn(fake, [], (message) => {
        if (message.method === "turn/interrupt") {
          fake.send({ id: message.id, result: {} });
        }
      }),
      callbacks: {
        onRequestUserInput: (event) => userInputEvents.push(event),
        onDiagnostic: (message) => diagnostics.push(message),
      },
    });

    try {
      fake.send({
        method: "item/commandExecution/requestApproval",
        id: 90,
        params: { threadId: "thread-1", turnId: "turn-1", itemId: "cmd-1" },
      });
      fake.send({
        method: "item/fileChange/requestApproval",
        id: 91,
        params: { threadId: "thread-1", turnId: "turn-1", itemId: "file-1" },
      });
      fake.send({
        method: "item/permissions/requestApproval",
        id: 92,
        params: { threadId: "thread-1", turnId: "turn-1", itemId: "perm-1" },
      });
      fake.send({
        method: "mcpServer/elicitation/request",
        id: 93,
        params: { threadId: "thread-1", turnId: "turn-1" },
      });
      fake.send({
        method: "item/tool/requestUserInput",
        id: 94,
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "question-1",
          questions: [{ id: "choice", question: "Choose" }],
        },
      });

      await waitFor(
        () =>
          fake.received.some((message) => message.method === "turn/interrupt"),
        "requestUserInput interrupt",
      );
      const responses = new Map(
        fake.received
          .filter((message) => !("method" in message) && "id" in message)
          .map((message) => [message.id, message]),
      );
      deepStrictEqual(responses.get(90), {
        id: 90,
        result: { decision: "decline" },
      });
      deepStrictEqual(responses.get(91), {
        id: 91,
        result: { decision: "decline" },
      });
      deepStrictEqual(responses.get(92), {
        id: 92,
        result: { permissions: {}, scope: "turn" },
      });
      deepStrictEqual(responses.get(93), {
        id: 93,
        result: { action: "decline", content: null, _meta: null },
      });
      deepStrictEqual(responses.get(94), { id: 94, result: { answers: {} } });
      deepStrictEqual(userInputEvents, [{
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "question-1",
        questions: [{ id: "choice", question: "Choose" }],
      }]);
      const interrupt = fake.received.find((message) =>
        message.method === "turn/interrupt"
      );
      deepStrictEqual(interrupt?.params, {
        threadId: "thread-1",
        turnId: "turn-1",
      });
      match(
        diagnostics.join(""),
        /Declined item\/commandExecution\/requestApproval: interactive approvals are disabled/,
      );
      match(
        diagnostics.join(""),
        /Declined item\/fileChange\/requestApproval: interactive approvals are disabled/,
      );
      match(
        diagnostics.join(""),
        /Declined item\/permissions\/requestApproval: permission grants are disabled/,
      );
      match(
        diagnostics.join(""),
        /Declined mcpServer\/elicitation\/request: MCP elicitation is disabled/,
      );
    } finally {
      await client.close();
    }
  });

  it("treats stderr as diagnostic and rejects pending RPCs on exit", async () => {
    const fake = new FakeAppServerProcess();
    const diagnostics: string[] = [];
    const exits: AppServerProcessStatus[] = [];
    const client = await CodexAppServerClient.start({
      cwd: "/workspace/project",
      spawn: createSpawn(fake),
      callbacks: {
        onDiagnostic: (message) => diagnostics.push(message),
        onExit: (status) => exits.push(status),
      },
    });
    const pending = client.startThread();
    await waitFor(
      () => fake.received.some((message) => message.method === "thread/start"),
      "pending thread request",
    );

    fake.sendStderr('{"method":"not-a-protocol-message"}\n');
    await waitFor(() => diagnostics.length > 0, "stderr diagnostic callback");
    fake.exit({ success: false, code: 7, signal: null });

    await rejects(pending, /App Server exited/);
    await waitFor(() => exits.length === 1, "exit callback");
    match(diagnostics.join(""), /not-a-protocol-message/);
    deepStrictEqual(exits, [{ success: false, code: 7, signal: null }]);
    ok(true);
  });

  it("times out an unresponsive RPC and terminates the process", async () => {
    const fake = new FakeAppServerProcess();
    const exits: AppServerProcessStatus[] = [];
    const client = await CodexAppServerClient.start({
      cwd: "/workspace/project",
      spawn: createSpawn(fake),
      rpcTimeoutMs: 10,
      terminationGraceMs: 10,
      callbacks: {
        onExit: (status) => exits.push(status),
      },
    });

    await assertRejects(
      () => client.interrupt("thread-1", "turn-1"),
      Error,
      "timed out",
    );
    await waitFor(() => exits.length === 1, "RPC timeout process exit");

    assertEquals(fake.killSignals, ["SIGTERM"]);
    assertEquals(exits, [{ success: false, code: 128, signal: "SIGTERM" }]);
    await client.close();
  });

  it("terminates a process that ignores stdin close", async () => {
    const fake = new FakeAppServerProcess({ exitOnStdinClose: false });
    const client = await CodexAppServerClient.start({
      cwd: "/workspace/project",
      spawn: createSpawn(fake),
      closeTimeoutMs: 10,
      terminationGraceMs: 10,
    });

    const status = await client.close();

    assertEquals(fake.killSignals, ["SIGTERM"]);
    assertEquals(status, { success: false, code: 128, signal: "SIGTERM" });
  });

  it("rejects within a final deadline when process status never settles", async () => {
    const fake = new FakeAppServerProcess({
      exitOnStdinClose: false,
      exitOnKill: false,
    });
    const client = await CodexAppServerClient.start({
      cwd: "/workspace/project",
      spawn: createSpawn(fake),
      closeTimeoutMs: 10,
      terminationGraceMs: 10,
    });

    const closing = client.close();
    const settled = await Promise.race([
      closing.then(() => "resolved" as const, () => "rejected" as const),
      new Promise<"pending">((resolve) =>
        setTimeout(() => resolve("pending"), 50)
      ),
    ]);
    if (settled === "pending") {
      fake.exit({ success: false, code: 128, signal: "SIGKILL" });
    }
    await closing.catch(() => undefined);

    assertEquals(settled, "rejected");
    assertEquals(fake.killSignals, ["SIGTERM", "SIGKILL"]);
  });
});
