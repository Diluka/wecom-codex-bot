import { readJsonLines } from "./jsonl.ts";
import type { CodexTurnInput, CodexTurnOptions } from "./codex-turn.ts";
import type {
  CodexModel,
  CodexThreadSession,
  ConfigDefaults,
  SettingsPatch,
} from "./model-settings.ts";
import {
  buildTurnAuthorityContext,
  type RequestAuthority,
} from "./owner-policy.ts";

type JsonObject = Record<string, unknown>;
type RequestId = string | number;
type EventCallback<T> = (event: T) => unknown;

export type CodexAppServerLogLevel = "debug" | "info" | "warn" | "error";

export interface CodexAppServerLifecycleEvent {
  level: CodexAppServerLogLevel;
  event:
    | "process_started"
    | "client_ready"
    | "client_closing"
    | "process_exited"
    | "process_signal_sent"
    | "process_signal_failed"
    | "rpc_started"
    | "rpc_completed"
    | "rpc_failed"
    | "thread_started"
    | "turn_started"
    | "turn_completed"
    | "item_started"
    | "item_completed"
    | "item_delta"
    | "notification_received"
    | "server_warning"
    | "server_error"
    | "server_request_received"
    | "server_request_declined"
    | "server_request_answered"
    | "server_request_unsupported"
    | "server_request_failed"
    | "protocol_invalid_json"
    | "protocol_unknown_message"
    | "stream_failed";
  method?: string;
  requestId?: RequestId;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  itemType?: string;
  status?: string;
  elapsedMs?: number;
  deltaLength?: number;
  deltaChunks?: number;
  summaryParts?: number;
  contentParts?: number;
  questionCount?: number;
  errorCode?: number;
  failure?:
    | "timeout"
    | "write_failed"
    | "rpc_error"
    | "process_exit"
    | "handler_failed";
  policy?:
    | "interactive_approval_disabled"
    | "permission_grant_disabled"
    | "mcp_elicitation_disabled";
  exitCode?: number;
  signal?: string | null;
  success?: boolean;
  expected?: boolean;
  pendingRequests?: number;
}

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

export interface AdditionalContextEntry {
  value: string;
  kind: "untrusted" | "application";
}

export interface CodexAppServerCallbacks {
  onLifecycle?: EventCallback<CodexAppServerLifecycleEvent>;
  onNotification?: EventCallback<AppServerNotification>;
  onThreadStarted?: EventCallback<ThreadStartedEvent>;
  onTurnCompleted?: EventCallback<TurnCompletedEvent>;
  onRequestUserInput?: EventCallback<RequestUserInputEvent>;
  onStderr?: EventCallback<string>;
  onDiagnostic?: EventCallback<string>;
  onExit?: EventCallback<AppServerProcessStatus>;
}

export interface CodexAppServerOptions {
  cwd: string;
  developerInstructions?: string;
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
  method: string;
  startedAt: number;
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

interface DeltaAggregate {
  method: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  itemType?: string;
  chunks: number;
  length: number;
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
  readonly #deltaAggregates = new Map<string, DeltaAggregate>();
  readonly #stdoutDone: Promise<void>;
  readonly #stderrDone: Promise<void>;
  readonly #exitPromise: Promise<AppServerProcessStatus>;
  #nextRequestId = 0;
  #exited = false;
  #stdinClosed = false;
  #closing = false;
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

    this.#stdoutDone = this.#readStdout();
    this.#stderrDone = this.#readStderr();
    this.#exitPromise = this.#watchExit();
  }

  static async start(
    options: CodexAppServerOptions,
  ): Promise<CodexAppServerClient> {
    const startedAt = performance.now();
    const environment = Deno.env.toObject();
    delete environment.WECOM_OWNER_USER_ID;
    delete environment.BOT_ID;
    delete environment.BOT_SECRET;

    const process = (options.spawn ?? defaultSpawn)("codex", {
      args: options.developerInstructions === undefined
        ? ["app-server", "--stdio"]
        : [
          "-c",
          `developer_instructions=${
            JSON.stringify(options.developerInstructions)
          }`,
          "app-server",
          "--stdio",
        ],
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
    client.#lifecycle({ level: "info", event: "process_started" });

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
      client.#lifecycle({
        level: "info",
        event: "client_ready",
        elapsedMs: elapsedMs(startedAt),
      });
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  async startThread(): Promise<CodexThreadSession> {
    return threadSession(
      await this.#request("thread/start", { cwd: this.#cwd }),
    );
  }

  async resumeThread(threadId: string): Promise<CodexThreadSession> {
    return threadSession(
      await this.#request("thread/resume", {
        threadId,
        cwd: this.#cwd,
      }),
    );
  }

  async listModels(): Promise<CodexModel[]> {
    const models: CodexModel[] = [];
    let cursor: string | null = null;
    do {
      const page = modelPage(
        await this.#request("model/list", {
          cursor,
          limit: 100,
          includeHidden: true,
        }),
      );
      models.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor !== null);
    return models;
  }

  async readConfigDefaults(): Promise<ConfigDefaults> {
    const result = await this.#request("config/read", {
      cwd: this.#cwd,
      includeLayers: false,
    });
    const config = isObject(result) && isObject(result.config)
      ? result.config
      : {};
    return {
      model: nullableString(config.model, "config.model"),
      effort: nullableString(
        config.model_reasoning_effort,
        "config.model_reasoning_effort",
      ),
    };
  }

  async updateThreadSettings(
    threadId: string,
    patch: SettingsPatch,
  ): Promise<void> {
    await this.#request("thread/settings/update", { threadId, ...patch });
  }

  async writeConfigDefaults(patch: SettingsPatch): Promise<void> {
    const edits = Object.entries({
      model: patch.model,
      model_reasoning_effort: patch.effort,
    }).filter((entry): entry is [string, string | null] =>
      entry[1] !== undefined
    ).map(([keyPath, value]) => ({ keyPath, value, mergeStrategy: "upsert" }));
    if (edits.length === 0) return;
    await this.#request("config/batchWrite", {
      edits,
      reloadUserConfig: false,
    });
  }

  async startTurn(
    threadId: string,
    input: CodexTurnInput,
    authority: RequestAuthority,
    options: CodexTurnOptions = {},
  ): Promise<string> {
    const additionalContext: Record<string, AdditionalContextEntry> = {
      wecom_owner_policy: {
        kind: "application",
        value: buildTurnAuthorityContext(authority),
      },
    };
    const result = await this.#request("turn/start", {
      threadId,
      input: [
        { type: "text", text: input.text, text_elements: [] },
        ...input.localImagePaths.map((path) => ({
          type: "localImage",
          path,
        })),
      ],
      cwd: this.#cwd,
      additionalContext,
      ...(options.summary ? { summary: options.summary } : {}),
    });
    return requiredNestedString(result, "turn", "id");
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    await this.#request("turn/interrupt", { threadId, turnId });
  }

  async close(): Promise<AppServerProcessStatus> {
    if (!this.#closing) {
      this.#closing = true;
      this.#lifecycle({ level: "info", event: "client_closing" });
    }
    if (!this.#stdinClosed) {
      this.#stdinClosed = true;
      try {
        await withTimeout(
          this.#stdin.close(),
          this.#closeTimeoutMs,
          "closing App Server stdin",
        );
      } catch (error) {
        this.#lifecycle({
          level: "warn",
          event: "stream_failed",
          method: "stdin",
          failure: "handler_failed",
        });
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
      this.#lifecycle({
        level: "warn",
        event: "stream_failed",
        method: "process_status",
        failure: "handler_failed",
      });
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
    const startedAt = performance.now();
    this.#lifecycle({
      level: "debug",
      event: "rpc_started",
      method,
      requestId: id,
    });
    const response = new Promise<unknown>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        const pending = this.#takePending(id);
        if (!pending) return;
        this.#lifecycle({
          level: "warn",
          event: "rpc_failed",
          method: pending.method,
          requestId: id,
          elapsedMs: elapsedMs(pending.startedAt),
          failure: "timeout",
        });
        pending.reject(new CodexRpcTimeoutError(method, this.#rpcTimeoutMs));
        this.#terminate();
      }, this.#rpcTimeoutMs);
      this.#pending.set(id, {
        method,
        startedAt,
        resolve,
        reject,
        timeoutId,
      });
    });

    void this.#writeMessage({ method, id, params }).catch((error) => {
      const pending = this.#takePending(id);
      if (pending) {
        this.#lifecycle({
          level: "warn",
          event: "rpc_failed",
          method: pending.method,
          requestId: id,
          elapsedMs: elapsedMs(pending.startedAt),
          failure: "write_failed",
        });
      }
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
          this.#lifecycle({
            level: "warn",
            event: "protocol_invalid_json",
          });
          this.#diagnostic(
            `Invalid App Server JSONL: ${errorMessage(error)}\n`,
          );
          continue;
        }
        this.#handleMessage(message);
      }
    } catch (error) {
      this.#lifecycle({
        level: "warn",
        event: "stream_failed",
        method: "stdout",
        failure: "handler_failed",
      });
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
        if (text) this.#stderr(text);
      }
      const tail = decoder.decode();
      if (tail) this.#stderr(tail);
    } catch (error) {
      this.#lifecycle({
        level: "warn",
        event: "stream_failed",
        method: "stderr",
        failure: "handler_failed",
      });
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
        this.#lifecycle({ level: "warn", event: "protocol_unknown_message" });
        break;
    }
  }

  #handleResponse(message: JsonObject): void {
    const id = message.id;
    if (!isRequestId(id)) {
      this.#lifecycle({ level: "warn", event: "protocol_unknown_message" });
      return;
    }
    const pending = this.#takePending(id);
    if (!pending) {
      this.#lifecycle({
        level: "debug",
        event: "notification_received",
        method: "unmatched_response",
        requestId: id,
      });
      return;
    }

    if (hasOwn(message, "error") && message.error != null) {
      const error = isObject(message.error) ? message.error : {};
      this.#lifecycle({
        level: "warn",
        event: "rpc_failed",
        method: pending.method,
        requestId: id,
        elapsedMs: elapsedMs(pending.startedAt),
        failure: "rpc_error",
        errorCode: typeof error.code === "number" ? error.code : undefined,
      });
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
    this.#lifecycle({
      level: "debug",
      event: "rpc_completed",
      method: pending.method,
      requestId: id,
      elapsedMs: elapsedMs(pending.startedAt),
    });
    pending.resolve(message.result);
  }

  async #handleServerRequest(message: JsonObject): Promise<void> {
    const id = message.id;
    const method = message.method;
    if (!isRequestId(id) || typeof method !== "string") return;
    const context = lifecycleContext(message.params);
    this.#lifecycle({
      level: "debug",
      event: "server_request_received",
      method,
      requestId: id,
      ...context,
    });

    try {
      switch (method) {
        case "item/commandExecution/requestApproval":
        case "item/fileChange/requestApproval":
          this.#recordDecline(
            method,
            id,
            "interactive_approval_disabled",
            context,
          );
          await this.#writeMessage({ id, result: { decision: "decline" } });
          this.#recordServerRequestAnswer(method, id, context);
          return;
        case "execCommandApproval":
        case "applyPatchApproval":
          this.#recordDecline(
            method,
            id,
            "interactive_approval_disabled",
            context,
          );
          await this.#writeMessage({ id, result: { decision: "denied" } });
          this.#recordServerRequestAnswer(method, id, context);
          return;
        case "item/permissions/requestApproval":
          this.#recordDecline(
            method,
            id,
            "permission_grant_disabled",
            context,
          );
          await this.#writeMessage({
            id,
            result: { permissions: {}, scope: "turn" },
          });
          this.#recordServerRequestAnswer(method, id, context);
          return;
        case "mcpServer/elicitation/request":
          this.#recordDecline(
            method,
            id,
            "mcp_elicitation_disabled",
            context,
          );
          await this.#writeMessage({
            id,
            result: { action: "decline", content: null, _meta: null },
          });
          this.#recordServerRequestAnswer(method, id, context);
          return;
        case "item/tool/requestUserInput":
          await this.#handleRequestUserInput(id, message.params);
          return;
        default:
          this.#lifecycle({
            level: "warn",
            event: "server_request_unsupported",
            method,
            requestId: id,
            ...context,
          });
          await this.#writeMessage({
            id,
            error: {
              code: -32601,
              message: `Unsupported server request: ${method}`,
            },
          });
      }
    } catch (error) {
      this.#lifecycle({
        level: "error",
        event: "server_request_failed",
        method,
        requestId: id,
        failure: "handler_failed",
        ...context,
      });
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
    this.#lifecycle({
      level: "info",
      event: "server_request_answered",
      method: "item/tool/requestUserInput",
      requestId: id,
      ...(threadId ? { threadId } : {}),
      ...(turnId ? { turnId } : {}),
      ...(itemId ? { itemId } : {}),
      questionCount: questions.length,
    });

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

    const lifecycle = notificationLifecycleEvent(method, params);
    if (lifecycle.event === "item_delta") {
      this.#recordDelta(lifecycle);
    } else {
      if (lifecycle.event === "item_completed") {
        this.#flushDeltaAggregates(lifecycle);
      } else if (lifecycle.event === "turn_completed") {
        this.#flushDeltaAggregates({
          threadId: lifecycle.threadId,
          turnId: lifecycle.turnId,
        });
      }
      this.#lifecycle(lifecycle);
    }
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
    await Promise.all([this.#stdoutDone, this.#stderrDone]);
    if (this.#forceKillTimer !== undefined) {
      clearTimeout(this.#forceKillTimer);
      this.#forceKillTimer = undefined;
    }
    const pendingRequests = this.#pending.size;
    const expected = this.#closing;
    const error = new CodexAppServerExitedError(status);
    for (const [requestId, pending] of this.#pending) {
      clearTimeout(pending.timeoutId);
      this.#lifecycle({
        level: "warn",
        event: "rpc_failed",
        method: pending.method,
        requestId,
        elapsedMs: elapsedMs(pending.startedAt),
        failure: "process_exit",
      });
      pending.reject(error);
    }
    this.#pending.clear();
    this.#flushDeltaAggregates();
    this.#lifecycle({
      level: expected && status.success ? "info" : "warn",
      event: "process_exited",
      exitCode: status.code,
      signal: status.signal,
      success: status.success,
      expected,
      pendingRequests,
    });
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
      this.#lifecycle({
        level: "warn",
        event: "process_signal_sent",
        signal: "SIGTERM",
      });
    } catch (error) {
      this.#lifecycle({
        level: "error",
        event: "process_signal_failed",
        signal: "SIGTERM",
        failure: "handler_failed",
      });
      this.#diagnostic(
        `Failed to terminate Codex App Server: ${errorMessage(error)}\n`,
      );
    }
    this.#forceKillTimer = setTimeout(() => {
      this.#forceKillTimer = undefined;
      if (this.#exited) return;
      try {
        this.#process.kill("SIGKILL");
        this.#lifecycle({
          level: "warn",
          event: "process_signal_sent",
          signal: "SIGKILL",
        });
      } catch (error) {
        this.#lifecycle({
          level: "error",
          event: "process_signal_failed",
          signal: "SIGKILL",
          failure: "handler_failed",
        });
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

  #stderr(message: string): void {
    const callback = this.#callbacks.onStderr;
    if (!callback) return;
    try {
      const result = callback(message);
      if (result instanceof Promise) void result.catch(() => {});
    } catch {
      // Stderr observers must never affect protocol processing.
    }
  }

  #recordDelta(event: CodexAppServerLifecycleEvent): void {
    const method = event.method;
    if (!method) return;
    const key = JSON.stringify([
      method,
      event.threadId,
      event.turnId,
      event.itemId,
    ]);
    const aggregate = this.#deltaAggregates.get(key) ?? {
      method,
      threadId: event.threadId,
      turnId: event.turnId,
      itemId: event.itemId,
      itemType: event.itemType,
      chunks: 0,
      length: 0,
    };
    aggregate.chunks++;
    aggregate.length += event.deltaLength ?? 0;
    this.#deltaAggregates.set(key, aggregate);
  }

  #flushDeltaAggregates(
    scope: Pick<
      CodexAppServerLifecycleEvent,
      "threadId" | "turnId" | "itemId"
    > = {},
  ): void {
    for (const [key, aggregate] of this.#deltaAggregates) {
      if (scope.threadId && aggregate.threadId !== scope.threadId) continue;
      if (scope.turnId && aggregate.turnId !== scope.turnId) continue;
      if (scope.itemId && aggregate.itemId !== scope.itemId) continue;
      this.#deltaAggregates.delete(key);
      this.#lifecycle({
        level: "debug",
        event: "item_delta",
        method: aggregate.method,
        threadId: aggregate.threadId,
        turnId: aggregate.turnId,
        itemId: aggregate.itemId,
        itemType: aggregate.itemType,
        deltaChunks: aggregate.chunks,
        deltaLength: aggregate.length,
      });
    }
  }

  #lifecycle(event: CodexAppServerLifecycleEvent): void {
    const callback = this.#callbacks.onLifecycle;
    if (!callback) return;
    try {
      const result = callback(event);
      if (result instanceof Promise) void result.catch(() => {});
    } catch {
      // Logging must never affect protocol processing.
    }
  }

  #recordDecline(
    method: string,
    requestId: RequestId,
    policy: NonNullable<CodexAppServerLifecycleEvent["policy"]>,
    context: ReturnType<typeof lifecycleContext>,
  ): void {
    this.#lifecycle({
      level: "warn",
      event: "server_request_declined",
      method,
      requestId,
      policy,
      ...context,
    });
  }

  #recordServerRequestAnswer(
    method: string,
    requestId: RequestId,
    context: ReturnType<typeof lifecycleContext>,
  ): void {
    this.#lifecycle({
      level: "debug",
      event: "server_request_answered",
      method,
      requestId,
      ...context,
    });
  }
}

type LifecycleContext = Pick<
  CodexAppServerLifecycleEvent,
  | "threadId"
  | "turnId"
  | "itemId"
  | "itemType"
  | "status"
  | "deltaLength"
  | "summaryParts"
  | "contentParts"
  | "questionCount"
>;

function lifecycleContext(rawParams: unknown): LifecycleContext {
  const params = isObject(rawParams) ? rawParams : {};
  const thread = isObject(params.thread) ? params.thread : {};
  const turn = isObject(params.turn) ? params.turn : {};
  const item = isObject(params.item) ? params.item : {};
  const delta = typeof params.delta === "string"
    ? params.delta
    : typeof params.deltaBase64 === "string"
    ? params.deltaBase64
    : undefined;
  const questions = Array.isArray(params.questions) ? params.questions : [];

  return compactLifecycleContext({
    threadId: optionalString(params.threadId) ?? optionalString(thread.id),
    turnId: optionalString(params.turnId) ?? optionalString(turn.id),
    itemId: optionalString(params.itemId) ?? optionalString(item.id),
    itemType: optionalString(item.type),
    status: optionalString(params.status) ?? optionalString(turn.status) ??
      optionalString(item.status),
    deltaLength: delta?.length,
    summaryParts: Array.isArray(item.summary) ? item.summary.length : undefined,
    contentParts: Array.isArray(item.content) ? item.content.length : undefined,
    questionCount: questions.length > 0 ? questions.length : undefined,
  });
}

function compactLifecycleContext(context: LifecycleContext): LifecycleContext {
  return Object.fromEntries(
    Object.entries(context).filter(([, value]) => value !== undefined),
  ) as LifecycleContext;
}

function notificationLifecycleEvent(
  method: string,
  params: JsonObject,
): CodexAppServerLifecycleEvent {
  const context = lifecycleContext(params);
  switch (method) {
    case "thread/started":
      return { level: "info", event: "thread_started", method, ...context };
    case "turn/started":
      return { level: "info", event: "turn_started", method, ...context };
    case "turn/completed":
      return {
        level: context.status === "failed" ? "warn" : "info",
        event: "turn_completed",
        method,
        ...context,
      };
    case "item/started":
      return { level: "debug", event: "item_started", method, ...context };
    case "item/completed":
      return { level: "debug", event: "item_completed", method, ...context };
    case "warning":
    case "guardianWarning":
    case "configWarning":
      return { level: "warn", event: "server_warning", method, ...context };
    case "error":
      return { level: "error", event: "server_error", method, ...context };
    default: {
      const delta = isDeltaNotification(method);
      return {
        level: "debug",
        event: delta ? "item_delta" : "notification_received",
        method,
        ...context,
      };
    }
  }
}

function isDeltaNotification(method: string): boolean {
  return method.endsWith("Delta") || method.endsWith("/delta");
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
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

function threadSession(value: unknown): CodexThreadSession {
  const result = isObject(value) ? value : {};
  const thread = isObject(result.thread) ? result.thread : {};
  const threadId = requiredString(thread.id, "thread.id");
  const model = requiredString(result.model, "model");
  const effort = result.reasoningEffort == null
    ? null
    : requiredString(result.reasoningEffort, "reasoningEffort");
  return { threadId, settings: { model, effort } };
}

function modelPage(value: unknown): {
  data: CodexModel[];
  nextCursor: string | null;
} {
  const result = isObject(value) ? value : {};
  if (!Array.isArray(result.data)) {
    throw new Error("Codex RPC response is missing data");
  }
  return {
    data: result.data.map((entry, index) =>
      modelEntry(entry, `data[${index}]`)
    ),
    nextCursor: nullableString(result.nextCursor, "nextCursor"),
  };
}

function modelEntry(value: unknown, path: string): CodexModel {
  const entry = isObject(value) ? value : {};
  if (!Array.isArray(entry.supportedReasoningEfforts)) {
    throw new Error(
      `Codex RPC response is missing ${path}.supportedReasoningEfforts`,
    );
  }
  return {
    id: requiredString(entry.id, `${path}.id`),
    model: requiredString(entry.model, `${path}.model`),
    displayName: requiredString(entry.displayName, `${path}.displayName`),
    description: requiredString(entry.description, `${path}.description`),
    hidden: requiredBoolean(entry.hidden, `${path}.hidden`),
    isDefault: requiredBoolean(entry.isDefault, `${path}.isDefault`),
    defaultReasoningEffort: requiredString(
      entry.defaultReasoningEffort,
      `${path}.defaultReasoningEffort`,
    ),
    supportedReasoningEfforts: entry.supportedReasoningEfforts.map(
      (value, index) => {
        const option = isObject(value) ? value : {};
        const optionPath = `${path}.supportedReasoningEfforts[${index}]`;
        return {
          reasoningEffort: requiredString(
            option.reasoningEffort,
            `${optionPath}.reasoningEffort`,
          ),
          description: requiredString(
            option.description,
            `${optionPath}.description`,
          ),
        };
      },
    ),
  };
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Codex RPC response is missing ${path}`);
  }
  return value;
}

function requiredBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Codex RPC response is missing ${path}`);
  }
  return value;
}

function nullableString(value: unknown, path: string): string | null {
  return value == null ? null : requiredString(value, path);
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
