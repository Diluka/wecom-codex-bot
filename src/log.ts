import pino from "pino";
import pretty, { type PrettyOptions } from "pino-pretty";
import { redactSecrets } from "./output.ts";

const SCOPES = [
  "request",
  "codex",
  "wecom",
  "output",
  "lifecycle",
] as const;
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
const REQUEST_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

type LogScope = (typeof SCOPES)[number];
type LogFields = Record<string, unknown>;
type LogMethod = (message: unknown, fields?: LogFields) => void;

export interface LoggerOptions {
  secrets?: Iterable<string>;
  destination?: PrettyOptions["destination"];
}

export interface ScopedLogger {
  info: LogMethod;
  warn: LogMethod;
  error: LogMethod;
}

export type ProjectLogger = Record<LogScope, ScopedLogger> & {
  flush(): void;
};

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

export function createLogger(options: LoggerOptions = {}): ProjectLogger {
  const secrets = [...(options.secrets ?? [])];
  const stream = pretty({
    colorize: false,
    destination: options.destination,
    ignore: "pid,hostname,scope",
    messageFormat: (log, messageKey) =>
      `[${String(log.scope)}] ${String(log[messageKey])}`,
    singleLine: true,
    translateTime: "SYS:yyyy-mm-dd'T'HH:MM:ss.l o",
    sync: true,
  });
  const root = pino({ base: null }, stream);
  const scopes = Object.fromEntries(
    SCOPES.map((scope) => [
      scope,
      wrapLogger(root.child({ scope }), secrets),
    ]),
  ) as Record<LogScope, ScopedLogger>;

  return {
    ...scopes,
    flush: () => root.flush(),
  };
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
  logger: Pick<ProjectLogger, "request">,
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
  logger.request[level](event.state, fields);
}

function wrapLogger(
  logger: ReturnType<typeof pino>,
  secrets: readonly string[],
): ScopedLogger {
  const write = (
    level: "info" | "warn" | "error",
    message: unknown,
    fields?: LogFields,
  ): void => {
    const safeMessage = redactSecrets(loggerMessage(message), secrets);
    if (fields === undefined) logger[level](safeMessage);
    else logger[level](redactFields(fields, secrets), safeMessage);
  };
  return {
    info: (message, fields) => write("info", message, fields),
    warn: (message, fields) => write("warn", message, fields),
    error: (message, fields) => write("error", message, fields),
  };
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
    result[redactSecrets(key, secrets)] = redactValue(
      fields[key],
      secrets,
      seen,
    );
  }
  return result;
}

function redactValue(
  value: unknown,
  secrets: readonly string[],
  seen = new WeakMap<object, unknown>(),
): unknown {
  if (typeof value === "string") return redactSecrets(value, secrets);
  if (value instanceof Error) {
    return redactSecrets(loggerMessage(value), secrets);
  }
  if (value === null || typeof value !== "object") return value;

  const previous = seen.get(value);
  if (previous !== undefined) return previous;
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    seen.set(value, result);
    for (const entry of value) result.push(redactValue(entry, secrets, seen));
    return result;
  }

  const result: LogFields = Object.create(null);
  seen.set(value, result);
  for (const [key, entry] of Object.entries(value)) {
    result[redactSecrets(key, secrets)] = redactValue(entry, secrets, seen);
  }
  return result;
}

function loggerMessage(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  return String(value);
}

export type TerminalLogLevel = "info" | "error";

export interface TerminalLogger {
  log(message: string): void;
  error(message: string): void;
}

export function logTerminal(
  level: TerminalLogLevel,
  value: unknown,
  secrets: Iterable<string>,
  logger: TerminalLogger = console,
): void {
  const message = redactSecrets(errorMessage(value), secrets);
  if (level === "error") logger.error(`[wecom-codex-bot] ${message}`);
  else logger.log(`[wecom-codex-bot] ${message}`);
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;
  return String(value);
}
