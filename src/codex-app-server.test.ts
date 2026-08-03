import { deepStrictEqual, equal, match, rejects } from "node:assert/strict";
import { assertEquals, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";

import {
  type AppServerProcess,
  type AppServerProcessStatus,
  classifyAppServerMessage,
  CodexAppServerClient,
  type CodexAppServerLifecycleEvent,
  CodexRpcError,
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
  #statusResolved = false;
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
    this.closeStreams();
    this.resolveStatus(status);
  }

  resolveStatus(status: AppServerProcessStatus): void {
    if (this.#statusResolved) return;
    this.#statusResolved = true;
    this.#resolveStatus(status);
  }

  closeStreams(): void {
    if (this.#exited) return;
    this.#exited = true;
    this.#stdoutController.close();
    this.#stderrController.close();
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

function modelFixture(
  id: string,
  defaultEffort: string,
  efforts: readonly string[],
): JsonObject {
  return {
    id,
    model: id,
    displayName: `Display ${id}`,
    description: `Description for ${id}`,
    hidden: false,
    isDefault: id === "gpt-a",
    defaultReasoningEffort: defaultEffort,
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
      reasoningEffort,
      description: `${reasoningEffort} effort`,
    })),
  };
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

  it("spawns stdio App Server with process-only instructions and no bot secrets", async () => {
    const oldBotId = Deno.env.get("BOT_ID");
    const oldBotSecret = Deno.env.get("BOT_SECRET");
    const oldOwnerUserId = Deno.env.get("WECOM_OWNER_USER_ID");
    Deno.env.set("BOT_ID", "bot-id-secret");
    Deno.env.set("BOT_SECRET", "bot-secret-value");
    Deno.env.set("WECOM_OWNER_USER_ID", "owner-id-secret");

    const fake = new FakeAppServerProcess();
    const calls: Array<{ command: string; options: Deno.CommandOptions }> = [];
    let client: CodexAppServerClient | undefined;
    try {
      client = await CodexAppServerClient.start({
        cwd: "/workspace/project",
        developerInstructions: 'Owner "policy"\npath \\ workspace',
        spawn: createSpawn(fake, calls),
      });
      await waitFor(
        () => fake.received.some((message) => message.method === "initialized"),
        "initialized notification",
      );

      equal(calls.length, 1);
      equal(calls[0].command, "codex");
      deepStrictEqual(calls[0].options.args, [
        "-c",
        'developer_instructions="Owner \\"policy\\"\\npath \\\\ workspace"',
        "app-server",
        "--stdio",
      ]);
      equal(calls[0].options.cwd, "/workspace/project");
      equal(calls[0].options.clearEnv, true);
      equal(calls[0].options.env?.BOT_ID, undefined);
      equal(calls[0].options.env?.BOT_SECRET, undefined);
      equal(calls[0].options.env?.WECOM_OWNER_USER_ID, undefined);
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
      restoreEnv("WECOM_OWNER_USER_ID", oldOwnerUserId);
      await client?.close();
    }
  });
});

describe("CodexAppServerClient thread settings", () => {
  it("parses thread settings and sends exact owner authority context", async () => {
    const fake = new FakeAppServerProcess();
    const client = await CodexAppServerClient.start({
      cwd: "/workspace/project",
      spawn: createSpawn(fake, [], (message) => {
        if (message.method === "thread/start") {
          fake.send({
            id: message.id,
            result: {
              thread: { id: "thread-new" },
              model: "gpt-test",
              reasoningEffort: "medium",
            },
          });
        } else if (message.method === "thread/resume") {
          fake.send({
            id: message.id,
            result: {
              thread: {
                id: message.params && (message.params as JsonObject).threadId,
              },
              model: "gpt-test",
              reasoningEffort: "high",
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
      deepStrictEqual(await client.startThread(), {
        threadId: "thread-new",
        settings: { model: "gpt-test", effort: "medium" },
      });
      deepStrictEqual(await client.resumeThread("thread-existing"), {
        threadId: "thread-existing",
        settings: { model: "gpt-test", effort: "high" },
      });
      equal(
        await client.startTurn(
          "thread-existing",
          { text: "Run tests", localImagePaths: [] },
          "restricted",
        ),
        "turn-new",
      );
      equal(
        await client.startTurn(
          "thread-existing",
          {
            text: "Inspect attachments",
            localImagePaths: ["/tmp/one.png", "/tmp/two.jpg"],
          },
          "owner",
          { summary: "auto" },
        ),
        "turn-new",
      );
      await client.interrupt("thread-existing", "turn-new");

      const requests = fake.received.filter((message) => "id" in message);
      deepStrictEqual(
        requests.map((request) => request.id),
        [1, 2, 3, 4, 5, 6],
      );
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
          additionalContext: {
            wecom_owner_policy: {
              kind: "application",
              value: "Bot verified authority for the current turn: restricted",
            },
          },
        },
      });
      deepStrictEqual(requests[4], {
        method: "turn/start",
        id: 5,
        params: {
          threadId: "thread-existing",
          input: [
            {
              type: "text",
              text: "Inspect attachments",
              text_elements: [],
            },
            { type: "localImage", path: "/tmp/one.png" },
            { type: "localImage", path: "/tmp/two.jpg" },
          ],
          cwd: "/workspace/project",
          additionalContext: {
            wecom_owner_policy: {
              kind: "application",
              value: "Bot verified authority for the current turn: owner",
            },
          },
          summary: "auto",
        },
      });
      deepStrictEqual(requests[5], {
        method: "turn/interrupt",
        id: 6,
        params: { threadId: "thread-existing", turnId: "turn-new" },
      });
    } finally {
      await client.close();
    }
  });

  it("normalizes absent or null thread settings effort to null", async () => {
    const fake = new FakeAppServerProcess();
    const client = await CodexAppServerClient.start({
      cwd: "/workspace/project",
      spawn: createSpawn(fake, [], (message) => {
        if (message.method === "thread/start") {
          fake.send({
            id: message.id,
            result: { thread: { id: "thread-new" }, model: "gpt-test" },
          });
        } else if (message.method === "thread/resume") {
          fake.send({
            id: message.id,
            result: {
              thread: { id: "thread-existing" },
              model: "gpt-test",
              reasoningEffort: null,
            },
          });
        }
      }),
    });

    try {
      deepStrictEqual(await client.startThread(), {
        threadId: "thread-new",
        settings: { model: "gpt-test", effort: null },
      });
      deepStrictEqual(await client.resumeThread("thread-existing"), {
        threadId: "thread-existing",
        settings: { model: "gpt-test", effort: null },
      });
    } finally {
      await client.close();
    }
  });

  it("propagates a rejected contextual turn RPC without retrying", async () => {
    const fake = new FakeAppServerProcess();
    const client = await CodexAppServerClient.start({
      cwd: "/workspace/project",
      spawn: createSpawn(fake, [], (message) => {
        if (message.method === "turn/start") {
          fake.send({
            id: message.id,
            error: { code: -32602, message: "context rejected" },
          });
        }
      }),
    });

    try {
      const error = await assertRejects(
        () =>
          client.startTurn(
            "thread-existing",
            { text: "Run tests", localImagePaths: [] },
            "restricted",
          ),
        CodexRpcError,
        "context rejected",
      );
      assertEquals(error.code, -32602);
      const requests = fake.received.filter((message) =>
        message.method === "turn/start"
      );
      assertEquals(requests.length, 1);
      deepStrictEqual(requests[0].params, {
        threadId: "thread-existing",
        input: [{ type: "text", text: "Run tests", text_elements: [] }],
        cwd: "/workspace/project",
        additionalContext: {
          wecom_owner_policy: {
            kind: "application",
            value: "Bot verified authority for the current turn: restricted",
          },
        },
      });
    } finally {
      await client.close();
    }
  });

  it("rejects malformed thread settings responses", async () => {
    const fake = new FakeAppServerProcess();
    let startCount = 0;
    const client = await CodexAppServerClient.start({
      cwd: "/workspace/project",
      spawn: createSpawn(fake, [], (message) => {
        if (message.method !== "thread/start") return;
        startCount += 1;
        fake.send({
          id: message.id,
          result: startCount === 1
            ? { thread: { id: "thread-new" }, reasoningEffort: "medium" }
            : {
              thread: { id: "thread-new" },
              model: "gpt-test",
              reasoningEffort: "",
            },
        });
      }),
    });

    try {
      await rejects(client.startThread(), /missing model/);
      await rejects(client.startThread(), /missing reasoningEffort/);
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
        result: {
          thread: { id: "resumed" },
          model: "gpt-resumed",
          reasoningEffort: null,
        },
      });
      fake.send({
        id: startRequest.id,
        result: {
          thread: { id: "started" },
          model: "gpt-started",
          reasoningEffort: "low",
        },
      });

      deepStrictEqual(await Promise.all([started, resumed]), [
        {
          threadId: "started",
          settings: { model: "gpt-started", effort: "low" },
        },
        {
          threadId: "resumed",
          settings: { model: "gpt-resumed", effort: null },
        },
      ]);
    } finally {
      await client.close();
    }
  });
});

describe("CodexAppServerClient lists models and updates settings", () => {
  it("lists models and updates thread and config settings", async () => {
    const fake = new FakeAppServerProcess();
    const pageOneModel = modelFixture("gpt-a", "medium", ["low", "medium"]);
    const pageTwoModel = modelFixture("gpt-b", "high", ["medium", "high"]);
    const client = await CodexAppServerClient.start({
      cwd: "/workspace/project",
      spawn: createSpawn(fake, [], (message) => {
        if (message.method === "model/list") {
          const params = message.params as JsonObject;
          fake.send({
            id: message.id,
            result: params.cursor === null
              ? { data: [pageOneModel], nextCursor: "page-2" }
              : { data: [pageTwoModel], nextCursor: null },
          });
        } else if (message.method === "config/read") {
          fake.send({
            id: message.id,
            result: {
              config: {
                model: "gpt-a",
                model_reasoning_effort: "medium",
              },
            },
          });
        } else if (
          message.method === "thread/settings/update" ||
          message.method === "config/batchWrite"
        ) {
          fake.send({ id: message.id, result: {} });
        }
      }),
    });

    try {
      deepStrictEqual(await client.listModels(), [pageOneModel, pageTwoModel]);
      deepStrictEqual(await client.readConfigDefaults(), {
        model: "gpt-a",
        effort: "medium",
      });
      await client.updateThreadSettings("thread-1", {
        model: "gpt-b",
        effort: "high",
      });
      await client.writeConfigDefaults({ model: "gpt-b", effort: "high" });
      await client.writeConfigDefaults({});

      const modelRequests = fake.received.filter((message) =>
        message.method === "model/list"
      );
      deepStrictEqual(modelRequests.map(({ params }) => params), [
        { cursor: null, limit: 100, includeHidden: true },
        { cursor: "page-2", limit: 100, includeHidden: true },
      ]);
      const configRead = fake.received.find((message) =>
        message.method === "config/read"
      )!;
      deepStrictEqual(configRead.params, {
        cwd: "/workspace/project",
        includeLayers: false,
      });
      const threadUpdate = fake.received.find((message) =>
        message.method === "thread/settings/update"
      )!;
      deepStrictEqual(threadUpdate.params, {
        threadId: "thread-1",
        model: "gpt-b",
        effort: "high",
      });
      const configWrites = fake.received.filter((message) =>
        message.method === "config/batchWrite"
      );
      equal(configWrites.length, 1);
      deepStrictEqual(configWrites[0].params, {
        edits: [
          { keyPath: "model", value: "gpt-b", mergeStrategy: "upsert" },
          {
            keyPath: "model_reasoning_effort",
            value: "high",
            mergeStrategy: "upsert",
          },
        ],
        reloadUserConfig: false,
      });
    } finally {
      await client.close();
    }
  });

  it("rejects malformed model catalog entries", async () => {
    const fake = new FakeAppServerProcess();
    const invalidModel = modelFixture("gpt-a", "medium", ["medium"]);
    invalidModel.supportedReasoningEfforts = [{ reasoningEffort: "medium" }];
    const client = await CodexAppServerClient.start({
      cwd: "/workspace/project",
      spawn: createSpawn(fake, [], (message) => {
        if (message.method === "model/list") {
          fake.send({
            id: message.id,
            result: { data: [invalidModel], nextCursor: null },
          });
        }
      }),
    });

    try {
      await rejects(
        client.listModels(),
        /supportedReasoningEfforts\[0\]\.description/,
      );
    } finally {
      await client.close();
    }
  });

  it("normalizes absent config defaults and rejects malformed values", async () => {
    const fake = new FakeAppServerProcess();
    let readCount = 0;
    const client = await CodexAppServerClient.start({
      cwd: "/workspace/project",
      spawn: createSpawn(fake, [], (message) => {
        if (message.method !== "config/read") return;
        readCount += 1;
        fake.send({
          id: message.id,
          result: readCount === 1 ? { config: {} } : { config: { model: 42 } },
        });
      }),
    });

    try {
      deepStrictEqual(await client.readConfigDefaults(), {
        model: null,
        effort: null,
      });
      await rejects(client.readConfigDefaults(), /config\.model/);
    } finally {
      await client.close();
    }
  });
});

describe("CodexAppServerClient", () => {
  it("exposes consumed scoped notifications and selects the authoritative final message", async () => {
    const fake = new FakeAppServerProcess();
    const observed: Array<{ name: string; value: unknown }> = [];
    const client = await CodexAppServerClient.start({
      cwd: "/workspace/project",
      spawn: createSpawn(fake),
      callbacks: {
        onThreadStarted: (event) =>
          observed.push({ name: "thread", value: event }),
        onTurnCompleted: (event) =>
          observed.push({ name: "completed", value: event }),
      },
    });

    try {
      fake.send({ method: "future/unknown", params: { ignored: true } });
      fake.send({
        method: "thread/started",
        params: {
          thread: {
            id: "child-1",
            parentThreadId: "parent-1",
            agentNickname: "amber-otter",
            agentRole: "reviewer",
            name: "Review API",
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
          threadId: "child-1",
          parentThreadId: "parent-1",
          agentNickname: "amber-otter",
          agentRole: "reviewer",
          name: "Review API",
        },
      );
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
    const lifecycleEvents: CodexAppServerLifecycleEvent[] = [];
    const client = await CodexAppServerClient.start({
      cwd: "/workspace/project",
      spawn: createSpawn(fake),
      callbacks: {
        onLifecycle: (event) => lifecycleEvents.push(event),
        onNotification: (notification) => notifications.push(notification),
      },
    });

    try {
      fake.send({
        method: "turn/started",
        params: { threadId: "thread-1", turn: { id: "turn-1" } },
      });
      fake.send({
        method: "item/agentMessage/delta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "message-1",
          delta: "partial",
        },
      });
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
      fake.send({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turn: { id: "turn-1", status: "completed", error: null },
        },
      });

      await waitFor(
        () => notifications.length === 6,
        "generic notification callbacks",
      );
      deepStrictEqual(
        notifications.map((notification) => notification.method),
        [
          "turn/started",
          "item/agentMessage/delta",
          "item/reasoning/summaryTextDelta",
          "item/commandExecution/outputDelta",
          "future/notification",
          "turn/completed",
        ],
      );
      deepStrictEqual(notifications[0].params, {
        threadId: "thread-1",
        turn: { id: "turn-1" },
      });
      deepStrictEqual(notifications[1].params, {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "message-1",
        delta: "partial",
      });
      deepStrictEqual(notifications[2].params, {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "reasoning-1",
        delta: "summary",
      });
      deepStrictEqual(notifications[3].params, {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-1",
        delta: "stdout",
      });
      deepStrictEqual(
        lifecycleEvents.filter((event) => event.event === "item_delta").map(
          (
            {
              event,
              level,
              method,
              threadId,
              turnId,
              itemId,
              deltaLength,
              deltaChunks,
            },
          ) => ({
            event,
            level,
            method,
            threadId,
            turnId,
            itemId,
            deltaLength,
            deltaChunks,
          }),
        ),
        [
          {
            event: "item_delta",
            level: "debug",
            method: "item/agentMessage/delta",
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "message-1",
            deltaLength: 7,
            deltaChunks: 1,
          },
          {
            event: "item_delta",
            level: "debug",
            method: "item/reasoning/summaryTextDelta",
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "reasoning-1",
            deltaLength: 7,
            deltaChunks: 1,
          },
          {
            event: "item_delta",
            level: "debug",
            method: "item/commandExecution/outputDelta",
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "command-1",
            deltaLength: 6,
            deltaChunks: 1,
          },
        ],
      );
      const lifecycleJson = JSON.stringify(lifecycleEvents);
      assertEquals(lifecycleJson.includes('"delta":"partial"'), false);
      assertEquals(lifecycleJson.includes('"delta":"summary"'), false);
      assertEquals(lifecycleJson.includes('"delta":"stdout"'), false);

      fake.send({
        method: "guardianWarning",
        params: { message: "sandbox warning" },
      });
      await waitFor(
        () =>
          lifecycleEvents.some((event) => event.method === "guardianWarning"),
        "guardian warning lifecycle",
      );
      const guardianWarning = lifecycleEvents.find((event) =>
        event.method === "guardianWarning"
      );
      assertEquals(guardianWarning?.event, "server_warning");
      assertEquals(guardianWarning?.level, "warn");
    } finally {
      await client.close();
    }
  });

  it("aggregates repeated delta chunks until the item completes", async () => {
    const fake = new FakeAppServerProcess();
    const lifecycleEvents: CodexAppServerLifecycleEvent[] = [];
    const client = await CodexAppServerClient.start({
      cwd: "/workspace/project",
      spawn: createSpawn(fake),
      callbacks: {
        onLifecycle: (event) => lifecycleEvents.push(event),
      },
    });

    try {
      for (const delta of ["first", "second"]) {
        fake.send({
          method: "item/commandExecution/outputDelta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "command-1",
            delta,
          },
        });
      }
      fake.send({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: {
            id: "command-1",
            type: "commandExecution",
            status: "completed",
          },
        },
      });

      await waitFor(
        () => lifecycleEvents.some((event) => event.event === "item_completed"),
        "completed item lifecycle",
      );
      const deltas = lifecycleEvents.filter((event) =>
        event.event === "item_delta"
      );
      deepStrictEqual(deltas, [{
        level: "debug",
        event: "item_delta",
        method: "item/commandExecution/outputDelta",
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "command-1",
        itemType: undefined,
        deltaChunks: 2,
        deltaLength: 11,
      }]);
    } finally {
      await client.close();
    }
  });

  it("fails server requests closed and interrupts on requestUserInput", async () => {
    const fake = new FakeAppServerProcess();
    const userInputEvents: unknown[] = [];
    const lifecycleEvents: CodexAppServerLifecycleEvent[] = [];
    const client = await CodexAppServerClient.start({
      cwd: "/workspace/project",
      spawn: createSpawn(fake, [], (message) => {
        if (message.method === "turn/interrupt") {
          fake.send({ id: message.id, result: {} });
        }
      }),
      callbacks: {
        onLifecycle: (event) => lifecycleEvents.push(event),
        onRequestUserInput: (event) => userInputEvents.push(event),
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
      deepStrictEqual(
        lifecycleEvents.filter((event) =>
          event.event === "server_request_declined"
        ).map(({ method, requestId, policy, threadId, turnId, itemId }) => ({
          method,
          requestId,
          policy,
          threadId,
          turnId,
          itemId,
        })),
        [
          {
            method: "item/commandExecution/requestApproval",
            requestId: 90,
            policy: "interactive_approval_disabled",
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "cmd-1",
          },
          {
            method: "item/fileChange/requestApproval",
            requestId: 91,
            policy: "interactive_approval_disabled",
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "file-1",
          },
          {
            method: "item/permissions/requestApproval",
            requestId: 92,
            policy: "permission_grant_disabled",
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "perm-1",
          },
          {
            method: "mcpServer/elicitation/request",
            requestId: 93,
            policy: "mcp_elicitation_disabled",
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: undefined,
          },
        ],
      );
    } finally {
      await client.close();
    }
  });

  it("separates stderr and closes pending RPC lifecycles on exit", async () => {
    const fake = new FakeAppServerProcess();
    const stderr: string[] = [];
    const lifecycleEvents: CodexAppServerLifecycleEvent[] = [];
    const exits: AppServerProcessStatus[] = [];
    const client = await CodexAppServerClient.start({
      cwd: "/workspace/project",
      spawn: createSpawn(fake),
      callbacks: {
        onStderr: (message) => stderr.push(message),
        onLifecycle: (event) => lifecycleEvents.push(event),
        onExit: (status) => exits.push(status),
      },
    });
    const pending = client.startThread();
    await waitFor(
      () => fake.received.some((message) => message.method === "thread/start"),
      "pending thread request",
    );

    fake.sendStderr('{"method":"not-a-protocol-message"}\n');
    await waitFor(() => stderr.length > 0, "stderr callback");
    fake.exit({ success: false, code: 7, signal: null });

    await rejects(pending, /App Server exited/);
    await waitFor(() => exits.length === 1, "exit callback");
    match(stderr.join(""), /not-a-protocol-message/);
    deepStrictEqual(
      lifecycleEvents.filter((event) => event.event === "rpc_failed").map(
        ({ method, requestId, failure }) => ({ method, requestId, failure }),
      ),
      [{ method: "thread/start", requestId: 2, failure: "process_exit" }],
    );
    deepStrictEqual(exits, [{ success: false, code: 7, signal: null }]);
  });

  it("drains buffered stdout before flushing delta aggregates on exit", async () => {
    const fake = new FakeAppServerProcess();
    const lifecycleEvents: CodexAppServerLifecycleEvent[] = [];
    const client = await CodexAppServerClient.start({
      cwd: "/workspace/project",
      spawn: createSpawn(fake),
      callbacks: {
        onLifecycle: (event) => lifecycleEvents.push(event),
      },
    });

    fake.resolveStatus({ success: false, code: 9, signal: null });
    await Promise.resolve();
    fake.send({
      method: "item/reasoning/summaryTextDelta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "reasoning-1",
        delta: "private summary",
      },
    });
    fake.closeStreams();

    await waitFor(
      () => lifecycleEvents.some((event) => event.event === "process_exited"),
      "process exit after stdout drain",
    );
    const deltaIndex = lifecycleEvents.findIndex((event) =>
      event.event === "item_delta"
    );
    const exitIndex = lifecycleEvents.findIndex((event) =>
      event.event === "process_exited"
    );
    assertEquals(deltaIndex >= 0, true);
    assertEquals(deltaIndex < exitIndex, true);
    deepStrictEqual(lifecycleEvents[deltaIndex], {
      level: "debug",
      event: "item_delta",
      method: "item/reasoning/summaryTextDelta",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "reasoning-1",
      itemType: undefined,
      deltaChunks: 1,
      deltaLength: 15,
    });
    await client.close();
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
