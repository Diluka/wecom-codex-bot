import pino, { type LogFn, type Logger } from "pino";
import pretty, { type PrettyOptions } from "pino-pretty";
import { redactSecrets } from "./output.ts";

const REQUEST_WARN = new Set(["runtime_unavailable", "shutdown_discarded"]);
const REQUEST_ERROR = new Set(["failed", "runtime_lost"]);
const RESERVED_LOG_FIELDS = new Set([
  "scope",
  "time",
  "level",
  "pid",
  "hostname",
  "msg",
  "name",
  "v",
]);
const REDACT_PATHS = [...RESERVED_LOG_FIELDS, "*"];
const OMIT_LOG_VALUE = Symbol("omit-log-value");
const REQUEST_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

type LogFields = Record<string, unknown>;

export interface LoggerOptions {
  secrets?: Iterable<string>;
  destination?: PrettyOptions["destination"];
}

// Structural by design: the orchestrator's later event type needs no import here.
export interface RequestStatusEventLike {
  state: string;
  chatType: string;
  chatId: string;
  userId: string;
  msgId: string;
  summary?: string;
  threadId?: string;
  turnId?: string;
  replacedByMsgId?: string;
  triggerMsgId?: string;
  reason?: string;
  error?: unknown;
  elapsedMs?: number;
  activeCount?: number;
  pendingCount?: number;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const secrets = [...(options.secrets ?? [])];
  const stream = pretty({
    colorize: false,
    destination: options.destination,
    errorLikeObjectKeys: [],
    ignore: "pid,hostname,scope",
    messageFormat: (log, messageKey) =>
      `[${String(log.scope)}] ${String(log[messageKey])}`,
    singleLine: true,
    translateTime: "SYS:yyyy-mm-dd'T'HH:MM:ss.l o",
    sync: true,
  });
  const root = pino({
    base: null,
    redact: {
      // Explicit paths preserve the actual key; Pino reports wildcard keys as
      // an internal symbol when serializing child bindings.
      paths: REDACT_PATHS,
      censor(value, path) {
        const key = path[0];
        if (
          key !== "scope" && key !== "msg" && RESERVED_LOG_FIELDS.has(key)
        ) {
          return undefined;
        }
        const redacted = redactValue(value, secrets);
        if (redacted === OMIT_LOG_VALUE) return undefined;
        return (key === "scope" || key === "msg") &&
            typeof redacted === "string"
          ? singleLine(redacted)
          : redacted;
      },
    },
    hooks: {
      logMethod(args, method) {
        const sanitizedArgs = args.map((argument, index) =>
          sanitizeLogArgument(argument, index === 0, secrets)
        ) as Parameters<LogFn>;
        method.apply(this, sanitizedArgs);
      },
    },
  }, stream);

  return root;
}

export function summarizeRequest(
  text: string,
  secrets: Iterable<string> = [],
): string {
  const normalized = redactSecrets(text, secrets).replace(/\s+/gu, " ").trim();
  const graphemes = [...REQUEST_SEGMENTER.segment(normalized)];
  const summary = graphemes.slice(0, 10).map(({ segment }) => segment).join("");
  return graphemes.length > 10 ? `${summary}…` : summary;
}

export function logRequestStatus(
  logger: Logger,
  event: RequestStatusEventLike,
): void {
  const fields: LogFields = {
    chat_type: event.chatType,
    chat_id: event.chatId,
    user_id: event.userId,
    msg_id: event.msgId,
    summary: event.summary,
    thread_id: event.threadId,
    turn_id: event.turnId,
    replaced_by_msg_id: event.replacedByMsgId,
    trigger_msg_id: event.triggerMsgId,
    reason: event.reason,
    error: event.error,
    elapsed_ms: event.elapsedMs,
    active_count: event.activeCount,
    pending_count: event.pendingCount,
  };
  const level = REQUEST_ERROR.has(event.state)
    ? "error"
    : REQUEST_WARN.has(event.state)
    ? "warn"
    : "info";
  logger[level](fields, event.state);
}

function sanitizeLogArgument(
  value: unknown,
  isFirst: boolean,
  secrets: readonly string[],
): unknown {
  if (isFirst && isLogFields(value)) return redactFields(value, secrets);
  if (typeof value === "string") {
    return singleLine(redactSecrets(value, secrets));
  }
  const redacted = redactValue(value, secrets);
  return redacted === OMIT_LOG_VALUE ? null : redacted;
}

function isLogFields(value: unknown): value is LogFields {
  return value !== null && typeof value === "object" &&
    !Array.isArray(value) && !(value instanceof Error);
}

function redactFields(
  fields: LogFields,
  secrets: readonly string[],
): LogFields {
  const result: LogFields = Object.create(null);
  const seen = new WeakMap<object, unknown>();
  seen.set(fields, result);
  for (const key of Object.keys(fields)) {
    if (RESERVED_LOG_FIELDS.has(key)) continue;
    const redacted = redactValue(
      fields[key],
      secrets,
      seen,
    );
    if (redacted === OMIT_LOG_VALUE) continue;
    result[redactSecrets(key, secrets)] = redacted;
  }
  return result;
}

function redactValue(
  value: unknown,
  secrets: readonly string[],
  seen = new WeakMap<object, unknown>(),
): unknown {
  if (
    value === undefined || typeof value === "function" ||
    typeof value === "symbol" || typeof value === "bigint"
  ) {
    return OMIT_LOG_VALUE;
  }
  if (typeof value === "string") return redactSecrets(value, secrets);
  if (value instanceof Error) {
    const previous = seen.get(value);
    if (previous !== undefined) return previous;
    const result: LogFields = Object.create(null);
    seen.set(value, result);
    result.type = redactSecrets(value.name, secrets);
    result.message = redactSecrets(value.message, secrets);
    if (value.stack) result.stack = redactSecrets(value.stack, secrets);
    if (value.cause !== undefined) {
      const cause = redactValue(value.cause, secrets, seen);
      if (cause !== OMIT_LOG_VALUE) result.cause = cause;
    }
    for (const [key, entry] of Object.entries(value)) {
      if (key === "cause") continue;
      const redacted = redactValue(entry, secrets, seen);
      if (redacted === OMIT_LOG_VALUE) continue;
      result[redactSecrets(key, secrets)] = redacted;
    }
    return result;
  }
  if (value === null || typeof value !== "object") return value;

  const previous = seen.get(value);
  if (previous !== undefined) return previous;
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    seen.set(value, result);
    for (const entry of value) {
      const redacted = redactValue(entry, secrets, seen);
      result.push(redacted === OMIT_LOG_VALUE ? null : redacted);
    }
    return result;
  }

  const result: LogFields = Object.create(null);
  seen.set(value, result);
  for (const [key, entry] of Object.entries(value)) {
    const redacted = redactValue(entry, secrets, seen);
    if (redacted === OMIT_LOG_VALUE) continue;
    result[redactSecrets(key, secrets)] = redacted;
  }
  return result;
}

function singleLine(value: string): string {
  return value.replace(/\r\n|\r|\n/gu, "\\n");
}
