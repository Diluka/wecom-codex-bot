import type { ProgressTail } from "./progress-tail.ts";

export const DEFAULT_TAIL_BYTES = 16 * 1024;
export const DEFAULT_SPLIT_BYTES = 18 * 1024;
export const DEFAULT_MAX_PARTS = 4;
const DEFAULT_FLUSH_INTERVAL_MS = 2_500;
const DEFAULT_ROTATE_AFTER_MS = 6 * 60_000;
const DEFAULT_RETRY_DELAY_MS = 2_500;
const DEFAULT_MAX_FINISH_ATTEMPTS = 3;
const DEFAULT_MAX_ROTATION_ATTEMPTS = 3;
export const WECOM_MINUTE_LIMIT = 30;
export const WECOM_HOUR_LIMIT = 1_000;
export const WECOM_REGULAR_MINUTE_LIMIT = 24;
export const WECOM_REGULAR_HOUR_LIMIT = 900;
export const TRUNCATION_MARKER = "\n\n[内容过长，已截断]";
const CONTINUATION_MARKER = "[Progress continues in a new stream]";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const encoder = new TextEncoder();

function byteLength(value: string): number {
  return encoder.encode(value).byteLength;
}

function validateByteLimit(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer");
  }
}

function utf8Prefix(value: string, maxBytes: number): string {
  validateByteLimit(maxBytes);
  let used = 0;
  const result: string[] = [];
  for (const character of value) {
    const size = byteLength(character);
    if (used + size > maxBytes) break;
    result.push(character);
    used += size;
  }
  return result.join("");
}

export function utf8Tail(
  value: string,
  maxBytes = DEFAULT_TAIL_BYTES,
): string {
  validateByteLimit(maxBytes);
  let used = 0;
  const result: string[] = [];
  const characters = Array.from(value);
  for (let index = characters.length - 1; index >= 0; index--) {
    const character = characters[index];
    const size = byteLength(character);
    if (used + size > maxBytes) break;
    result.push(character);
    used += size;
  }
  return result.reverse().join("");
}

function chunks(value: string, maxBytes: number): string[] {
  validateByteLimit(maxBytes);
  if (maxBytes === 0) {
    if (value.length === 0) return [];
    throw new RangeError("maxBytes must be greater than zero for splitting");
  }

  const result: string[] = [];
  let current: string[] = [];
  let currentBytes = 0;
  for (const character of value) {
    const size = byteLength(character);
    if (size > maxBytes) {
      throw new RangeError("maxBytes is smaller than one UTF-8 code point");
    }
    if (currentBytes + size > maxBytes) {
      result.push(current.join(""));
      current = [];
      currentBytes = 0;
    }
    current.push(character);
    currentBytes += size;
  }
  if (current.length > 0) result.push(current.join(""));
  return result;
}

export function splitUtf8(
  value: string,
  maxBytes = DEFAULT_SPLIT_BYTES,
  maxParts = DEFAULT_MAX_PARTS,
): string[] {
  if (!Number.isSafeInteger(maxParts) || maxParts <= 0) {
    throw new RangeError("maxParts must be a positive safe integer");
  }
  const allParts = chunks(value, maxBytes);
  if (allParts.length <= maxParts) return allParts;

  const markerBytes = byteLength(TRUNCATION_MARKER);
  if (markerBytes > maxBytes) {
    throw new RangeError("maxBytes is too small for the truncation marker");
  }
  const result = allParts.slice(0, maxParts);
  result[maxParts - 1] = utf8Prefix(
    result[maxParts - 1],
    maxBytes - markerBytes,
  ) + TRUNCATION_MARKER;
  return result;
}

export interface ProgressBufferOptions {
  maxBytes?: number;
}

/** Retains a UTF-8-safe tail of streamed progress. */
export class ProgressBuffer {
  readonly #maxBytes: number;
  #content = "";

  constructor(options: ProgressBufferOptions = {}) {
    this.#maxBytes = options.maxBytes ?? DEFAULT_TAIL_BYTES;
    validateByteLimit(this.#maxBytes);
  }

  append(content: string): this {
    this.#content = utf8Tail(this.#content + content, this.#maxBytes);
    return this;
  }

  replaceTailBlock(expected: string, replacement: string): string | null {
    const prefix = this.#prefixBeforeTail(expected);
    if (prefix === null) return null;
    const block = progressBlockSeparator(prefix, replacement) + replacement;
    this.#replaceFromPrefix(prefix, block);
    return block;
  }

  #prefixBeforeTail(expected: string): string | null {
    if (!expected || !this.#content.endsWith(expected)) {
      return null;
    }
    return this.#content.slice(0, -expected.length);
  }

  #replaceFromPrefix(prefix: string, replacement: string): void {
    this.#content = utf8Tail(prefix + replacement, this.#maxBytes);
  }

  snapshot(): string {
    return this.#content;
  }
}

export type WeComStreamSender = (
  frame: unknown,
  streamId: string,
  content: string,
  finish: boolean,
) => Promise<unknown>;

/** Serializes and rate-limits outbound sends per conversation. */
export class ConversationSendQueue {
  readonly #regularQueues = new Map<string, Promise<void>>();
  readonly #operationQueues = new Map<string, Promise<void>>();
  readonly #sendTimes = new Map<string, number[]>();
  readonly #now: () => number;
  readonly #wait: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  readonly #regularAbort = new AbortController();
  #regularShutdown = false;
  #closed = false;

  constructor(options: ConversationSendQueueOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#wait = options.wait ?? systemWait;
  }

  beginShutdown(): void {
    if (this.#regularShutdown) return;
    this.#regularShutdown = true;
    this.#regularAbort.abort();
  }

  close(): void {
    if (this.#closed) return;
    this.beginShutdown();
    this.#closed = true;
    this.#sendTimes.clear();
  }

  enqueue<T>(conversationKey: string, operation: () => Promise<T>): Promise<T> {
    if (this.#regularShutdown) {
      return Promise.reject(queueShutdownError());
    }
    const previous = this.#regularQueues.get(conversationKey) ??
      Promise.resolve();
    const run = async () => {
      this.#assertRegularOpen();
      await this.#acquire(
        conversationKey,
        WECOM_REGULAR_MINUTE_LIMIT,
        WECOM_REGULAR_HOUR_LIMIT,
      );
      this.#assertRegularOpen();
      return await this.#serialize(conversationKey, async () => {
        this.#assertRegularOpen();
        return await this.#runRegularOperation(operation);
      });
    };
    const result = previous.then(run, run);
    const settled = result.then(() => undefined, () => undefined);
    this.#regularQueues.set(conversationKey, settled);
    void settled.then(() => {
      if (this.#regularQueues.get(conversationKey) === settled) {
        this.#regularQueues.delete(conversationKey);
      }
    });
    return result;
  }

  tryEnqueue<T>(
    conversationKey: string,
    operation: () => Promise<T>,
  ): Promise<QueueAttempt<T>> {
    if (
      this.#regularShutdown ||
      this.#regularQueues.has(conversationKey) ||
      this.#operationQueues.has(conversationKey) ||
      !this.#tryAcquire(
        conversationKey,
        WECOM_REGULAR_MINUTE_LIMIT,
        WECOM_REGULAR_HOUR_LIMIT,
      )
    ) {
      return Promise.resolve({ accepted: false });
    }
    return this.#serialize(conversationKey, async () => {
      if (this.#regularShutdown) return { accepted: false };
      return await this.#runTryOperation(operation);
    });
  }

  enqueueCritical<T>(
    conversationKey: string,
    operation: () => Promise<T>,
  ): Promise<QueueAttempt<T>> {
    if (this.#closed) return Promise.resolve({ accepted: false });
    return this.#serialize(conversationKey, async () => {
      if (this.#closed) return { accepted: false };
      if (
        !this.#tryAcquire(
          conversationKey,
          WECOM_MINUTE_LIMIT,
          WECOM_HOUR_LIMIT,
        )
      ) {
        return { accepted: false };
      }
      return { accepted: true, value: await operation() };
    });
  }

  async #acquire(
    conversationKey: string,
    minuteLimit: number,
    hourLimit: number,
  ): Promise<void> {
    const sendTimes = this.#sendTimes.get(conversationKey) ?? [];
    this.#sendTimes.set(conversationKey, sendTimes);

    while (true) {
      const now = this.#now();
      const delayMs = this.#delayUntilAvailable(
        sendTimes,
        now,
        minuteLimit,
        hourLimit,
      );

      if (delayMs <= 0) {
        sendTimes.push(now);
        return;
      }
      await this.#waitForRegular(Math.max(1, Math.ceil(delayMs)));
    }
  }

  async #waitForRegular(delayMs: number): Promise<void> {
    const signal = this.#regularAbort.signal;
    if (signal.aborted) throw queueShutdownError();

    let rejectAborted: ((reason?: unknown) => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAborted = reject;
    });
    const onAbort = () => rejectAborted?.(queueShutdownError());
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      await Promise.race([this.#wait(delayMs, signal), aborted]);
    } catch (error) {
      if (signal.aborted) throw queueShutdownError();
      throw error;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  async #runRegularOperation<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const signal = this.#regularAbort.signal;
    if (signal.aborted) throw queueShutdownError();

    let rejectAborted: ((reason?: unknown) => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAborted = reject;
    });
    const onAbort = () => rejectAborted?.(queueShutdownError());
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      // Release the queue even if the underlying gateway reply cannot abort.
      return await Promise.race([operation(), aborted]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  async #runTryOperation<T>(
    operation: () => Promise<T>,
  ): Promise<QueueAttempt<T>> {
    const signal = this.#regularAbort.signal;
    if (signal.aborted) return { accepted: false };

    let resolveAborted: (() => void) | undefined;
    const aborted = new Promise<QueueAttempt<T>>((resolve) => {
      resolveAborted = () => resolve({ accepted: false });
    });
    const onAbort = () => resolveAborted?.();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      let result: Promise<QueueAttempt<T>>;
      try {
        result = Promise.resolve(operation()).then((value) => ({
          accepted: true as const,
          value,
        }));
      } catch (error) {
        result = Promise.reject(error);
      }
      return await Promise.race([result, aborted]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  #assertRegularOpen(): void {
    if (this.#regularShutdown) throw queueShutdownError();
  }

  #tryAcquire(
    conversationKey: string,
    minuteLimit: number,
    hourLimit: number,
  ): boolean {
    const sendTimes = this.#sendTimes.get(conversationKey) ?? [];
    this.#sendTimes.set(conversationKey, sendTimes);
    const now = this.#now();
    if (
      this.#delayUntilAvailable(sendTimes, now, minuteLimit, hourLimit) > 0
    ) return false;
    sendTimes.push(now);
    return true;
  }

  #delayUntilAvailable(
    sendTimes: number[],
    now: number,
    minuteLimit: number,
    hourLimit: number,
  ): number {
    while (sendTimes.length > 0 && sendTimes[0] <= now - HOUR_MS) {
      sendTimes.shift();
    }

    let minuteStart = 0;
    while (
      minuteStart < sendTimes.length &&
      sendTimes[minuteStart] <= now - MINUTE_MS
    ) {
      minuteStart++;
    }

    let delayMs = 0;
    if (sendTimes.length - minuteStart >= minuteLimit) {
      delayMs = Math.max(
        delayMs,
        sendTimes[minuteStart] + MINUTE_MS - now,
      );
    }
    if (sendTimes.length >= hourLimit) {
      delayMs = Math.max(delayMs, sendTimes[0] + HOUR_MS - now);
    }
    return delayMs;
  }

  #serialize<T>(
    conversationKey: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#operationQueues.get(conversationKey) ??
      Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(() => undefined, () => undefined);
    this.#operationQueues.set(conversationKey, settled);
    void settled.then(() => {
      if (this.#operationQueues.get(conversationKey) === settled) {
        this.#operationQueues.delete(conversationKey);
      }
    });
    return result;
  }
}

export type QueueAttempt<T> =
  | { accepted: true; value: T }
  | { accepted: false };

export interface ConversationSendQueueOptions {
  now?: () => number;
  wait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

function systemWait(delayMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(queueShutdownError());
      return;
    }

    const handle = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(handle);
      reject(queueShutdownError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function queueShutdownError(): Error {
  return new Error("conversation send queue is shutting down");
}

export interface WeComSinkOptions {
  send: WeComStreamSender;
  queue?: ConversationSendQueue;
  onError?: (error: Error) => unknown;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** Sends stream frames through the conversation queue with failure reporting. */
export class WeComSink {
  readonly #options: WeComSinkOptions;
  readonly #queue: ConversationSendQueue;

  constructor(options: WeComSinkOptions) {
    this.#options = options;
    this.#queue = options.queue ?? new ConversationSendQueue();
  }

  send(
    conversationKey: string,
    frame: unknown,
    streamId: string,
    content: string,
    finish: boolean,
    critical = finish,
  ): Promise<boolean> {
    const operation = async () => {
      try {
        await this.#options.send(frame, streamId, content, finish);
        return true;
      } catch (value) {
        try {
          this.#options.onError?.(toError(value));
        } catch {
          // A reporting callback must not break the per-conversation queue.
        }
        return false;
      }
    };
    const queued = critical
      ? this.#queue.enqueueCritical(conversationKey, operation)
      : this.#queue.tryEnqueue(conversationKey, operation);
    return queued.then((attempt) => attempt.accepted ? attempt.value : false);
  }
}

export interface TimerApi {
  setTimeout(
    callback: () => void | Promise<void>,
    delayMs: number,
  ): unknown;
  clearTimeout(handle: unknown): void;
}

const systemTimers: TimerApi = {
  setTimeout(callback, delayMs) {
    return globalThis.setTimeout(() => {
      try {
        void Promise.resolve(callback()).catch(() => undefined);
      } catch {
        // Controller callbacks route sender failures through WeComSink.
      }
    }, delayMs);
  },
  clearTimeout(handle) {
    globalThis.clearTimeout(handle as number);
  },
};

function progressBlockSeparator(current: string, next: string): string {
  const currentEndsWithBreak = current.endsWith("\n") || current.endsWith("\r");
  const nextStartsWithBreak = next.startsWith("\n") || next.startsWith("\r");
  return current && !currentEndsWithBreak && !nextStartsWithBreak ? "\n" : "";
}

function appendProgressSnapshot(
  target: ProgressBuffer,
  content: string,
): void {
  if (!content) return;
  target.append(progressBlockSeparator(target.snapshot(), content) + content);
}

interface TrackedProgressTail extends ProgressTail {
  content: string;
}

export interface StreamControllerOptions {
  conversationKey: string;
  frame: unknown;
  sink: WeComSink;
  streamIdFactory?: () => string;
  timers?: TimerApi;
}

/** Coalesces, rotates, and finalizes a single WeCom progress stream. */
export class StreamController {
  readonly #conversationKey: string;
  readonly #frame: unknown;
  readonly #sink: WeComSink;
  #buffer: ProgressBuffer;
  readonly #streamIdFactory: () => string;
  readonly #timers: TimerApi;
  #streamId: string;
  #flushTimer: unknown;
  #rotationTimer: unknown;
  #operation: Promise<void> = Promise.resolve();
  #finishPromise?: Promise<boolean>;
  #finished = false;
  #rotationAttempts = 0;
  #rotationDisabled = false;
  #replaceableTail?: TrackedProgressTail;

  constructor(options: StreamControllerOptions) {
    this.#conversationKey = options.conversationKey;
    this.#frame = options.frame;
    this.#sink = options.sink;
    this.#buffer = new ProgressBuffer();
    this.#streamIdFactory = options.streamIdFactory ??
      (() => `stream-${crypto.randomUUID()}`);
    this.#timers = options.timers ?? systemTimers;
    this.#streamId = this.#streamIdFactory();
  }

  appendBlock(
    content: string,
    progressTail?: ProgressTail,
  ): this {
    if (this.#finished) throw new Error("stream is already finished");

    const nextTail = progressTail;
    const previous = this.#replaceableTail;
    if (nextTail && previous) {
      if (nextTail.key === previous.key) {
        const replacement = this.#buffer.replaceTailBlock(
          previous.content,
          content,
        );
        if (replacement !== null) {
          this.#replaceableTail = { ...nextTail, content: replacement };
          this.#afterWrite();
          return this;
        }
      } else {
        this.#buffer.replaceTailBlock(
          previous.content,
          previous.completedText,
        );
      }
    }

    const separator = progressBlockSeparator(this.#buffer.snapshot(), content);
    const block = separator + content;
    this.#buffer.append(block);
    this.#replaceableTail = nextTail
      ? { ...nextTail, content: block }
      : undefined;
    this.#afterWrite();
    return this;
  }

  #afterWrite(): void {
    this.#armFlush();
    this.#armRotation();
  }

  flush(): Promise<boolean> {
    this.#clearFlushTimer();
    return this.#enqueue(async () => {
      if (this.#finished) return false;
      const content = this.#buffer.snapshot();
      if (content.length === 0) return true;
      return await this.#sink.send(
        this.#conversationKey,
        this.#frame,
        this.#streamId,
        content,
        false,
      );
    });
  }

  finish(): Promise<boolean> {
    if (this.#finishPromise) return this.#finishPromise;
    this.#finished = true;
    this.#clearFlushTimer();
    this.#clearRotationTimer();
    this.#finishPromise = this.#enqueue(async () => {
      const content = this.#buffer.snapshot();
      if (content.length === 0) return true;
      for (
        let attempt = 1;
        attempt <= DEFAULT_MAX_FINISH_ATTEMPTS;
        attempt++
      ) {
        const sent = await this.#sink.send(
          this.#conversationKey,
          this.#frame,
          this.#streamId,
          content,
          true,
        );
        if (sent) return true;
        if (attempt < DEFAULT_MAX_FINISH_ATTEMPTS) await this.#retryDelay();
      }
      return false;
    });
    return this.#finishPromise;
  }

  #retryDelay(): Promise<void> {
    return new Promise((resolve) => {
      this.#timers.setTimeout(resolve, DEFAULT_RETRY_DELAY_MS);
    });
  }

  #armFlush(): void {
    if (this.#flushTimer !== undefined) return;
    this.#flushTimer = this.#timers.setTimeout(async () => {
      this.#flushTimer = undefined;
      await this.flush();
    }, DEFAULT_FLUSH_INTERVAL_MS);
  }

  #armRotation(delayMs = DEFAULT_ROTATE_AFTER_MS): void {
    if (
      this.#finished || this.#rotationDisabled ||
      this.#rotationTimer !== undefined
    ) return;
    this.#rotationTimer = this.#timers.setTimeout(async () => {
      this.#rotationTimer = undefined;
      await this.#enqueue(async () => {
        await this.#rotate();
      });
    }, delayMs);
  }

  async #rotate(): Promise<void> {
    if (this.#finished) return;
    this.#clearFlushTimer();
    const previousBuffer = this.#buffer;
    const previousTail = this.#replaceableTail;
    if (previousTail) {
      previousBuffer.replaceTailBlock(
        previousTail.content,
        previousTail.completedText,
      );
    }
    const nextBuffer = new ProgressBuffer();
    this.#buffer = nextBuffer;
    this.#replaceableTail = undefined;
    const content = previousBuffer.snapshot();
    if (content.length > 0) {
      const finished = await this.#sink.send(
        this.#conversationKey,
        this.#frame,
        this.#streamId,
        content,
        true,
      );
      if (!finished) {
        const restoredBuffer = new ProgressBuffer();
        appendProgressSnapshot(restoredBuffer, previousBuffer.snapshot());
        appendProgressSnapshot(restoredBuffer, nextBuffer.snapshot());
        this.#buffer = restoredBuffer;
        this.#rotationAttempts++;
        if (this.#rotationAttempts < DEFAULT_MAX_ROTATION_ATTEMPTS) {
          this.#armRotation(DEFAULT_RETRY_DELAY_MS);
        } else {
          this.#rotationDisabled = true;
        }
        return;
      }
    }
    this.#rotationAttempts = 0;
    if (this.#finished) {
      if (nextBuffer.snapshot().length > 0) {
        const continuationBuffer = new ProgressBuffer();
        appendProgressSnapshot(continuationBuffer, CONTINUATION_MARKER);
        appendProgressSnapshot(continuationBuffer, nextBuffer.snapshot());
        this.#buffer = continuationBuffer;
        this.#streamId = this.#streamIdFactory();
      }
      return;
    }

    const continuationBuffer = new ProgressBuffer();
    appendProgressSnapshot(continuationBuffer, CONTINUATION_MARKER);
    appendProgressSnapshot(continuationBuffer, nextBuffer.snapshot());
    this.#buffer = continuationBuffer;
    this.#streamId = this.#streamIdFactory();
    const started = await this.#sink.send(
      this.#conversationKey,
      this.#frame,
      this.#streamId,
      this.#buffer.snapshot(),
      false,
      true,
    );
    if (!started) this.#armFlush();
    this.#armRotation();
  }

  #clearFlushTimer(): void {
    if (this.#flushTimer === undefined) return;
    this.#timers.clearTimeout(this.#flushTimer);
    this.#flushTimer = undefined;
  }

  #clearRotationTimer(): void {
    if (this.#rotationTimer === undefined) return;
    this.#timers.clearTimeout(this.#rotationTimer);
    this.#rotationTimer = undefined;
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#operation.then(operation, operation);
    this.#operation = result.then(() => undefined, () => undefined);
    return result;
  }
}
