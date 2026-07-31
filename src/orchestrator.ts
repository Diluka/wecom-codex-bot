import type { ActivityEvent } from "./activity-event.ts";
import { summarizeRequest } from "./log.ts";
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
  detach(): void;
}

export interface ChatOutput {
  send(message: RoutedMessage, text: string, final?: boolean): Promise<void>;
  startProgress(message: RoutedText): Promise<ProgressHandle>;
}

export type RequestStatus =
  | "received"
  | "duplicate_ignored"
  | "runtime_unavailable"
  | "shutdown_discarded"
  | "queued"
  | "superseded"
  | "thread_starting"
  | "thread_started"
  | "thread_resuming"
  | "thread_resumed"
  | "thread_ready"
  | "turn_starting"
  | "running"
  | "interrupt_requested"
  | "turn_completed"
  | "reply_sending"
  | "reply_sent"
  | "reply_skipped"
  | "completed"
  | "failed"
  | "interrupted"
  | "runtime_lost";

export interface RequestStatusEvent {
  state: RequestStatus;
  chatType: ChatType;
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
  activeCount: number;
  pendingCount: number;
}

export interface ConversationOrchestratorOptions {
  state: OrchestratorState;
  codex: CodexPort;
  output: ChatOutput;
  workspace: string;
  outputSettings?: OutputSettings;
  onError?: (error: Error) => void;
  onRequestStatus?: (event: RequestStatusEvent) => void;
  now?: () => number;
  summarizeRequest?: (text: string) => string;
  shutdownGraceMs?: number;
  interruptRetryDelaysMs?: readonly number[];
}

interface TurnControl {
  forceComplete: (outcome: TurnOutcome) => void;
  forceSignal: Promise<TurnOutcome>;
  forced: boolean;
}

type ForceRaceResult<T> =
  | { type: "value"; value: T }
  | { type: "error"; error: unknown }
  | { type: "forced" };

type SendWithForceResult = "sent" | "forced";
type RequestPhase = "pre_turn" | "turn" | "reply";

interface ActiveTurn {
  threadId: string;
  turnId?: string;
  trace: RequestTrace;
  turnOutput: TurnOutput;
  control: TurnControl;
  shutdownRequested: boolean;
  interruptWhenReady: boolean;
  lateInterruptRequested: boolean;
  interruptStatusEmitted: boolean;
}

interface RequestTrace {
  message: RoutedText;
  startedAt: number;
  threadId?: string;
  turnId?: string;
  phase: RequestPhase;
  terminal: boolean;
}

interface TurnOutput {
  message: RoutedText;
  progress: ProgressHandle;
  progressWritten: boolean;
  progressEndsWithLineBreak: boolean;
  pipeline: TurnOutputPipeline;
  activityTail: Promise<void>;
  acceptingActivities: boolean;
  finished: boolean;
  shutdownActivity?: ActivityEvent;
  shutdownHandled: boolean;
}

interface ConversationSlot {
  pending?: RequestTrace;
  current?: RequestTrace;
  resetPending?: RoutedText;
  active?: ActiveTurn;
  control?: TurnControl;
  interruptRequested: boolean;
  interruptFailures: number;
  interruptRetryTimer?: ReturnType<typeof setTimeout>;
  drain?: Promise<void>;
}

interface RequestStatusDetails {
  replacedByMsgId?: string;
  triggerMsgId?: string;
  reason?: string;
  error?: unknown;
}

const TERMINAL_REQUEST_STATUSES = new Set<RequestStatus>([
  "duplicate_ignored",
  "shutdown_discarded",
  "superseded",
  "completed",
  "failed",
  "interrupted",
  "runtime_lost",
]);

function isSupersedable(trace?: RequestTrace): trace is RequestTrace {
  return Boolean(trace && !trace.terminal && trace.phase === "pre_turn");
}

function isInterruptible(active?: ActiveTurn): active is ActiveTurn {
  return Boolean(
    active && !active.trace.terminal && active.trace.phase === "turn",
  );
}

const HELP = [
  "可用命令：",
  "- `/new`：中断当前任务并新建 Codex 会话",
  "- `/status`：查看当前聊天的绑定与运行状态",
  "- `/help`：显示本帮助",
].join("\n");

/** Serializes each conversation's Codex turns, state changes, and output. */
export class ConversationOrchestrator {
  readonly #state: OrchestratorState;
  readonly #codex: CodexPort;
  readonly #output: ChatOutput;
  readonly #workspace: string;
  readonly #outputSettings: OutputSettings;
  readonly #onError?: (error: Error) => void;
  readonly #onRequestStatus?: (event: RequestStatusEvent) => void;
  readonly #now: () => number;
  readonly #summarizeRequest: (text: string) => string;
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
    this.#onRequestStatus = options.onRequestStatus;
    this.#now = options.now ?? Date.now;
    this.#summarizeRequest = options.summarizeRequest ?? summarizeRequest;
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
    const command = message.text.trim();
    if (command === "/help" || command === "/status" || command === "/new") {
      if (this.#shuttingDown) return;
      if (!this.#state.claimMessage(message.msgId, message.conversationKey)) {
        return;
      }
      if (command === "/help") {
        await this.#output.send(message, HELP);
        return;
      }
      if (command === "/status") {
        await this.#output.send(message, this.#status(message.conversationKey));
        return;
      }
    } else {
      const trace = this.#createRequestTrace(message);
      this.#emitRequestStatus(trace, "received");
      if (this.#shuttingDown) {
        this.#emitRequestStatus(trace, "shutdown_discarded", {
          reason: "shutdown",
        });
        return;
      }
      if (!this.#state.claimMessage(message.msgId, message.conversationKey)) {
        this.#emitRequestStatus(trace, "duplicate_ignored");
        return;
      }
      if (!this.#codex.ready) {
        this.#emitRequestStatus(trace, "runtime_unavailable");
        await this.#sendRequestReply(
          trace,
          () =>
            this.#output.send(
              message,
              "Codex App Server 暂不可用，请稍后重试。",
            ),
        );
        this.#emitRequestStatus(trace, "completed", {
          reason: "runtime_unavailable",
        });
        return;
      }

      const slot = this.#slot(message.conversationKey);
      const superseded = slot.pending ??
        (isSupersedable(slot.current) ? slot.current : undefined);
      slot.pending = trace;
      if (superseded) {
        this.#emitRequestStatus(superseded, "superseded", {
          replacedByMsgId: message.msgId,
        });
      }
      this.#emitRequestStatus(trace, "queued");
      if (isInterruptible(slot.active)) {
        this.#requestInterrupt(slot, message.msgId);
      }
      if (!slot.drain) {
        slot.drain = this.#drain(message.conversationKey, slot).finally(() => {
          slot.drain = undefined;
        });
      }
      await slot.drain;
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
      const superseded = slot.pending ??
        (isSupersedable(slot.current) ? slot.current : undefined);
      slot.pending = undefined;
      slot.resetPending = message;
      if (superseded) {
        this.#emitRequestStatus(superseded, "superseded", {
          reason: "reset",
        });
      }
    }

    if (isInterruptible(slot.active)) this.#requestInterrupt(slot);
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
      const pending = slot.pending;
      const current = isSupersedable(slot.current) ? slot.current : undefined;
      slot.pending = undefined;
      slot.resetPending = undefined;
      if (pending) {
        this.#emitRequestStatus(pending, "shutdown_discarded", {
          reason: "shutdown",
        });
      }
      if (current) {
        this.#emitRequestStatus(current, "shutdown_discarded", {
          reason: "shutdown",
        });
      }
      if (slot.drain) drains.push(slot.drain);
      if (!isInterruptible(slot.active)) continue;
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
        const control = this.#createTurnControl();
        slot.control = control;
        try {
          await this.#resetConversation(request, control);
        } catch {
          // Output failures must not strand already-claimed pending work.
        } finally {
          if (slot.control === control) slot.control = undefined;
        }
        continue;
      }

      const trace = slot.pending!;
      slot.pending = undefined;
      slot.current = trace;
      const control = this.#createTurnControl();
      slot.control = control;
      try {
        await this.#runTurn(trace, slot, control);
      } catch (error) {
        if (!trace.terminal) {
          const failure = errorMessage(error);
          try {
            await this.#sendRequestWithForce(
              control,
              trace,
              `任务启动失败：${failure}`,
              true,
            );
          } catch {
            // Continue draining newer work when the fallback cannot be sent.
          }
          this.#emitRequestStatus(trace, "failed", { error: failure });
        }
      } finally {
        if (slot.active?.control === control) {
          this.#clearActive(slot, slot.active);
        }
        if (slot.control === control) slot.control = undefined;
        if (slot.current === trace) slot.current = undefined;
      }
    }

    if (
      !slot.active && !slot.control && !slot.current && !slot.pending &&
      !slot.resetPending
    ) {
      this.#slots.delete(conversationKey);
    }
  }

  async #resetConversation(
    message: RoutedText,
    control: TurnControl,
  ): Promise<void> {
    try {
      const started = await this.#startAndBindThread(message, control);
      if (started === undefined) return;
    } catch (error) {
      await this.#sendWithForce(
        control,
        message,
        `新建 Codex 会话失败：${errorMessage(error)}`,
        true,
      );
      return;
    }

    await this.#sendWithForce(
      control,
      message,
      `已新建 Codex 会话。\n\n工作目录：\`${this.#workspace}\``,
    );
  }

  async #runTurn(
    trace: RequestTrace,
    slot: ConversationSlot,
    control: TurnControl,
  ): Promise<void> {
    const message = trace.message;
    const threadId = await this.#ensureThread(trace, control);
    if (threadId === undefined) return;

    // A newer message that arrived while loading the thread wins before any
    // model work is started.
    if (this.#shuttingDown || slot.resetPending || slot.pending) return;

    const progress = await this.#output.startProgress(message);
    const turnOutput = this.#createTurnOutput(message, progress);
    if (
      trace.terminal || this.#shuttingDown || slot.resetPending || slot.pending
    ) {
      await this.#finishTurnOutput(turnOutput, undefined, control);
      return;
    }
    try {
      await this.#enqueueActivity(turnOutput, {
        tag: "QUEUE",
        body: "已提交给 Codex",
        delivery: "progress",
      }, control);
    } catch (error) {
      await this.#finishTurnOutput(turnOutput, undefined, control);
      throw error;
    }
    if (
      trace.terminal || this.#shuttingDown || slot.resetPending || slot.pending
    ) {
      await this.#finishTurnOutput(turnOutput, undefined, control);
      return;
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
      trace,
      turnOutput,
      control,
      shutdownRequested: false,
      interruptWhenReady: false,
      lateInterruptRequested: false,
      interruptStatusEmitted: false,
    };
    trace.phase = "turn";
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
    this.#emitRequestStatus(trace, "turn_starting");
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
      trace.phase = "reply";
      this.#observeLateStart(active, start);
      try {
        await this.#finishTurnOutput(turnOutput, {
          tag: "TURN",
          body: startResult.outcome.status,
          delivery: "progress",
        }, control);
      } finally {
        this.#clearActive(slot, active);
        this.#emitForcedOutcome(trace, startResult.outcome);
      }
      return;
    }

    if (startResult.type === "error") {
      trace.phase = "reply";
      try {
        await this.#finishTurnOutput(turnOutput, undefined, control);
      } finally {
        this.#clearActive(slot, active);
      }
      throw startResult.error;
    }

    const handle = startResult.handle;

    active.turnId = handle.turnId;
    trace.turnId = handle.turnId;
    if (active.interruptWhenReady) this.#requestInterrupt(slot);
    if (control.forced) {
      trace.phase = "reply";
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
        this.#emitForcedOutcome(trace, forcedOutcome);
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
      this.#emitRequestStatus(trace, "running");
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
      trace.phase = "reply";
      this.#emitRequestStatus(trace, "turn_completed", {
        reason: interruptedOutcome.status,
        ...(interruptedOutcome.error
          ? { error: interruptedOutcome.error }
          : {}),
      });
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
    trace.phase = "reply";
    const superseded = Boolean(slot.resetPending || slot.pending);
    this.#emitRequestStatus(trace, "turn_completed", {
      reason: outcome.status,
      ...(outcome.error ? { error: outcome.error } : {}),
    });

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

    if (
      outcome.status === "completed" && outcome.finalAnswer && !superseded &&
      !this.#shuttingDown
    ) {
      await this.#sendRequestWithForce(
        control,
        trace,
        outcome.finalAnswer,
        true,
      );
    } else if (
      outcome.status === "failed" && !superseded && !this.#shuttingDown
    ) {
      await this.#sendRequestWithForce(
        control,
        trace,
        `Codex 执行失败：${outcome.error ?? "unknown error"}`,
        true,
      );
    } else {
      const reason = superseded
        ? "superseded"
        : this.#shuttingDown
        ? "shutdown"
        : outcome.status === "completed"
        ? "no_final_answer"
        : outcome.status;
      this.#emitRequestStatus(trace, "reply_skipped", { reason });
    }
    this.#emitRequestStatus(
      trace,
      outcomeRequestStatus(outcome.status),
      outcome.error ? { error: outcome.error } : {},
    );
  }

  #createTurnOutput(
    message: RoutedText,
    progress: ProgressHandle,
  ): TurnOutput {
    return {
      message,
      progress,
      progressWritten: false,
      progressEndsWithLineBreak: false,
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

  async #raceWithForce<T>(
    operation: () => Promise<T>,
    control: TurnControl,
  ): Promise<ForceRaceResult<T>> {
    let pending: Promise<T>;
    try {
      pending = Promise.resolve(operation());
    } catch (error) {
      pending = Promise.reject(error);
    }
    return await Promise.race([
      pending.then(
        (value) => ({ type: "value" as const, value }),
        (error) => ({ type: "error" as const, error }),
      ),
      control.forceSignal.then(() => ({ type: "forced" as const })),
    ]);
  }

  async #sendWithForce(
    control: TurnControl,
    message: RoutedMessage,
    text: string,
    final = false,
  ): Promise<SendWithForceResult> {
    if (control.forced) return "forced";
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
    return result.type;
  }

  async #sendRequestWithForce(
    control: TurnControl,
    trace: RequestTrace,
    text: string,
    final = false,
  ): Promise<void> {
    trace.phase = "reply";
    if (control.forced) {
      this.#emitRequestStatus(trace, "reply_skipped", {
        reason: "shutdown",
      });
      return;
    }
    this.#emitRequestStatus(trace, "reply_sending");
    let result: SendWithForceResult;
    try {
      result = await this.#sendWithForce(
        control,
        trace.message,
        text,
        final,
      );
    } catch (error) {
      this.#emitRequestStatus(trace, "failed", {
        error: errorMessage(error),
      });
      throw error;
    }
    if (result === "forced") {
      this.#emitRequestStatus(trace, "reply_skipped", {
        reason: "shutdown",
      });
    } else {
      this.#emitRequestStatus(trace, "reply_sent");
    }
  }

  async #sendRequestReply(
    trace: RequestTrace,
    send: () => Promise<void>,
  ): Promise<void> {
    trace.phase = "reply";
    this.#emitRequestStatus(trace, "reply_sending");
    try {
      await send();
    } catch (error) {
      this.#emitRequestStatus(trace, "failed", {
        error: errorMessage(error),
      });
      throw error;
    }
    this.#emitRequestStatus(trace, "reply_sent");
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
      if (
        turnOutput.finished ||
        (control?.forced && !turnOutput.acceptingActivities)
      ) return;
      await this.#dispatchActivity(turnOutput, activity, control);
    });
    turnOutput.activityTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #dispatchActivity(
    turnOutput: TurnOutput,
    activity: ActivityEvent,
    control?: TurnControl,
  ): Promise<void> {
    const rendered = turnOutput.pipeline.apply(activity);
    if (rendered === null) {
      if (activity.tag === "SHUTDOWN") turnOutput.shutdownHandled = true;
      return;
    }
    if (activity.delivery === "direct") {
      if (control) {
        await this.#sendWithForce(control, turnOutput.message, rendered);
      } else {
        await this.#output.send(turnOutput.message, rendered);
      }
    } else {
      const startsWithLineBreak = rendered.startsWith("\n") ||
        rendered.startsWith("\r");
      if (
        turnOutput.progressWritten &&
        !turnOutput.progressEndsWithLineBreak &&
        !startsWithLineBreak
      ) {
        turnOutput.progress.append("\n");
      }
      turnOutput.progress.append(rendered);
      turnOutput.progressWritten = true;
      turnOutput.progressEndsWithLineBreak = rendered.endsWith("\n") ||
        rendered.endsWith("\r");
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
        await this.#dispatchActivity(
          turnOutput,
          turnOutput.shutdownActivity,
          control,
        );
      } catch (error) {
        this.#report(error);
      }
    }
    if (terminal) {
      try {
        await this.#dispatchActivity(turnOutput, terminal, control);
      } catch (error) {
        this.#report(error);
      }
    }
    let finish: Promise<void>;
    try {
      finish = Promise.resolve(turnOutput.progress.finish());
    } catch (error) {
      finish = Promise.reject(error);
    }
    if (control) {
      const finishResult = await Promise.race([
        finish.then(
          () => "finished" as const,
          () => "finished" as const,
        ),
        control.forceSignal.then(() => "forced" as const),
      ]);
      if (finishResult === "forced") {
        try {
          turnOutput.progress.detach();
        } catch (error) {
          this.#report(error);
        }
      }
    } else {
      try {
        await finish;
      } catch {
        // Progress finish failures are already reported by ChatOutput.
      }
    }
    try {
      turnOutput.pipeline.clear();
    } finally {
      turnOutput.finished = true;
    }
  }

  async #startAndBindThread(
    message: RoutedText,
    control: TurnControl,
    trace?: RequestTrace,
  ): Promise<string | undefined> {
    if (trace) this.#emitRequestStatus(trace, "thread_starting");
    const started = await this.#raceWithForce(
      () => this.#codex.startThread(),
      control,
    );
    if (
      started.type === "forced" || control.forced || this.#shuttingDown
    ) return undefined;
    if (started.type === "error") throw started.error;

    if (trace) {
      trace.threadId = started.value;
      this.#emitRequestStatus(trace, "thread_started");
    }
    this.#state.bindConversation(
      message.conversationKey,
      message.chatType,
      started.value,
    );
    this.#loadedThreads.set(started.value, this.#codex.generation);
    return started.value;
  }

  async #ensureThread(
    trace: RequestTrace,
    control: TurnControl,
  ): Promise<string | undefined> {
    const message = trace.message;
    const existing = this.#state.getConversation(message.conversationKey);
    if (!existing) {
      const threadId = await this.#startAndBindThread(message, control, trace);
      if (threadId !== undefined) {
        this.#emitRequestStatus(trace, "thread_ready");
      }
      return threadId;
    }

    trace.threadId = existing.threadId;
    if (
      this.#loadedThreads.get(existing.threadId) !== this.#codex.generation
    ) {
      this.#emitRequestStatus(trace, "thread_resuming");
      const resumed = await this.#raceWithForce(
        () => this.#codex.resumeThread(existing.threadId),
        control,
      );
      if (
        resumed.type === "forced" || control.forced || this.#shuttingDown
      ) return undefined;
      if (resumed.type === "error") throw resumed.error;
      this.#emitRequestStatus(trace, "thread_resumed");
      this.#loadedThreads.set(existing.threadId, this.#codex.generation);
    }
    this.#emitRequestStatus(trace, "thread_ready");
    return existing.threadId;
  }

  #createRequestTrace(message: RoutedText): RequestTrace {
    return {
      message,
      startedAt: this.#now(),
      phase: "pre_turn",
      terminal: false,
    };
  }

  #emitForcedOutcome(trace: RequestTrace, outcome: TurnOutcome): void {
    this.#emitRequestStatus(trace, "reply_skipped", { reason: "shutdown" });
    this.#emitRequestStatus(
      trace,
      outcomeRequestStatus(outcome.status),
      outcome.error ? { error: outcome.error } : {},
    );
  }

  #emitRequestStatus(
    trace: RequestTrace,
    state: RequestStatus,
    details: RequestStatusDetails = {},
  ): void {
    if (trace.terminal) return;
    const terminal = TERMINAL_REQUEST_STATUSES.has(state);
    if (terminal) trace.terminal = true;
    const counts = this.#requestCounts();
    let summary: string | undefined;
    if (state === "received") {
      try {
        summary = this.#summarizeRequest(trace.message.text);
      } catch {
        // Request observation must not alter conversation processing.
      }
    }
    const event: RequestStatusEvent = {
      state,
      chatType: trace.message.chatType,
      chatId: trace.message.chatId,
      userId: trace.message.senderUserId,
      msgId: trace.message.msgId,
      ...(summary !== undefined ? { summary } : {}),
      ...(trace.threadId ? { threadId: trace.threadId } : {}),
      ...(trace.turnId ? { turnId: trace.turnId } : {}),
      ...details,
      ...(terminal
        ? { elapsedMs: Math.max(0, this.#now() - trace.startedAt) }
        : {}),
      activeCount: counts.active,
      pendingCount: counts.pending,
    };
    try {
      this.#onRequestStatus?.(event);
    } catch {
      // Logging callbacks are isolated from the request drain.
    }
  }

  #requestCounts(): { active: number; pending: number } {
    let active = 0;
    let pending = 0;
    for (const slot of this.#slots.values()) {
      const activeTrace = slot.current ?? slot.active?.trace;
      if (activeTrace && !activeTrace.terminal) active++;
      if (slot.pending || slot.resetPending) pending++;
    }
    return { active, pending };
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

  #requestInterrupt(slot: ConversationSlot, triggerMsgId?: string): void {
    const active = slot.active;
    if (!active) return;
    if (!active.interruptStatusEmitted) {
      active.interruptStatusEmitted = true;
      this.#emitRequestStatus(active.trace, "interrupt_requested", {
        ...(triggerMsgId ? { triggerMsgId } : {}),
      });
    }
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

function outcomeRequestStatus(status: string): RequestStatus {
  switch (status) {
    case "completed":
    case "failed":
    case "interrupted":
    case "runtime_lost":
      return status;
    default:
      return "failed";
  }
}
