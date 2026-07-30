import type { ActivityEvent } from "./activity-event.ts";
import { TurnOutputPipeline } from "./output-pipeline.ts";
import { buildCodexPrompt } from "./prompt.ts";
import {
  DEFAULT_OUTPUT_SETTINGS,
  type OutputSettings,
} from "./output-settings.ts";
import type {
  ChatType,
  ConversationKey,
  InboundMessage,
  InboundText,
} from "./wecom.ts";

export interface RoutedMessage extends InboundMessage {
  frame: unknown;
}

export interface RoutedText extends InboundText, RoutedMessage {}

export interface ConversationStateRecord {
  conversationKey: string;
  chatType: ChatType;
  threadId: string;
  activeTurnId: string | null;
  lastStatus: string | null;
  lastError: string | null;
}

export interface OrchestratorState {
  claimMessage(msgId: string, conversationKey: string): boolean;
  getConversation(
    conversationKey: string,
  ): ConversationStateRecord | null | undefined;
  bindConversation(
    conversationKey: string,
    chatType: ChatType,
    threadId: string,
  ): ConversationStateRecord;
  beginTurn(
    conversationKey: string,
    turnId: string,
  ): ConversationStateRecord;
  finishTurn(
    conversationKey: string,
    turnId: string,
    status: string,
    error?: string | null,
  ): ConversationStateRecord;
}

export interface TurnOutcome {
  status: string;
  finalAnswer?: string;
  error?: string | null;
}

export interface CodexTurnHandle {
  turnId: string;
  completion: Promise<TurnOutcome>;
}

export interface CodexPort {
  readonly ready: boolean;
  readonly generation: number;
  startThread(): Promise<string>;
  resumeThread(threadId: string): Promise<void>;
  startTurn(
    threadId: string,
    prompt: string,
    onActivity: (event: ActivityEvent) => void | Promise<void>,
  ): Promise<CodexTurnHandle>;
  interruptTurn(threadId: string, turnId: string): Promise<void>;
}

export interface ProgressHandle {
  append(text: string): void;
  finish(): Promise<void>;
}

export interface ChatOutput {
  send(message: RoutedMessage, text: string, final?: boolean): Promise<void>;
  startProgress(message: RoutedText): Promise<ProgressHandle>;
}

export interface ConversationOrchestratorOptions {
  state: OrchestratorState;
  codex: CodexPort;
  output: ChatOutput;
  workspace: string;
  outputSettings?: OutputSettings;
  onError?: (error: Error) => void;
  shutdownGraceMs?: number;
  interruptRetryDelaysMs?: readonly number[];
}

interface TurnControl {
  forceComplete: (outcome: TurnOutcome) => void;
  forceSignal: Promise<TurnOutcome>;
  forced: boolean;
}

interface ActiveTurn {
  threadId: string;
  turnId?: string;
  turnOutput: TurnOutput;
  control: TurnControl;
  shutdownRequested: boolean;
  interruptWhenReady: boolean;
  lateInterruptRequested: boolean;
}

interface TurnOutput {
  message: RoutedText;
  progress: ProgressHandle;
  pipeline: TurnOutputPipeline;
  activityTail: Promise<void>;
  acceptingActivities: boolean;
  finished: boolean;
  shutdownActivity?: ActivityEvent;
  shutdownHandled: boolean;
}

interface ConversationSlot {
  pending?: RoutedText;
  resetPending?: RoutedText;
  active?: ActiveTurn;
  control?: TurnControl;
  interruptRequested: boolean;
  interruptFailures: number;
  interruptRetryTimer?: ReturnType<typeof setTimeout>;
  drain?: Promise<void>;
}

const HELP = [
  "可用命令：",
  "- `/new`：中断当前任务并新建 Codex 会话",
  "- `/status`：查看当前聊天的绑定与运行状态",
  "- `/help`：显示本帮助",
].join("\n");

export class ConversationOrchestrator {
  readonly #state: OrchestratorState;
  readonly #codex: CodexPort;
  readonly #output: ChatOutput;
  readonly #workspace: string;
  readonly #outputSettings: OutputSettings;
  readonly #onError?: (error: Error) => void;
  readonly #shutdownGraceMs: number;
  readonly #interruptRetryDelaysMs: readonly number[];
  readonly #slots = new Map<ConversationKey, ConversationSlot>();
  readonly #loadedThreads = new Map<string, number>();
  #shuttingDown = false;

  constructor(options: ConversationOrchestratorOptions) {
    this.#state = options.state;
    this.#codex = options.codex;
    this.#output = options.output;
    this.#workspace = options.workspace;
    this.#outputSettings = options.outputSettings ?? DEFAULT_OUTPUT_SETTINGS;
    this.#onError = options.onError;
    this.#shutdownGraceMs = options.shutdownGraceMs ?? 30_000;
    this.#interruptRetryDelaysMs = options.interruptRetryDelaysMs ?? [
      1_000,
      2_000,
      4_000,
    ];
    if (
      !Number.isFinite(this.#shutdownGraceMs) || this.#shutdownGraceMs < 0
    ) {
      throw new RangeError("shutdownGraceMs must be a non-negative number");
    }
    if (
      this.#interruptRetryDelaysMs.some((delay) =>
        !Number.isFinite(delay) || delay < 0
      )
    ) {
      throw new RangeError(
        "interruptRetryDelaysMs must contain non-negative numbers",
      );
    }
  }

  async handleText(message: RoutedText): Promise<void> {
    if (this.#shuttingDown) return;
    if (!this.#state.claimMessage(message.msgId, message.conversationKey)) {
      return;
    }

    const command = message.text.trim();
    if (command === "/help") {
      await this.#output.send(message, HELP);
      return;
    }
    if (command === "/status") {
      await this.#output.send(message, this.#status(message.conversationKey));
      return;
    }
    if (!this.#codex.ready) {
      await this.#output.send(
        message,
        "Codex App Server 暂不可用，请稍后重试。",
      );
      return;
    }

    const slot = this.#slot(message.conversationKey);
    if (command === "/new") {
      slot.pending = undefined;
      slot.resetPending = message;
    } else if (slot.resetPending) {
      slot.pending = message;
    } else {
      slot.pending = message;
    }

    if (slot.active) this.#requestInterrupt(slot);
    if (!slot.drain) {
      slot.drain = this.#drain(message.conversationKey, slot).finally(() => {
        slot.drain = undefined;
      });
    }
    await slot.drain;
  }

  async handleUnsupported(
    message: RoutedMessage,
    messageType: string,
  ): Promise<void> {
    if (this.#shuttingDown) return;
    if (!this.#state.claimMessage(message.msgId, message.conversationKey)) {
      return;
    }
    await this.#output.send(
      message,
      `暂不支持 \`${messageType}\` 消息，请发送纯文本。`,
    );
  }

  async interruptAll(): Promise<void> {
    const drains: Promise<void>[] = [];
    this.#shuttingDown = true;
    for (const slot of this.#slots.values()) {
      this.#clearInterruptRetry(slot);
      slot.pending = undefined;
      slot.resetPending = undefined;
      if (slot.drain) drains.push(slot.drain);
      if (!slot.active) continue;
      this.#requestShutdown(slot);
    }
    if (drains.length === 0) return;

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), this.#shutdownGraceMs);
    });
    const drained = await Promise.race([
      Promise.all(drains).then(() => true as const),
      deadline,
    ]);
    if (timeout !== undefined) clearTimeout(timeout);
    if (drained) return;

    for (const slot of this.#slots.values()) {
      slot.control?.forceComplete({
        status: "runtime_lost",
        error: "shutdown grace period expired",
      });
    }
    await Promise.all(drains);
  }

  #slot(key: ConversationKey): ConversationSlot {
    let slot = this.#slots.get(key);
    if (!slot) {
      slot = { interruptRequested: false, interruptFailures: 0 };
      this.#slots.set(key, slot);
    }
    return slot;
  }

  async #drain(
    conversationKey: ConversationKey,
    slot: ConversationSlot,
  ): Promise<void> {
    while (slot.resetPending || slot.pending) {
      if (slot.resetPending) {
        const request = slot.resetPending;
        slot.resetPending = undefined;
        try {
          await this.#resetConversation(request);
        } catch {
          // Output failures must not strand already-claimed pending work.
        }
        continue;
      }

      const message = slot.pending!;
      slot.pending = undefined;
      const control = this.#createTurnControl();
      slot.control = control;
      try {
        await this.#runTurn(message, slot, control);
      } catch (error) {
        try {
          await this.#sendWithForce(
            control,
            message,
            `任务启动失败：${errorMessage(error)}`,
            true,
          );
        } catch {
          // Continue draining newer work when the fallback cannot be sent.
        }
      } finally {
        if (slot.active?.control === control) {
          this.#clearActive(slot, slot.active);
        }
        if (slot.control === control) slot.control = undefined;
      }
    }

    if (!slot.active && !slot.control && !slot.pending && !slot.resetPending) {
      this.#slots.delete(conversationKey);
    }
  }

  async #resetConversation(message: RoutedText): Promise<void> {
    let threadId: string;
    try {
      threadId = await this.#codex.startThread();
      this.#state.bindConversation(
        message.conversationKey,
        message.chatType,
        threadId,
      );
      this.#loadedThreads.set(threadId, this.#codex.generation);
    } catch (error) {
      await this.#output.send(
        message,
        `新建 Codex 会话失败：${errorMessage(error)}`,
        true,
      );
      return;
    }

    await this.#output.send(
      message,
      `已新建 Codex 会话。\n\n工作目录：\`${this.#workspace}\``,
    );
  }

  async #runTurn(
    message: RoutedText,
    slot: ConversationSlot,
    control: TurnControl,
  ): Promise<void> {
    const threadId = await this.#ensureThread(message);

    // A newer message that arrived while loading the thread wins before any
    // model work is started.
    if (this.#shuttingDown || slot.resetPending || slot.pending) return;

    const progress = await this.#output.startProgress(message);
    const turnOutput = this.#createTurnOutput(message, progress);
    try {
      await this.#enqueueActivity(turnOutput, {
        tag: "QUEUE",
        body: "已提交给 Codex",
        delivery: "progress",
      }, control);
    } catch (error) {
      await this.#finishTurnOutput(turnOutput);
      throw error;
    }
    const prompt = buildCodexPrompt({
      chatType: message.chatType,
      conversationKey: message.conversationKey,
      senderUserId: message.senderUserId,
      msgId: message.msgId,
      content: message.text,
    });

    const active: ActiveTurn = {
      threadId,
      turnOutput,
      control,
      shutdownRequested: false,
      interruptWhenReady: false,
      lateInterruptRequested: false,
    };
    slot.active = active;
    slot.interruptRequested = false;
    slot.interruptFailures = 0;
    if (this.#shuttingDown) {
      this.#requestShutdown(slot);
      control.forceComplete({
        status: "runtime_lost",
        error: "shutdown began before turn started",
      });
    }

    let start: Promise<CodexTurnHandle>;
    try {
      start = this.#codex.startTurn(
        threadId,
        prompt,
        (activity) => this.#enqueueActivity(turnOutput, activity, control),
      );
    } catch (error) {
      start = Promise.reject(error);
    }

    const startResult = await Promise.race([
      start.then(
        (handle) => ({ type: "handle" as const, handle }),
        (error) => ({ type: "error" as const, error }),
      ),
      control.forceSignal.then((outcome) => ({
        type: "forced" as const,
        outcome,
      })),
    ]);
    if (startResult.type === "forced") {
      this.#observeLateStart(active, start);
      try {
        await this.#finishTurnOutput(turnOutput, {
          tag: "TURN",
          body: startResult.outcome.status,
          delivery: "progress",
        }, control);
      } finally {
        this.#clearActive(slot, active);
      }
      return;
    }

    if (startResult.type === "error") {
      try {
        await this.#finishTurnOutput(turnOutput, undefined, control);
      } finally {
        this.#clearActive(slot, active);
      }
      throw startResult.error;
    }

    const handle = startResult.handle;

    active.turnId = handle.turnId;
    if (active.interruptWhenReady) this.#requestInterrupt(slot);
    if (control.forced) {
      void handle.completion.catch(() => undefined);
      const forcedOutcome = await control.forceSignal;
      try {
        await this.#finishTurnOutput(turnOutput, {
          tag: "TURN",
          body: forcedOutcome.status,
          delivery: "progress",
        }, control);
      } finally {
        this.#clearActive(slot, active);
      }
      return;
    }
    try {
      if (!active.shutdownRequested) {
        await this.#enqueueActivity(turnOutput, {
          tag: "TURN",
          body: "started",
          delivery: "progress",
        }, control);
      }
      this.#state.beginTurn(message.conversationKey, handle.turnId);
    } catch (error) {
      this.#requestInterrupt(slot);
      let interruptedOutcome: TurnOutcome;
      try {
        interruptedOutcome = await Promise.race([
          handle.completion,
          control.forceSignal,
        ]);
      } catch (completionError) {
        interruptedOutcome = {
          status: "failed",
          error: errorMessage(completionError),
        };
      }
      try {
        await this.#finishTurnOutput(turnOutput, {
          tag: "TURN",
          body: interruptedOutcome.status,
          delivery: "progress",
        }, control);
      } finally {
        this.#clearActive(slot, active);
      }
      void handle.completion.catch(() => undefined);
      throw error;
    }
    if (slot.resetPending || slot.pending) this.#requestInterrupt(slot);

    let outcome: TurnOutcome;
    try {
      outcome = await Promise.race([handle.completion, control.forceSignal]);
    } catch (error) {
      outcome = { status: "failed", error: errorMessage(error) };
    }

    try {
      await this.#finishTurnOutput(turnOutput, {
        tag: "TURN",
        body: outcome.status,
        delivery: "progress",
      }, control);
      try {
        this.#state.finishTurn(
          message.conversationKey,
          handle.turnId,
          outcome.status,
          outcome.error ?? null,
        );
      } catch (error) {
        this.#report(error);
      }
    } finally {
      this.#clearActive(slot, active);
    }

    const superseded = Boolean(slot.resetPending || slot.pending);
    if (
      outcome.status === "completed" && outcome.finalAnswer && !superseded &&
      !this.#shuttingDown
    ) {
      await this.#sendWithForce(control, message, outcome.finalAnswer, true);
    } else if (
      outcome.status === "failed" && !superseded && !this.#shuttingDown
    ) {
      await this.#sendWithForce(
        control,
        message,
        `Codex 执行失败：${outcome.error ?? "unknown error"}`,
        true,
      );
    }
  }

  #createTurnOutput(
    message: RoutedText,
    progress: ProgressHandle,
  ): TurnOutput {
    return {
      message,
      progress,
      pipeline: new TurnOutputPipeline(this.#outputSettings),
      activityTail: Promise.resolve(),
      acceptingActivities: true,
      finished: false,
      shutdownHandled: false,
    };
  }

  #createTurnControl(): TurnControl {
    const forced = Promise.withResolvers<TurnOutcome>();
    const control: TurnControl = {
      forceComplete: () => {},
      forceSignal: forced.promise,
      forced: false,
    };
    control.forceComplete = (outcome) => {
      if (control.forced) return;
      control.forced = true;
      forced.resolve(outcome);
    };
    return control;
  }

  async #sendWithForce(
    control: TurnControl,
    message: RoutedMessage,
    text: string,
    final = false,
  ): Promise<void> {
    if (control.forced) return;
    let send: Promise<void>;
    try {
      send = this.#output.send(message, text, final);
    } catch (error) {
      send = Promise.reject(error);
    }
    const result = await Promise.race([
      send.then(
        () => ({ type: "sent" as const }),
        (error) => ({ type: "error" as const, error }),
      ),
      control.forceSignal.then(() => ({ type: "forced" as const })),
    ]);
    if (result.type === "error") throw result.error;
  }

  #clearActive(slot: ConversationSlot, active: ActiveTurn): void {
    this.#clearInterruptRetry(slot);
    if (slot.active === active) slot.active = undefined;
    slot.interruptRequested = false;
    slot.interruptFailures = 0;
  }

  #enqueueActivity(
    turnOutput: TurnOutput,
    activity: ActivityEvent,
    control?: TurnControl,
  ): Promise<void> {
    if (
      control?.forced || !turnOutput.acceptingActivities ||
      turnOutput.finished
    ) {
      return Promise.resolve();
    }
    const result = turnOutput.activityTail.then(async () => {
      if (turnOutput.finished) return;
      await this.#dispatchActivity(turnOutput, activity);
    });
    turnOutput.activityTail = result.then(
      () => undefined,
      () => undefined,
    );
    if (!control) return result;
    return Promise.race([result, control.forceSignal.then(() => undefined)]);
  }

  async #dispatchActivity(
    turnOutput: TurnOutput,
    activity: ActivityEvent,
  ): Promise<void> {
    const rendered = turnOutput.pipeline.apply(activity);
    if (rendered === null) {
      if (activity.tag === "SHUTDOWN") turnOutput.shutdownHandled = true;
      return;
    }
    if (activity.delivery === "direct") {
      await this.#output.send(turnOutput.message, rendered);
    } else {
      turnOutput.progress.append(rendered);
    }
    if (activity.tag === "SHUTDOWN") turnOutput.shutdownHandled = true;
  }

  async #finishTurnOutput(
    turnOutput: TurnOutput,
    terminal?: ActivityEvent,
    control?: TurnControl,
  ): Promise<void> {
    if (turnOutput.finished) return;
    turnOutput.acceptingActivities = false;
    let forced = control?.forced ?? false;
    if (!forced && control) {
      forced = await Promise.race([
        turnOutput.activityTail.then(() => false),
        control.forceSignal.then(() => true),
      ]);
    } else if (!forced) {
      await turnOutput.activityTail;
    }
    if (
      (forced || control?.forced) && turnOutput.shutdownActivity &&
      !turnOutput.shutdownHandled
    ) {
      try {
        await this.#dispatchActivity(turnOutput, turnOutput.shutdownActivity);
      } catch (error) {
        this.#report(error);
      }
    }
    if (terminal) {
      try {
        await this.#dispatchActivity(turnOutput, terminal);
      } catch (error) {
        this.#report(error);
      }
    }
    try {
      await turnOutput.progress.finish();
    } catch {
      // Progress finish failures are already reported by ChatOutput.
    } finally {
      turnOutput.pipeline.clear();
      turnOutput.finished = true;
    }
  }

  async #ensureThread(message: RoutedText): Promise<string> {
    const existing = this.#state.getConversation(message.conversationKey);
    if (!existing) {
      const threadId = await this.#codex.startThread();
      this.#state.bindConversation(
        message.conversationKey,
        message.chatType,
        threadId,
      );
      this.#loadedThreads.set(threadId, this.#codex.generation);
      return threadId;
    }

    if (
      this.#loadedThreads.get(existing.threadId) !== this.#codex.generation
    ) {
      await this.#codex.resumeThread(existing.threadId);
      this.#loadedThreads.set(existing.threadId, this.#codex.generation);
    }
    return existing.threadId;
  }

  #requestShutdown(slot: ConversationSlot): void {
    const active = slot.active;
    if (!active) return;
    if (!active.shutdownRequested) {
      active.shutdownRequested = true;
      const activity: ActivityEvent = {
        tag: "SHUTDOWN",
        body: "shutting down",
        delivery: "progress",
      };
      active.turnOutput.shutdownActivity = activity;
      void this.#enqueueActivity(active.turnOutput, activity, active.control)
        .catch((error) => this.#report(error));
    }
    this.#requestInterrupt(slot);
  }

  #observeLateStart(
    active: ActiveTurn,
    start: Promise<CodexTurnHandle>,
  ): void {
    void start.then(
      (handle) => {
        void handle.completion.catch(() => undefined);
        if (
          !active.interruptWhenReady || active.lateInterruptRequested
        ) return;
        active.lateInterruptRequested = true;
        void this.#codex.interruptTurn(active.threadId, handle.turnId)
          .catch((error) => this.#report(error));
      },
      () => undefined,
    );
  }

  #requestInterrupt(slot: ConversationSlot): void {
    const active = slot.active;
    if (!active) return;
    if (!active.turnId) {
      active.interruptWhenReady = true;
      return;
    }
    if (slot.interruptRequested) return;
    this.#clearInterruptRetry(slot);
    slot.interruptRequested = true;
    const turnId = active.turnId;
    void this.#codex.interruptTurn(active.threadId, turnId).catch(
      (error) => {
        void this.#enqueueActivity(active.turnOutput, {
          tag: "ERROR",
          body: `interrupt failed: ${errorMessage(error)}`,
          delivery: "progress",
        }, active.control).catch((activityError) =>
          this.#report(activityError)
        );
        if (slot.active !== active) return;
        slot.interruptRequested = false;
        if (this.#shuttingDown || (!slot.pending && !slot.resetPending)) return;

        const delay = this.#interruptRetryDelaysMs[slot.interruptFailures++];
        if (delay === undefined) return;
        slot.interruptRetryTimer = setTimeout(() => {
          slot.interruptRetryTimer = undefined;
          this.#requestInterrupt(slot);
        }, delay);
      },
    );
  }

  #clearInterruptRetry(slot: ConversationSlot): void {
    if (slot.interruptRetryTimer === undefined) return;
    clearTimeout(slot.interruptRetryTimer);
    slot.interruptRetryTimer = undefined;
  }

  #report(value: unknown): void {
    const error = value instanceof Error ? value : new Error(String(value));
    try {
      this.#onError?.(error);
    } catch {
      // Error reporting must not break conversation draining.
    }
  }

  #status(conversationKey: ConversationKey): string {
    const record = this.#state.getConversation(conversationKey);
    const slot = this.#slots.get(conversationKey);
    return [
      `conversation: \`${conversationKey}\``,
      `thread: \`${record?.threadId ?? "not bound"}\``,
      `codex: ${this.#codex.ready ? "ready" : "unavailable"}`,
      `turn: ${slot?.active ? "in_progress" : record?.lastStatus ?? "idle"}`,
      `queued: ${slot?.pending || slot?.resetPending ? "yes" : "no"}`,
      record?.lastError ? `last_error: ${record.lastError}` : "",
    ].filter(Boolean).join("\n");
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
