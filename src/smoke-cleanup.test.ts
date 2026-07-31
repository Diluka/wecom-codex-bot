import {
  assertEquals,
  assertMatch,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Writable } from "node:stream";
import { createLogger } from "./log.ts";
import { finishSmoke } from "./smoke-cleanup.ts";

function setup() {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  const logger = createLogger({ destination });
  let flushes = 0;

  return {
    codexLogger: logger.child({ scope: "codex" }),
    flush: () => {
      flushes++;
      logger.flush();
    },
    flushes: () => flushes,
    output: () => chunks.join(""),
  };
}

describe("finishSmoke", () => {
  it("logs a close failure without replacing the primary error", async () => {
    const harness = setup();
    const primaryError = new Error("primary failed");
    const closeError = new Error("close failed");
    const operation = async (): Promise<void> => {
      let hasPrimaryError = false;
      try {
        await Promise.reject(primaryError);
      } catch (error) {
        hasPrimaryError = true;
        throw error;
      } finally {
        await finishSmoke(
          harness.codexLogger,
          () => Promise.reject(closeError),
          harness.flush,
          hasPrimaryError,
        );
      }
    };

    const thrown = await assertRejects(() => operation());

    assertStrictEquals(thrown, primaryError);
    assertEquals(harness.flushes(), 1);
    assertMatch(harness.output(), / ERROR: \[codex\] close_failed /);
    assertMatch(harness.output(), /"error":"Error: close failed"/);
  });

  it("throws a close failure when the primary operation succeeded", async () => {
    const harness = setup();
    const closeError = new Error("close failed");

    const thrown = await assertRejects(() =>
      finishSmoke(
        harness.codexLogger,
        () => Promise.reject(closeError),
        harness.flush,
        false,
      )
    );

    assertStrictEquals(thrown, closeError);
    assertEquals(harness.flushes(), 1);
    assertMatch(harness.output(), / ERROR: \[codex\] close_failed /);
  });

  it("flushes after a successful close", async () => {
    const harness = setup();

    await finishSmoke(
      harness.codexLogger,
      () => Promise.resolve(),
      harness.flush,
      false,
    );

    assertEquals(harness.flushes(), 1);
    assertEquals(harness.output(), "");
  });
});
