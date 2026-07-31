import {
  type AppServerNotification,
  type AppServerProcessStatus,
  type CodexAppServerCallbacks,
  CodexAppServerClient,
  type CodexAppServerOptions,
  type RequestUserInputEvent,
  type ThreadStartedEvent,
  type TurnCompletedEvent,
} from "./codex-app-server.ts";
import type { ActivityEvent } from "./activity-event.ts";
import type { RequestAuthority } from "./owner-policy.ts";
import {
  describeCodexNotification,
  describeSubagentStatusUpdates,
  type SubagentStatus,
  type SubagentStatusUpdate,
} from "./codex-events.ts";
import type {
  CodexModel,
  CodexSettings,
  CodexThreadSession,
  ConfigDefaults,
  ModelSettingsSnapshot,
  ModelSettingsUpdateResult,
  SettingsPatch,
} from "./model-settings.ts";
import type {
  CodexPort,
  CodexTurnHandle,
  TurnOutcome,
} from "./orchestrator.ts";

export interface CodexRuntimeClient {
  startThread(): Promise<CodexThreadSession>;
  resumeThread(threadId: string): Promise<CodexThreadSession>;
  startTurn(
    threadId: string,
    prompt: string,
    authority: RequestAuthority,
  ): Promise<string>;
  interrupt(threadId: string, turnId: string): Promise<void>;
  listModels(): Promise<CodexModel[]>;
  readConfigDefaults(): Promise<ConfigDefaults>;
  updateThreadSettings(threadId: string, patch: SettingsPatch): Promise<void>;
  writeConfigDefaults(patch: SettingsPatch): Promise<void>;
  close(): Promise<unknown>;
}

export type CodexRuntimeClientFactory = (
  options: CodexAppServerOptions,
) => Promise<CodexRuntimeClient>;

type MaybePromise<T> = T | Promise<T>;

export interface CodexRuntimeTrace {
  method: string;
  decision: "routed" | "buffered" | "ignored";
  reason:
    | "stale_generation"
    | "missing_turn_ids"
    | "adapter_ignored"
    | "turn_owned_by_orchestrator"
    | "delivered"
    | "buffered"
    | "terminal_turn"
    | "no_matching_turn";
  generation: number;
  threadId?: string;
  turnId?: string;
  tag?: ActivityEvent["tag"];
}

export interface CodexRuntimeOptions {
  workspace: string;
  developerInstructions?: string;
  clientFactory?: CodexRuntimeClientFactory;
  delay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  onFatal?: (error: Error) => MaybePromise<void>;
  onDiagnostic?: (message: string) => MaybePromise<void>;
  onTrace?: (trace: CodexRuntimeTrace) => MaybePromise<void>;
}

interface ActiveTurn {
  onActivity: (event: ActivityEvent) => void | Promise<void>;
  resolve: (outcome: TurnOutcome) => void;
}

interface PendingTurnStart {
  readonly generation: number;
}

interface SettingsRuntimeContext {
  readonly client: CodexRuntimeClient;
  readonly token: object;
  readonly generation: number;
}

interface SubagentRecord {
  parentTurnId?: string;
  agentNickname?: string;
  agentRole?: string;
  name?: string;
  status?: SubagentStatus;
  lastEmittedStatus?: SubagentStatus;
  pendingStatuses?: SubagentStatus[];
  terminalFallbackEmitted?: boolean;
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

/** Adapts Codex App Server sessions into the orchestrator's resilient Codex port. */
export class CodexRuntime implements CodexPort {
  readonly #workspace: string;
  readonly #developerInstructions?: string;
  readonly #clientFactory: CodexRuntimeClientFactory;
  readonly #delay: (
    milliseconds: number,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly #onFatal?: (error: Error) => MaybePromise<void>;
  readonly #onDiagnostic?: (message: string) => MaybePromise<void>;
  readonly #onTrace?: (trace: CodexRuntimeTrace) => MaybePromise<void>;
  readonly #activeTurns = new Map<string, ActiveTurn>();
  readonly #bufferedActivities = new Map<string, ActivityEvent[]>();
  readonly #bufferedOutcomes = new Map<string, TurnOutcome>();
  readonly #terminalTurnKeys = new Set<string>();
  readonly #ambiguousSubagentTurnKeys = new Set<string>();
  readonly #startingThreads = new Map<string, Set<PendingTurnStart>>();
  readonly #connectingTokens = new Set<object>();
  readonly #earlyExits = new Map<object, AppServerProcessStatus>();
  readonly #threadSettings = new Map<string, CodexSettings>();
  readonly #resumePromises = new Map<string, Promise<void>>();
  readonly #threadSettingTails = new Map<string, Promise<void>>();
  readonly #subagentsByParentThread = new Map<
    string,
    Map<string, SubagentRecord>
  >();

  #client?: CodexRuntimeClient;
  #clientToken?: object;
  #startPromise?: Promise<void>;
  #restartPromise?: Promise<void>;
  #restartRequested = false;
  #restartDelayController?: AbortController;
  #ready = false;
  #generation = 0;
  #catalog?: { generation: number; models: readonly CodexModel[] };
  #catalogPromise?: {
    generation: number;
    promise: Promise<readonly CodexModel[]>;
  };
  #configWriteTail: Promise<void> = Promise.resolve();
  #started = false;
  #stopping = false;

  constructor(options: CodexRuntimeOptions) {
    this.#workspace = options.workspace;
    this.#developerInstructions = options.developerInstructions;
    this.#clientFactory = options.clientFactory ?? defaultClientFactory;
    this.#delay = options.delay ?? defaultDelay;
    this.#onFatal = options.onFatal;
    this.#onDiagnostic = options.onDiagnostic;
    this.#onTrace = options.onTrace;
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
    this.#clearModelSettingsState();

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
    const client = this.#requireClient();
    const token = this.#clientToken;
    const session = await client.startThread();
    if (
      !this.#ready || client !== this.#client || token !== this.#clientToken
    ) {
      throw new Error("Codex runtime changed while starting a thread");
    }
    this.#threadSettings.set(session.threadId, session.settings);
    return session.threadId;
  }

  async resumeThread(threadId: string): Promise<void> {
    if (this.#threadSettings.has(threadId)) return;
    const pending = this.#resumePromises.get(threadId);
    if (pending) return await pending;

    const client = this.#requireClient();
    const token = this.#clientToken;
    const resume = (async () => {
      const session = await client.resumeThread(threadId);
      if (
        !this.#ready || client !== this.#client || token !== this.#clientToken
      ) {
        throw new Error("Codex runtime changed while resuming a thread");
      }
      this.#threadSettings.set(session.threadId, session.settings);
    })();
    this.#resumePromises.set(threadId, resume);
    try {
      await resume;
    } finally {
      if (this.#resumePromises.get(threadId) === resume) {
        this.#resumePromises.delete(threadId);
      }
    }
  }

  async getModelSettings(
    threadId?: string,
  ): Promise<ModelSettingsSnapshot> {
    return await this.#getModelSettings(this.#settingsContext(), threadId);
  }

  async #getModelSettings(
    context: SettingsRuntimeContext,
    threadId?: string,
  ): Promise<ModelSettingsSnapshot> {
    const models = await this.#models(context);
    const settings = await this.#currentSettings(context, threadId, models);
    const selectedModel = models.find(({ model }) => model === settings.model);
    if (!selectedModel) {
      throw new Error(
        `Codex model catalog does not include ${settings.model}`,
      );
    }
    return {
      settings,
      selectedModel,
      models,
      source: threadId ? "thread" : "default",
    };
  }

  async setModel(
    threadId: string | undefined,
    model: string,
  ): Promise<ModelSettingsUpdateResult> {
    const context = this.#settingsContext();
    if (threadId) {
      return await this.#enqueueThreadSettings(
        threadId,
        () => this.#setModel(context, threadId, model),
      );
    }
    return await this.#setModel(context, undefined, model);
  }

  async #setModel(
    context: SettingsRuntimeContext,
    threadId: string | undefined,
    model: string,
  ): Promise<ModelSettingsUpdateResult> {
    this.#assertSettingsContext(
      context,
      threadId ? "updating thread settings" : "updating default settings",
    );
    const models = await this.#models(context);
    const selectedModel = models.find((entry) => entry.model === model);
    if (!selectedModel) {
      return {
        status: "invalid_model",
        availableModels: models.map((entry) => entry.model),
      };
    }
    const current = await this.#currentSettings(context, threadId, models);
    const patch: SettingsPatch = { model };
    let effort = current.effort;
    let effortAdjusted = false;
    if (effort === null || !supportedEfforts(selectedModel).includes(effort)) {
      effort = selectedModel.defaultReasoningEffort;
      patch.effort = effort;
      effortAdjusted = true;
    }
    return await this.#applySettings(
      context,
      threadId,
      patch,
      { model, effort },
      effortAdjusted,
    );
  }

  async setEffort(
    threadId: string | undefined,
    effort: string,
  ): Promise<ModelSettingsUpdateResult> {
    const context = this.#settingsContext();
    if (threadId) {
      return await this.#enqueueThreadSettings(
        threadId,
        () => this.#setEffort(context, threadId, effort),
      );
    }
    return await this.#setEffort(context, undefined, effort);
  }

  async #setEffort(
    context: SettingsRuntimeContext,
    threadId: string | undefined,
    effort: string,
  ): Promise<ModelSettingsUpdateResult> {
    this.#assertSettingsContext(
      context,
      threadId ? "updating thread settings" : "updating default settings",
    );
    const snapshot = await this.#getModelSettings(context, threadId);
    const efforts = supportedEfforts(snapshot.selectedModel);
    if (!efforts.includes(effort)) {
      return {
        status: "invalid_effort",
        model: snapshot.settings.model,
        availableEfforts: efforts,
      };
    }
    return await this.#applySettings(
      context,
      threadId,
      { effort },
      { model: snapshot.settings.model, effort },
      false,
    );
  }

  async startTurn(
    threadId: string,
    prompt: string,
    authority: RequestAuthority,
    onActivity: (event: ActivityEvent) => void | Promise<void>,
  ): Promise<CodexTurnHandle> {
    const client = this.#requireClient();
    const clientToken = this.#clientToken;
    const pendingStart = this.#startPendingTurn(threadId);
    let activated = false;
    try {
      const turnId = await client.startTurn(threadId, prompt, authority);
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

      if (this.#terminalTurnKeys.delete(key)) {
        this.#ambiguousSubagentTurnKeys.add(key);
      }
      this.#activeTurns.set(key, { onActivity, resolve });
      activated = true;
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
      this.#finishPendingTurn(threadId, pendingStart, activated);
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
        developerInstructions: this.#developerInstructions,
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
      onThreadStarted: (event) => this.#handleThreadStarted(token, event),
      onTurnCompleted: (event) => this.#handleTurnCompleted(token, event),
      onRequestUserInput: (event) => this.#handleRequestUserInput(token, event),
      onDiagnostic: (message) => this.#diagnostic(message),
      onExit: (status) => this.#handleExit(token, status),
    };
  }

  #handleNotification(token: object, event: AppServerNotification): void {
    const ids = notificationIds(event.params);
    if (token !== this.#clientToken) {
      this.#trace({
        method: event.method,
        decision: "ignored",
        reason: "stale_generation",
        generation: this.#generation,
        ...(ids ?? {}),
      });
      return;
    }
    if (!ids) {
      this.#trace({
        method: event.method,
        decision: "ignored",
        reason: "missing_turn_ids",
        generation: this.#generation,
      });
      return;
    }
    for (const update of describeSubagentStatusUpdates(event)) {
      this.#recordSubagentStatus(ids.threadId, ids.turnId, update);
    }
    const activity = describeCodexNotification(event);
    // Terminal TURN output is owned by the orchestrator and TurnOutcome.
    if (!activity) {
      this.#trace({
        method: event.method,
        decision: "ignored",
        reason: "adapter_ignored",
        generation: this.#generation,
        ...ids,
      });
      return;
    }
    if (activity.tag === "TURN") {
      this.#trace({
        method: event.method,
        decision: "ignored",
        reason: "turn_owned_by_orchestrator",
        generation: this.#generation,
        ...ids,
        tag: activity.tag,
      });
      return;
    }
    this.#routeActivity(ids.threadId, ids.turnId, activity, event.method);
  }

  #handleThreadStarted(token: object, event: ThreadStartedEvent): void {
    if (token !== this.#clientToken || !event.parentThreadId) return;
    if (!this.#hasActiveOrPendingTurn(event.parentThreadId)) return;

    const record = this.#subagentRecord(event.parentThreadId, event.threadId);
    if (event.agentNickname) record.agentNickname = event.agentNickname;
    if (event.agentRole) record.agentRole = event.agentRole;
    if (event.name) record.name = event.name;
    this.#emitSubagentStatus(event.parentThreadId, event.threadId);
  }

  #recordSubagentStatus(
    parentThreadId: string,
    parentTurnId: string,
    update: SubagentStatusUpdate,
  ): void {
    const key = turnKey(parentThreadId, parentTurnId);
    if (
      this.#terminalTurnKeys.has(key) || this.#bufferedOutcomes.has(key) ||
      this.#ambiguousSubagentTurnKeys.has(key)
    ) {
      return;
    }
    const record = this.#subagentRecord(parentThreadId, update.agentThreadId);
    if (
      record.parentTurnId !== undefined && record.parentTurnId !== parentTurnId
    ) {
      record.status = undefined;
      record.lastEmittedStatus = undefined;
      record.pendingStatuses = undefined;
      record.terminalFallbackEmitted = undefined;
    }
    if (record.status === update.status) return;
    record.parentTurnId = parentTurnId;
    record.status = update.status;
    this.#emitSubagentStatus(parentThreadId, update.agentThreadId);
  }

  #emitSubagentStatus(
    parentThreadId: string,
    childThreadId: string,
  ): void {
    const record = this.#subagentsByParentThread.get(parentThreadId)?.get(
      childThreadId,
    );
    if (
      !record?.parentTurnId || !record.status ||
      this.#ambiguousSubagentTurnKeys.has(
        turnKey(parentThreadId, record.parentTurnId),
      )
    ) {
      return;
    }

    const displayName = subagentDisplayName(record);
    if (!displayName) {
      if (!isTerminalSubagentStatus(record.status)) {
        (record.pendingStatuses ??= []).push(record.status);
        return;
      }

      record.pendingStatuses = undefined;
      record.terminalFallbackEmitted = true;
      this.#routeSubagentStatus(
        parentThreadId,
        childThreadId,
        record,
        childThreadId.slice(0, 8),
        record.status,
      );
      return;
    }

    if (record.terminalFallbackEmitted) return;
    const pendingStatuses = record.pendingStatuses ?? [];
    record.pendingStatuses = undefined;
    for (const status of pendingStatuses) {
      this.#routeSubagentStatus(
        parentThreadId,
        childThreadId,
        record,
        displayName,
        status,
      );
    }
    this.#routeSubagentStatus(
      parentThreadId,
      childThreadId,
      record,
      displayName,
      record.status,
    );
  }

  #routeSubagentStatus(
    parentThreadId: string,
    childThreadId: string,
    record: SubagentRecord,
    displayName: string,
    status: SubagentStatus,
  ): void {
    if (!record.parentTurnId || record.lastEmittedStatus === status) return;
    this.#routeActivity(parentThreadId, record.parentTurnId, {
      tag: "SUBAGENT",
      body: `${displayName}：${subagentStatusLabel(status)}`,
      threadId: parentThreadId,
      turnId: record.parentTurnId,
      itemId: childThreadId,
      delivery: "progress",
    });
    record.lastEmittedStatus = status;
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
    this.#clearModelSettingsState();
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
    traceMethod?: string,
  ): void {
    const key = turnKey(threadId, turnId);
    if (this.#terminalTurnKeys.has(key)) {
      this.#routeTrace(traceMethod, threadId, turnId, activity, {
        decision: "ignored",
        reason: "terminal_turn",
      });
      return;
    }
    // A terminal event observed before startTurn resolves is also terminal.
    if (this.#bufferedOutcomes.has(key)) {
      this.#routeTrace(traceMethod, threadId, turnId, activity, {
        decision: "ignored",
        reason: "terminal_turn",
      });
      return;
    }
    const active = this.#activeTurns.get(key);
    if (active) {
      this.#deliverActivity(active.onActivity, activity);
      this.#routeTrace(traceMethod, threadId, turnId, activity, {
        decision: "routed",
        reason: "delivered",
      });
      return;
    }
    if (!this.#isPendingTurn(threadId)) {
      this.#routeTrace(traceMethod, threadId, turnId, activity, {
        decision: "ignored",
        reason: "no_matching_turn",
      });
      return;
    }
    const buffered = this.#bufferedActivities.get(key) ?? [];
    buffered.push(activity);
    this.#bufferedActivities.set(key, buffered);
    this.#routeTrace(traceMethod, threadId, turnId, activity, {
      decision: "buffered",
      reason: "buffered",
    });
  }

  #routeTrace(
    method: string | undefined,
    threadId: string,
    turnId: string,
    activity: ActivityEvent,
    result: Pick<CodexRuntimeTrace, "decision" | "reason">,
  ): void {
    if (!method) return;
    this.#trace({
      method,
      ...result,
      generation: this.#generation,
      threadId,
      turnId,
      tag: activity.tag,
    });
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
    this.#ambiguousSubagentTurnKeys.delete(key);
    this.#clearBufferedTurn(key);
    this.#clearSubagentTurn(...turnIds(key));
    active.resolve(outcome);
  }

  #resolveActiveTurnsAsLost(): void {
    for (const [key, active] of this.#activeTurns) {
      this.#terminalTurnKeys.add(key);
      this.#ambiguousSubagentTurnKeys.delete(key);
      this.#clearBufferedTurn(key);
      this.#clearSubagentTurn(...turnIds(key));
      active.resolve({ status: "runtime_lost" });
    }
    this.#activeTurns.clear();
  }

  #clearBufferedEvents(): void {
    this.#bufferedActivities.clear();
    this.#bufferedOutcomes.clear();
    this.#terminalTurnKeys.clear();
    this.#ambiguousSubagentTurnKeys.clear();
    this.#startingThreads.clear();
    this.#subagentsByParentThread.clear();
  }

  #clearModelSettingsState(): void {
    this.#threadSettings.clear();
    this.#resumePromises.clear();
    this.#threadSettingTails.clear();
    this.#catalog = undefined;
    this.#catalogPromise = undefined;
    this.#configWriteTail = Promise.resolve();
  }

  async #currentSettings(
    context: SettingsRuntimeContext,
    threadId: string | undefined,
    models: readonly CodexModel[],
  ): Promise<CodexSettings> {
    if (threadId) {
      return await this.#loadedThreadSettings(context, threadId);
    }
    const defaults = await context.client.readConfigDefaults();
    this.#assertSettingsContext(context, "reading default settings");
    return resolveDefaults(defaults, models);
  }

  async #loadedThreadSettings(
    context: SettingsRuntimeContext,
    threadId: string,
  ): Promise<CodexSettings> {
    this.#assertSettingsContext(context, "loading thread settings");
    if (!this.#threadSettings.has(threadId)) {
      await this.resumeThread(threadId);
    }
    this.#assertSettingsContext(context, "loading thread settings");
    const settings = this.#threadSettings.get(threadId);
    if (!settings) {
      throw new Error(
        `Codex thread settings are unavailable for ${threadId}`,
      );
    }
    return settings;
  }

  async #models(
    context: SettingsRuntimeContext,
  ): Promise<readonly CodexModel[]> {
    this.#assertSettingsContext(context, "loading the model catalog");
    if (this.#catalog?.generation === context.generation) {
      return this.#catalog.models;
    }
    if (this.#catalogPromise?.generation === context.generation) {
      const models = await this.#catalogPromise.promise;
      this.#assertSettingsContext(context, "loading the model catalog");
      return models;
    }
    const load = (async (): Promise<readonly CodexModel[]> => {
      const models = await context.client.listModels();
      this.#assertSettingsContext(context, "loading the model catalog");
      this.#catalog = { generation: context.generation, models };
      return models;
    })();
    const pending = { generation: context.generation, promise: load };
    this.#catalogPromise = pending;
    try {
      return await load;
    } finally {
      if (this.#catalogPromise === pending) {
        this.#catalogPromise = undefined;
      }
    }
  }

  async #applySettings(
    context: SettingsRuntimeContext,
    threadId: string | undefined,
    patch: SettingsPatch,
    next: CodexSettings,
    effortAdjusted: boolean,
  ): Promise<ModelSettingsUpdateResult> {
    let threadUpdated = false;
    if (threadId) {
      this.#assertSettingsContext(context, "updating thread settings");
      await context.client.updateThreadSettings(threadId, patch);
      this.#assertSettingsContext(context, "updating thread settings");
      this.#threadSettings.set(threadId, next);
      threadUpdated = true;
    }

    try {
      await this.#enqueueConfigWrite(
        context,
        () => context.client.writeConfigDefaults(patch),
      );
      return {
        status: "updated",
        settings: next,
        threadUpdated,
        defaultPersisted: true,
        effortAdjusted,
      };
    } catch (error) {
      return {
        status: "updated",
        settings: next,
        threadUpdated,
        defaultPersisted: false,
        effortAdjusted,
        persistenceError: errorMessage(error),
      };
    }
  }

  async #enqueueThreadSettings<T>(
    threadId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#threadSettingTails.get(threadId) ??
      Promise.resolve();
    const update = previous.then(operation);
    const tail = update.then(() => {}, () => {});
    this.#threadSettingTails.set(threadId, tail);
    try {
      return await update;
    } finally {
      if (this.#threadSettingTails.get(threadId) === tail) {
        this.#threadSettingTails.delete(threadId);
      }
    }
  }

  async #enqueueConfigWrite(
    context: SettingsRuntimeContext,
    operation: () => Promise<void>,
  ): Promise<void> {
    const write = this.#configWriteTail.catch(() => {}).then(async () => {
      this.#assertSettingsContext(
        context,
        "persisting default settings",
      );
      await operation();
      this.#assertSettingsContext(
        context,
        "persisting default settings",
      );
    });
    this.#configWriteTail = write;
    try {
      await write;
    } finally {
      if (this.#configWriteTail === write) {
        this.#configWriteTail = Promise.resolve();
      }
    }
  }

  #subagentRecord(
    parentThreadId: string,
    childThreadId: string,
  ): SubagentRecord {
    let records = this.#subagentsByParentThread.get(parentThreadId);
    if (!records) {
      records = new Map();
      this.#subagentsByParentThread.set(parentThreadId, records);
    }
    let record = records.get(childThreadId);
    if (!record) {
      record = {};
      records.set(childThreadId, record);
    }
    return record;
  }

  #clearSubagentTurn(parentThreadId: string, parentTurnId: string): void {
    const records = this.#subagentsByParentThread.get(parentThreadId);
    if (!records) return;

    for (const [childThreadId, record] of records) {
      if (
        record.parentTurnId === parentTurnId ||
        record.parentTurnId === undefined
      ) {
        records.delete(childThreadId);
      }
    }
    if (records.size === 0) {
      this.#subagentsByParentThread.delete(parentThreadId);
    }
  }

  #hasActiveOrPendingTurn(threadId: string): boolean {
    if (this.#isPendingTurn(threadId)) return true;
    for (const key of this.#activeTurns.keys()) {
      if (turnIds(key)[0] === threadId) return true;
    }
    return false;
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
    activated: boolean,
  ): void {
    const pendingStarts = this.#startingThreads.get(threadId);
    if (!pendingStarts?.delete(pendingStart)) return;
    const isCurrentGeneration = pendingStart.generation === this.#generation;
    if (isCurrentGeneration && !activated) {
      // Early child events cannot be assigned to one concurrent pending RPC.
      this.#clearUnactivatedSubagentThread(threadId);
    }
    if (pendingStarts.size > 0) return;
    this.#startingThreads.delete(threadId);
    if (isCurrentGeneration) {
      this.#clearBufferedThread(threadId);
    }
  }

  #clearUnactivatedSubagentThread(parentThreadId: string): void {
    const records = this.#subagentsByParentThread.get(parentThreadId);
    if (!records) return;

    const activeTurnIds = new Set<string>();
    for (const key of this.#activeTurns.keys()) {
      const [threadId, turnId] = turnIds(key);
      if (threadId === parentThreadId) activeTurnIds.add(turnId);
    }
    const unactivatedTurnIds = new Set<string>();
    for (const [childThreadId, record] of records) {
      const belongsToActiveTurn = record.parentTurnId
        ? activeTurnIds.has(record.parentTurnId)
        : activeTurnIds.size > 0;
      if (belongsToActiveTurn) continue;
      if (record.parentTurnId) unactivatedTurnIds.add(record.parentTurnId);
      records.delete(childThreadId);
    }
    if (records.size === 0) {
      this.#subagentsByParentThread.delete(parentThreadId);
    }
    for (const turnId of unactivatedTurnIds) {
      const key = turnKey(parentThreadId, turnId);
      const buffered = this.#bufferedActivities.get(key);
      if (!buffered) continue;
      const retained = buffered.filter((activity) =>
        activity.tag !== "SUBAGENT"
      );
      if (retained.length > 0) {
        this.#bufferedActivities.set(key, retained);
      } else {
        this.#bufferedActivities.delete(key);
      }
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

  #settingsContext(): SettingsRuntimeContext {
    const client = this.#requireClient();
    const token = this.#clientToken;
    if (!token) throw new Error("Codex App Server is unavailable");
    return { client, token, generation: this.#generation };
  }

  #assertSettingsContext(
    context: SettingsRuntimeContext,
    action: string,
  ): void {
    if (
      !this.#ready || context.client !== this.#client ||
      context.token !== this.#clientToken ||
      context.generation !== this.#generation
    ) {
      throw new Error(`Codex runtime changed while ${action}`);
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

  #trace(trace: CodexRuntimeTrace): void {
    if (!this.#onTrace) return;
    try {
      const result = this.#onTrace(trace);
      if (result instanceof Promise) void result.catch(() => {});
    } catch {
      // Trace callbacks are observational and cannot affect runtime routing.
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

function resolveDefaults(
  defaults: ConfigDefaults,
  models: readonly CodexModel[],
): CodexSettings {
  const selected = models.find(({ model }) => model === defaults.model) ??
    models.find(({ isDefault }) => isDefault) ?? models[0];
  if (!selected) throw new Error("Codex model catalog is empty");
  return {
    model: selected.model,
    effort: defaults.effort ?? selected.defaultReasoningEffort,
  };
}

function supportedEfforts(model: CodexModel): string[] {
  return model.supportedReasoningEfforts.map(({ reasoningEffort }) =>
    reasoningEffort
  );
}

function turnKey(threadId: string, turnId: string): string {
  return `${threadId}\u0000${turnId}`;
}

function turnIds(key: string): [threadId: string, turnId: string] {
  const delimiter = key.indexOf("\u0000");
  return [key.slice(0, delimiter), key.slice(delimiter + 1)];
}

function subagentDisplayName(record: SubagentRecord): string | undefined {
  const primaryName = record.agentNickname ?? record.name;
  if (primaryName) {
    return record.agentRole
      ? `${primaryName} (${record.agentRole})`
      : primaryName;
  }
  return record.agentRole;
}

function isTerminalSubagentStatus(status: SubagentStatus): boolean {
  return status === "cancelled" || status === "completed" ||
    status === "failed";
}

function subagentStatusLabel(status: SubagentStatus): string {
  switch (status) {
    case "starting":
      return "已启动";
    case "working":
      return "正在工作";
    case "cancelled":
      return "已取消";
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
  }
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
