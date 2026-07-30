import {
  type AppServerNotification,
  type AppServerProcessStatus,
  type CodexAppServerCallbacks,
  CodexAppServerClient,
  type CodexAppServerOptions,
  type RequestUserInputEvent,
  type TurnCompletedEvent,
} from "./codex-app-server.ts";
import type { ActivityEvent } from "./activity-event.ts";
import { describeCodexNotification } from "./codex-events.ts";
import type {
  CodexPort,
  CodexTurnHandle,
  TurnOutcome,
} from "./orchestrator.ts";

export interface CodexRuntimeClient {
  startThread(): Promise<string>;
  resumeThread(threadId: string): Promise<string>;
  startTurn(threadId: string, prompt: string): Promise<string>;
  interrupt(threadId: string, turnId: string): Promise<void>;
  close(): Promise<unknown>;
}

export type CodexRuntimeClientFactory = (
  options: CodexAppServerOptions,
) => Promise<CodexRuntimeClient>;

type MaybePromise<T> = T | Promise<T>;

export interface CodexRuntimeOptions {
  workspace: string;
  clientFactory?: CodexRuntimeClientFactory;
  delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  onFatal?: (error: Error) => MaybePromise<void>;
  onDiagnostic?: (message: string) => MaybePromise<void>;
}

interface ActiveTurn {
  onActivity: (event: ActivityEvent) => void | Promise<void>;
  resolve: (outcome: TurnOutcome) => void;
}

interface PendingTurnStart {
  readonly generation: number;
}

const RESTART_DELAYS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;
const defaultClientFactory: CodexRuntimeClientFactory = (options) =>
  CodexAppServerClient.start(options);

const defaultDelay = (
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> => {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
};

export class CodexRuntime implements CodexPort {
  readonly #workspace: string;
  readonly #clientFactory: CodexRuntimeClientFactory;
  readonly #delay: (
    milliseconds: number,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly #onFatal?: (error: Error) => MaybePromise<void>;
  readonly #onDiagnostic?: (message: string) => MaybePromise<void>;
  readonly #activeTurns = new Map<string, ActiveTurn>();
  readonly #bufferedActivities = new Map<string, ActivityEvent[]>();
  readonly #bufferedOutcomes = new Map<string, TurnOutcome>();
  readonly #terminalTurnKeys = new Set<string>();
  readonly #startingThreads = new Map<string, Set<PendingTurnStart>>();
  readonly #connectingTokens = new Set<object>();
  readonly #earlyExits = new Map<object, AppServerProcessStatus>();

  #client?: CodexRuntimeClient;
  #clientToken?: object;
  #startPromise?: Promise<void>;
  #restartPromise?: Promise<void>;
  #restartRequested = false;
  #restartDelayController?: AbortController;
  #ready = false;
  #generation = 0;
  #started = false;
  #stopping = false;

  constructor(options: CodexRuntimeOptions) {
    this.#workspace = options.workspace;
    this.#clientFactory = options.clientFactory ?? defaultClientFactory;
    this.#delay = options.delay ?? defaultDelay;
    this.#onFatal = options.onFatal;
    this.#onDiagnostic = options.onDiagnostic;
  }

  get ready(): boolean {
    return this.#ready;
  }

  get generation(): number {
    return this.#generation;
  }

  async start(): Promise<void> {
    if (this.#ready) return;
    if (this.#stopping) throw new Error("Codex runtime has been stopped");
    if (this.#startPromise) return await this.#startPromise;
    if (this.#started) {
      throw new Error("Codex App Server is restarting");
    }

    this.#started = true;
    this.#startPromise = this.#connect().catch((error) => {
      this.#started = false;
      throw error;
    }).finally(() => {
      this.#startPromise = undefined;
    });
    return await this.#startPromise;
  }

  async stop(): Promise<void> {
    if (this.#stopping) return;
    this.#stopping = true;
    this.#ready = false;
    this.#restartRequested = false;
    this.#restartDelayController?.abort();
    this.#restartDelayController = undefined;
    this.#resolveActiveTurnsAsLost();
    this.#clearBufferedEvents();

    const client = this.#client;
    this.#client = undefined;
    this.#clientToken = undefined;
    if (client) {
      try {
        await client.close();
      } catch (error) {
        this.#diagnostic(
          `Failed to close Codex App Server: ${errorMessage(error)}\n`,
        );
      }
    }
  }

  async startThread(): Promise<string> {
    return await this.#requireClient().startThread();
  }

  async resumeThread(threadId: string): Promise<void> {
    await this.#requireClient().resumeThread(threadId);
  }

  async startTurn(
    threadId: string,
    prompt: string,
    onActivity: (event: ActivityEvent) => void | Promise<void>,
  ): Promise<CodexTurnHandle> {
    const client = this.#requireClient();
    const clientToken = this.#clientToken;
    const pendingStart = this.#startPendingTurn(threadId);
    try {
      const turnId = await client.startTurn(threadId, prompt);
      const { promise: completion, resolve } = Promise.withResolvers<
        TurnOutcome
      >();
      const key = turnKey(threadId, turnId);

      if (
        !this.#ready || client !== this.#client ||
        clientToken !== this.#clientToken
      ) {
        // Exit and stop already clear the old generation's buffers.
        resolve({ status: "runtime_lost" });
        return { turnId, completion };
      }
      if (this.#activeTurns.has(key)) {
        throw new Error(`Codex turn is already active: ${threadId}/${turnId}`);
      }

      this.#terminalTurnKeys.delete(key);
      this.#activeTurns.set(key, { onActivity, resolve });
      const activities = this.#bufferedActivities.get(key) ?? [];
      this.#bufferedActivities.delete(key);
      for (const activity of activities) {
        this.#deliverActivity(onActivity, activity);
      }

      const outcome = this.#bufferedOutcomes.get(key);
      if (outcome) {
        this.#bufferedOutcomes.delete(key);
        this.#completeTurn(key, outcome);
      }
      return { turnId, completion };
    } finally {
      this.#finishPendingTurn(threadId, pendingStart);
    }
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.#requireClient().interrupt(threadId, turnId);
  }

  async #connect(): Promise<void> {
    const token = {};
    this.#connectingTokens.add(token);
    try {
      const client = await this.#clientFactory({
        cwd: this.#workspace,
        callbacks: this.#callbacks(token),
      });
      const earlyExit = this.#earlyExits.get(token);
      if (earlyExit) {
        try {
          await client.close();
        } catch {
          // The client has already exited; the original status is authoritative.
        }
        throw appServerExitedError(earlyExit);
      }
      if (this.#stopping) {
        try {
          await client.close();
        } catch {
          // Shutdown should not be blocked by a client that exited while starting.
        }
        throw new Error("Codex runtime stopped while App Server was starting");
      }

      this.#client = client;
      this.#clientToken = token;
      this.#ready = true;
      this.#generation++;
    } finally {
      this.#connectingTokens.delete(token);
      this.#earlyExits.delete(token);
    }
  }

  #callbacks(token: object): CodexAppServerCallbacks {
    return {
      onNotification: (event) => this.#handleNotification(token, event),
      onTurnCompleted: (event) => this.#handleTurnCompleted(token, event),
      onRequestUserInput: (event) => this.#handleRequestUserInput(token, event),
      onDiagnostic: (message) => this.#diagnostic(message),
      onExit: (status) => this.#handleExit(token, status),
    };
  }

  #handleNotification(token: object, event: AppServerNotification): void {
    if (token !== this.#clientToken) return;
    const ids = notificationIds(event.params);
    if (!ids) return;
    const activity = describeCodexNotification(event);
    // Terminal TURN output is owned by the orchestrator and TurnOutcome.
    if (!activity || activity.tag === "TURN") return;
    this.#routeActivity(ids.threadId, ids.turnId, activity);
  }

  #handleTurnCompleted(token: object, event: TurnCompletedEvent): void {
    if (token !== this.#clientToken) return;
    const outcome: TurnOutcome = {
      status: event.status,
      ...(event.finalMessage !== undefined
        ? { finalAnswer: event.finalMessage }
        : {}),
      error: errorMessageOrNull(event.error),
    };
    const key = turnKey(event.threadId, event.turnId);
    if (this.#activeTurns.has(key)) {
      this.#completeTurn(key, outcome);
    } else if (this.#isPendingTurn(event.threadId)) {
      this.#terminalTurnKeys.add(key);
      this.#bufferedOutcomes.set(key, outcome);
    }
  }

  #handleRequestUserInput(token: object, event: RequestUserInputEvent): void {
    if (token !== this.#clientToken) return;
    this.#routeActivity(
      event.threadId,
      event.turnId,
      requestUserInputActivity(event),
    );
  }

  #handleExit(token: object, status: AppServerProcessStatus): void {
    if (token !== this.#clientToken) {
      if (this.#connectingTokens.has(token)) {
        this.#earlyExits.set(token, status);
      }
      return;
    }

    this.#ready = false;
    this.#client = undefined;
    this.#clientToken = undefined;
    this.#resolveActiveTurnsAsLost();
    this.#clearBufferedEvents();
    if (this.#stopping) return;
    if (this.#restartPromise) {
      this.#restartRequested = true;
      return;
    }
    this.#startRestartRound();
  }

  #startRestartRound(): void {
    if (this.#stopping || this.#restartPromise) return;
    this.#restartRequested = false;
    const restart = this.#restart();
    this.#restartPromise = restart;
    void restart.then(
      () => this.#finishRestartRound(restart),
      (error) => {
        this.#diagnostic(`Codex restart loop failed: ${errorMessage(error)}\n`);
        this.#finishRestartRound(restart);
      },
    );
  }

  #finishRestartRound(restart: Promise<void>): void {
    if (this.#restartPromise !== restart) return;
    this.#restartPromise = undefined;
    if (this.#restartRequested && !this.#stopping && !this.#ready) {
      this.#startRestartRound();
    }
  }

  async #restart(): Promise<void> {
    let lastError = new Error("Codex App Server exited");
    for (const milliseconds of RESTART_DELAYS) {
      const delayController = new AbortController();
      this.#restartDelayController = delayController;
      try {
        await this.#delay(milliseconds, delayController.signal);
      } catch (error) {
        lastError = toError(error);
        if (this.#stopping) return;
        continue;
      } finally {
        if (this.#restartDelayController === delayController) {
          this.#restartDelayController = undefined;
        }
      }
      if (this.#stopping) return;

      try {
        await this.#connect();
        return;
      } catch (error) {
        lastError = toError(error);
        if (this.#stopping) return;
        this.#diagnostic(
          `Codex App Server restart failed: ${lastError.message}\n`,
        );
      }
    }
    await this.#fatal(lastError);
  }

  #routeActivity(
    threadId: string,
    turnId: string,
    activity: ActivityEvent,
  ): void {
    const key = turnKey(threadId, turnId);
    if (this.#terminalTurnKeys.has(key)) return;
    // A terminal event observed before startTurn resolves is also terminal.
    if (this.#bufferedOutcomes.has(key)) return;
    const active = this.#activeTurns.get(key);
    if (active) {
      this.#deliverActivity(active.onActivity, activity);
      return;
    }
    if (!this.#isPendingTurn(threadId)) return;
    const buffered = this.#bufferedActivities.get(key) ?? [];
    buffered.push(activity);
    this.#bufferedActivities.set(key, buffered);
  }

  #deliverActivity(
    onActivity: (event: ActivityEvent) => void | Promise<void>,
    activity: ActivityEvent,
  ): void {
    try {
      const result = onActivity(activity);
      if (isPromiseLike(result)) {
        void Promise.resolve(result).catch((error) => {
          this.#diagnostic(
            `Codex activity callback failed: ${errorMessage(error)}\n`,
          );
        });
      }
    } catch (error) {
      this.#diagnostic(
        `Codex activity callback failed: ${errorMessage(error)}\n`,
      );
    }
  }

  #completeTurn(key: string, outcome: TurnOutcome): void {
    const active = this.#activeTurns.get(key);
    if (!active) return;
    this.#activeTurns.delete(key);
    this.#terminalTurnKeys.add(key);
    this.#clearBufferedTurn(key);
    active.resolve(outcome);
  }

  #resolveActiveTurnsAsLost(): void {
    for (const [key, active] of this.#activeTurns) {
      this.#terminalTurnKeys.add(key);
      this.#clearBufferedTurn(key);
      active.resolve({ status: "runtime_lost" });
    }
    this.#activeTurns.clear();
  }

  #clearBufferedEvents(): void {
    this.#bufferedActivities.clear();
    this.#bufferedOutcomes.clear();
    this.#terminalTurnKeys.clear();
    this.#startingThreads.clear();
  }

  #startPendingTurn(threadId: string): PendingTurnStart {
    const pendingStart = { generation: this.#generation };
    const pendingStarts = this.#startingThreads.get(threadId) ?? new Set();
    pendingStarts.add(pendingStart);
    this.#startingThreads.set(threadId, pendingStarts);
    return pendingStart;
  }

  #finishPendingTurn(
    threadId: string,
    pendingStart: PendingTurnStart,
  ): void {
    const pendingStarts = this.#startingThreads.get(threadId);
    if (!pendingStarts?.delete(pendingStart) || pendingStarts.size > 0) return;
    this.#startingThreads.delete(threadId);
    if (pendingStart.generation === this.#generation) {
      this.#clearBufferedThread(threadId);
    }
  }

  #isPendingTurn(threadId: string): boolean {
    const pendingStarts = this.#startingThreads.get(threadId);
    if (!pendingStarts) return false;
    for (const pendingStart of pendingStarts) {
      if (pendingStart.generation === this.#generation) return true;
    }
    return false;
  }

  #clearBufferedTurn(key: string): void {
    this.#bufferedActivities.delete(key);
    this.#bufferedOutcomes.delete(key);
  }

  #clearBufferedThread(threadId: string): void {
    const prefix = `${threadId}\u0000`;
    for (const key of this.#bufferedActivities.keys()) {
      if (key.startsWith(prefix)) this.#bufferedActivities.delete(key);
    }
    for (const key of this.#bufferedOutcomes.keys()) {
      if (key.startsWith(prefix)) this.#bufferedOutcomes.delete(key);
    }
  }

  #requireClient(): CodexRuntimeClient {
    if (!this.#ready || !this.#client) {
      throw new Error("Codex App Server is unavailable");
    }
    return this.#client;
  }

  async #fatal(error: Error): Promise<void> {
    if (!this.#onFatal) return;
    try {
      await this.#onFatal(error);
    } catch (callbackError) {
      this.#diagnostic(
        `Codex fatal callback failed: ${errorMessage(callbackError)}\n`,
      );
    }
  }

  #diagnostic(message: string): void {
    if (!this.#onDiagnostic) return;
    try {
      const result = this.#onDiagnostic(message);
      if (result instanceof Promise) void result.catch(() => {});
    } catch {
      // Diagnostic callbacks must never affect runtime state transitions.
    }
  }
}

function notificationIds(
  params: Record<string, unknown>,
): { threadId: string; turnId: string } | null {
  const threadId = optionalString(params.threadId);
  const turn = record(params.turn);
  const turnId = optionalString(params.turnId) ?? optionalString(turn?.id);
  return threadId && turnId ? { threadId, turnId } : null;
}

function requestUserInputActivity(event: RequestUserInputEvent): ActivityEvent {
  return {
    tag: "CONTENT",
    body: renderRequestUserInput(event.questions),
    threadId: event.threadId,
    turnId: event.turnId,
    ...(event.itemId ? { itemId: event.itemId } : {}),
    delivery: "direct",
  };
}

function renderRequestUserInput(questions: readonly unknown[]): string {
  const lines = ["Codex 需要用户输入"];
  if (questions.length === 0) {
    lines.push("", "Codex 请求补充信息。", "", "请直接发送下一条文本继续。");
    return lines.join("\n");
  }

  questions.forEach((rawQuestion, index) => {
    const question = record(rawQuestion) ?? {};
    const header = optionalString(question.header) ?? `问题 ${index + 1}`;
    const prompt = optionalString(question.question) ??
      optionalString(question.prompt) ?? "请补充信息";
    lines.push("", `### ${header}`, "", prompt);

    if (Array.isArray(question.options)) {
      let hasOption = false;
      for (const rawOption of question.options) {
        const option = record(rawOption);
        const label = optionalString(option?.label);
        if (!label) continue;
        const description = optionalString(option?.description);
        if (!hasOption) {
          lines.push("");
          hasOption = true;
        }
        lines.push(
          description ? `- **${label}**：${description}` : `- **${label}**`,
        );
      }
    }
  });
  lines.push("", "请直接发送下一条文本继续。");
  return lines.join("\n");
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}\u0000${turnId}`;
}

function errorMessageOrNull(error: unknown): string | null {
  if (error == null) return null;
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  const message = optionalString(record(error)?.message);
  if (message !== undefined) return message;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as PromiseLike<unknown>).then === "function";
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function appServerExitedError(status: AppServerProcessStatus): Error {
  return new Error(
    `Codex App Server exited while starting (code=${status.code}, signal=${
      status.signal ?? "none"
    })`,
  );
}
