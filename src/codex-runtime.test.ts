import {
  assertEquals,
  assertMatch,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
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
  type CodexRuntimeTrace,
} from "./codex-runtime.ts";
import type { ActivityEvent } from "./activity-event.ts";
import type { CodexTurnOptions } from "./codex-turn.ts";
import type {
  CodexModel,
  CodexSettings,
  CodexThreadSession,
  ConfigDefaults,
  SettingsPatch,
} from "./model-settings.ts";
import type { RequestAuthority } from "./owner-policy.ts";

const EXITED: AppServerProcessStatus = {
  success: false,
  code: 1,
  signal: null,
};

function modelFixture(
  model: string,
  defaultReasoningEffort: string,
  efforts: readonly string[],
): CodexModel {
  return {
    id: model,
    model,
    displayName: model,
    description: `${model} description`,
    hidden: false,
    isDefault: false,
    defaultReasoningEffort,
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({
      reasoningEffort,
      description: `${reasoningEffort} description`,
    })),
  };
}

class FakeClient implements CodexRuntimeClient {
  callbacks: CodexAppServerCallbacks = {};
  models: CodexModel[] = [
    modelFixture("gpt-a", "medium", ["low", "medium"]),
  ];
  configDefaults: ConfigDefaults = { model: "gpt-a", effort: "medium" };
  readonly threadSettings = new Map<string, CodexSettings>();
  readonly startedThreads: string[] = [];
  readonly resumedThreads: string[] = [];
  readonly startedTurns: Array<{
    threadId: string;
    prompt: string;
    authority: RequestAuthority;
    options?: CodexTurnOptions;
  }> = [];
  readonly interruptedTurns: Array<{ threadId: string; turnId: string }> = [];
  readonly threadUpdates: Array<{ threadId: string; patch: SettingsPatch }> =
    [];
  readonly configWrites: SettingsPatch[] = [];
  readonly resumeBehaviors: Array<() => Promise<CodexThreadSession>> = [];
  readonly modelListBehaviors: Array<() => Promise<CodexModel[]>> = [];
  readonly threadUpdateBehaviors: Array<() => Promise<void>> = [];
  readonly configWriteBehaviors: Array<() => Promise<void>> = [];
  readonly turnIds: Array<string | Promise<string>> = [];
  listModelCalls = 0;
  configReadCalls = 0;
  closeCalls = 0;

  startThread(): Promise<CodexThreadSession> {
    const threadId = `thread-${this.startedThreads.length + 1}`;
    this.startedThreads.push(threadId);
    return Promise.resolve({
      threadId,
      settings: this.threadSettings.get(threadId) ?? {
        model: "gpt-a",
        effort: "medium",
      },
    });
  }

  resumeThread(threadId: string): Promise<CodexThreadSession> {
    this.resumedThreads.push(threadId);
    const behavior = this.resumeBehaviors.shift();
    if (behavior) return behavior();
    return Promise.resolve({
      threadId,
      settings: this.threadSettings.get(threadId) ?? {
        model: "gpt-a",
        effort: "medium",
      },
    });
  }

  listModels(): Promise<CodexModel[]> {
    this.listModelCalls++;
    return this.modelListBehaviors.shift()?.() ?? Promise.resolve(this.models);
  }

  readConfigDefaults(): Promise<ConfigDefaults> {
    this.configReadCalls++;
    return Promise.resolve(this.configDefaults);
  }

  updateThreadSettings(
    threadId: string,
    patch: SettingsPatch,
  ): Promise<void> {
    this.threadUpdates.push({ threadId, patch });
    return this.threadUpdateBehaviors.shift()?.() ?? Promise.resolve();
  }

  writeConfigDefaults(patch: SettingsPatch): Promise<void> {
    this.configWrites.push(patch);
    return this.configWriteBehaviors.shift()?.() ?? Promise.resolve();
  }

  async startTurn(
    threadId: string,
    prompt: string,
    authority: RequestAuthority,
    options?: CodexTurnOptions,
  ): Promise<string> {
    this.startedTurns.push({
      threadId,
      prompt,
      authority,
      ...(options ? { options } : {}),
    });
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
  reject: (reason?: unknown) => void;
} {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  return { promise, resolve, reject };
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

describe("CodexRuntime caches thread model settings", () => {
  it("caches thread model settings from starts and coalesced resumes", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    factory.queue.push(client);
    const runtime = runtimeWith(factory);
    await runtime.start();

    assertEquals(await runtime.startThread(), "thread-1");
    await runtime.resumeThread("thread-1");
    await runtime.resumeThread("thread-existing");
    await runtime.resumeThread("thread-existing");

    assertEquals(client.resumedThreads, ["thread-existing"]);
    await runtime.stop();
  });
});

describe("CodexRuntime validates model settings", () => {
  it("resolves bound and default model settings snapshots", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    factory.queue.push(client);
    const runtime = runtimeWith(factory);
    await runtime.start();

    await runtime.resumeThread("thread-1");
    assertEquals(await runtime.getModelSettings("thread-1"), {
      settings: { model: "gpt-a", effort: "medium" },
      selectedModel: client.models[0],
      models: client.models,
      source: "thread",
    });
    assertEquals(await runtime.getModelSettings(), {
      settings: { model: "gpt-a", effort: "medium" },
      selectedModel: client.models[0],
      models: client.models,
      source: "default",
    });
    await runtime.stop();
  });

  it("preserves bound thread settings when the model is absent from the catalog", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    client.threadSettings.set("thread-custom", {
      model: "custom-thread-model",
      effort: "ultra",
    });
    factory.queue.push(client);
    const runtime = runtimeWith(factory);
    await runtime.start();

    assertEquals(await runtime.getModelSettings("thread-custom"), {
      settings: { model: "custom-thread-model", effort: "ultra" },
      selectedModel: null,
      models: client.models,
      source: "thread",
    });
    assertEquals(client.resumedThreads, ["thread-custom"]);
    await runtime.stop();
  });

  it("preserves custom config defaults with and without an explicit effort", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    client.configDefaults = {
      model: "project-custom-model",
      effort: "high",
    };
    factory.queue.push(client);
    const runtime = runtimeWith(factory);
    await runtime.start();

    assertEquals(await runtime.getModelSettings(), {
      settings: { model: "project-custom-model", effort: "high" },
      selectedModel: null,
      models: client.models,
      source: "default",
    });

    client.configDefaults = {
      model: "project-custom-with-model-default",
      effort: null,
    };
    assertEquals(await runtime.getModelSettings(), {
      settings: {
        model: "project-custom-with-model-default",
        effort: null,
      },
      selectedModel: null,
      models: client.models,
      source: "default",
    });
    await runtime.stop();
  });

  it("uses catalog defaults only when config omits a model or its effort", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    const catalogDefault = modelFixture("gpt-default", "high", [
      "medium",
      "high",
    ]);
    catalogDefault.isDefault = true;
    client.models.push(catalogDefault);
    client.configDefaults = { model: null, effort: null };
    factory.queue.push(client);
    const runtime = runtimeWith(factory);
    await runtime.start();

    assertEquals((await runtime.getModelSettings()).settings, {
      model: "gpt-default",
      effort: "high",
    });

    client.configDefaults = { model: "gpt-a", effort: null };
    assertEquals((await runtime.getModelSettings()).settings, {
      model: "gpt-a",
      effort: "medium",
    });
    await runtime.stop();
  });

  it("rejects unknown models without writing settings", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    factory.queue.push(client);
    const runtime = runtimeWith(factory);
    await runtime.start();

    assertEquals(await runtime.setModel("thread-1", "missing-model"), {
      status: "invalid_model",
      availableModels: ["gpt-a"],
    });
    assertEquals(client.threadUpdates, []);
    assertEquals(client.configWrites, []);
    await runtime.stop();
  });

  it("rejects unsupported efforts without writing settings", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    factory.queue.push(client);
    const runtime = runtimeWith(factory);
    await runtime.start();

    assertEquals(await runtime.setEffort("thread-1", "high"), {
      status: "invalid_effort",
      model: "gpt-a",
      availableEfforts: ["low", "medium"],
    });
    assertEquals(client.threadUpdates, []);
    assertEquals(client.configWrites, []);
    await runtime.stop();
  });

  it("rejects effort changes for uncatalogued models but still allows a catalog model switch", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    client.threadSettings.set("thread-custom", {
      model: "custom-thread-model",
      effort: "ultra",
    });
    factory.queue.push(client);
    const runtime = runtimeWith(factory);
    await runtime.start();

    assertEquals(await runtime.setEffort("thread-custom", "high"), {
      status: "invalid_effort",
      model: "custom-thread-model",
      availableEfforts: [],
    });
    assertEquals(client.threadUpdates, []);
    assertEquals(client.configWrites, []);

    assertEquals(await runtime.setModel("thread-custom", "gpt-a"), {
      status: "updated",
      settings: { model: "gpt-a", effort: "medium" },
      threadUpdated: true,
      defaultPersisted: true,
      effortAdjusted: true,
    });
    assertEquals(client.threadUpdates, [{
      threadId: "thread-custom",
      patch: { model: "gpt-a", effort: "medium" },
    }]);
    assertEquals(client.configWrites, [{
      model: "gpt-a",
      effort: "medium",
    }]);
    await runtime.stop();
  });
});

describe("CodexRuntime updates model settings", () => {
  it("adjusts an unsupported effort when switching a bound thread model", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    client.models.push(modelFixture("gpt-b", "high", ["high"]));
    factory.queue.push(client);
    const runtime = runtimeWith(factory);
    await runtime.start();

    assertEquals(await runtime.setModel("thread-1", "gpt-b"), {
      status: "updated",
      settings: { model: "gpt-b", effort: "high" },
      threadUpdated: true,
      defaultPersisted: true,
      effortAdjusted: true,
    });
    assertEquals(client.threadUpdates[0], {
      threadId: "thread-1",
      patch: { model: "gpt-b", effort: "high" },
    });
    assertEquals(client.configWrites[0], {
      model: "gpt-b",
      effort: "high",
    });
    await runtime.stop();
  });

  it("updates effort without replacing the selected model", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    factory.queue.push(client);
    const runtime = runtimeWith(factory);
    await runtime.start();

    assertEquals(await runtime.setEffort("thread-1", "low"), {
      status: "updated",
      settings: { model: "gpt-a", effort: "low" },
      threadUpdated: true,
      defaultPersisted: true,
      effortAdjusted: false,
    });
    assertEquals(client.threadUpdates[0], {
      threadId: "thread-1",
      patch: { effort: "low" },
    });
    assertEquals(client.configWrites[0], {
      model: "gpt-a",
      effort: "low",
    });
    await runtime.stop();
  });

  it("keeps a successful thread update when default persistence fails", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    client.models.push(modelFixture("gpt-b", "high", ["high"]));
    client.configWriteBehaviors.push(() =>
      Promise.reject(new Error("config unavailable"))
    );
    factory.queue.push(client);
    const runtime = runtimeWith(factory);
    await runtime.start();

    assertEquals(await runtime.setModel("thread-1", "gpt-b"), {
      status: "updated",
      settings: { model: "gpt-b", effort: "high" },
      threadUpdated: true,
      defaultPersisted: false,
      effortAdjusted: true,
      persistenceError: "config unavailable",
    });
    assertEquals((await runtime.getModelSettings("thread-1")).settings, {
      model: "gpt-b",
      effort: "high",
    });
    assertEquals(client.resumedThreads, ["thread-1"]);
    await runtime.stop();
  });

  it("returns a complete persistence failure when no thread is bound", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    client.configWriteBehaviors.push(() =>
      Promise.reject(new Error("defaults read-only"))
    );
    factory.queue.push(client);
    const runtime = runtimeWith(factory);
    await runtime.start();

    assertEquals(await runtime.setEffort(undefined, "low"), {
      status: "updated",
      settings: { model: "gpt-a", effort: "low" },
      threadUpdated: false,
      defaultPersisted: false,
      effortAdjusted: false,
      persistenceError: "defaults read-only",
    });
    assertEquals(client.threadUpdates, []);
    await runtime.stop();
  });

  it("does not persist defaults after a thread update fails", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    client.threadUpdateBehaviors.push(() =>
      Promise.reject(new Error("thread unavailable"))
    );
    factory.queue.push(client);
    const runtime = runtimeWith(factory);
    await runtime.start();

    await assertRejects(
      () => runtime.setEffort("thread-1", "low"),
      Error,
      "thread unavailable",
    );
    assertEquals(client.configWrites, []);
    await runtime.stop();
  });
});

describe("CodexRuntime serializes mixed model and effort updates", () => {
  it("validates a queued effort against the preceding model update", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    const modelUpdate = deferred<void>();
    client.models.push(modelFixture("gpt-b", "high", ["high"]));
    client.threadUpdateBehaviors.push(
      () => modelUpdate.promise,
      () => Promise.resolve(),
    );
    factory.queue.push(client);
    const runtime = runtimeWith(factory);
    await runtime.start();

    const settingModel = runtime.setModel("thread-1", "gpt-b");
    await waitFor(
      () => client.threadUpdates.length === 1,
      "blocked model update",
    );
    const settingEffort = runtime.setEffort("thread-1", "high");

    modelUpdate.resolve();
    assertEquals(await settingModel, {
      status: "updated",
      settings: { model: "gpt-b", effort: "high" },
      threadUpdated: true,
      defaultPersisted: true,
      effortAdjusted: true,
    });
    assertEquals(await settingEffort, {
      status: "updated",
      settings: { model: "gpt-b", effort: "high" },
      threadUpdated: true,
      defaultPersisted: true,
      effortAdjusted: false,
    });
    assertEquals(client.threadUpdates, [
      {
        threadId: "thread-1",
        patch: { model: "gpt-b", effort: "high" },
      },
      { threadId: "thread-1", patch: { effort: "high" } },
    ]);
    assertEquals((await runtime.getModelSettings("thread-1")).settings, {
      model: "gpt-b",
      effort: "high",
    });
    await runtime.stop();
  });
});

describe("CodexRuntime serializes default settings mutations", () => {
  it("validates a queued effort against defaults written by the preceding model change", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    const modelWrite = deferred<void>();
    client.models.push(modelFixture("gpt-b", "high", ["high"]));
    client.configWriteBehaviors.push(async () => {
      await modelWrite.promise;
      client.configDefaults = {
        ...client.configDefaults,
        ...client.configWrites[0],
      };
    });
    factory.queue.push(client);
    const runtime = runtimeWith(factory);
    await runtime.start();

    const settingModel = runtime.setModel(undefined, "gpt-b");
    await waitFor(
      () => client.configWrites.length === 1,
      "blocked default model write",
    );
    const settingEffort = runtime.setEffort(undefined, "low");
    await Promise.resolve();
    const readsWhileModelWriteBlocked = client.configReadCalls;

    modelWrite.resolve();
    assertEquals(await settingModel, {
      status: "updated",
      settings: { model: "gpt-b", effort: "high" },
      threadUpdated: false,
      defaultPersisted: true,
      effortAdjusted: true,
    });
    const effortResult = await settingEffort;
    await runtime.stop();

    assertEquals(readsWhileModelWriteBlocked, 1);
    assertEquals(effortResult, {
      status: "invalid_effort",
      model: "gpt-b",
      availableEfforts: ["high"],
    });
    assertEquals(client.configReadCalls, 2);
    assertEquals(client.configWrites, [{ model: "gpt-b", effort: "high" }]);
  });

  it("persists complete defaults after concurrent updates to different threads", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    const modelWrite = deferred<void>();
    client.models.push(modelFixture("gpt-b", "high", ["high"]));
    client.threadSettings.set("thread-a", {
      model: "gpt-a",
      effort: "medium",
    });
    client.threadSettings.set("thread-b", {
      model: "gpt-a",
      effort: "medium",
    });
    client.configWriteBehaviors.push(
      async () => {
        await modelWrite.promise;
        client.configDefaults = {
          ...client.configDefaults,
          ...client.configWrites[0],
        };
      },
      () => {
        client.configDefaults = {
          ...client.configDefaults,
          ...client.configWrites[1],
        };
        return Promise.resolve();
      },
    );
    factory.queue.push(client);
    const runtime = runtimeWith(factory);
    await runtime.start();
    await Promise.all([
      runtime.resumeThread("thread-a"),
      runtime.resumeThread("thread-b"),
    ]);

    const settingModel = runtime.setModel("thread-a", "gpt-b");
    await waitFor(
      () => client.configWrites.length === 1,
      "blocked thread model default write",
    );
    const settingEffort = runtime.setEffort("thread-b", "low");
    await waitFor(
      () => client.threadUpdates.length === 2,
      "concurrent thread effort update",
    );
    const threadUpdatesWhileModelWriteBlocked = client.threadUpdates.length;

    modelWrite.resolve();
    await Promise.all([settingModel, settingEffort]);
    await runtime.stop();

    assertEquals(threadUpdatesWhileModelWriteBlocked, 2);
    assertEquals(client.configWrites, [
      { model: "gpt-b", effort: "high" },
      { model: "gpt-a", effort: "low" },
    ]);
    assertEquals(client.configDefaults, {
      model: "gpt-a",
      effort: "low",
    });
  });
});

describe("CodexRuntime isolates queued settings across restart", () => {
  it("drops queued old-generation thread updates without blocking new work", async () => {
    const factory = new FakeFactory();
    const firstClient = new FakeClient();
    const replacement = new FakeClient();
    const oldThreadUpdate = deferred<void>();
    firstClient.threadUpdateBehaviors.push(() => oldThreadUpdate.promise);
    factory.queue.push(firstClient, replacement);
    const runtime = runtimeWith(factory);
    await runtime.start();

    const oldInFlight = runtime.setEffort("thread-1", "low");
    await waitFor(
      () => firstClient.threadUpdates.length === 1,
      "old in-flight thread update",
    );
    const oldQueued = runtime.setEffort("thread-1", "medium");

    firstClient.exit();
    await waitFor(
      () => runtime.ready && runtime.generation === 2,
      "thread queue runtime restart",
    );
    const current = runtime.setEffort("thread-1", "low");
    await waitFor(
      () => replacement.threadUpdates.length === 1,
      "new-generation thread update",
    );
    assertEquals(replacement.threadUpdates, [{
      threadId: "thread-1",
      patch: { effort: "low" },
    }]);

    oldThreadUpdate.resolve();
    await assertRejects(
      () => oldInFlight,
      Error,
      "runtime changed while updating thread settings",
    );
    await assertRejects(
      () => oldQueued,
      Error,
      "runtime changed while updating thread settings",
    );
    assertEquals(await current, {
      status: "updated",
      settings: { model: "gpt-a", effort: "low" },
      threadUpdated: true,
      defaultPersisted: true,
      effortAdjusted: false,
    });
    assertEquals((await runtime.getModelSettings("thread-1")).settings, {
      model: "gpt-a",
      effort: "low",
    });
    assertEquals(replacement.threadUpdates.length, 1);
    await runtime.stop();
  });

  it("drops queued old-generation config writes without blocking new writes", async () => {
    const factory = new FakeFactory();
    const firstClient = new FakeClient();
    const replacement = new FakeClient();
    const oldConfigWrite = deferred<void>();
    firstClient.configWriteBehaviors.push(() => oldConfigWrite.promise);
    factory.queue.push(firstClient, replacement);
    const runtime = runtimeWith(factory);
    await runtime.start();

    const oldInFlight = runtime.setEffort(undefined, "low");
    await waitFor(
      () => firstClient.configWrites.length === 1,
      "old in-flight config write",
    );
    const oldQueued = runtime.setEffort(undefined, "medium");
    await Promise.resolve();
    assertEquals(firstClient.configReadCalls, 1);

    firstClient.exit();
    await waitFor(
      () => runtime.ready && runtime.generation === 2,
      "config queue runtime restart",
    );
    const current = runtime.setEffort(undefined, "low");
    await waitFor(
      () => replacement.configWrites.length === 1,
      "new-generation config write",
    );
    assertEquals(replacement.configWrites, [{ effort: "low" }]);

    oldConfigWrite.resolve();
    assertEquals(await oldInFlight, {
      status: "updated",
      settings: { model: "gpt-a", effort: "low" },
      threadUpdated: false,
      defaultPersisted: false,
      effortAdjusted: false,
      persistenceError:
        "Codex runtime changed while persisting default settings",
    });
    await assertRejects(
      () => oldQueued,
      Error,
      "Codex runtime changed while updating default settings",
    );
    assertEquals(await current, {
      status: "updated",
      settings: { model: "gpt-a", effort: "low" },
      threadUpdated: false,
      defaultPersisted: true,
      effortAdjusted: false,
    });
    assertEquals(replacement.configWrites.length, 1);
    await runtime.stop();
  });
});

describe("CodexRuntime serializes model settings operations", () => {
  it("coalesces concurrent resumes for one thread", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    const resumed = deferred<CodexThreadSession>();
    client.resumeBehaviors.push(() => resumed.promise);
    factory.queue.push(client);
    const runtime = runtimeWith(factory);
    await runtime.start();

    const first = runtime.resumeThread("thread-1");
    const second = runtime.resumeThread("thread-1");
    assertEquals(client.resumedThreads, ["thread-1"]);
    resumed.resolve({
      threadId: "thread-1",
      settings: { model: "gpt-a", effort: "medium" },
    });
    await Promise.all([first, second]);
    await runtime.resumeThread("thread-1");
    await runtime.stop();

    assertEquals(client.resumedThreads, ["thread-1"]);
  });

  it("runs updates to one thread in arrival order", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    const firstUpdate = deferred<void>();
    client.threadUpdateBehaviors.push(
      () => firstUpdate.promise,
      () => Promise.resolve(),
    );
    factory.queue.push(client);
    const runtime = runtimeWith(factory);
    await runtime.start();

    const first = runtime.setEffort("thread-1", "low");
    await waitFor(
      () => client.threadUpdates.length === 1,
      "first thread settings update",
    );
    const second = runtime.setEffort("thread-1", "medium");
    await Promise.resolve();
    assertEquals(client.threadUpdates, [{
      threadId: "thread-1",
      patch: { effort: "low" },
    }]);

    firstUpdate.resolve();
    await Promise.all([first, second]);
    await runtime.stop();
    assertEquals(client.threadUpdates, [
      { threadId: "thread-1", patch: { effort: "low" } },
      { threadId: "thread-1", patch: { effort: "medium" } },
    ]);
  });

  it("runs thread RPCs concurrently and serializes global config writes", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    const firstThreadUpdate = deferred<void>();
    const secondThreadUpdate = deferred<void>();
    const firstConfigWrite = deferred<void>();
    const secondConfigWrite = deferred<void>();
    client.threadUpdateBehaviors.push(
      () => firstThreadUpdate.promise,
      () => secondThreadUpdate.promise,
    );
    client.configWriteBehaviors.push(
      () => firstConfigWrite.promise,
      () => secondConfigWrite.promise,
    );
    factory.queue.push(client);
    const runtime = runtimeWith(factory);
    await runtime.start();
    await Promise.all([
      runtime.resumeThread("thread-a"),
      runtime.resumeThread("thread-b"),
    ]);

    const first = runtime.setEffort("thread-a", "low");
    const second = runtime.setEffort("thread-b", "medium");
    await waitFor(
      () => client.threadUpdates.length === 2,
      "concurrent thread settings updates",
    );
    firstThreadUpdate.resolve();
    secondThreadUpdate.resolve();
    await waitFor(
      () => client.configWrites.length === 1,
      "first config write",
    );
    firstConfigWrite.resolve();
    await waitFor(
      () => client.configWrites.length === 2,
      "second config write",
    );
    secondConfigWrite.resolve();

    await Promise.all([first, second]);
    await runtime.stop();
    assertEquals(client.threadUpdates.map(({ threadId }) => threadId), [
      "thread-a",
      "thread-b",
    ]);
  });

  it("continues config writes after a rejected write", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    const rejectedWrite = deferred<void>();
    const recoveredWrite = deferred<void>();
    client.configWriteBehaviors.push(
      () => rejectedWrite.promise,
      () => recoveredWrite.promise,
    );
    factory.queue.push(client);
    const runtime = runtimeWith(factory);
    await runtime.start();

    const first = runtime.setEffort(undefined, "low");
    await waitFor(
      () => client.configWrites.length === 1,
      "rejected config write",
    );
    const second = runtime.setEffort(undefined, "medium");
    await Promise.resolve();
    assertEquals(client.configWrites.length, 1);

    rejectedWrite.reject(new Error("first write failed"));
    assertEquals(await first, {
      status: "updated",
      settings: { model: "gpt-a", effort: "low" },
      threadUpdated: false,
      defaultPersisted: false,
      effortAdjusted: false,
      persistenceError: "first write failed",
    });
    await waitFor(
      () => client.configWrites.length === 2,
      "recovered config write",
    );
    recoveredWrite.resolve();
    assertEquals(await second, {
      status: "updated",
      settings: { model: "gpt-a", effort: "medium" },
      threadUpdated: false,
      defaultPersisted: true,
      effortAdjusted: false,
    });
    await runtime.stop();
  });

  it("drops an old-generation late thread update from the new cache", async () => {
    const factory = new FakeFactory();
    const firstClient = new FakeClient();
    const replacement = new FakeClient();
    const lateUpdate = deferred<void>();
    firstClient.threadUpdateBehaviors.push(() => lateUpdate.promise);
    factory.queue.push(firstClient, replacement);
    const runtime = runtimeWith(factory);
    await runtime.start();

    const updating = runtime.setEffort("thread-1", "low");
    await waitFor(
      () => firstClient.threadUpdates.length === 1,
      "old-generation thread update",
    );
    firstClient.exit();
    await waitFor(
      () => runtime.ready && runtime.generation === 2,
      "settings runtime restart",
    );
    lateUpdate.resolve();
    await assertRejects(
      () => updating,
      Error,
      "runtime changed while updating thread settings",
    );

    assertEquals((await runtime.getModelSettings("thread-1")).settings, {
      model: "gpt-a",
      effort: "medium",
    });
    await runtime.stop();
    assertEquals(replacement.resumedThreads, ["thread-1"]);
  });

  it("loads the model catalog once per generation and refetches after restart", async () => {
    const factory = new FakeFactory();
    const firstClient = new FakeClient();
    const replacement = new FakeClient();
    const firstCatalog = deferred<CodexModel[]>();
    firstClient.modelListBehaviors.push(() => firstCatalog.promise);
    factory.queue.push(firstClient, replacement);
    const runtime = runtimeWith(factory);
    await runtime.start();

    const firstSnapshot = runtime.getModelSettings();
    const concurrentSnapshot = runtime.getModelSettings();
    firstCatalog.resolve(firstClient.models);
    await Promise.all([firstSnapshot, concurrentSnapshot]);

    firstClient.exit();
    await waitFor(
      () => runtime.ready && runtime.generation === 2,
      "catalog runtime restart",
    );
    await runtime.getModelSettings();
    await runtime.getModelSettings();
    await runtime.stop();

    assertEquals(firstClient.listModelCalls, 1);
    assertEquals(replacement.listModelCalls, 1);
  });
});

describe("CodexRuntime", () => {
  it("routes App Server stderr separately from internal diagnostics", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    factory.queue.push(client);
    const stderr: string[] = [];
    const diagnostics: string[] = [];
    const runtime = runtimeWith(factory, {
      onAppServerStderr: (message) => {
        stderr.push(message);
      },
      onDiagnostic: (message) => {
        diagnostics.push(message);
      },
    });
    await runtime.start();

    client.callbacks.onStderr?.("raw stderr");
    client.callbacks.onDiagnostic?.("internal failure");

    assertEquals(stderr, ["raw stderr"]);
    assertEquals(diagnostics, ["internal failure"]);
    await runtime.stop();
  });

  it("forwards per-turn reasoning summary options to App Server", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    factory.queue.push(client);
    const runtime = runtimeWith(factory);
    await runtime.start();

    await runtime.startTurn(
      "thread-summary",
      "prompt",
      "owner",
      () => {},
      { summary: "auto" },
    );

    assertEquals(client.startedTurns, [{
      threadId: "thread-summary",
      prompt: "prompt",
      authority: "owner",
      options: { summary: "auto" },
    }]);
    await runtime.stop();
  });

  it("reports safe notification routing metadata without payload content", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    client.turnIds.push("turn-trace");
    factory.queue.push(client);
    const traces: CodexRuntimeTrace[] = [];
    const runtime = runtimeWith(factory, {
      onTrace: (trace) => {
        traces.push(trace);
      },
    });
    await runtime.start();
    const handle = await runtime.startTurn(
      "thread-trace",
      "prompt",
      "owner",
      () => {},
    );

    client.callbacks.onNotification?.({
      method: "item/reasoning/summaryTextDelta",
      params: {
        threadId: "thread-trace",
        turnId: "turn-trace",
        delta: "forbidden-private-body",
      },
    });
    client.callbacks.onNotification?.({
      method: "item/reasoning/textDelta",
      params: {
        threadId: "thread-trace",
        turnId: "turn-trace",
        delta: "forbidden-private-reasoning",
      },
    });
    client.callbacks.onNotification?.({
      method: "warning",
      params: { message: "forbidden-without-scope" },
    });
    client.callbacks.onNotification?.({
      method: "turn/started",
      params: { threadId: "thread-trace", turnId: "turn-trace" },
    });

    assertEquals(traces, [
      {
        method: "item/reasoning/summaryTextDelta",
        decision: "routed",
        reason: "delivered",
        generation: 1,
        threadId: "thread-trace",
        turnId: "turn-trace",
        tag: "CONTENT",
      },
      {
        method: "item/reasoning/textDelta",
        decision: "ignored",
        reason: "adapter_ignored",
        generation: 1,
        threadId: "thread-trace",
        turnId: "turn-trace",
      },
      {
        method: "warning",
        decision: "ignored",
        reason: "missing_turn_ids",
        generation: 1,
      },
      {
        method: "turn/started",
        decision: "ignored",
        reason: "turn_owned_by_orchestrator",
        generation: 1,
        threadId: "thread-trace",
        turnId: "turn-trace",
        tag: "TURN",
      },
    ]);
    assertEquals(JSON.stringify(traces).includes("forbidden"), false);

    client.callbacks.onTurnCompleted?.({
      threadId: "thread-trace",
      turnId: "turn-trace",
      status: "completed",
      error: null,
    });
    await handle.completion;
    await runtime.stop();
  });

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
      "owner",
      () => {},
    );
    assertEquals(handle.turnId, "turn-9");
    await runtime.interruptTurn("thread-existing", "turn-9");
    assertEquals(client.resumedThreads, ["thread-existing"]);
    assertEquals(client.startedTurns, [{
      threadId: "thread-existing",
      prompt: "检查测试",
      authority: "owner",
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
      "restricted",
      (activity) => {
        firstProgress.push(activity);
      },
    );
    const second = await runtime.startTurn(
      "thread-b",
      "second",
      "restricted",
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
      "restricted",
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

  it("clears early subagent state when a turn start rejects before activation", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    let rejectFirstTurn!: (reason?: unknown) => void;
    const firstTurn = new Promise<string>((_resolve, reject) => {
      rejectFirstTurn = reject;
    });
    client.turnIds.push(firstTurn, "turn-retry");
    factory.queue.push(client);
    const runtime = runtimeWith(factory);
    await runtime.start();

    const failedStart = runtime.startTurn(
      "parent-retry",
      "first",
      "restricted",
      () => {},
    );
    await waitFor(() => client.startedTurns.length === 1, "first turn RPC");
    client.callbacks.onNotification?.({
      method: "item/started",
      params: {
        threadId: "parent-retry",
        turnId: "turn-retry",
        item: {
          type: "collabAgentToolCall",
          receiverThreadIds: ["child-retry"],
        },
      },
    });
    rejectFirstTurn(new Error("first turn failed"));
    await assertRejects(() => failedStart, Error, "first turn failed");

    const activities: ActivityEvent[] = [];
    const retry = await runtime.startTurn(
      "parent-retry",
      "retry",
      "restricted",
      (activity) => {
        activities.push(activity);
      },
    );
    client.callbacks.onThreadStarted?.({
      threadId: "child-retry",
      parentThreadId: "parent-retry",
      agentNickname: "stale-name",
    });

    assertEquals(
      activities.filter((activity) => activity.tag === "SUBAGENT"),
      [],
    );

    client.callbacks.onTurnCompleted?.({
      threadId: "parent-retry",
      turnId: "turn-retry",
      status: "completed",
      error: null,
    });
    await retry.completion;
    await runtime.stop();
  });

  it("keeps active subagent state when another turn start rejects", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    let rejectFailedTurn!: (reason?: unknown) => void;
    const failedTurn = new Promise<string>((_resolve, reject) => {
      rejectFailedTurn = reject;
    });
    client.turnIds.push("turn-active", failedTurn);
    factory.queue.push(client);
    const runtime = runtimeWith(factory);
    await runtime.start();

    const activities: ActivityEvent[] = [];
    const active = await runtime.startTurn(
      "parent-active",
      "active",
      "restricted",
      (activity) => {
        activities.push(activity);
      },
    );
    client.callbacks.onNotification?.({
      method: "item/started",
      params: {
        threadId: "parent-active",
        turnId: "turn-active",
        item: {
          type: "collabAgentToolCall",
          receiverThreadIds: ["child-active"],
        },
      },
    });

    const failedStart = runtime.startTurn(
      "parent-active",
      "failed",
      "restricted",
      () => {},
    );
    await waitFor(() => client.startedTurns.length === 2, "failed turn RPC");
    client.callbacks.onNotification?.({
      method: "item/started",
      params: {
        threadId: "parent-active",
        turnId: "turn-failed",
        item: {
          type: "collabAgentToolCall",
          receiverThreadIds: ["child-failed"],
        },
      },
    });
    rejectFailedTurn(new Error("failed turn"));
    await assertRejects(() => failedStart, Error, "failed turn");

    client.callbacks.onThreadStarted?.({
      threadId: "child-active",
      parentThreadId: "parent-active",
      agentNickname: "active-name",
    });
    client.callbacks.onThreadStarted?.({
      threadId: "child-failed",
      parentThreadId: "parent-active",
      agentNickname: "stale-name",
    });

    assertEquals(
      activities.filter((activity) => activity.tag === "SUBAGENT"),
      [{
        tag: "SUBAGENT",
        body: "active-name：已启动",
        itemId: "child-active",
        threadId: "parent-active",
        turnId: "turn-active",
        delivery: "progress",
      }],
    );

    client.callbacks.onTurnCompleted?.({
      threadId: "parent-active",
      turnId: "turn-active",
      status: "completed",
      error: null,
    });
    await active.completion;
    await runtime.stop();
  });

  it("drops unactivated subagent state when a concurrent start rejects", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    const failedResponse = Promise.withResolvers<string>();
    const pendingResponse = Promise.withResolvers<string>();
    client.turnIds.push(
      failedResponse.promise,
      pendingResponse.promise,
      "turn-concurrent-a",
    );
    factory.queue.push(client);
    const runtime = runtimeWith(factory);
    await runtime.start();

    const failedStart = runtime.startTurn(
      "parent-concurrent",
      "first",
      "restricted",
      () => {},
    );
    await waitFor(() => client.startedTurns.length === 1, "first turn RPC");
    const pendingActivities: ActivityEvent[] = [];
    const pendingStart = runtime.startTurn(
      "parent-concurrent",
      "second",
      "restricted",
      (activity) => {
        pendingActivities.push(activity);
      },
    );
    await waitFor(() => client.startedTurns.length === 2, "second turn RPC");
    client.callbacks.onNotification?.({
      method: "item/started",
      params: {
        threadId: "parent-concurrent",
        turnId: "turn-concurrent-a",
        item: {
          type: "collabAgentToolCall",
          receiverThreadIds: ["child-concurrent"],
        },
      },
    });
    client.callbacks.onThreadStarted?.({
      threadId: "child-concurrent",
      parentThreadId: "parent-concurrent",
      agentNickname: "stale-name",
    });
    client.callbacks.onNotification?.({
      method: "item/reasoning/summaryTextDelta",
      params: {
        threadId: "parent-concurrent",
        turnId: "turn-concurrent-a",
        delta: "safe early progress",
      },
    });
    failedResponse.reject(new Error("first concurrent turn failed"));
    await assertRejects(
      () => failedStart,
      Error,
      "first concurrent turn failed",
    );

    pendingResponse.resolve("turn-concurrent-a");
    const pending = await pendingStart;
    assertEquals(
      pendingActivities.filter((activity) => activity.tag === "SUBAGENT"),
      [],
    );
    assertEquals(pendingActivities, [
      {
        tag: "TOOL",
        summary: "collaboration",
        toolState: "started",
        threadId: "parent-concurrent",
        turnId: "turn-concurrent-a",
        delivery: "progress",
      },
      {
        tag: "CONTENT",
        body: "safe early progress",
        threadId: "parent-concurrent",
        turnId: "turn-concurrent-a",
        delivery: "progress",
      },
    ]);

    client.callbacks.onTurnCompleted?.({
      threadId: "parent-concurrent",
      turnId: "turn-concurrent-a",
      status: "completed",
      error: null,
    });
    await pending.completion;
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
      "restricted",
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
      "restricted",
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

  it("routes named subagent statuses through the parent turn once per state", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    client.turnIds.push("turn-1");
    factory.queue.push(client);
    const runtime = runtimeWith(factory);
    await runtime.start();

    const activities: ActivityEvent[] = [];
    const handle = await runtime.startTurn(
      "parent-1",
      "work",
      "restricted",
      (activity) => {
        activities.push(activity);
      },
    );

    client.callbacks.onNotification?.({
      method: "item/started",
      params: {
        threadId: "parent-1",
        turnId: "turn-1",
        item: {
          type: "collabAgentToolCall",
          receiverThreadIds: ["child-1"],
        },
      },
    });
    client.callbacks.onThreadStarted?.({
      threadId: "child-1",
      parentThreadId: "parent-1",
      agentNickname: "amber-otter",
      agentRole: "reviewer",
    });
    client.callbacks.onNotification?.({
      method: "item/completed",
      params: {
        threadId: "parent-1",
        turnId: "turn-1",
        item: {
          type: "subAgentActivity",
          agentThreadId: "child-1",
          kind: "started",
        },
      },
    });
    client.callbacks.onNotification?.({
      method: "item/completed",
      params: {
        threadId: "parent-1",
        turnId: "turn-1",
        item: {
          type: "subAgentActivity",
          agentThreadId: "child-1",
          kind: "started",
        },
      },
    });

    assertEquals(
      activities.filter((activity) => activity.tag === "SUBAGENT"),
      [
        {
          tag: "SUBAGENT",
          body: "amber-otter (reviewer)：已启动",
          itemId: "child-1",
          threadId: "parent-1",
          turnId: "turn-1",
          delivery: "progress",
        },
        {
          tag: "SUBAGENT",
          body: "amber-otter (reviewer)：正在工作",
          itemId: "child-1",
          threadId: "parent-1",
          turnId: "turn-1",
          delivery: "progress",
        },
      ],
    );

    client.callbacks.onNotification?.({
      method: "item/updated",
      params: {
        threadId: "parent-1",
        turnId: "turn-1",
        item: {
          type: "collabAgentToolCall",
          agentsStates: { "child-1": { status: "completed" } },
        },
      },
    });

    assertEquals(
      activities.filter((activity) => activity.tag === "SUBAGENT"),
      [
        {
          tag: "SUBAGENT",
          body: "amber-otter (reviewer)：已启动",
          itemId: "child-1",
          threadId: "parent-1",
          turnId: "turn-1",
          delivery: "progress",
        },
        {
          tag: "SUBAGENT",
          body: "amber-otter (reviewer)：正在工作",
          itemId: "child-1",
          threadId: "parent-1",
          turnId: "turn-1",
          delivery: "progress",
        },
        {
          tag: "SUBAGENT",
          body: "amber-otter (reviewer)：已完成",
          itemId: "child-1",
          threadId: "parent-1",
          turnId: "turn-1",
          delivery: "progress",
        },
      ],
    );

    client.callbacks.onTurnCompleted?.({
      threadId: "parent-1",
      turnId: "turn-1",
      status: "completed",
      error: null,
    });
    await handle.completion;
    await runtime.stop();
  });

  it("replays distinct pending subagent statuses when metadata arrives", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    client.turnIds.push("turn-pending");
    factory.queue.push(client);
    const runtime = runtimeWith(factory);
    await runtime.start();

    const activities: ActivityEvent[] = [];
    const handle = await runtime.startTurn(
      "parent-pending",
      "work",
      "restricted",
      (activity) => {
        activities.push(activity);
      },
    );

    client.callbacks.onNotification?.({
      method: "item/started",
      params: {
        threadId: "parent-pending",
        turnId: "turn-pending",
        item: {
          type: "collabAgentToolCall",
          receiverThreadIds: ["child-pending"],
        },
      },
    });
    client.callbacks.onThreadStarted?.({
      threadId: "child-pending",
      parentThreadId: "parent-pending",
    });
    for (const method of ["item/completed", "item/updated"] as const) {
      client.callbacks.onNotification?.({
        method,
        params: {
          threadId: "parent-pending",
          turnId: "turn-pending",
          item: {
            type: "subAgentActivity",
            agentThreadId: "child-pending",
            kind: "started",
          },
        },
      });
    }
    client.callbacks.onThreadStarted?.({
      threadId: "child-pending",
      parentThreadId: "parent-pending",
      agentNickname: "queue-name",
    });

    assertEquals(
      activities.filter((activity) => activity.tag === "SUBAGENT"),
      [
        {
          tag: "SUBAGENT",
          body: "queue-name：已启动",
          itemId: "child-pending",
          threadId: "parent-pending",
          turnId: "turn-pending",
          delivery: "progress",
        },
        {
          tag: "SUBAGENT",
          body: "queue-name：正在工作",
          itemId: "child-pending",
          threadId: "parent-pending",
          turnId: "turn-pending",
          delivery: "progress",
        },
      ],
    );

    client.callbacks.onTurnCompleted?.({
      threadId: "parent-pending",
      turnId: "turn-pending",
      status: "completed",
      error: null,
    });
    await handle.completion;
    await runtime.stop();
  });

  it("does not replay pending statuses after an anonymous terminal fallback", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    client.turnIds.push("turn-terminal-pending");
    factory.queue.push(client);
    const runtime = runtimeWith(factory);
    await runtime.start();

    const activities: ActivityEvent[] = [];
    const handle = await runtime.startTurn(
      "parent-terminal-pending",
      "work",
      "restricted",
      (activity) => {
        activities.push(activity);
      },
    );

    client.callbacks.onNotification?.({
      method: "item/started",
      params: {
        threadId: "parent-terminal-pending",
        turnId: "turn-terminal-pending",
        item: {
          type: "collabAgentToolCall",
          receiverThreadIds: ["child-terminal-pending"],
        },
      },
    });
    client.callbacks.onNotification?.({
      method: "item/completed",
      params: {
        threadId: "parent-terminal-pending",
        turnId: "turn-terminal-pending",
        item: {
          type: "subAgentActivity",
          agentThreadId: "child-terminal-pending",
          kind: "started",
        },
      },
    });
    client.callbacks.onNotification?.({
      method: "item/updated",
      params: {
        threadId: "parent-terminal-pending",
        turnId: "turn-terminal-pending",
        item: {
          type: "collabAgentToolCall",
          agentsStates: {
            "child-terminal-pending": { status: "completed" },
          },
        },
      },
    });
    client.callbacks.onThreadStarted?.({
      threadId: "child-terminal-pending",
      parentThreadId: "parent-terminal-pending",
      agentNickname: "queue-name",
    });

    assertEquals(
      activities.filter((activity) => activity.tag === "SUBAGENT"),
      [{
        tag: "SUBAGENT",
        body: "child-te：已完成",
        itemId: "child-terminal-pending",
        threadId: "parent-terminal-pending",
        turnId: "turn-terminal-pending",
        delivery: "progress",
      }],
    );

    client.callbacks.onTurnCompleted?.({
      threadId: "parent-terminal-pending",
      turnId: "turn-terminal-pending",
      status: "completed",
      error: null,
    });
    await handle.completion;
    await runtime.stop();
  });

  it("uses a child thread prefix for terminal subagent status without metadata", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    client.turnIds.push("turn-no");
    factory.queue.push(client);
    const runtime = runtimeWith(factory);
    await runtime.start();

    const activities: ActivityEvent[] = [];
    const handle = await runtime.startTurn(
      "parent-no",
      "work",
      "restricted",
      (activity) => {
        activities.push(activity);
      },
    );

    client.callbacks.onNotification?.({
      method: "item/updated",
      params: {
        threadId: "parent-no",
        turnId: "turn-no",
        item: {
          type: "collabAgentToolCall",
          agentsStates: { "child-no-name": { status: "completed" } },
        },
      },
    });

    assertEquals(
      activities.filter((activity) => activity.tag === "SUBAGENT"),
      [{
        tag: "SUBAGENT",
        body: "child-no：已完成",
        itemId: "child-no-name",
        threadId: "parent-no",
        turnId: "turn-no",
        delivery: "progress",
      }],
    );

    client.callbacks.onTurnCompleted?.({
      threadId: "parent-no",
      turnId: "turn-no",
      status: "completed",
      error: null,
    });
    await handle.completion;
    await runtime.stop();
  });

  it("uses a child role when it is the only available display metadata", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    client.turnIds.push("turn-role");
    factory.queue.push(client);
    const runtime = runtimeWith(factory);
    await runtime.start();

    const activities: ActivityEvent[] = [];
    const handle = await runtime.startTurn(
      "parent-role",
      "work",
      "restricted",
      (activity) => {
        activities.push(activity);
      },
    );

    client.callbacks.onNotification?.({
      method: "item/started",
      params: {
        threadId: "parent-role",
        turnId: "turn-role",
        item: {
          type: "collabAgentToolCall",
          receiverThreadIds: ["child-role"],
        },
      },
    });
    client.callbacks.onThreadStarted?.({
      threadId: "child-role",
      parentThreadId: "parent-role",
      agentRole: "reviewer",
    });

    assertEquals(
      activities.filter((activity) => activity.tag === "SUBAGENT"),
      [{
        tag: "SUBAGENT",
        body: "reviewer：已启动",
        itemId: "child-role",
        threadId: "parent-role",
        turnId: "turn-role",
        delivery: "progress",
      }],
    );

    client.callbacks.onTurnCompleted?.({
      threadId: "parent-role",
      turnId: "turn-role",
      status: "completed",
      error: null,
    });
    await handle.completion;
    await runtime.stop();
  });

  it("uses a child name before its role when no nickname is available", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    client.turnIds.push("turn-name");
    factory.queue.push(client);
    const runtime = runtimeWith(factory);
    await runtime.start();

    const activities: ActivityEvent[] = [];
    const handle = await runtime.startTurn(
      "parent-name",
      "work",
      "restricted",
      (activity) => {
        activities.push(activity);
      },
    );

    client.callbacks.onNotification?.({
      method: "item/started",
      params: {
        threadId: "parent-name",
        turnId: "turn-name",
        item: {
          type: "collabAgentToolCall",
          receiverThreadIds: ["child-name"],
        },
      },
    });
    client.callbacks.onThreadStarted?.({
      threadId: "child-name",
      parentThreadId: "parent-name",
      name: "literary-albatross",
      agentRole: "reviewer",
    });

    assertEquals(
      activities.filter((activity) => activity.tag === "SUBAGENT"),
      [{
        tag: "SUBAGENT",
        body: "literary-albatross (reviewer)：已启动",
        itemId: "child-name",
        threadId: "parent-name",
        turnId: "turn-name",
        delivery: "progress",
      }],
    );

    client.callbacks.onTurnCompleted?.({
      threadId: "parent-name",
      turnId: "turn-name",
      status: "completed",
      error: null,
    });
    await handle.completion;
    await runtime.stop();
  });

  it("includes an equal-valued role when a child name is present", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    client.turnIds.push("turn-equal-name");
    factory.queue.push(client);
    const runtime = runtimeWith(factory);
    await runtime.start();

    const activities: ActivityEvent[] = [];
    const handle = await runtime.startTurn(
      "parent-equal-name",
      "work",
      "restricted",
      (activity) => {
        activities.push(activity);
      },
    );

    client.callbacks.onNotification?.({
      method: "item/started",
      params: {
        threadId: "parent-equal-name",
        turnId: "turn-equal-name",
        item: {
          type: "collabAgentToolCall",
          receiverThreadIds: ["child-equal-name"],
        },
      },
    });
    client.callbacks.onThreadStarted?.({
      threadId: "child-equal-name",
      parentThreadId: "parent-equal-name",
      name: "reviewer",
      agentRole: "reviewer",
    });

    assertEquals(
      activities.filter((activity) => activity.tag === "SUBAGENT"),
      [{
        tag: "SUBAGENT",
        body: "reviewer (reviewer)：已启动",
        itemId: "child-equal-name",
        threadId: "parent-equal-name",
        turnId: "turn-equal-name",
        delivery: "progress",
      }],
    );

    client.callbacks.onTurnCompleted?.({
      threadId: "parent-equal-name",
      turnId: "turn-equal-name",
      status: "completed",
      error: null,
    });
    await handle.completion;
    await runtime.stop();
  });

  it("clears child metadata when its parent turn completes", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    client.turnIds.push("turn-complete", "turn-next");
    factory.queue.push(client);
    const runtime = runtimeWith(factory);
    await runtime.start();

    const completedActivities: ActivityEvent[] = [];
    const completed = await runtime.startTurn(
      "parent-clean",
      "first",
      "restricted",
      (activity) => {
        completedActivities.push(activity);
      },
    );
    client.callbacks.onNotification?.({
      method: "item/started",
      params: {
        threadId: "parent-clean",
        turnId: "turn-complete",
        item: {
          type: "collabAgentToolCall",
          receiverThreadIds: ["child-clean"],
        },
      },
    });
    client.callbacks.onThreadStarted?.({
      threadId: "child-clean",
      parentThreadId: "parent-clean",
      agentNickname: "stale-name",
    });
    client.callbacks.onTurnCompleted?.({
      threadId: "parent-clean",
      turnId: "turn-complete",
      status: "completed",
      error: null,
    });
    await completed.completion;

    const nextActivities: ActivityEvent[] = [];
    const next = await runtime.startTurn(
      "parent-clean",
      "second",
      "restricted",
      (activity) => {
        nextActivities.push(activity);
      },
    );
    client.callbacks.onNotification?.({
      method: "item/completed",
      params: {
        threadId: "parent-clean",
        turnId: "turn-next",
        item: {
          type: "subAgentActivity",
          agentThreadId: "child-clean",
          kind: "started",
        },
      },
    });

    assertEquals(
      completedActivities.filter((activity) => activity.tag === "SUBAGENT"),
      [{
        tag: "SUBAGENT",
        body: "stale-name：已启动",
        itemId: "child-clean",
        threadId: "parent-clean",
        turnId: "turn-complete",
        delivery: "progress",
      }],
    );
    assertEquals(nextActivities, []);

    client.callbacks.onTurnCompleted?.({
      threadId: "parent-clean",
      turnId: "turn-next",
      status: "completed",
      error: null,
    });
    await next.completion;
    await runtime.stop();
  });

  it("clears child metadata when an App Server exit loses its parent turn", async () => {
    const factory = new FakeFactory();
    const crashed = new FakeClient();
    const replacement = new FakeClient();
    crashed.turnIds.push("turn-lost");
    replacement.turnIds.push("turn-recovered");
    factory.queue.push(crashed, replacement);
    const runtime = runtimeWith(factory, { delay: async () => {} });
    await runtime.start();

    const lost = await runtime.startTurn(
      "parent-lost",
      "first",
      "restricted",
      () => {},
    );
    crashed.callbacks.onNotification?.({
      method: "item/started",
      params: {
        threadId: "parent-lost",
        turnId: "turn-lost",
        item: {
          type: "collabAgentToolCall",
          receiverThreadIds: ["child-lost"],
        },
      },
    });
    crashed.callbacks.onThreadStarted?.({
      threadId: "child-lost",
      parentThreadId: "parent-lost",
      agentNickname: "stale-name",
    });
    crashed.exit();
    assertEquals(await lost.completion, { status: "runtime_lost" });
    await waitFor(() => runtime.ready && runtime.generation === 2, "restart");

    const recoveredActivities: ActivityEvent[] = [];
    const recovered = await runtime.startTurn(
      "parent-lost",
      "second",
      "restricted",
      (activity) => {
        recoveredActivities.push(activity);
      },
    );
    replacement.callbacks.onNotification?.({
      method: "item/completed",
      params: {
        threadId: "parent-lost",
        turnId: "turn-recovered",
        item: {
          type: "subAgentActivity",
          agentThreadId: "child-lost",
          kind: "started",
        },
      },
    });

    assertEquals(recoveredActivities, []);
    replacement.callbacks.onTurnCompleted?.({
      threadId: "parent-lost",
      turnId: "turn-recovered",
      status: "completed",
      error: null,
    });
    await recovered.completion;
    await runtime.stop();
  });

  it("does not retain late child state when a parent turn id is reused", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    client.turnIds.push("turn-reused", "turn-reused");
    factory.queue.push(client);
    const runtime = runtimeWith(factory);
    await runtime.start();

    const first = await runtime.startTurn(
      "parent-reused",
      "first",
      "restricted",
      () => {},
    );
    client.callbacks.onTurnCompleted?.({
      threadId: "parent-reused",
      turnId: "turn-reused",
      status: "completed",
      error: null,
    });
    await first.completion;
    client.callbacks.onNotification?.({
      method: "item/started",
      params: {
        threadId: "parent-reused",
        turnId: "turn-reused",
        item: {
          type: "collabAgentToolCall",
          receiverThreadIds: ["child-late"],
        },
      },
    });

    const activities: ActivityEvent[] = [];
    const second = await runtime.startTurn(
      "parent-reused",
      "second",
      "restricted",
      (activity) => {
        activities.push(activity);
      },
    );
    client.callbacks.onThreadStarted?.({
      threadId: "child-late",
      parentThreadId: "parent-reused",
      agentNickname: "late-name",
    });

    assertEquals(activities, []);

    client.callbacks.onTurnCompleted?.({
      threadId: "parent-reused",
      turnId: "turn-reused",
      status: "completed",
      error: null,
    });
    await second.completion;
    await runtime.stop();
  });

  it("suppresses ambiguous child status after a parent turn id is reused", async () => {
    const factory = new FakeFactory();
    const client = new FakeClient();
    client.turnIds.push("turn-reused-active", "turn-reused-active");
    factory.queue.push(client);
    const runtime = runtimeWith(factory);
    await runtime.start();

    const first = await runtime.startTurn(
      "parent-reused-active",
      "first",
      "restricted",
      () => {},
    );
    client.callbacks.onTurnCompleted?.({
      threadId: "parent-reused-active",
      turnId: "turn-reused-active",
      status: "completed",
      error: null,
    });
    await first.completion;

    const activities: ActivityEvent[] = [];
    const second = await runtime.startTurn(
      "parent-reused-active",
      "second",
      "restricted",
      (activity) => {
        activities.push(activity);
      },
    );
    client.callbacks.onNotification?.({
      method: "item/started",
      params: {
        threadId: "parent-reused-active",
        turnId: "turn-reused-active",
        item: {
          type: "collabAgentToolCall",
          receiverThreadIds: ["child-reused-active"],
        },
      },
    });
    client.callbacks.onThreadStarted?.({
      threadId: "child-reused-active",
      parentThreadId: "parent-reused-active",
      agentNickname: "old-child",
    });

    assertEquals(
      activities.filter((activity) => activity.tag === "SUBAGENT"),
      [],
    );

    client.callbacks.onTurnCompleted?.({
      threadId: "parent-reused-active",
      turnId: "turn-reused-active",
      status: "completed",
      error: null,
    });
    await second.completion;
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
      "restricted",
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
      "restricted",
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

    const first = await runtime.startTurn(
      "thread-reused",
      "first",
      "restricted",
      () => {},
    );
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
      "restricted",
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

    const first = await runtime.startTurn(
      "thread-reused",
      "first",
      "restricted",
      () => {},
    );
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
      "restricted",
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

    const starting = runtime.startTurn(
      "thread-pending",
      "first",
      "restricted",
      () => {},
    );
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
      "restricted",
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
      "restricted",
      () => {},
    );
    await waitFor(() => crashed.startedTurns.length === 1, "original turn RPC");
    crashed.exit();
    await waitFor(() => runtime.ready && runtime.generation === 2, "restart");

    const activities: ActivityEvent[] = [];
    const replacementStarting = runtime.startTurn(
      "thread-generation-race",
      "replacement",
      "restricted",
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

    const first = await runtime.startTurn(
      "thread-reused",
      "first",
      "restricted",
      () => {},
    );
    crashed.exit();
    assertEquals(await first.completion, { status: "runtime_lost" });
    await waitFor(() => runtime.ready && runtime.generation === 2, "restart");

    const activities: ActivityEvent[] = [];
    const starting = runtime.startTurn(
      "thread-reused",
      "second",
      "restricted",
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

  it("passes developer instructions unchanged to every client generation", async () => {
    const factory = new FakeFactory();
    const crashed = new FakeClient();
    const replacement = new FakeClient();
    factory.queue.push(crashed, replacement);
    const developerInstructions = "stable owner isolation policy";
    const runtime = runtimeWith(factory, {
      developerInstructions,
      delay: async () => {},
    });
    await runtime.start();

    crashed.exit();
    await waitFor(() => runtime.ready && runtime.generation === 2, "restart");

    assertEquals(
      factory.calls.map((options) => options.developerInstructions),
      [developerInstructions, developerInstructions],
    );
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
      "restricted",
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
