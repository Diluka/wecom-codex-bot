import {
  type AppServerNotification,
  type AppServerProcessStatus,
  type CodexAppServerCallbacks,
  CodexAppServerClient,
  type CodexAppServerOptions,
  type RequestUserInputEvent,
  type TurnCompletedEvent,
} from "./codex-app-server.ts";
import { describeCodexNotification } from "./codex-events.ts";
import type {
  CodexPort,
  CodexTurnHandle,
  TurnOutcome,
} from "./orchestrator.ts";
import {
  DEFAULT_PROGRESS_SETTINGS,
  type ProgressSettings,
} from "./output-settings.ts";
import { TurnProgressPolicy } from "./progress-policy.ts";

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
  progressSettings?: ProgressSettings;
  clientFactory?: CodexRuntimeClientFactory;
  delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  onFatal?: (error: Error) => MaybePromise<void>;
  onDiagnostic?: (message: string) => MaybePromise<void>;
}

interface ActiveTurn {
  onProgress: (text: string) => void;
  resolve: (outcome: TurnOutcome) => void;
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
  readonly #progressSettings: ProgressSettings;
  readonly #activeTurns = new Map<string, ActiveTurn>();
  readonly #bufferedProgress = new Map<string, string[]>();
  readonly #bufferedOutcomes = new Map<string, TurnOutcome>();
  readonly #progressPolicies = new Map<string, TurnProgressPolicy>();
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
    this.#progressSettings = options.progressSettings ??
      DEFAULT_PROGRESS_SETTINGS;
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
    onProgress: (text: string) => void,
  ): Promise<CodexTurnHandle> {
    const client = this.#requireClient();
    const clientToken = this.#clientToken;
    const turnId = await client.startTurn(threadId, prompt);
    const { promise: completion, resolve } = Promise.withResolvers<
      TurnOutcome
    >();
    const key = turnKey(threadId, turnId);

    if (
      !this.#ready || client !== this.#client ||
      clientToken !== this.#clientToken
    ) {
      this.#clearProgressPolicy(key);
      resolve({ status: "runtime_lost" });
      return { turnId, completion };
    }
    if (this.#activeTurns.has(key)) {
      throw new Error(`Codex turn is already active: ${threadId}/${turnId}`);
    }

    this.#activeTurns.set(key, { onProgress, resolve });
    const progress = this.#bufferedProgress.get(key) ?? [];
    this.#bufferedProgress.delete(key);
    for (const text of progress) this.#deliverProgress(onProgress, text);

    const outcome = this.#bufferedOutcomes.get(key);
    if (outcome) {
      this.#bufferedOutcomes.delete(key);
      this.#completeTurn(key, outcome);
    }
    return { turnId, completion };
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
    const progressEvent = describeCodexNotification(event);
    if (!progressEvent) return;
    const rendered = this.#progressPolicy(
      turnKey(ids.threadId, ids.turnId),
    ).apply(progressEvent);
    if (rendered === null) return;
    this.#routeProgress(ids.threadId, ids.turnId, rendered);
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
    this.#clearProgressPolicy(key);
    if (this.#activeTurns.has(key)) {
      this.#completeTurn(key, outcome);
    } else {
      this.#bufferedOutcomes.set(key, outcome);
    }
  }

  #handleRequestUserInput(token: object, event: RequestUserInputEvent): void {
    if (token !== this.#clientToken) return;
    this.#routeProgress(
      event.threadId,
      event.turnId,
      renderRequestUserInput(event.questions),
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

  #routeProgress(threadId: string, turnId: string, text: string): void {
    const key = turnKey(threadId, turnId);
    const active = this.#activeTurns.get(key);
    if (active) {
      this.#deliverProgress(active.onProgress, text);
      return;
    }
    const buffered = this.#bufferedProgress.get(key) ?? [];
    buffered.push(text);
    this.#bufferedProgress.set(key, buffered);
  }

  #deliverProgress(onProgress: (text: string) => void, text: string): void {
    try {
      onProgress(text);
    } catch (error) {
      this.#diagnostic(
        `Codex progress callback failed: ${errorMessage(error)}\n`,
      );
    }
  }

  #completeTurn(key: string, outcome: TurnOutcome): void {
    const active = this.#activeTurns.get(key);
    if (!active) return;
    this.#activeTurns.delete(key);
    this.#clearProgressPolicy(key);
    active.resolve(outcome);
  }

  #resolveActiveTurnsAsLost(): void {
    for (const [key, active] of this.#activeTurns) {
      this.#clearProgressPolicy(key);
      active.resolve({ status: "runtime_lost" });
    }
    this.#activeTurns.clear();
  }

  #clearBufferedEvents(): void {
    this.#bufferedProgress.clear();
    this.#bufferedOutcomes.clear();
    this.#progressPolicies.clear();
  }

  #progressPolicy(key: string): TurnProgressPolicy {
    let policy = this.#progressPolicies.get(key);
    if (!policy) {
      policy = new TurnProgressPolicy(this.#progressSettings);
      this.#progressPolicies.set(key, policy);
    }
    return policy;
  }

  #clearProgressPolicy(key: string): void {
    const policy = this.#progressPolicies.get(key);
    policy?.clear();
    this.#progressPolicies.delete(key);
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

function renderRequestUserInput(questions: readonly unknown[]): string {
  const lines = ["\n[Codex 需要用户输入]"];
  if (questions.length === 0) {
    lines.push("", "Codex 请求补充信息。", "", "请直接发送下一条文本继续。\n");
    return lines.join("\n");
  }

  questions.forEach((rawQuestion, index) => {
    const question = record(rawQuestion) ?? {};
    const header = optionalString(question.header) ?? `问题 ${index + 1}`;
    const prompt = optionalString(question.question) ??
      optionalString(question.prompt) ?? "请补充信息";
    lines.push("", `### ${header}`, "", prompt);

    if (Array.isArray(question.options)) {
      for (const rawOption of question.options) {
        const option = record(rawOption);
        const label = optionalString(option?.label);
        if (!label) continue;
        const description = optionalString(option?.description);
        lines.push(
          description ? `- **${label}**：${description}` : `- **${label}**`,
        );
      }
    }
  });
  lines.push("", "请直接发送下一条文本继续。\n");
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
