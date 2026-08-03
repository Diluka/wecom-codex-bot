import { assertEquals, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
import { join } from "node:path";

import { ImageTempStore } from "./image-temp-store.ts";
import { BotLifecycle } from "./lifecycle.ts";

const PNG = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
]);
const VALID_IMAGE = {
  status: "valid",
  url: "https://example.invalid/image",
  aesKey: "key-1",
} as const;

function setup(
  options: {
    failTempStart?: boolean;
    failTempClose?: boolean;
    failRuntimeStart?: boolean;
    failFinish?: boolean;
    failBeginShutdown?: boolean;
    runtimeStart?: Promise<void>;
    interruptAll?: Promise<void>;
    imageTempStore?: ImageTempStore;
  } = {},
) {
  const events: string[] = [];
  const errors: Error[] = [];
  const output = {
    beginShutdown: () => {
      events.push("output:begin-shutdown");
      if (options.failBeginShutdown) throw new Error("begin shutdown failed");
    },
    finishAll: () => {
      events.push("output:finish");
      return options.failFinish
        ? Promise.reject(new Error("finish failed"))
        : Promise.resolve();
    },
  };
  const lifecycle = new BotLifecycle({
    state: {
      markRuntimeLost: () => {
        events.push("state:runtime-lost");
        return 2;
      },
      close: () => events.push("state:close"),
    },
    imageTempStore: {
      start: () => {
        events.push("temp:start");
        if (options.failTempStart) {
          return Promise.reject(new Error("temp start failed"));
        }
        return options.imageTempStore?.start() ?? Promise.resolve();
      },
      close: () => {
        events.push("temp:close");
        if (options.failTempClose) {
          return Promise.reject(new Error("temp close failed"));
        }
        return options.imageTempStore?.close() ?? Promise.resolve();
      },
    },
    runtime: {
      start: () => {
        events.push("runtime:start");
        return options.runtimeStart ??
          (options.failRuntimeStart
            ? Promise.reject(new Error("start failed"))
            : Promise.resolve());
      },
      stop: () => {
        events.push("runtime:stop");
        return Promise.resolve();
      },
    },
    gateway: {
      connect: () => {
        events.push("gateway:connect");
      },
      disconnect: () => {
        events.push("gateway:disconnect");
      },
    },
    orchestrator: {
      interruptAll: () => {
        events.push("orchestrator:interrupt");
        return options.interruptAll ?? Promise.resolve();
      },
    },
    output,
    onError: (error: Error) => errors.push(error),
  });
  return { lifecycle, events, errors };
}

describe("BotLifecycle", () => {
  it("marks stale turns, starts Codex, then connects Enterprise WeChat", async () => {
    const { lifecycle, events } = setup();

    assertEquals(await lifecycle.start(), 2);
    assertEquals(events, [
      "state:runtime-lost",
      "temp:start",
      "runtime:start",
      "gateway:connect",
    ]);
  });

  it("finishes streams before disconnecting Enterprise WeChat", async () => {
    const { lifecycle, events } = setup();
    await lifecycle.start();
    events.length = 0;

    await lifecycle.stop();

    assertEquals(events, [
      "orchestrator:interrupt",
      "output:begin-shutdown",
      "output:finish",
      "gateway:disconnect",
      "runtime:stop",
      "temp:close",
      "state:close",
    ]);
  });

  it("begins output shutdown before awaiting interrupted turns", async () => {
    const interruptAll = Promise.withResolvers<void>();
    const { lifecycle, events } = setup({
      interruptAll: interruptAll.promise,
    });
    await lifecycle.start();
    events.length = 0;

    const stopping = lifecycle.stop();
    assertEquals(events, [
      "orchestrator:interrupt",
      "output:begin-shutdown",
    ]);

    interruptAll.resolve();
    await stopping;
    assertEquals(events, [
      "orchestrator:interrupt",
      "output:begin-shutdown",
      "output:finish",
      "gateway:disconnect",
      "runtime:stop",
      "temp:close",
      "state:close",
    ]);
  });

  it("cleans up Codex without connecting WeChat when stopped during startup", async () => {
    const runtimeStart = Promise.withResolvers<void>();
    const { lifecycle, events } = setup({
      runtimeStart: runtimeStart.promise,
    });

    const starting = lifecycle.start();
    const startRejected = assertRejects(
      () => starting,
      Error,
      "stopped while starting",
    );
    const stopping = lifecycle.stop();
    runtimeStart.resolve();

    await Promise.all([startRejected, stopping]);
    assertEquals(events, [
      "state:runtime-lost",
      "temp:start",
      "runtime:start",
      "runtime:stop",
      "temp:close",
      "state:close",
    ]);
  });

  it("continues shutdown after an error and reports it", async () => {
    const { lifecycle, events, errors } = setup({ failFinish: true });
    await lifecycle.start();
    events.length = 0;

    await lifecycle.stop();

    assertEquals(events, [
      "orchestrator:interrupt",
      "output:begin-shutdown",
      "output:finish",
      "gateway:disconnect",
      "runtime:stop",
      "temp:close",
      "state:close",
    ]);
    assertEquals(errors.map((error) => error.message), ["finish failed"]);
  });

  it("continues shutdown when beginning output shutdown throws", async () => {
    const { lifecycle, events, errors } = setup({
      failBeginShutdown: true,
    });
    await lifecycle.start();
    events.length = 0;

    await lifecycle.stop();

    assertEquals(events, [
      "orchestrator:interrupt",
      "output:begin-shutdown",
      "output:finish",
      "gateway:disconnect",
      "runtime:stop",
      "temp:close",
      "state:close",
    ]);
    assertEquals(errors.map((error) => error.message), [
      "begin shutdown failed",
    ]);
  });

  it("closes temp storage and state without starting runtime when temp start fails", async () => {
    const { lifecycle, events } = setup({ failTempStart: true });

    await assertRejects(() => lifecycle.start(), Error, "temp start failed");
    assertEquals(events, [
      "state:runtime-lost",
      "temp:start",
      "temp:close",
      "state:close",
    ]);
  });

  it("closes temp storage after a runtime start failure", async () => {
    const { lifecycle, events } = setup({ failRuntimeStart: true });

    await assertRejects(() => lifecycle.start(), Error, "start failed");
    assertEquals(events, [
      "state:runtime-lost",
      "temp:start",
      "runtime:start",
      "temp:close",
      "state:close",
    ]);
  });

  it("reports temp close failure and still closes state", async () => {
    const { lifecycle, events, errors } = setup({ failTempClose: true });
    await lifecycle.start();
    events.length = 0;

    await lifecycle.stop();

    assertEquals(events.at(-2), "temp:close");
    assertEquals(events.at(-1), "state:close");
    assertEquals(errors.map((error) => error.message), [
      "temp close failed",
    ]);
  });

  it("bounds lifecycle shutdown around a non-settling image download", async () => {
    using time = new FakeTime();
    const rootsBefore = await imageTempRoots();
    const lateDownload = Promise.withResolvers<Uint8Array>();
    const lateStarted = Promise.withResolvers<void>();
    const store = new ImageTempStore(() => {
      lateStarted.resolve();
      return lateDownload.promise;
    });
    const { lifecycle, events } = setup({ imageTempStore: store });
    await lifecycle.start();
    const rootsAfter = await imageTempRoots();
    const roots = [...rootsAfter].filter((root) => !rootsBefore.has(root));
    assertEquals(roots.length, 1);
    const root = roots[0];
    events.length = 0;

    const preparing = store.prepare(
      VALID_IMAGE,
      new AbortController().signal,
    );
    await lateStarted.promise;
    const preparationRejected = assertRejects(
      () => preparing,
      Error,
      "cancelled",
    );
    const stopping = lifecycle.stop();
    await preparationRejected;
    await time.runMicrotasks();
    assertEquals(events.at(-1), "temp:close");

    await time.tickAsync(5_000);
    await stopping;
    assertEquals(events.slice(-2), ["temp:close", "state:close"]);
    await assertRejects(() => Deno.stat(root), Deno.errors.NotFound);

    lateDownload.resolve(PNG);
    await lateDownload.promise;
    await time.runMicrotasks();
    await time.runMicrotasks();
    await assertRejects(() => Deno.stat(root), Deno.errors.NotFound);
  });

  it("is idempotent on repeated stop", async () => {
    const { lifecycle, events } = setup();
    await lifecycle.start();
    await lifecycle.stop();
    const count = events.length;

    await lifecycle.stop();
    assertEquals(events.length, count);
  });
});

async function imageTempRoots(): Promise<Set<string>> {
  const roots = new Set<string>();
  for await (const entry of Deno.readDir("/tmp")) {
    if (entry.name.startsWith("wecom-codex-bot-")) {
      roots.add(join("/tmp", entry.name));
    }
  }
  return roots;
}
