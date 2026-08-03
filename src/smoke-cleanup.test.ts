import {
  assertEquals,
  assertMatch,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { join } from "node:path";
import { Writable } from "node:stream";
import { createLogger } from "./log.ts";
import {
  assertGeneratedTurnStartSchema,
  finishSmoke,
} from "./smoke-cleanup.ts";

function compatibleTurnStartSchema(): Record<string, unknown> {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "TurnStartParams",
    type: "object",
    properties: {
      input: {
        type: "array",
        items: { $ref: "#/definitions/UserInput" },
      },
      additionalContext: {
        type: ["object", "null"],
        additionalProperties: {
          $ref: "#/definitions/AdditionalContextEntry",
        },
      },
    },
    definitions: {
      UserInput: {
        oneOf: [
          {
            type: "object",
            required: ["type", "text"],
            properties: {
              type: { type: "string", enum: ["text"] },
              text: { type: "string" },
            },
          },
          {
            type: "object",
            required: ["type", "path"],
            properties: {
              type: { type: "string", enum: ["localImage"] },
              path: { type: "string" },
            },
          },
        ],
      },
      AdditionalContextEntry: {
        type: "object",
        required: ["kind", "value"],
        properties: {
          kind: {
            $ref: "#/definitions/AdditionalContextKind",
          },
          value: {
            type: "string",
          },
        },
      },
      AdditionalContextKind: {
        type: "string",
        enum: ["untrusted", "application"],
      },
    },
  };
}

function remoteOnlyTurnStartSchema(): Record<string, unknown> {
  const schema = compatibleTurnStartSchema();
  const definitions = schema.definitions as Record<string, JsonObject>;
  definitions.UserInput = {
    oneOf: [
      {
        type: "object",
        required: ["type", "url"],
        properties: {
          type: { type: "string", enum: ["image"] },
          url: { type: "string" },
        },
      },
    ],
  };
  return schema;
}

type JsonObject = Record<string, unknown>;

async function withTurnStartSchema(
  schema: Record<string, unknown>,
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await Deno.makeTempDir();
  const v2Directory = join(directory, "v2");
  try {
    await Deno.mkdir(v2Directory, { recursive: true });
    await Deno.writeTextFile(
      join(v2Directory, "TurnStartParams.json"),
      JSON.stringify(schema),
    );
    await run(directory);
  } finally {
    await Deno.remove(directory, { recursive: true });
  }
}

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
    let schemaCleanups = 0;
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
          () => {
            schemaCleanups++;
          },
        );
      }
    };

    const thrown = await assertRejects(() => operation());

    assertStrictEquals(thrown, primaryError);
    assertEquals(schemaCleanups, 1);
    assertEquals(harness.flushes(), 1);
    assertMatch(harness.output(), / ERROR: \[codex\] close_failed /);
    assertMatch(
      harness.output(),
      /"error":\{"type":"Error","message":"close failed","stack":"at Object\.<anonymous> \(.*smoke-cleanup\.test\.ts:\d+:\d+\)"/,
    );
  });

  it("throws a close failure when the primary operation succeeded", async () => {
    const harness = setup();
    const closeError = new Error("close failed");
    let schemaCleanups = 0;

    const thrown = await assertRejects(() =>
      finishSmoke(
        harness.codexLogger,
        () => Promise.reject(closeError),
        harness.flush,
        false,
        () => {
          schemaCleanups++;
        },
      )
    );

    assertStrictEquals(thrown, closeError);
    assertEquals(schemaCleanups, 1);
    assertEquals(harness.flushes(), 1);
    assertMatch(harness.output(), / ERROR: \[codex\] close_failed /);
  });

  it("keeps a close failure when schema cleanup also fails", async () => {
    const harness = setup();
    const closeError = new Error("close failed");
    const cleanupError = new Error("cleanup failed");

    const thrown = await assertRejects(() =>
      finishSmoke(
        harness.codexLogger,
        () => Promise.reject(closeError),
        harness.flush,
        false,
        () => Promise.reject(cleanupError),
      )
    );

    assertStrictEquals(thrown, closeError);
    assertEquals(harness.flushes(), 1);
    assertMatch(harness.output(), / ERROR: \[codex\] close_failed /);
    assertMatch(harness.output(), / ERROR: \[codex\] schema_cleanup_failed /);
  });

  it("throws a schema cleanup failure after a successful operation", async () => {
    const harness = setup();
    const cleanupError = new Error("cleanup failed");

    const thrown = await assertRejects(() =>
      finishSmoke(
        harness.codexLogger,
        () => Promise.resolve(),
        harness.flush,
        false,
        () => Promise.reject(cleanupError),
      )
    );

    assertStrictEquals(thrown, cleanupError);
    assertEquals(harness.flushes(), 1);
    assertMatch(harness.output(), / ERROR: \[codex\] schema_cleanup_failed /);
  });

  it("flushes after a successful close", async () => {
    const harness = setup();

    await finishSmoke(
      harness.codexLogger,
      () => Promise.resolve(),
      harness.flush,
      false,
      () => Promise.resolve(),
    );

    assertEquals(harness.flushes(), 1);
    assertEquals(harness.output(), "");
  });
});

describe("generated TurnStartParams schema checks", () => {
  it("accepts the current v2 schema shape", async () => {
    await withTurnStartSchema(
      compatibleTurnStartSchema(),
      async (directory) => {
        await assertGeneratedTurnStartSchema(directory);
      },
    );
  });

  it("requires the exact application AdditionalContext kind", async () => {
    const schema = compatibleTurnStartSchema();
    const definitions = schema.definitions as Record<string, unknown>;
    definitions.AdditionalContextKind = {
      type: "string",
      enum: ["untrusted", "application-preview"],
    };

    await withTurnStartSchema(schema, async (directory) => {
      await assertRejects(
        () => assertGeneratedTurnStartSchema(directory),
        Error,
        "TurnStartParams.additionalContext",
      );
    });
  });

  it("rejects a remote-only image input schema", async () => {
    await withTurnStartSchema(
      remoteOnlyTurnStartSchema(),
      async (directory) => {
        await assertRejects(
          () => assertGeneratedTurnStartSchema(directory),
          Error,
          "TurnStartParams.input",
        );
      },
    );
  });

  it("does not accept a compatible schema from another file", async () => {
    await withTurnStartSchema(
      remoteOnlyTurnStartSchema(),
      async (directory) => {
        await Deno.writeTextFile(
          join(directory, "protocol.schemas.json"),
          JSON.stringify(compatibleTurnStartSchema()),
        );

        await assertRejects(
          () => assertGeneratedTurnStartSchema(directory),
          Error,
          "TurnStartParams.input",
        );
      },
    );
  });
});
