import type { Logger } from "pino";
import { join } from "node:path";

type MaybePromise<T> = T | Promise<T>;
type JsonObject = Record<string, unknown>;

const SCHEMA_COMPATIBILITY_ERROR =
  'Generated Codex App Server schema must define TurnStartParams.additionalContext with the exact AdditionalContext kind "application"';
const LOCAL_IMAGE_SCHEMA_COMPATIBILITY_ERROR =
  "Generated Codex App Server schema must define TurnStartParams.input localImage entries with a string path";

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

function schemaProperty(
  document: JsonObject,
  schema: unknown,
  name: string,
): JsonObject | undefined {
  const resolved = resolveLocalReference(document, schema);
  const properties = isObject(resolved?.properties)
    ? resolved.properties
    : undefined;
  return resolveLocalReference(document, properties?.[name]);
}

function supportsApplicationContext(document: JsonObject): boolean {
  const additionalContext = resolveLocalReference(
    document,
    schemaProperty(document, document, "additionalContext"),
  );
  const entry = resolveLocalReference(
    document,
    additionalContext?.additionalProperties,
  );
  const kind = schemaProperty(document, entry, "kind");

  return Array.isArray(kind?.enum) && kind.enum.includes("application");
}

function isLocalImageInput(document: JsonObject, schema: unknown): boolean {
  const resolved = resolveLocalReference(document, schema);
  if (resolved === undefined) return false;
  const required = resolved.required;
  if (
    !Array.isArray(required) ||
    !required.includes("type") ||
    !required.includes("path")
  ) {
    return false;
  }

  const type = schemaProperty(document, resolved, "type");
  const path = schemaProperty(document, resolved, "path");

  return Array.isArray(type?.enum) && type.enum.includes("localImage") &&
    path?.type === "string";
}

function supportsLocalImage(document: JsonObject): boolean {
  const input = schemaProperty(document, document, "input");
  const userInput = resolveLocalReference(document, input?.items);
  return Array.isArray(userInput?.oneOf) &&
    userInput.oneOf.some((schema) => isLocalImageInput(document, schema));
}

async function readTurnStartSchema(directory: string): Promise<JsonObject> {
  const path = join(directory, "v2", "TurnStartParams.json");
  try {
    const document: unknown = JSON.parse(await Deno.readTextFile(path));
    if (isObject(document)) return document;
  } catch (cause) {
    throw new Error(`Invalid generated JSON schema: ${path}`, { cause });
  }
  throw new Error(`Invalid generated JSON schema: ${path}`);
}

export async function assertGeneratedTurnStartSchema(
  schemaDirectory: string,
): Promise<void> {
  const document = await readTurnStartSchema(schemaDirectory);
  if (!supportsApplicationContext(document)) {
    throw new Error(SCHEMA_COMPATIBILITY_ERROR);
  }
  if (!supportsLocalImage(document)) {
    throw new Error(LOCAL_IMAGE_SCHEMA_COMPATIBILITY_ERROR);
  }
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
