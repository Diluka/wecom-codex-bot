import type { ActivityEvent } from "./activity-event.ts";
import type { CodexTurnInput, CodexTurnOptions } from "./codex-turn.ts";
import {
  type ImageLease,
  ImagePreparationError,
  type ImagePreparer,
} from "./image-temp-store.ts";
import {
  classifyRequestAuthority,
  normalizeOwnerUserId,
  type RequestAuthority,
} from "./owner-policy.ts";
import { summarizeRequest } from "./log.ts";
import type {
  ModelSettingsSnapshot,
  ModelSettingsUpdateResult,
} from "./model-settings.ts";
import {
  type OutputDecisionReason,
  TurnOutputPipeline,
} from "./output-pipeline.ts";
import { buildCodexTurnInput } from "./prompt.ts";
import {
  DEFAULT_OUTPUT_SETTINGS,
  type OutputSettings,
} from "./output-settings.ts";
import type { ProgressTail } from "./progress-tail.ts";
import type {
  ChatType,
  ConversationKey,
  InboundImageReference,
  InboundMessage,
  InboundText,
  InboundUserMessage,
} from "./wecom.ts";

export interface RoutedMessage extends InboundMessage {
  frame: unknown;
}

export type RoutedUserMessage = InboundUserMessage & RoutedMessage;
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
  getModelSettings(threadId?: string): Promise<ModelSettingsSnapshot>;
  setModel(
    threadId: string | undefined,
    model: string,
  ): Promise<ModelSettingsUpdateResult>;
  setEffort(
    threadId: string | undefined,
    effort: string,
  ): Promise<ModelSettingsUpdateResult>;
  startTurn(
    threadId: string,
    input: CodexTurnInput,
    authority: RequestAuthority,
    onActivity: (event: ActivityEvent) => void | Promise<void>,
    options?: CodexTurnOptions,
  ): Promise<CodexTurnHandle>;
  interruptTurn(threadId: string, turnId: string): Promise<void>;
}

export interface ProgressHandle {
  append(text: string, progressTail?: ProgressTail): void;
  finish(): Promise<void>;
  detach(): void;
}

export interface ChatOutput {
  send(message: RoutedMessage, text: string, final?: boolean): Promise<void>;
  startProgress(message: RoutedMessage): Promise<ProgressHandle>;
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
  imagePreparer: ImagePreparer;
  workspace: string;
  ownerUserId?: string;
  outputSettings?: OutputSettings;
  groupOutputSettings?: OutputSettings;
  onError?: (error: Error) => void;
  onRequestStatus?: (event: RequestStatusEvent) => void;
  onOutputDecision?: (event: OutputDecisionEvent) => void;
  now?: () => number;
  messageDebounceTimers?: OrchestratorTimerApi;
  shutdownGraceMs?: number;
  interruptRetryDelaysMs?: readonly number[];
}

export interface OutputDecisionEvent {
  tag: ActivityEvent["tag"];
  delivery: ActivityEvent["delivery"];
  threadId?: string;
  turnId?: string;
  disposition: "rendered" | "suppressed";
  reason: OutputDecisionReason;
}

export interface OrchestratorTimerApi {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

interface TurnControl {
  forceComplete: (outcome: TurnOutcome) => void;
  forceSignal: Promise<TurnOutcome>;
  forced: boolean;
  forcedOutcome?: TurnOutcome;
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
  request: PendingRequest;
  turnOutput: TurnOutput;
  control: TurnControl;
  shutdownRequested: boolean;
  stopRequested: boolean;
  interruptWhenReady: boolean;
  lateInterruptRequested: boolean;
  interruptStatusEmitted: boolean;
}

interface RequestTrace {
  message: RoutedUserMessage;
  startedAt: number;
  threadId?: string;
  turnId?: string;
  phase: RequestPhase;
  terminal: boolean;
}

interface PendingMessage {
  readonly message: RoutedUserMessage;
  readonly contentImages: readonly PendingImage[];
  readonly quoteImages: readonly PendingImage[];
}

interface PendingRequest {
  message: RoutedUserMessage;
  messages: PendingMessage[];
  traces: RequestTrace[];
  settingsBarrier: Promise<void>;
}

interface DebounceBatch {
  messages: PendingMessage[];
  traces: RequestTrace[];
  settingsBarrier: Promise<void>;
  timer?: unknown;
  completion: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface TurnOutput {
  message: RoutedUserMessage;
  progress: ProgressHandle;
  pipeline: TurnOutputPipeline;
  activityTail: Promise<void>;
  acceptingActivities: boolean;
  finished: boolean;
  shutdownActivity?: ActivityEvent;
  shutdownHandled: boolean;
}

interface ConversationSlot {
  debounce?: DebounceBatch;
  pending?: PendingRequest;
  current?: PendingRequest;
  resetPending?: ResetRequest;
  active?: ActiveTurn;
  control?: TurnControl;
  interruptRequested: boolean;
  interruptFailures: number;
  interruptRetryTimer?: ReturnType<typeof setTimeout>;
  drain?: Promise<void>;
}

interface ResetRequest {
  message: RoutedText;
  settingsBarrier: Promise<void>;
}

interface RequestStatusDetails {
  replacedByMsgId?: string;
  triggerMsgId?: string;
  reason?: string;
  error?: unknown;
}

interface PreparedRequestImages {
  readonly input: CodexTurnInput;
  readonly leases: readonly ImageLease[];
}

type SettingsCommand =
  | { kind: "model"; value?: string; valid: boolean }
  | { kind: "effort"; value?: string; valid: boolean };

const TERMINAL_REQUEST_STATUSES = new Set<RequestStatus>([
  "duplicate_ignored",
  "shutdown_discarded",
  "superseded",
  "completed",
  "failed",
  "interrupted",
  "runtime_lost",
]);
const MESSAGE_DEBOUNCE_MS = 3_000;

class PendingImage {
  readonly #controller = new AbortController();
  readonly result: Promise<ImageLease>;
  #lease?: ImageLease;
  #released = false;

  constructor(
    preparer: ImagePreparer,
    reference: InboundImageReference,
  ) {
    this.result = preparer.prepare(reference, this.#controller.signal)
      .then((lease) => {
        this.#lease = lease;
        return lease;
      });
    void this.result.catch(() => undefined);
  }

  cancel(): void {
    this.#controller.abort();
  }

  async release(): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    this.cancel();
    await this.#lease?.release();
  }
}

function hasLiveTraces(request?: PendingRequest): request is PendingRequest {
  return Boolean(request?.traces.some((trace) => !trace.terminal));
}

function isSupersedable(request?: PendingRequest): request is PendingRequest {
  return Boolean(
    hasLiveTraces(request) &&
      request.traces.every((trace) =>
        trace.terminal || trace.phase === "pre_turn"
      ),
  );
}

function isInterruptible(active?: ActiveTurn): active is ActiveTurn {
  return Boolean(
    active && hasLiveTraces(active.request) &&
      active.request.traces.every((trace) =>
        trace.terminal || trace.phase === "turn"
      ),
  );
}

function settingsCommand(text: string): SettingsCommand | undefined {
  const parts = text.trim().split(/\s+/);
  if (parts[0] !== "/model" && parts[0] !== "/effort") return undefined;
  return {
    kind: parts[0] === "/model" ? "model" : "effort",
    ...(parts.length === 2 ? { value: parts[1] } : {}),
    valid: parts.length <= 2,
  };
}

function modelHelp(snapshot: ModelSettingsSnapshot): string {
  return [
    `当前模型：\`${snapshot.settings.model}\``,
    `可选模型：${
      snapshot.models.map(({ model }) => `\`${model}\``).join("、")
    }`,
    "用法：`/model <model-id>`",
  ].join("\n");
}

function effortHelp(snapshot: ModelSettingsSnapshot): string {
  if (!snapshot.selectedModel) {
    return [
      `当前推理强度：\`${snapshot.settings.effort ?? "default"}\``,
      `当前模型 \`${snapshot.settings.model}\` 不在模型目录中，无法显示或校验支持的推理强度。`,
      "用法：`/effort <level>`",
    ].join("\n");
  }
  const efforts = snapshot.selectedModel.supportedReasoningEfforts
    .map(({ reasoningEffort }) => `\`${reasoningEffort}\``)
    .join("、");
  return [
    `当前推理强度：\`${snapshot.settings.effort ?? "default"}\``,
    `当前模型支持：${efforts}`,
    "用法：`/effort <level>`",
  ].join("\n");
}

function codeList(values: readonly string[]): string {
  return values.map((value) => `\`${value}\``).join("、");
}

function settingsUpdateReply(
  result: ModelSettingsUpdateResult,
  activeTurn: boolean,
): string {
  if (result.status === "invalid_model") {
    return `未知模型。可选模型：${codeList(result.availableModels)}`;
  }
  if (result.status === "invalid_effort") {
    if (result.availableEfforts.length === 0) {
      return `模型 \`${result.model}\` 不在模型目录中，无法校验或修改推理强度。请先用 \`/model <model-id>\` 切换到目录中的模型。`;
    }
    return `模型 \`${result.model}\` 不支持该强度。可选强度：${
      codeList(result.availableEfforts)
    }`;
  }
  if (!result.defaultPersisted && !result.threadUpdated) {
    return `设置未修改：${result.persistenceError ?? "全局默认保存失败"}`;
  }

  const settings = `模型 \`${result.settings.model}\`，推理强度 \`${
    result.settings.effort ?? "default"
  }\``;
  const lines = result.threadUpdated
    ? [`当前 thread 已切换：${settings}。`]
    : [`全局默认值已保存：${settings}。`];
  if (result.effortAdjusted) {
    lines.push(
      `模型切换后，推理强度已自动调整为 \`${
        result.settings.effort ?? "default"
      }\`。`,
    );
  }
  if (result.threadUpdated) {
    lines.push(
      result.defaultPersisted
        ? "已保存为新会话默认值。"
        : `全局默认值保存失败：${
          result.persistenceError ?? "全局默认保存失败"
        }`,
    );
  }
  if (result.threadUpdated && activeTurn) {
    lines.push("当前任务仍使用旧设置，后续任务将使用新设置。");
  }
  return lines.join("\n");
}

const SETTINGS_MUTATION_DENIED =
  "权限不足：只有机器人 owner 可以修改模型或推理强度；不带参数的 `/model` 和 `/effort` 仍可查询。";

const HELP = [
  "可用命令：",
  "- `/new`：中断当前任务并新建 Codex 会话",
  "- `/stop`：立即停止当前聊天中正在执行或等待的任务",
  "- `/status`：查看当前聊天的绑定与运行状态",
  "- `/model [model-id]`：查询当前模型；带 model-id 时切换并保存为新会话默认值（仅 owner）",
  "- `/effort [level]`：查询当前推理强度；带 level 时切换并保存为新会话默认值（仅 owner）",
  "- `/help`：显示本帮助",
].join("\n");

const systemMessageDebounceTimers: OrchestratorTimerApi = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
};

/** Serializes each conversation's Codex turns, state changes, and output. */
export class ConversationOrchestrator {
  readonly #state: OrchestratorState;
  readonly #codex: CodexPort;
  readonly #output: ChatOutput;
  readonly #imagePreparer: ImagePreparer;
  readonly #workspace: string;
  readonly #ownerUserId?: string;
  readonly #outputSettings: OutputSettings;
  readonly #groupOutputSettings: OutputSettings;
  readonly #onError?: (error: Error) => void;
  readonly #onRequestStatus?: (event: RequestStatusEvent) => void;
  readonly #onOutputDecision?: (event: OutputDecisionEvent) => void;
  readonly #now: () => number;
  readonly #messageDebounceTimers: OrchestratorTimerApi;
  readonly #shutdownGraceMs: number;
  readonly #interruptRetryDelaysMs: readonly number[];
  readonly #slots = new Map<ConversationKey, ConversationSlot>();
  readonly #loadedThreads = new Map<string, number>();
  readonly #settingsCommandTails = new Map<ConversationKey, Promise<void>>();
  readonly #settingsMutationTails = new Map<ConversationKey, Promise<void>>();
  readonly #shutdownSignal = Promise.withResolvers<void>();
  #shuttingDown = false;

  constructor(options: ConversationOrchestratorOptions) {
    this.#state = options.state;
    this.#codex = options.codex;
    this.#output = options.output;
    this.#imagePreparer = options.imagePreparer;
    this.#workspace = options.workspace;
    this.#ownerUserId = normalizeOwnerUserId(options.ownerUserId);
    this.#outputSettings = options.outputSettings ?? DEFAULT_OUTPUT_SETTINGS;
    this.#groupOutputSettings = options.groupOutputSettings ??
      this.#outputSettings;
    this.#onError = options.onError;
    this.#onRequestStatus = options.onRequestStatus;
    this.#onOutputDecision = options.onOutputDecision;
    this.#now = options.now ?? Date.now;
    this.#messageDebounceTimers = options.messageDebounceTimers ??
      systemMessageDebounceTimers;
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

  async handleMessage(message: RoutedUserMessage): Promise<void> {
    if (message.messageType === "text") {
      const command = message.text.trim();
      const parsedSettingsCommand = settingsCommand(command);
      if (
        command === "/help" || command === "/status" || command === "/new" ||
        command === "/stop" || parsedSettingsCommand
      ) {
        if (this.#shuttingDown) return;
        if (!this.#state.claimMessage(message.msgId, message.conversationKey)) {
          return;
        }
        if (command === "/help") {
          await this.#output.send(message, HELP);
          return;
        }
        if (command === "/status") {
          await this.#enqueueSettingsCommand(
            message.conversationKey,
            async () => {
              const status = await this.#status(message.conversationKey);
              if (status === undefined || this.#shuttingDown) return;
              await this.#output.send(message, status);
            },
          );
          return;
        }
        if (parsedSettingsCommand) {
          await this.#enqueueSettingsCommand(
            message.conversationKey,
            () => this.#handleSettingsCommand(message, parsedSettingsCommand),
            parsedSettingsCommand.valid && parsedSettingsCommand.value !==
                undefined,
          );
          return;
        }
        if (command === "/stop") {
          await this.#stopConversation(message);
          return;
        }
        const slot = this.#slot(message.conversationKey);
        const debounce = this.#cancelDebounce(slot);
        if (debounce) {
          this.#emitRequestStatuses(
            debounce,
            "superseded",
            { reason: "reset" },
          );
          void this.#releaseRequestImages(debounce);
        }
        const pending = slot.pending;
        const current = isSupersedable(slot.current) ? slot.current : undefined;
        slot.pending = undefined;
        if (pending) {
          this.#emitRequestStatuses(pending, "superseded", {
            reason: "reset",
          });
          void this.#releaseRequestImages(pending);
        }
        if (current) {
          this.#emitRequestStatuses(current, "superseded", {
            reason: "reset",
          });
          this.#cancelRequestImages(current);
        }
        if (!this.#codex.ready) {
          this.#deleteSlotIfIdle(message.conversationKey, slot);
          await this.#output.send(
            message,
            "Codex App Server 暂不可用，请稍后重试。",
          );
          return;
        }
        slot.resetPending = {
          message,
          settingsBarrier: this.#settingsMutationTails.get(
            message.conversationKey,
          ) ?? Promise.resolve(),
        };
        if (isInterruptible(slot.active)) this.#requestInterrupt(slot);
        if (!slot.drain) {
          slot.drain = this.#drain(message.conversationKey, slot).finally(
            () => {
              slot.drain = undefined;
            },
          );
        }
        await slot.drain;
        return;
      }
    }

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

    const settingsBarrier = this.#settingsMutationTails.get(
      message.conversationKey,
    ) ?? Promise.resolve();
    const request: PendingRequest = {
      message,
      messages: [{ message, contentImages: [], quoteImages: [] }],
      traces: [trace],
      settingsBarrier,
    };
    if (!this.#codex.ready) {
      this.#emitRequestStatuses(request, "runtime_unavailable");
      await this.#sendRequestReply(
        request,
        () =>
          this.#output.send(
            message,
            "Codex App Server 暂不可用，请稍后重试。",
          ),
      );
      this.#emitRequestStatuses(request, "completed", {
        reason: "runtime_unavailable",
      });
      return;
    }

    const slot = this.#slot(message.conversationKey);
    await this.#debounceMessage(
      message.conversationKey,
      slot,
      message,
      trace,
      settingsBarrier,
    );
  }

  async #handleSettingsCommand(
    message: RoutedText,
    command: SettingsCommand,
  ): Promise<void> {
    if (this.#shuttingDown) return;
    if (!command.valid) {
      await this.#output.send(
        message,
        command.kind === "model"
          ? "用法：`/model <model-id>`"
          : "用法：`/effort <level>`",
      );
      return;
    }
    if (
      command.value !== undefined &&
      classifyRequestAuthority(this.#ownerUserId, [message.senderUserId]) !==
        "owner"
    ) {
      await this.#output.send(message, SETTINGS_MUTATION_DENIED);
      return;
    }

    let reply: string;
    try {
      const record = this.#state.getConversation(message.conversationKey);
      if (command.value) {
        const result = command.kind === "model"
          ? await this.#codex.setModel(record?.threadId, command.value)
          : await this.#codex.setEffort(record?.threadId, command.value);
        if (this.#shuttingDown) return;
        reply = settingsUpdateReply(
          result,
          Boolean(this.#slots.get(message.conversationKey)?.active),
        );
      } else {
        const snapshot = await this.#codex.getModelSettings(record?.threadId);
        if (this.#shuttingDown) return;
        reply = command.kind === "model"
          ? modelHelp(snapshot)
          : effortHelp(snapshot);
      }
    } catch (error) {
      if (this.#shuttingDown) return;
      this.#report(error);
      reply = `${command.value ? "修改" : "读取"}模型设置失败：${
        errorMessage(error)
      }`;
    }
    if (this.#shuttingDown) return;
    await this.#output.send(message, reply);
  }

  #enqueueSettingsCommand(
    conversationKey: ConversationKey,
    operation: () => Promise<void>,
    mutation = false,
  ): Promise<void> {
    const previous = this.#settingsCommandTails.get(conversationKey) ??
      Promise.resolve();
    const result = (async () => {
      const ready = await Promise.race([
        previous.then(() => true as const),
        this.#shutdownSignal.promise.then(() => false as const),
      ]);
      if (!ready || this.#shuttingDown) return;
      await operation();
    })();
    const tail = result.then(() => {}, () => {});
    this.#settingsCommandTails.set(conversationKey, tail);
    if (mutation) this.#settingsMutationTails.set(conversationKey, tail);
    return result.finally(() => {
      if (this.#settingsCommandTails.get(conversationKey) === tail) {
        this.#settingsCommandTails.delete(conversationKey);
      }
      if (this.#settingsMutationTails.get(conversationKey) === tail) {
        this.#settingsMutationTails.delete(conversationKey);
      }
    });
  }

  async #stopConversation(message: RoutedText): Promise<void> {
    const slot = this.#slots.get(message.conversationKey);
    const hasWork = Boolean(
      slot?.debounce || slot?.pending || slot?.resetPending || slot?.current ||
        slot?.active || slot?.control,
    );

    if (slot) {
      const debounce = this.#cancelDebounce(slot);
      if (debounce) {
        this.#emitRequestStatuses(
          debounce,
          "interrupted",
          { reason: "stop" },
        );
        void this.#releaseRequestImages(debounce);
      }
      const pending = slot.pending;
      slot.pending = undefined;
      slot.resetPending = undefined;
      if (pending) {
        this.#emitRequestStatuses(pending, "interrupted", { reason: "stop" });
        void this.#releaseRequestImages(pending);
      }

      if (slot.active) {
        slot.active.stopRequested = true;
        this.#requestInterrupt(slot, undefined, "stop");
      } else if (slot.control) {
        if (isSupersedable(slot.current)) {
          this.#emitRequestStatuses(slot.current, "interrupted", {
            reason: "stop",
          });
          this.#cancelRequestImages(slot.current);
        }
        slot.control.forceComplete({ status: "interrupted" });
      }

      this.#deleteSlotIfIdle(message.conversationKey, slot);
    }

    await this.#output.send(
      message,
      hasWork ? "已停止当前任务。" : "当前没有正在执行或等待的任务。",
    );
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
      `暂不支持 \`${messageType}\` 消息，请发送文本或图片。`,
    );
  }

  async interruptAll(): Promise<void> {
    const drains: Promise<void>[] = [];
    this.#shuttingDown = true;
    this.#shutdownSignal.resolve();
    for (const slot of this.#slots.values()) {
      this.#clearInterruptRetry(slot);
      const debounce = this.#cancelDebounce(slot);
      const pending = slot.pending;
      const current = isSupersedable(slot.current) ? slot.current : undefined;
      slot.pending = undefined;
      slot.resetPending = undefined;
      if (debounce) {
        this.#emitRequestStatuses(
          debounce,
          "shutdown_discarded",
          { reason: "shutdown" },
        );
        void this.#releaseRequestImages(debounce);
      }
      if (pending) {
        this.#emitRequestStatuses(pending, "shutdown_discarded", {
          reason: "shutdown",
        });
        void this.#releaseRequestImages(pending);
      }
      if (current) {
        this.#emitRequestStatuses(current, "shutdown_discarded", {
          reason: "shutdown",
        });
        this.#cancelRequestImages(current);
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

  #deleteSlotIfIdle(
    conversationKey: ConversationKey,
    slot: ConversationSlot,
  ): void {
    if (
      this.#slots.get(conversationKey) === slot && !slot.active &&
      !slot.control && !slot.current && !slot.pending && !slot.resetPending &&
      !slot.debounce
    ) {
      this.#slots.delete(conversationKey);
    }
  }

  async #debounceMessage(
    conversationKey: ConversationKey,
    slot: ConversationSlot,
    message: RoutedUserMessage,
    trace: RequestTrace,
    settingsBarrier: Promise<void>,
  ): Promise<void> {
    const pendingMessage: PendingMessage = {
      message,
      contentImages: message.content.flatMap((part) =>
        part.type === "image"
          ? [
            new PendingImage(
              this.#imagePreparer,
              part.image,
            ),
          ]
          : []
      ),
      quoteImages: message.quoteImages.map((reference) =>
        new PendingImage(
          this.#imagePreparer,
          reference,
        )
      ),
    };
    let batch = slot.debounce;
    if (!batch) {
      const completion = Promise.withResolvers<void>();
      batch = {
        messages: [],
        traces: [],
        settingsBarrier,
        completion: completion.promise,
        resolve: completion.resolve,
        reject: completion.reject,
      };
      slot.debounce = batch;
    }
    batch.messages.push(pendingMessage);
    batch.traces.push(trace);
    batch.settingsBarrier = settingsBarrier;
    if (batch.timer !== undefined) {
      this.#messageDebounceTimers.clearTimeout(batch.timer);
    }
    const timer = this.#messageDebounceTimers.setTimeout(() => {
      if (slot.debounce !== batch || batch.timer !== timer) return;
      void this.#flushDebounce(conversationKey, slot, batch!).then(
        batch!.resolve,
        batch!.reject,
      );
    }, MESSAGE_DEBOUNCE_MS);
    batch.timer = timer;
    await batch.completion;
  }

  async #flushDebounce(
    conversationKey: ConversationKey,
    slot: ConversationSlot,
    batch: DebounceBatch,
  ): Promise<void> {
    if (slot.debounce !== batch) return;
    slot.debounce = undefined;
    batch.timer = undefined;
    const request = this.#requestFromBatch(batch);
    if (this.#shuttingDown) {
      this.#emitRequestStatuses(request, "shutdown_discarded", {
        reason: "shutdown",
      });
      await this.#releaseRequestImages(request);
      this.#deleteSlotIfIdle(conversationKey, slot);
      return;
    }
    if (!this.#codex.ready) {
      this.#emitRequestStatuses(request, "runtime_unavailable");
      try {
        await this.#sendRequestReply(
          request,
          () =>
            this.#output.send(
              request.message,
              "Codex App Server 暂不可用，请稍后重试。",
            ),
        );
        this.#emitRequestStatuses(request, "completed", {
          reason: "runtime_unavailable",
        });
      } finally {
        await this.#releaseRequestImages(request);
        this.#deleteSlotIfIdle(conversationKey, slot);
      }
      return;
    }
    await this.#enqueueRequest(conversationKey, slot, request);
  }

  #cancelDebounce(slot: ConversationSlot): PendingRequest | undefined {
    const batch = slot.debounce;
    if (!batch) return;
    slot.debounce = undefined;
    if (batch.timer !== undefined) {
      this.#messageDebounceTimers.clearTimeout(batch.timer);
      batch.timer = undefined;
    }
    batch.resolve();
    return this.#requestFromBatch(batch);
  }

  async #enqueueRequest(
    conversationKey: ConversationKey,
    slot: ConversationSlot,
    request: PendingRequest,
  ): Promise<void> {
    const pending = slot.pending;
    const current = !pending && isSupersedable(slot.current)
      ? slot.current
      : undefined;
    slot.pending = request;
    if (pending) {
      this.#emitRequestStatuses(pending, "superseded", {
        replacedByMsgId: request.message.msgId,
      });
      void this.#releaseRequestImages(pending);
    } else if (current) {
      this.#emitRequestStatuses(current, "superseded", {
        replacedByMsgId: request.message.msgId,
      });
      this.#cancelRequestImages(current);
    }
    this.#emitRequestStatuses(request, "queued");
    if (isInterruptible(slot.active)) {
      this.#requestInterrupt(slot, request.message.msgId);
    }
    if (!slot.drain) {
      slot.drain = this.#drain(conversationKey, slot).finally(() => {
        slot.drain = undefined;
      });
    }
    await slot.drain;
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

      const request = slot.pending!;
      slot.pending = undefined;
      slot.current = request;
      const control = this.#createTurnControl();
      slot.control = control;
      try {
        await this.#runTurn(request, slot, control);
      } catch (error) {
        if (hasLiveTraces(request)) {
          const failure = errorMessage(error);
          try {
            await this.#sendRequestWithForce(
              control,
              request,
              `任务启动失败：${failure}`,
              true,
            );
          } catch {
            // Continue draining newer work when the fallback cannot be sent.
          }
          if (control.forcedOutcome) {
            this.#emitForcedTerminal(request, control.forcedOutcome);
          } else {
            this.#emitRequestStatuses(request, "failed", { error: failure });
          }
        }
      } finally {
        if (slot.active?.control === control) {
          this.#clearActive(slot, slot.active);
        }
        if (slot.control === control) slot.control = undefined;
        if (slot.current === request) slot.current = undefined;
        await this.#releaseRequestImages(request);
      }
    }

    this.#deleteSlotIfIdle(conversationKey, slot);
  }

  async #resetConversation(
    request: ResetRequest,
    control: TurnControl,
  ): Promise<void> {
    const settingsReady = await this.#raceWithForce(
      () =>
        Promise.race([
          request.settingsBarrier.then(() => true as const),
          this.#shutdownSignal.promise.then(() => false as const),
        ]),
      control,
    );
    if (
      settingsReady.type === "forced" ||
      (settingsReady.type === "value" && !settingsReady.value)
    ) return;
    if (settingsReady.type === "error") throw settingsReady.error;

    const message = request.message;
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

  async #resolveRequestImages(
    request: PendingRequest,
  ): Promise<PreparedRequestImages> {
    const preparedMessages = await Promise.all(
      request.messages.map(async (pending) => {
        const [contentLeases, quoteLeases] = await Promise.all([
          Promise.all(pending.contentImages.map((image) => image.result)),
          Promise.all(pending.quoteImages.map((image) => image.result)),
        ]);
        let contentImageIndex = 0;
        return {
          message: pending.message,
          contentLeases,
          quoteLeases,
          content: pending.message.content.map((part) =>
            part.type === "text" ? part : {
              type: "image" as const,
              path: contentLeases[contentImageIndex++].path,
            }
          ),
        };
      }),
    );
    const input = buildCodexTurnInput({
      chatType: request.message.chatType,
      conversationKey: request.message.conversationKey,
      messages: preparedMessages.map((prepared) => ({
        senderUserId: prepared.message.senderUserId,
        msgId: prepared.message.msgId,
        content: prepared.content,
        quote: prepared.message.quote,
        quoteImages: prepared.quoteLeases.map(({ path }) => path),
      })),
    });
    return {
      input,
      leases: preparedMessages.flatMap((prepared) => [
        ...prepared.contentLeases,
        ...prepared.quoteLeases,
      ]),
    };
  }

  async #releaseRequestImages(request: PendingRequest): Promise<void> {
    const results = await Promise.allSettled(
      request.messages.flatMap((pending) =>
        [...pending.contentImages, ...pending.quoteImages].map((image) =>
          image.release()
        )
      ),
    );
    for (const result of results) {
      if (result.status === "rejected") this.#report(result.reason);
    }
  }

  async #releaseLeases(leases: readonly ImageLease[]): Promise<void> {
    const results = await Promise.allSettled(
      leases.map((lease) => lease.release()),
    );
    for (const result of results) {
      if (result.status === "rejected") this.#report(result.reason);
    }
  }

  #cancelRequestImages(request: PendingRequest): void {
    for (const pending of request.messages) {
      for (const image of [...pending.contentImages, ...pending.quoteImages]) {
        image.cancel();
      }
    }
  }

  async #runTurn(
    request: PendingRequest,
    slot: ConversationSlot,
    control: TurnControl,
  ): Promise<void> {
    const message = request.message;
    const settingsReady = await this.#raceWithForce(
      () =>
        Promise.race([
          request.settingsBarrier.then(() => true as const),
          this.#shutdownSignal.promise.then(() => false as const),
        ]),
      control,
    );
    if (
      settingsReady.type === "forced" ||
      (settingsReady.type === "value" && !settingsReady.value)
    ) return;
    if (settingsReady.type === "error") throw settingsReady.error;

    const prepared = await this.#raceWithForce(
      () => this.#resolveRequestImages(request),
      control,
    );
    if (prepared.type === "forced") return;
    if (prepared.type === "error") {
      if (!(prepared.error instanceof ImagePreparationError)) {
        throw prepared.error;
      }
      this.#cancelRequestImages(request);
      if (
        hasLiveTraces(request) && !control.forced && !this.#shuttingDown &&
        !slot.resetPending && !slot.pending
      ) {
        await this.#sendRequestWithForce(
          control,
          request,
          "图片处理失败，请重新发送图片。",
          true,
        );
      }
      if (control.forcedOutcome) {
        this.#emitForcedTerminal(request, control.forcedOutcome);
      } else {
        this.#emitRequestStatuses(request, "failed", {
          reason: "image_preparation_failed",
        });
      }
      return;
    }

    const threadId = await this.#ensureThread(request, control);
    if (threadId === undefined) return;

    // A newer message that arrived while loading the thread wins before any
    // model work is started.
    if (
      !hasLiveTraces(request) || control.forced || this.#shuttingDown ||
      slot.resetPending || slot.pending
    ) return;

    const input = prepared.value.input;
    const progress = await this.#startProgressWithForce(message, control);
    if (progress === undefined) return;
    const turnOutput = this.#createTurnOutput(message, progress);
    if (
      !hasLiveTraces(request) || control.forced || this.#shuttingDown ||
      slot.resetPending || slot.pending
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
      !hasLiveTraces(request) || control.forced || this.#shuttingDown ||
      slot.resetPending || slot.pending
    ) {
      await this.#finishTurnOutput(turnOutput, undefined, control);
      return;
    }

    const active: ActiveTurn = {
      threadId,
      request,
      turnOutput,
      control,
      shutdownRequested: false,
      stopRequested: false,
      interruptWhenReady: false,
      lateInterruptRequested: false,
      interruptStatusEmitted: false,
    };
    this.#setRequestPhase(request, "turn");
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
    this.#emitRequestStatuses(request, "turn_starting");
    const rpcLeases = prepared.value.leases.map((lease) => lease.retain());
    try {
      const authority = classifyRequestAuthority(
        this.#ownerUserId,
        request.messages.map(({ message }) => message.senderUserId),
      );
      start = this.#codex.startTurn(
        threadId,
        input,
        authority,
        (activity) => this.#enqueueActivity(turnOutput, activity, control),
        this.#effectiveOutputSettings(request.message).toolFormat === "summary"
          ? { summary: "auto" }
          : undefined,
      );
    } catch (error) {
      start = Promise.reject(error);
    }
    void start.then(
      () => this.#releaseLeases(rpcLeases),
      () => this.#releaseLeases(rpcLeases),
    ).catch((error) => this.#report(error));

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
      this.#setRequestPhase(request, "reply");
      this.#observeLateStart(active, start);
      try {
        await this.#finishTurnOutput(turnOutput, {
          tag: "TURN",
          body: startResult.outcome.status,
          delivery: "progress",
        }, control);
      } finally {
        this.#clearActive(slot, active);
        this.#emitForcedOutcome(request, startResult.outcome);
      }
      return;
    }

    if (startResult.type === "error") {
      this.#setRequestPhase(request, "reply");
      try {
        await this.#finishTurnOutput(turnOutput, undefined, control);
      } finally {
        this.#clearActive(slot, active);
      }
      if (active.stopRequested) {
        this.#emitRequestStatuses(request, "reply_skipped", { reason: "stop" });
        this.#emitRequestStatuses(request, "interrupted", { reason: "stop" });
        return;
      }
      throw startResult.error;
    }

    const handle = startResult.handle;

    active.turnId = handle.turnId;
    this.#setRequestTurnId(request, handle.turnId);
    if (active.interruptWhenReady) this.#requestInterrupt(slot);
    if (control.forced) {
      this.#setRequestPhase(request, "reply");
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
        this.#emitForcedOutcome(request, forcedOutcome);
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
      this.#emitRequestStatuses(request, "running");
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
      this.#setRequestPhase(request, "reply");
      this.#emitRequestStatuses(request, "turn_completed", {
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
      if (active.stopRequested) {
        this.#emitRequestStatuses(request, "reply_skipped", { reason: "stop" });
        this.#emitRequestStatuses(request, "interrupted", { reason: "stop" });
        return;
      }
      throw error;
    }
    if (slot.resetPending || slot.pending) {
      this.#requestInterrupt(slot);
    }

    let outcome: TurnOutcome;
    try {
      outcome = await Promise.race([handle.completion, control.forceSignal]);
    } catch (error) {
      outcome = { status: "failed", error: errorMessage(error) };
    }
    this.#setRequestPhase(request, "reply");
    const superseded = Boolean(slot.resetPending || slot.pending);
    this.#emitRequestStatuses(request, "turn_completed", {
      reason: outcome.status,
      ...(outcome.error ? { error: outcome.error } : {}),
    });

    let replyFailed = false;
    let replyError: unknown;
    try {
      await this.#finishTurnOutput(turnOutput, {
        tag: "TURN",
        body: active.stopRequested ? "interrupted" : outcome.status,
        delivery: "progress",
      }, control);

      if (
        outcome.status === "completed" && outcome.finalAnswer &&
        !superseded && !active.stopRequested && !this.#shuttingDown
      ) {
        await this.#sendRequestWithForce(
          control,
          request,
          outcome.finalAnswer,
          true,
          active,
        );
      } else if (
        outcome.status === "failed" && !superseded &&
        !active.stopRequested && !this.#shuttingDown
      ) {
        await this.#sendRequestWithForce(
          control,
          request,
          `Codex 执行失败：${outcome.error ?? "unknown error"}`,
          true,
          active,
        );
      } else {
        const reason = active.stopRequested
          ? "stop"
          : superseded
          ? "superseded"
          : this.#shuttingDown
          ? "shutdown"
          : outcome.status === "completed"
          ? "no_final_answer"
          : outcome.status;
        this.#emitRequestStatuses(request, "reply_skipped", { reason });
      }
    } catch (error) {
      replyFailed = true;
      replyError = error;
    } finally {
      const stopped = active.stopRequested;
      try {
        this.#state.finishTurn(
          message.conversationKey,
          handle.turnId,
          stopped ? "interrupted" : outcome.status,
          stopped ? null : outcome.error ?? null,
        );
      } catch (error) {
        this.#report(error);
      }
      this.#clearActive(slot, active);
    }

    if (active.stopRequested) {
      if (hasLiveTraces(request)) {
        if (replyFailed) {
          this.#emitRequestStatuses(request, "reply_skipped", {
            reason: "stop",
          });
        }
        this.#emitRequestStatuses(request, "interrupted", { reason: "stop" });
      }
      return;
    }
    if (replyFailed) {
      if (hasLiveTraces(request)) {
        this.#emitRequestStatuses(request, "failed", {
          error: errorMessage(replyError),
        });
      }
      return;
    }
    this.#emitRequestStatuses(
      request,
      outcomeRequestStatus(outcome.status),
      outcome.error ? { error: outcome.error } : {},
    );
  }

  #createTurnOutput(
    message: RoutedUserMessage,
    progress: ProgressHandle,
  ): TurnOutput {
    return {
      message,
      progress,
      pipeline: new TurnOutputPipeline(this.#effectiveOutputSettings(message)),
      activityTail: Promise.resolve(),
      acceptingActivities: true,
      finished: false,
      shutdownHandled: false,
    };
  }

  #effectiveOutputSettings(message: RoutedUserMessage): OutputSettings {
    return message.chatType === "group"
      ? this.#groupOutputSettings
      : this.#outputSettings;
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
      control.forcedOutcome = outcome;
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

  async #startProgressWithForce(
    message: RoutedUserMessage,
    control: TurnControl,
  ): Promise<ProgressHandle | undefined> {
    let pending: Promise<ProgressHandle>;
    try {
      pending = Promise.resolve(this.#output.startProgress(message));
    } catch (error) {
      pending = Promise.reject(error);
    }
    const result = await Promise.race([
      pending.then(
        (value) => ({ type: "value" as const, value }),
        (error) => ({ type: "error" as const, error }),
      ),
      control.forceSignal.then(() => ({ type: "forced" as const })),
    ]);
    if (result.type === "error") throw result.error;
    if (result.type === "value") return result.value;

    void pending.then(async (progress) => {
      await this.#finishTurnOutput(
        this.#createTurnOutput(message, progress),
        undefined,
        control,
      );
    }, () => undefined).catch((error) => this.#report(error));
    return undefined;
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
    request: PendingRequest,
    text: string,
    final = false,
    active?: ActiveTurn,
  ): Promise<void> {
    this.#setRequestPhase(request, "reply");
    if (control.forced) {
      this.#emitRequestStatuses(request, "reply_skipped", {
        reason: forcedReplyReason(control.forcedOutcome),
      });
      return;
    }
    this.#emitRequestStatuses(request, "reply_sending");
    let result: SendWithForceResult;
    try {
      result = await this.#sendWithForce(
        control,
        request.message,
        text,
        final,
      );
    } catch (error) {
      this.#emitRequestStatuses(
        request,
        active?.stopRequested ? "interrupted" : "failed",
        active?.stopRequested
          ? { reason: "stop" }
          : { error: errorMessage(error) },
      );
      throw error;
    }
    if (result === "forced") {
      this.#emitRequestStatuses(request, "reply_skipped", {
        reason: forcedReplyReason(control.forcedOutcome),
      });
    } else {
      this.#emitRequestStatuses(request, "reply_sent");
    }
  }

  async #sendRequestReply(
    request: PendingRequest,
    send: () => Promise<void>,
  ): Promise<void> {
    this.#setRequestPhase(request, "reply");
    this.#emitRequestStatuses(request, "reply_sending");
    try {
      await send();
    } catch (error) {
      this.#emitRequestStatuses(request, "failed", {
        error: errorMessage(error),
      });
      throw error;
    }
    this.#emitRequestStatuses(request, "reply_sent");
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
    const decision = turnOutput.pipeline.applyWithDecision(activity);
    this.#reportOutputDecision(activity, decision);
    const rendered = decision.output;
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
      turnOutput.progress.append(rendered, decision.progressTail);
    }
    if (activity.tag === "SHUTDOWN") turnOutput.shutdownHandled = true;
  }

  #reportOutputDecision(
    activity: ActivityEvent,
    decision: {
      disposition: "rendered" | "suppressed";
      reason: OutputDecisionReason;
    },
  ): void {
    if (!this.#onOutputDecision) return;
    try {
      this.#onOutputDecision({
        tag: activity.tag,
        delivery: activity.delivery,
        ...(activity.threadId ? { threadId: activity.threadId } : {}),
        ...(activity.turnId ? { turnId: activity.turnId } : {}),
        ...decision,
      });
    } catch {
      // Output tracing cannot change delivery behavior.
    }
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
    message: RoutedUserMessage,
    control: TurnControl,
    request?: PendingRequest,
  ): Promise<string | undefined> {
    if (request) this.#emitRequestStatuses(request, "thread_starting");
    const started = await this.#raceWithForce(
      () => this.#codex.startThread(),
      control,
    );
    if (
      started.type === "forced" || control.forced || this.#shuttingDown ||
      (request !== undefined && !hasLiveTraces(request))
    ) return undefined;
    if (started.type === "error") throw started.error;

    if (request) {
      this.#setRequestThreadId(request, started.value);
      this.#emitRequestStatuses(request, "thread_started");
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
    request: PendingRequest,
    control: TurnControl,
  ): Promise<string | undefined> {
    const message = request.message;
    const existing = this.#state.getConversation(message.conversationKey);
    if (!existing) {
      const threadId = await this.#startAndBindThread(
        message,
        control,
        request,
      );
      if (threadId !== undefined) {
        this.#emitRequestStatuses(request, "thread_ready");
      }
      return threadId;
    }

    this.#setRequestThreadId(request, existing.threadId);
    if (
      this.#loadedThreads.get(existing.threadId) !== this.#codex.generation
    ) {
      this.#emitRequestStatuses(request, "thread_resuming");
      const resumed = await this.#raceWithForce(
        () => this.#codex.resumeThread(existing.threadId),
        control,
      );
      if (
        resumed.type === "forced" || control.forced || this.#shuttingDown ||
        !hasLiveTraces(request)
      ) return undefined;
      if (resumed.type === "error") throw resumed.error;
      this.#emitRequestStatuses(request, "thread_resumed");
      this.#loadedThreads.set(existing.threadId, this.#codex.generation);
    }
    if (!hasLiveTraces(request)) return undefined;
    this.#emitRequestStatuses(request, "thread_ready");
    return existing.threadId;
  }

  #createRequestTrace(message: RoutedUserMessage): RequestTrace {
    return {
      message,
      startedAt: this.#now(),
      phase: "pre_turn",
      terminal: false,
    };
  }

  #requestFromBatch(batch: DebounceBatch): PendingRequest {
    return {
      message: batch.messages[batch.messages.length - 1].message,
      messages: batch.messages,
      traces: batch.traces,
      settingsBarrier: batch.settingsBarrier,
    };
  }

  #setRequestPhase(request: PendingRequest, phase: RequestPhase): void {
    for (const trace of request.traces) {
      if (!trace.terminal) trace.phase = phase;
    }
  }

  #setRequestThreadId(request: PendingRequest, threadId: string): void {
    for (const trace of request.traces) {
      if (!trace.terminal) trace.threadId = threadId;
    }
  }

  #setRequestTurnId(request: PendingRequest, turnId: string): void {
    for (const trace of request.traces) {
      if (!trace.terminal) trace.turnId = turnId;
    }
  }

  #emitForcedOutcome(request: PendingRequest, outcome: TurnOutcome): void {
    this.#emitRequestStatuses(request, "reply_skipped", {
      reason: forcedReplyReason(outcome),
    });
    this.#emitForcedTerminal(request, outcome);
  }

  #emitForcedTerminal(request: PendingRequest, outcome: TurnOutcome): void {
    this.#emitRequestStatuses(
      request,
      outcomeRequestStatus(outcome.status),
      outcome.status === "interrupted"
        ? { reason: "stop" }
        : outcome.error
        ? { error: outcome.error }
        : {},
    );
  }

  #emitRequestStatuses(
    request: PendingRequest,
    state: RequestStatus,
    details: RequestStatusDetails = {},
  ): void {
    const traces = request.traces.filter((trace) => !trace.terminal);
    const terminal = TERMINAL_REQUEST_STATUSES.has(state);
    if (terminal) {
      for (const trace of traces) trace.terminal = true;
    }
    for (const trace of traces) {
      this.#dispatchRequestStatus(trace, state, details, terminal);
    }
  }

  #emitRequestStatus(
    trace: RequestTrace,
    state: RequestStatus,
    details: RequestStatusDetails = {},
  ): void {
    if (trace.terminal) return;
    const terminal = TERMINAL_REQUEST_STATUSES.has(state);
    if (terminal) trace.terminal = true;
    this.#dispatchRequestStatus(trace, state, details, terminal);
  }

  #dispatchRequestStatus(
    trace: RequestTrace,
    state: RequestStatus,
    details: RequestStatusDetails,
    terminal: boolean,
  ): void {
    const counts = this.#requestCounts();
    const summary = state === "received" && trace.message.messageType === "text"
      ? summarizeRequest(trace.message.text)
      : undefined;
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
      const activeRequest = slot.current ?? slot.active?.request;
      if (hasLiveTraces(activeRequest)) active++;
      if (
        slot.resetPending || hasLiveTraces(slot.pending) ||
        slot.debounce?.traces.some((trace) => !trace.terminal)
      ) pending++;
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

  #requestInterrupt(
    slot: ConversationSlot,
    triggerMsgId?: string,
    reason?: string,
  ): void {
    const active = slot.active;
    if (!isInterruptible(active)) return;
    if (!active.interruptStatusEmitted) {
      active.interruptStatusEmitted = true;
      this.#emitRequestStatuses(active.request, "interrupt_requested", {
        ...(triggerMsgId ? { triggerMsgId } : {}),
        ...(reason ? { reason } : {}),
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
        if (slot.active !== active || !isInterruptible(active)) return;
        void this.#enqueueActivity(active.turnOutput, {
          tag: "ERROR",
          body: `interrupt failed: ${errorMessage(error)}`,
          delivery: "progress",
        }, active.control).catch((activityError) =>
          this.#report(activityError)
        );
        slot.interruptRequested = false;
        if (
          this.#shuttingDown ||
          (!active.stopRequested && !slot.pending && !slot.resetPending)
        ) return;

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

  async #status(
    conversationKey: ConversationKey,
  ): Promise<string | undefined> {
    const record = this.#state.getConversation(conversationKey);
    const slot = this.#slots.get(conversationKey);
    let model = "unknown";
    let effort = "unknown";
    let source: "thread" | "default" = record ? "thread" : "default";
    if (this.#codex.ready) {
      try {
        const snapshot = await this.#codex.getModelSettings(record?.threadId);
        if (this.#shuttingDown) return undefined;
        model = snapshot.settings.model;
        effort = snapshot.settings.effort ?? "default";
        source = snapshot.source;
      } catch (error) {
        if (this.#shuttingDown) return undefined;
        this.#report(error);
      }
    }
    const suffix = source === "default" ? " (default)" : "";
    return [
      `conversation: \`${conversationKey}\``,
      `thread: \`${record?.threadId ?? "not bound"}\``,
      `model: \`${model}\`${suffix}`,
      `effort: \`${effort}\`${suffix}`,
      `codex: ${this.#codex.ready ? "ready" : "unavailable"}`,
      `turn: ${slot?.active ? "in_progress" : record?.lastStatus ?? "idle"}`,
      `queued: ${
        slot?.debounce || slot?.pending || slot?.resetPending ? "yes" : "no"
      }`,
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

function forcedReplyReason(outcome?: TurnOutcome): "stop" | "shutdown" {
  return outcome?.status === "interrupted" ? "stop" : "shutdown";
}
