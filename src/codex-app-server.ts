import { readJsonLines } from "./jsonl.ts";

type JsonObject = Record<string, unknown>;
type RequestId = string | number;
type EventCallback<T> = (event: T) => unknown;

export interface AppServerProcessStatus {
  success: boolean;
  code: number;
  signal: string | null;
}

export interface AppServerProcess {
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly status: Promise<AppServerProcessStatus>;
  kill(signal?: Deno.Signal): void;
}

export type SpawnAppServer = (
  command: string,
  options: Deno.CommandOptions,
) => AppServerProcess;

export interface ThreadStartedEvent {
  threadId: string;
  parentThreadId?: string;
  agentNickname?: string;
  agentRole?: string;
  name?: string;
}

export interface TurnStartedEvent {
  threadId: string;
  turnId: string;
}

export interface TurnCompletedEvent extends TurnStartedEvent {
  status: string;
  error: unknown;
  finalMessage?: string;
}

export interface RequestUserInputEvent extends TurnStartedEvent {
  itemId?: string;
  questions: unknown[];
}

export interface AppServerNotification {
  method: string;
  params: JsonObject;
}

export interface CodexAppServerCallbacks {
  onNotification?: EventCallback<AppServerNotification>;
  onThreadStarted?: EventCallback<ThreadStartedEvent>;
  onTurnCompleted?: EventCallback<TurnCompletedEvent>;
  onRequestUserInput?: EventCallback<RequestUserInputEvent>;
  onDiagnostic?: EventCallback<string>;
  onExit?: EventCallback<AppServerProcessStatus>;
}

export interface CodexAppServerOptions {
  cwd: string;
  callbacks?: CodexAppServerCallbacks;
  spawn?: SpawnAppServer;
  rpcTimeoutMs?: number;
  closeTimeoutMs?: number;
  terminationGraceMs?: number;
}

export interface CompletedAgentMessage {
  text: string;
  phase?: string | null;
}

export type AppServerMessageKind =
  | "serverRequest"
  | "notification"
  | "response"
  | "unknown";

export function classifyAppServerMessage(
  message: unknown,
): AppServerMessageKind {
  if (!isObject(message)) return "unknown";
  if (typeof message.method === "string") {
    return hasOwn(message, "id") ? "serverRequest" : "notification";
  }
  return hasOwn(message, "id") ? "response" : "unknown";
}

export function selectFinalAgentMessage(
  messages: readonly CompletedAgentMessage[],
): string | undefined {
  let lastMessage: CompletedAgentMessage | undefined;
  let lastFinalMessage: CompletedAgentMessage | undefined;

  for (const message of messages) {
    lastMessage = message;
    if (message.phase === "final_answer") lastFinalMessage = message;
  }
  return (lastFinalMessage ?? lastMessage)?.text;
}

/** Represents an error response returned by the Codex JSON-RPC server. */
export class CodexRpcError extends Error {
  constructor(
    readonly code: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = "CodexRpcError";
  }
}

/** Signals that a Codex JSON-RPC request exceeded its configured deadline. */
export class CodexRpcTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly timeoutMs: number,
  ) {
    super(`Codex RPC ${method} timed out after ${timeoutMs}ms`);
    this.name = "CodexRpcTimeoutError";
  }
}

/** Signals that the Codex App Server process exited. */
export class CodexAppServerExitedError extends Error {
  constructor(readonly status: AppServerProcessStatus) {
    super(
      `Codex App Server exited (code=${status.code}, signal=${
        status.signal ?? "none"
      })`,
    );
    this.name = "CodexAppServerExitedError";
  }
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

const DEFAULT_RPC_TIMEOUT_MS = 30_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;
const DEFAULT_TERMINATION_GRACE_MS = 2_000;

const defaultSpawn: SpawnAppServer = (command, options) =>
  new Deno.Command(command, options).spawn();

/** Manages the stdio JSON-RPC session with a Codex App Server process. */
export class CodexAppServerClient {
  readonly #cwd: string;
  readonly #callbacks: CodexAppServerCallbacks;
  readonly #process: AppServerProcess;
  readonly #stdin: WritableStreamDefaultWriter<Uint8Array>;
  readonly #rpcTimeoutMs: number;
  readonly #closeTimeoutMs: number;
  readonly #terminationGraceMs: number;
  readonly #pending = new Map<RequestId, PendingRequest>();
  readonly #completedMessages = new Map<string, CompletedAgentMessage[]>();
  readonly #exitPromise: Promise<AppServerProcessStatus>;
  #nextRequestId = 0;
  #exited = false;
  #stdinClosed = false;
  #terminating = false;
  #forceKillTimer?: ReturnType<typeof setTimeout>;

  private constructor(
    cwd: string,
    callbacks: CodexAppServerCallbacks,
    process: AppServerProcess,
    rpcTimeoutMs: number,
    closeTimeoutMs: number,
    terminationGraceMs: number,
  ) {
    this.#cwd = cwd;
    this.#callbacks = callbacks;
    this.#process = process;
    this.#stdin = process.stdin.getWriter();
    this.#rpcTimeoutMs = rpcTimeoutMs;
    this.#closeTimeoutMs = closeTimeoutMs;
    this.#terminationGraceMs = terminationGraceMs;

    void this.#readStdout();
    void this.#readStderr();
    this.#exitPromise = this.#watchExit();
  }

  static async start(
    options: CodexAppServerOptions,
  ): Promise<CodexAppServerClient> {
    const environment = Deno.env.toObject();
    delete environment.BOT_ID;
    delete environment.BOT_SECRET;

    const process = (options.spawn ?? defaultSpawn)("codex", {
      args: ["app-server", "--stdio"],
      cwd: options.cwd,
      clearEnv: true,
      env: environment,
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    });
    const client = new CodexAppServerClient(
      options.cwd,
      options.callbacks ?? {},
      process,
      positiveTimeout(options.rpcTimeoutMs, DEFAULT_RPC_TIMEOUT_MS),
      positiveTimeout(options.closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS),
      positiveTimeout(
        options.terminationGraceMs,
        DEFAULT_TERMINATION_GRACE_MS,
      ),
    );

    try {
      await client.#request("initialize", {
        clientInfo: {
          name: "wecom_codex_bot",
          title: "WeCom Codex Bot",
          version: "0.1.0",
        },
        capabilities: {
          experimentalApi: true,
          requestAttestation: false,
        },
      });
      await client.#writeMessage({ method: "initialized" });
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  async startThread(): Promise<string> {
    const result = await this.#request("thread/start", { cwd: this.#cwd });
    return requiredNestedString(result, "thread", "id");
  }

  async resumeThread(threadId: string): Promise<string> {
    const result = await this.#request("thread/resume", {
      threadId,
      cwd: this.#cwd,
    });
    return requiredNestedString(result, "thread", "id");
  }

  async startTurn(threadId: string, text: string): Promise<string> {
    const result = await this.#request("turn/start", {
      threadId,
      input: [{ type: "text", text, text_elements: [] }],
      cwd: this.#cwd,
    });
    return requiredNestedString(result, "turn", "id");
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    await this.#request("turn/interrupt", { threadId, turnId });
  }

  async close(): Promise<AppServerProcessStatus> {
    if (!this.#stdinClosed) {
      this.#stdinClosed = true;
      try {
        await withTimeout(
          this.#stdin.close(),
          this.#closeTimeoutMs,
          "closing App Server stdin",
        );
      } catch (error) {
        if (!this.#exited) {
          this.#diagnostic(`${errorMessage(error)}\n`);
          this.#terminate();
        }
      }
    }

    try {
      return await withTimeout(
        this.#exitPromise,
        this.#closeTimeoutMs,
        "waiting for App Server exit",
      );
    } catch (error) {
      this.#diagnostic(`${errorMessage(error)}\n`);
      this.#terminate();
      return await withTimeout(
        this.#exitPromise,
        this.#terminationGraceMs + this.#closeTimeoutMs,
        "waiting for terminated App Server exit",
      );
    }
  }

  async #request(method: string, params: JsonObject): Promise<unknown> {
    if (this.#exited) {
      throw new Error("Codex App Server is not running");
    }

    const id = ++this.#nextRequestId;
    const response = new Promise<unknown>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const pending = this.#takePending(id);
        if (!pending) return;
        pending.reject(new CodexRpcTimeoutError(method, this.#rpcTimeoutMs));
        this.#terminate();
      }, this.#rpcTimeoutMs);
      this.#pending.set(id, { resolve, reject, timeoutId });
    });

    void this.#writeMessage({ method, id, params }).catch((error) => {
      const pending = this.#takePending(id);
      pending?.reject(error);
    });
    return await response;
  }

  async #writeMessage(message: JsonObject): Promise<void> {
    if (this.#exited) throw new Error("Codex App Server is not running");
    const line = new TextEncoder().encode(`${JSON.stringify(message)}\n`);
    await this.#stdin.write(line);
  }

  async #readStdout(): Promise<void> {
    try {
      for await (const line of readJsonLines(this.#process.stdout)) {
        if (line.trim().length === 0) continue;
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch (error) {
          this.#diagnostic(
            `Invalid App Server JSONL: ${errorMessage(error)}\n`,
          );
          continue;
        }
        this.#handleMessage(message);
      }
    } catch (error) {
      this.#diagnostic(`App Server stdout failed: ${errorMessage(error)}\n`);
    }
  }

  async #readStderr(): Promise<void> {
    const decoder = new TextDecoder();
    const reader = this.#process.stderr.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        if (text) this.#diagnostic(text);
      }
      const tail = decoder.decode();
      if (tail) this.#diagnostic(tail);
    } catch (error) {
      this.#diagnostic(`App Server stderr failed: ${errorMessage(error)}\n`);
    } finally {
      reader.releaseLock();
    }
  }

  #handleMessage(message: unknown): void {
    switch (classifyAppServerMessage(message)) {
      case "serverRequest":
        void this.#handleServerRequest(message as JsonObject);
        break;
      case "notification":
        this.#handleNotification(message as JsonObject);
        break;
      case "response":
        this.#handleResponse(message as JsonObject);
        break;
      case "unknown":
        break;
    }
  }

  #handleResponse(message: JsonObject): void {
    const id = message.id;
    if (!isRequestId(id)) return;
    const pending = this.#takePending(id);
    if (!pending) return;

    if (hasOwn(message, "error") && message.error != null) {
      const error = isObject(message.error) ? message.error : {};
      pending.reject(
        new CodexRpcError(
          typeof error.code === "number" ? error.code : undefined,
          typeof error.message === "string"
            ? error.message
            : "Codex RPC failed",
        ),
      );
      return;
    }
    pending.resolve(message.result);
  }

  async #handleServerRequest(message: JsonObject): Promise<void> {
    const id = message.id;
    const method = message.method;
    if (!isRequestId(id) || typeof method !== "string") return;

    try {
      switch (method) {
        case "item/commandExecution/requestApproval":
        case "item/fileChange/requestApproval":
          this.#recordDecline(method, "interactive approvals are disabled");
          await this.#writeMessage({ id, result: { decision: "decline" } });
          return;
        case "execCommandApproval":
        case "applyPatchApproval":
          this.#recordDecline(method, "interactive approvals are disabled");
          await this.#writeMessage({ id, result: { decision: "denied" } });
          return;
        case "item/permissions/requestApproval":
          this.#recordDecline(method, "permission grants are disabled");
          await this.#writeMessage({
            id,
            result: { permissions: {}, scope: "turn" },
          });
          return;
        case "mcpServer/elicitation/request":
          this.#recordDecline(method, "MCP elicitation is disabled");
          await this.#writeMessage({
            id,
            result: { action: "decline", content: null, _meta: null },
          });
          return;
        case "item/tool/requestUserInput":
          await this.#handleRequestUserInput(id, message.params);
          return;
        default:
          await this.#writeMessage({
            id,
            error: {
              code: -32601,
              message: `Unsupported server request: ${method}`,
            },
          });
      }
    } catch (error) {
      this.#diagnostic(`Failed to answer ${method}: ${errorMessage(error)}\n`);
    }
  }

  async #handleRequestUserInput(
    id: RequestId,
    rawParams: unknown,
  ): Promise<void> {
    const params = isObject(rawParams) ? rawParams : {};
    const threadId = optionalString(params.threadId);
    const turnId = optionalString(params.turnId);
    const itemId = optionalString(params.itemId);
    const questions = Array.isArray(params.questions) ? params.questions : [];

    if (threadId && turnId) {
      this.#emit(this.#callbacks.onRequestUserInput, {
        threadId,
        turnId,
        ...(itemId ? { itemId } : {}),
        questions,
      });
    }
    await this.#writeMessage({ id, result: { answers: {} } });

    if (threadId && turnId) {
      void this.interrupt(threadId, turnId).catch((error) => {
        this.#diagnostic(
          `Failed to interrupt turn after requestUserInput: ${
            errorMessage(error)
          }\n`,
        );
      });
    }
  }

  #handleNotification(message: JsonObject): void {
    const method = message.method;
    const params = isObject(message.params) ? message.params : {};
    if (typeof method !== "string") return;

    this.#emit(this.#callbacks.onNotification, { method, params });

    switch (method) {
      case "thread/started": {
        const thread = isObject(params.thread) ? params.thread : {};
        const threadId = optionalString(thread.id);
        const parentThreadId = optionalString(thread.parentThreadId);
        const agentNickname = optionalString(thread.agentNickname);
        const agentRole = optionalString(thread.agentRole);
        const name = optionalString(thread.name);
        if (threadId) {
          this.#emit(this.#callbacks.onThreadStarted, {
            threadId,
            ...(parentThreadId ? { parentThreadId } : {}),
            ...(agentNickname ? { agentNickname } : {}),
            ...(agentRole ? { agentRole } : {}),
            ...(name ? { name } : {}),
          });
        }
        return;
      }
      case "item/completed":
        this.#handleItemCompleted(params);
        return;
      case "turn/completed":
        this.#handleTurnCompleted(params);
        return;
      default:
        return;
    }
  }

  #handleItemCompleted(params: JsonObject): void {
    const threadId = optionalString(params.threadId);
    const turnId = optionalString(params.turnId);
    const item = isObject(params.item) ? params.item : undefined;
    if (!threadId || !turnId || !item) return;

    if (item.type === "agentMessage" && typeof item.text === "string") {
      const key = turnKey(threadId, turnId);
      const messages = this.#completedMessages.get(key) ?? [];
      messages.push({
        text: item.text,
        phase: typeof item.phase === "string" || item.phase === null
          ? item.phase
          : undefined,
      });
      this.#completedMessages.set(key, messages);
    }
  }

  #handleTurnCompleted(params: JsonObject): void {
    const threadId = optionalString(params.threadId);
    const turn = isObject(params.turn) ? params.turn : {};
    const turnId = optionalString(turn.id);
    if (!threadId || !turnId) return;

    const key = turnKey(threadId, turnId);
    const messages = this.#completedMessages.get(key) ?? [];
    this.#completedMessages.delete(key);
    this.#emit(this.#callbacks.onTurnCompleted, {
      threadId,
      turnId,
      status: typeof turn.status === "string" ? turn.status : "unknown",
      error: hasOwn(turn, "error") ? turn.error : null,
      finalMessage: selectFinalAgentMessage(messages),
    });
  }

  async #watchExit(): Promise<AppServerProcessStatus> {
    const status = await this.#process.status;
    this.#exited = true;
    if (this.#forceKillTimer !== undefined) {
      clearTimeout(this.#forceKillTimer);
      this.#forceKillTimer = undefined;
    }
    const error = new CodexAppServerExitedError(status);
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#emit(this.#callbacks.onExit, status);
    return status;
  }

  #takePending(id: RequestId): PendingRequest | undefined {
    const pending = this.#pending.get(id);
    if (!pending) return undefined;
    this.#pending.delete(id);
    clearTimeout(pending.timeoutId);
    return pending;
  }

  #terminate(): void {
    if (this.#exited || this.#terminating) return;
    this.#terminating = true;
    try {
      this.#process.kill("SIGTERM");
    } catch (error) {
      this.#diagnostic(
        `Failed to terminate Codex App Server: ${errorMessage(error)}\n`,
      );
    }
    this.#forceKillTimer = setTimeout(() => {
      this.#forceKillTimer = undefined;
      if (this.#exited) return;
      try {
        this.#process.kill("SIGKILL");
      } catch (error) {
        this.#diagnostic(
          `Failed to kill Codex App Server: ${errorMessage(error)}\n`,
        );
      }
    }, this.#terminationGraceMs);
  }

  #emit<T>(
    callback: EventCallback<T> | undefined,
    event: T,
  ): void {
    if (!callback) return;
    try {
      const result = callback(event);
      if (result instanceof Promise) {
        void result.catch((error) => {
          this.#diagnostic(
            `App Server callback failed: ${errorMessage(error)}\n`,
          );
        });
      }
    } catch (error) {
      this.#diagnostic(`App Server callback failed: ${errorMessage(error)}\n`);
    }
  }

  #diagnostic(message: string): void {
    const callback = this.#callbacks.onDiagnostic;
    if (!callback) return;
    try {
      const result = callback(message);
      if (result instanceof Promise) void result.catch(() => {});
    } catch {
      // Diagnostic handlers must never affect protocol processing.
    }
  }

  #recordDecline(method: string, reason: string): void {
    this.#diagnostic(`Declined ${method}: ${reason}\n`);
  }
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(object: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isRequestId(value: unknown): value is RequestId {
  return typeof value === "string" || typeof value === "number";
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requiredNestedString(
  value: unknown,
  objectKey: string,
  valueKey: string,
): string {
  const outer = isObject(value) ? value : {};
  const inner = isObject(outer[objectKey]) ? outer[objectKey] : {};
  const result = optionalString(inner[valueKey]);
  if (!result) {
    throw new Error(`Codex RPC response is missing ${objectKey}.${valueKey}`);
  }
  return result;
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}\u0000${turnId}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Timed out after ${timeoutMs}ms while ${operation}`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
