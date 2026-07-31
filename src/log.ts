import { once } from "node:events";
import pino, {
  type Bindings,
  type ChildLoggerOptions,
  type DestinationStream,
  type LogFn,
  type Logger,
} from "pino";
import pretty, { type PrettyOptions } from "pino-pretty";
import type { CodexAppServerLifecycleEvent } from "./codex-app-server.ts";
import type { LogLevel } from "./config.ts";

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
const OMIT_LOG_VALUE = Symbol("omit-log-value");
const MAX_LOG_TEXT_LENGTH = 100;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});
type LogFields = Record<string, unknown>;

export interface LoggerOptions {
  destination?: PrettyOptions["destination"];
  stream?: DestinationStream;
  level?: LogLevel;
}

export interface LogTransportOptions {
  level: LogLevel;
  filePath: string;
  terminalDestination?: PrettyOptions["destination"];
  onFileError?: (error: Error) => void;
}

type FileTransport = ReturnType<typeof pino.transport> & {
  readonly ready: boolean;
  readonly destroyed: boolean;
  readonly closed: boolean;
};

type RemovableMultiStream = ReturnType<typeof pino.multistream> & {
  readonly lastId: number;
  remove(id: number): RemovableMultiStream;
};

export interface LogTransport {
  stream: DestinationStream;
  file: FileTransport;
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
  const stream = options.stream ??
    pretty({
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
    level: options.level ?? "info",
    base: null,
    hooks: {
      logMethod(args, method) {
        const normalizedArgs = args.map((argument, index) =>
          normalizeLogArgument(argument, index === 0)
        ) as Parameters<LogFn>;
        method.apply(this, normalizedArgs);
      },
    },
  }, stream);

  return normalizeChildLogger(root);
}

export function createLogTransport(
  options: LogTransportOptions,
): LogTransport {
  const terminal = pretty({
    colorize: false,
    destination: options.terminalDestination,
    errorLikeObjectKeys: [],
    ignore: "pid,hostname,scope",
    messageFormat: (log, messageKey) =>
      `[${String(log.scope)}] ${String(log[messageKey])}`,
    singleLine: true,
    translateTime: "SYS:yyyy-mm-dd'T'HH:MM:ss.l o",
    sync: true,
  });
  const file = pino.transport({
    target: "pino/file",
    options: {
      destination: options.filePath,
      mkdir: true,
      append: true,
      mode: 0o600,
    },
  }) as FileTransport;
  const stream = pino.multistream([
    { level: options.level, stream: terminal },
  ]) as RemovableMultiStream;
  stream.add({ level: options.level, stream: file });
  const fileStreamId = stream.lastId;
  let fileAttached = true;

  file.on("error", (error: Error) => {
    if (!fileAttached) return;
    fileAttached = false;
    stream.remove(fileStreamId);
    options.onFileError?.(error);
  });

  return { stream, file };
}

export async function waitForLogTransport(
  transport: LogTransport,
): Promise<void> {
  if (transport.file.ready) return;
  await once(transport.file, "ready");
}

export async function closeLogTransport(
  transport: LogTransport,
): Promise<void> {
  if (transport.file.closed) return;
  const closed = once(transport.file, "close");
  if (!transport.file.destroyed) transport.file.end();
  await closed;
}

export function summarizeRequest(text: string): string {
  const normalized = text.replace(/\s+/gu, " ").trim();
  const graphemes = [...GRAPHEME_SEGMENTER.segment(normalized)];
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

export function logAppServerLifecycle(
  logger: Logger,
  event: CodexAppServerLifecycleEvent,
): void {
  logger[event.level]({
    method: event.method,
    request_id: event.requestId,
    thread_id: event.threadId,
    turn_id: event.turnId,
    item_id: event.itemId,
    item_type: event.itemType,
    status: event.status,
    elapsed_ms: event.elapsedMs,
    delta_length: event.deltaLength,
    delta_chunks: event.deltaChunks,
    summary_parts: event.summaryParts,
    content_parts: event.contentParts,
    question_count: event.questionCount,
    error_code: event.errorCode,
    failure: event.failure,
    policy: event.policy,
    exit_code: event.exitCode,
    signal: event.signal,
    success: event.success,
    expected: event.expected,
    pending_requests: event.pendingRequests,
  }, event.event);
}

export function logAppServerStderr(logger: Logger, message: string): void {
  logger.debug({ chunk_length: message.length }, "app_server_stderr");
}

function normalizeLogArgument(
  value: unknown,
  isFirst: boolean,
): unknown {
  if (isFirst && isLogFields(value)) return normalizeFields(value);
  if (typeof value === "string") {
    return normalizeText(value);
  }
  const normalized = normalizeValue(value);
  return normalized === OMIT_LOG_VALUE ? null : normalized;
}

function isLogFields(value: unknown): value is LogFields {
  return value !== null && typeof value === "object" &&
    !Array.isArray(value) && !(value instanceof Error);
}

function normalizeFields(fields: LogFields): LogFields {
  const result: LogFields = Object.create(null);
  const seen = new WeakMap<object, unknown>();
  seen.set(fields, result);
  for (const key of Object.keys(fields)) {
    if (RESERVED_LOG_FIELDS.has(key)) continue;
    const normalized = normalizeValue(fields[key], seen);
    if (normalized === OMIT_LOG_VALUE) continue;
    result[normalizeText(key)] = normalized;
  }
  return result;
}

function normalizeChildLogger(logger: Logger): Logger {
  const child = logger.child as unknown as (
    this: Logger,
    bindings: Bindings,
    options?: ChildLoggerOptions,
  ) => Logger;
  logger.child = (function (
    this: Logger,
    bindings: Bindings,
    options?: ChildLoggerOptions,
  ): Logger {
    return child.call(this, normalizeChildBindings(bindings), options);
  }) as unknown as Logger["child"];
  return logger;
}

function normalizeChildBindings(bindings: Bindings): Bindings {
  // Pino calls hasOwnProperty while serializing child bindings.
  const result: Bindings = {};
  const seen = new WeakMap<object, unknown>();
  seen.set(bindings, result);
  for (const key of Object.keys(bindings)) {
    if (key !== "scope" && RESERVED_LOG_FIELDS.has(key)) continue;
    const normalized = normalizeValue(bindings[key], seen);
    if (normalized === OMIT_LOG_VALUE) continue;
    result[normalizeText(key)] = normalized;
  }
  return result;
}

function normalizeValue(
  value: unknown,
  seen = new WeakMap<object, unknown>(),
): unknown {
  if (
    value === undefined || typeof value === "function" ||
    typeof value === "symbol" || typeof value === "bigint"
  ) {
    return OMIT_LOG_VALUE;
  }
  if (typeof value === "string") return normalizeText(value);
  if (value instanceof Error) {
    const previous = seen.get(value);
    if (previous !== undefined) return previous;
    const result: LogFields = Object.create(null);
    seen.set(value, result);
    result.type = normalizeText(value.name);
    result.message = normalizeText(value.message);
    if (value.stack) result.stack = normalizeStackFrame(value.stack);
    if (value.cause !== undefined) {
      const cause = normalizeValue(value.cause, seen);
      if (cause !== OMIT_LOG_VALUE) result.cause = cause;
    }
    for (const [key, entry] of Object.entries(value)) {
      if (key === "cause") continue;
      const normalized = normalizeValue(entry, seen);
      if (normalized === OMIT_LOG_VALUE) continue;
      result[normalizeText(key)] = normalized;
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
      const normalized = normalizeValue(entry, seen);
      result.push(normalized === OMIT_LOG_VALUE ? null : normalized);
    }
    return result;
  }

  const result: LogFields = Object.create(null);
  seen.set(value, result);
  for (const [key, entry] of Object.entries(value)) {
    const normalized = normalizeValue(entry, seen);
    if (normalized === OMIT_LOG_VALUE) continue;
    result[normalizeText(key)] = normalized;
  }
  return result;
}

function singleLine(value: string): string {
  return value.replace(/\r\n|\r|\n/gu, "\\n");
}

function normalizeText(value: string): string {
  return truncateText(singleLine(value));
}

function truncateText(value: string): string {
  const graphemes = [...GRAPHEME_SEGMENTER.segment(value)];
  if (graphemes.length <= MAX_LOG_TEXT_LENGTH) return value;
  return graphemes.slice(0, MAX_LOG_TEXT_LENGTH - 1).map(({ segment }) =>
    segment
  ).join("") + "…";
}

function normalizeStackFrame(stack: string): string {
  const lines = stack.split(/\r\n|\r|\n/gu);
  const frame = lines.slice(1).find((line) => line.trim()) ?? lines[0] ?? "";
  const value = singleLine(frame.trim());
  const graphemes = [...GRAPHEME_SEGMENTER.segment(value)];
  if (graphemes.length <= MAX_LOG_TEXT_LENGTH) return value;
  const head = graphemes.slice(0, 49).map(({ segment }) => segment).join("");
  const tail = graphemes.slice(-50).map(({ segment }) => segment).join("");
  return `${head}…${tail}`;
}
