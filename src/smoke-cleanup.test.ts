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
  assertGeneratedSchemaSupportsApplicationContext,
  assertGeneratedSchemaSupportsLocalImage,
  finishSmoke,
} from "./smoke-cleanup.ts";

function compatibleSchemaBundle(): Record<string, unknown> {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "CodexAppServerProtocol",
    type: "object",
    definitions: {
      v2: {
        TurnStartParams: {
          type: "object",
          properties: {
            input: {
              type: "array",
              items: { $ref: "#/definitions/v2/UserInput" },
            },
            additionalContext: {
              description:
                "Optional client-provided context fragments keyed by an opaque source identifier.",
              type: ["object", "null"],
              additionalProperties: {
                $ref: "#/definitions/v2/AdditionalContextEntry",
              },
            },
          },
        },
        UserInput: {
          oneOf: [
            { $ref: "#/definitions/v2/TextInput" },
            { $ref: "#/definitions/v2/LocalImageInput" },
          ],
        },
        TextInput: {
          type: "object",
          required: ["type", "text"],
          properties: {
            type: { type: "string", enum: ["text"] },
            text: { type: "string" },
          },
        },
        LocalImageInput: {
          type: "object",
          required: ["type", "path"],
          properties: {
            type: { type: "string", enum: ["localImage"] },
            path: { type: "string" },
          },
        },
        AdditionalContextEntry: {
          type: "object",
          required: ["kind", "value"],
          properties: {
            kind: {
              $ref: "#/definitions/v2/AdditionalContextKind",
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
    },
  };
}

function rootTurnStartParamsSchemaBundle(): Record<string, unknown> {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "TurnStartParams",
    type: "object",
    properties: {
      input: {
        type: "array",
        items: {
          oneOf: [
            {
              type: "object",
              required: ["type", "path"],
              properties: {
                type: { const: "localImage" },
                path: { type: "string" },
              },
            },
          ],
        },
      },
    },
  };
}

function compatibleDefsSchemaBundle(): Record<string, unknown> {
  const bundle = JSON.parse(
    JSON.stringify(compatibleSchemaBundle()).replaceAll(
      "#/definitions/",
      "#/$defs/",
    ),
  ) as Record<string, unknown>;
  bundle.$defs = bundle.definitions;
  delete bundle.definitions;
  return bundle;
}

async function withSchemaBundle(
  bundle: Record<string, unknown>,
  run: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await Deno.makeTempDir();
  const nestedDirectory = join(directory, "generated", "v2");
  try {
    await Deno.mkdir(nestedDirectory, { recursive: true });
    await Deno.writeTextFile(
      join(nestedDirectory, "protocol.schemas.json"),
      JSON.stringify(bundle),
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

describe("assertGeneratedSchemaSupportsApplicationContext", () => {
  it("accepts the structured TurnStartParams application context schema", async () => {
    await withSchemaBundle(compatibleSchemaBundle(), async (directory) => {
      await assertGeneratedSchemaSupportsApplicationContext(directory);
    });
  });

  it("requires the exact application AdditionalContext kind", async () => {
    const bundle = compatibleSchemaBundle();
    const definitions = bundle.definitions as Record<string, unknown>;
    const v2 = definitions.v2 as Record<string, unknown>;
    v2.AdditionalContextKind = {
      type: "string",
      enum: ["untrusted", "application-preview"],
    };

    await withSchemaBundle(bundle, async (directory) => {
      await assertRejects(
        () => assertGeneratedSchemaSupportsApplicationContext(directory),
        Error,
        "TurnStartParams.additionalContext",
      );
    });
  });
});

describe("assertGeneratedSchemaSupportsLocalImage", () => {
  it("accepts a localImage turn input with a string path", async () => {
    await withSchemaBundle(compatibleSchemaBundle(), async (directory) => {
      await assertGeneratedSchemaSupportsLocalImage(directory);
    });
  });

  it("accepts a root TurnStartParams document with inline localImage input", async () => {
    await withSchemaBundle(
      rootTurnStartParamsSchemaBundle(),
      async (directory) => {
        await assertGeneratedSchemaSupportsLocalImage(directory);
      },
    );
  });

  it("finds TurnStartParams in nested $defs", async () => {
    await withSchemaBundle(compatibleDefsSchemaBundle(), async (directory) => {
      await assertGeneratedSchemaSupportsLocalImage(directory);
    });
  });

  it("rejects a remote-only image input schema", async () => {
    const bundle = compatibleSchemaBundle();
    const definitions = bundle.definitions as Record<
      string,
      Record<string, unknown>
    >;
    const v2 = definitions.v2 as Record<string, unknown>;
    v2.LocalImageInput = {
      type: "object",
      required: ["type", "url"],
      properties: {
        type: { type: "string", enum: ["image"] },
        url: { type: "string" },
      },
    };

    await withSchemaBundle(bundle, async (directory) => {
      await assertRejects(
        () => assertGeneratedSchemaSupportsLocalImage(directory),
        Error,
        "TurnStartParams.input",
      );
    });
  });

  it("requires localImage inputs to require both type and path", async () => {
    const bundle = compatibleSchemaBundle();
    const definitions = bundle.definitions as Record<
      string,
      Record<string, unknown>
    >;
    const v2 = definitions.v2 as Record<string, unknown>;
    const localImage = v2.LocalImageInput as Record<string, unknown>;
    delete localImage.required;

    await withSchemaBundle(bundle, async (directory) => {
      await assertRejects(
        () => assertGeneratedSchemaSupportsLocalImage(directory),
        Error,
        "TurnStartParams.input",
      );
    });
  });
});
