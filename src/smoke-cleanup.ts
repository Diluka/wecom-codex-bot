import type { Logger } from "pino";
import { join } from "node:path";

type MaybePromise<T> = T | Promise<T>;
type JsonObject = Record<string, unknown>;

const SCHEMA_COMPATIBILITY_ERROR =
  'Generated Codex App Server schema must define TurnStartParams.additionalContext with the exact AdditionalContext kind "application"';

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resolveLocalReference(
  document: JsonObject,
  schema: unknown,
): JsonObject | undefined {
  if (!isObject(schema)) return undefined;
  if (typeof schema.$ref !== "string") return schema;
  if (!schema.$ref.startsWith("#/")) return undefined;

  let current: unknown = document;
  for (const encodedPart of schema.$ref.slice(2).split("/")) {
    if (!isObject(current)) return undefined;
    const part = encodedPart.replaceAll("~1", "/").replaceAll("~0", "~");
    current = current[part];
  }
  return isObject(current) ? current : undefined;
}

function turnSchemaSupportsApplicationContext(
  document: JsonObject,
  turnSchema: unknown,
): boolean {
  const turn = resolveLocalReference(document, turnSchema);
  const properties = isObject(turn?.properties) ? turn.properties : undefined;
  const additionalContext = resolveLocalReference(
    document,
    properties?.additionalContext,
  );
  const entry = resolveLocalReference(
    document,
    additionalContext?.additionalProperties,
  );
  const entryProperties = isObject(entry?.properties)
    ? entry.properties
    : undefined;
  const kind = resolveLocalReference(document, entryProperties?.kind);

  return Array.isArray(kind?.enum) && kind.enum.includes("application");
}

function definitionsSupportApplicationContext(
  document: JsonObject,
  definitions: unknown,
): boolean {
  if (!isObject(definitions)) return false;

  return Object.entries(definitions).some(([name, schema]) =>
    (name === "TurnStartParams" &&
      turnSchemaSupportsApplicationContext(document, schema)) ||
    definitionsSupportApplicationContext(document, schema)
  );
}

function documentSupportsApplicationContext(document: unknown): boolean {
  if (!isObject(document)) return false;
  if (
    document.title === "TurnStartParams" &&
    turnSchemaSupportsApplicationContext(document, document)
  ) {
    return true;
  }
  return definitionsSupportApplicationContext(document, document.definitions);
}

async function* jsonSchemaFiles(directory: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(directory)) {
    const path = join(directory, entry.name);
    if (entry.isDirectory) {
      yield* jsonSchemaFiles(path);
    } else if (entry.isFile && entry.name.endsWith(".json")) {
      yield path;
    }
  }
}

export async function assertGeneratedSchemaSupportsApplicationContext(
  schemaDirectory: string,
): Promise<void> {
  for await (const path of jsonSchemaFiles(schemaDirectory)) {
    let document: unknown;
    try {
      document = JSON.parse(await Deno.readTextFile(path));
    } catch (cause) {
      throw new Error(`Invalid generated JSON schema: ${path}`, { cause });
    }
    if (documentSupportsApplicationContext(document)) return;
  }

  throw new Error(SCHEMA_COMPATIBILITY_ERROR);
}

export async function finishSmoke(
  codexLogger: Logger,
  close: () => MaybePromise<unknown>,
  flush: () => void,
  hasPrimaryError: boolean,
  cleanupSchema: () => MaybePromise<unknown>,
): Promise<void> {
  let retainedError: unknown;
  let hasRetainedError = false;

  try {
    await close();
  } catch (error) {
    codexLogger.error({ error }, "close_failed");
    if (!hasPrimaryError) {
      retainedError = error;
      hasRetainedError = true;
    }
  }

  try {
    await cleanupSchema();
  } catch (error) {
    codexLogger.error({ error }, "schema_cleanup_failed");
    if (!hasPrimaryError && !hasRetainedError) {
      retainedError = error;
      hasRetainedError = true;
    }
  }

  try {
    flush();
  } catch (error) {
    if (!hasPrimaryError && !hasRetainedError) {
      retainedError = error;
      hasRetainedError = true;
    }
  }

  if (hasRetainedError) throw retainedError;
}
