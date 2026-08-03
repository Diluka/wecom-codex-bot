import type { Logger } from "pino";
import { join } from "node:path";

type MaybePromise<T> = T | Promise<T>;
type JsonObject = Record<string, unknown>;

const SCHEMA_COMPATIBILITY_ERROR =
  'Generated Codex App Server schema must define TurnStartParams.additionalContext with the exact AdditionalContext kind "application"';
const LOCAL_IMAGE_SCHEMA_COMPATIBILITY_ERROR =
  "Generated Codex App Server schema must define TurnStartParams.input localImage entries with a string path";
const JSON_SCHEMA_KEYWORDS = new Set([
  "$schema",
  "$id",
  "$ref",
  "$anchor",
  "$dynamicRef",
  "$dynamicAnchor",
  "$vocabulary",
  "$comment",
  "$defs",
  "definitions",
  "title",
  "description",
  "default",
  "deprecated",
  "readOnly",
  "writeOnly",
  "examples",
  "type",
  "enum",
  "const",
  "multipleOf",
  "maximum",
  "exclusiveMaximum",
  "minimum",
  "exclusiveMinimum",
  "maxLength",
  "minLength",
  "pattern",
  "prefixItems",
  "items",
  "additionalItems",
  "contains",
  "minContains",
  "maxContains",
  "maxItems",
  "minItems",
  "uniqueItems",
  "properties",
  "patternProperties",
  "additionalProperties",
  "unevaluatedProperties",
  "propertyNames",
  "maxProperties",
  "minProperties",
  "required",
  "dependentRequired",
  "dependentSchemas",
  "dependencies",
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "unevaluatedItems",
  "format",
  "contentEncoding",
  "contentMediaType",
  "contentSchema",
]);

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasJsonSchemaKeyword(value: JsonObject): boolean {
  return Object.keys(value).some((key) => JSON_SCHEMA_KEYWORDS.has(key));
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

function resolveReferenceChain(
  document: JsonObject,
  schema: unknown,
  seen = new WeakSet<object>(),
): JsonObject | undefined {
  if (!isObject(schema) || seen.has(schema)) return undefined;
  seen.add(schema);
  if (typeof schema.$ref !== "string") return schema;

  const target = resolveLocalReference(document, schema);
  return target === undefined
    ? undefined
    : resolveReferenceChain(document, target, seen);
}

function isLocalImageInputSchema(
  document: JsonObject,
  schema: JsonObject,
): boolean {
  const required = schema.required;
  if (
    !Array.isArray(required) ||
    !required.includes("type") ||
    !required.includes("path")
  ) {
    return false;
  }

  const properties = isObject(schema.properties)
    ? schema.properties
    : undefined;
  const type = resolveReferenceChain(document, properties?.type);
  const path = resolveReferenceChain(document, properties?.path);

  return (type?.const === "localImage" ||
    (Array.isArray(type?.enum) && type.enum.includes("localImage"))) &&
    path?.type === "string";
}

function schemaSupportsLocalImage(
  document: JsonObject,
  schema: unknown,
  seen: WeakSet<object>,
): boolean {
  if (!isObject(schema) || seen.has(schema)) return false;
  seen.add(schema);

  if (isLocalImageInputSchema(document, schema)) return true;

  const target = resolveLocalReference(document, schema);
  if (
    target !== undefined && target !== schema &&
    schemaSupportsLocalImage(document, target, seen)
  ) {
    return true;
  }

  for (const key of ["items", "oneOf", "anyOf", "allOf"]) {
    const nested = schema[key];
    if (Array.isArray(nested)) {
      if (
        nested.some((entry) => schemaSupportsLocalImage(document, entry, seen))
      ) {
        return true;
      }
    } else if (schemaSupportsLocalImage(document, nested, seen)) {
      return true;
    }
  }

  return false;
}

function turnSchemaSupportsLocalImage(
  document: JsonObject,
  turnSchema: unknown,
): boolean {
  const turn = resolveLocalReference(document, turnSchema);
  const properties = isObject(turn?.properties) ? turn.properties : undefined;
  return schemaSupportsLocalImage(
    document,
    properties?.input,
    new WeakSet<object>(),
  );
}

function definitionsSupportLocalImage(
  document: JsonObject,
  definitions: unknown,
  seen = new WeakSet<object>(),
): boolean {
  if (!isObject(definitions) || seen.has(definitions)) return false;
  seen.add(definitions);

  return Object.entries(definitions).some(([name, schema]) => {
    if (
      name === "TurnStartParams" &&
      turnSchemaSupportsLocalImage(document, schema)
    ) {
      return true;
    }
    if (!isObject(schema)) return false;

    if (hasJsonSchemaKeyword(schema)) {
      return definitionsSupportLocalImage(
        document,
        schema.definitions,
        seen,
      ) || definitionsSupportLocalImage(document, schema.$defs, seen);
    }
    return definitionsSupportLocalImage(document, schema, seen);
  });
}

function documentSupportsLocalImage(document: unknown): boolean {
  if (!isObject(document)) return false;
  if (document.title === "TurnStartParams") {
    return turnSchemaSupportsLocalImage(document, document);
  }
  return definitionsSupportLocalImage(document, document.definitions) ||
    definitionsSupportLocalImage(document, document.$defs);
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

export async function assertGeneratedSchemaSupportsLocalImage(
  schemaDirectory: string,
): Promise<void> {
  for await (const path of jsonSchemaFiles(schemaDirectory)) {
    let document: unknown;
    try {
      document = JSON.parse(await Deno.readTextFile(path));
    } catch {
      throw new Error("Invalid generated JSON schema");
    }
    if (documentSupportsLocalImage(document)) return;
  }
  throw new Error(LOCAL_IMAGE_SCHEMA_COMPATIBILITY_ERROR);
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
