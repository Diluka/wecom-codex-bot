import type { ActivityEvent } from "./activity-event.ts";
import type { OutputSettings } from "./output-settings.ts";
import type { ProgressTail } from "./progress-tail.ts";

const EXCERPT_LIMIT = 800;
const LINE_LIMIT = 160;
const FALLBACK_ITEM = Symbol("fallback item");
const COMPLETED_REASONING_SUMMARY = "*已完成上一阶段，继续处理中…*";

type StreamItemKey = string | typeof FALLBACK_ITEM;
type StreamStates<T> = Map<string, Map<StreamItemKey, T>>;

interface ExcerptState {
  used: number;
  truncated: boolean;
}

interface LineState {
  emitted: boolean;
  truncated: boolean;
}

export type OutputDecisionReason =
  | "direct"
  | "direct_missing_body"
  | "tool_format_summary"
  | "level_off"
  | "no_source"
  | "no_visible_text"
  | "full"
  | "line"
  | "line_complete"
  | "excerpt"
  | "excerpt_complete";

export interface OutputPipelineDecision {
  output: string | null;
  disposition: "rendered" | "suppressed";
  reason: OutputDecisionReason;
  progressTail?: ProgressTail;
}

/** Applies per-turn detail filtering and label rendering to activity events. */
export class TurnOutputPipeline {
  readonly #settings: OutputSettings;
  readonly #reasoningSummaries = new Map<string, Map<number, string>>();
  readonly #excerpts: StreamStates<ExcerptState> = new Map();
  readonly #lines: StreamStates<LineState> = new Map();

  constructor(settings: OutputSettings) {
    this.#settings = settings;
  }

  apply(event: ActivityEvent): string | null {
    return this.applyWithDecision(event).output;
  }

  applyWithDecision(event: ActivityEvent): OutputPipelineDecision {
    this.#releaseCompletedToolResultStream(event);
    if (event.delivery === "direct") {
      return event.body === undefined
        ? suppressed("direct_missing_body")
        : rendered(event.body, "direct");
    }
    if (
      this.#settings.toolFormat === "summary" &&
      (event.tag === "TOOL" || event.tag === "TOOL_RESULT")
    ) {
      return suppressed("tool_format_summary");
    }

    const summarySnapshot = this.#reasoningSummarySnapshot(event);
    const renderable = summarySnapshot ?? event;
    const level = this.#settings.levels[renderable.tag];
    if (level === "off") return suppressed("level_off");

    const rawSource = sourceText(renderable);
    if (rawSource === null) return suppressed("no_source");
    const source = summarySnapshot === null
      ? rawSource
      : italicizeFullLineBold(rawSource);

    let visible: string | null;
    let reason: OutputDecisionReason;
    if (level === "line") {
      visible = summarySnapshot
        ? summaryLine(source)
        : this.#line(renderable, source);
      reason = visible === null ? "line_complete" : "line";
    } else if (level === "excerpt") {
      visible = summarySnapshot
        ? summaryExcerpt(source)
        : this.#excerpt(renderable, source);
      reason = visible === null ? "excerpt_complete" : "excerpt";
    } else {
      visible = source;
      reason = "full";
    }
    if (!visible) {
      return suppressed(visible === null ? reason : "no_visible_text");
    }

    const output = renderLabel(this.#settings, renderable.tag, visible);
    const progressTail = summarySnapshot && event.reasoningSummary
      ? {
        key: JSON.stringify([
          event.reasoningSummary.itemId,
          event.reasoningSummary.summaryIndex,
        ]),
        completedText: renderLabel(
          this.#settings,
          "CONTENT",
          COMPLETED_REASONING_SUMMARY,
        ),
      }
      : undefined;
    return rendered(output, reason, progressTail);
  }

  clear(): void {
    this.#reasoningSummaries.clear();
    this.#excerpts.clear();
    this.#lines.clear();
  }

  #reasoningSummarySnapshot(event: ActivityEvent): ActivityEvent | null {
    if (
      this.#settings.toolFormat !== "summary" || event.tag !== "CONTENT" ||
      event.body === undefined || !event.reasoningSummary
    ) {
      return null;
    }

    const { itemId, summaryIndex } = event.reasoningSummary;
    let sections = this.#reasoningSummaries.get(itemId);
    if (!sections) {
      sections = new Map();
      this.#reasoningSummaries.set(itemId, sections);
    }
    const body = (sections.get(summaryIndex) ?? "") + event.body;
    sections.set(summaryIndex, body);
    return { ...event, body };
  }
  #excerpt(event: ActivityEvent, source: string): string | null {
    const state = streamState(
      this.#excerpts,
      event.tag,
      event.itemId,
      () => ({ used: 0, truncated: false }),
    );
    if (state.truncated) return null;

    const codePoints = Array.from(source);
    const remaining = EXCERPT_LIMIT - state.used;
    if (codePoints.length <= remaining) {
      state.used += codePoints.length;
      return source;
    }

    state.used += Math.max(remaining, 0);
    state.truncated = true;
    return `${codePoints.slice(0, Math.max(remaining, 0)).join("")}...`;
  }

  #line(event: ActivityEvent, source: string): string | null {
    const state = streamState(
      this.#lines,
      event.tag,
      event.itemId,
      () => ({ emitted: false, truncated: false }),
    );
    if (state.truncated) return null;

    const lines = source.split(/\r?\n/);
    const firstIndex = lines.findIndex((value) => value.trim());
    if (firstIndex === -1) return null;

    if (state.emitted) {
      state.truncated = true;
      return null;
    }

    const first = lines[firstIndex].trim();
    const codePoints = Array.from(first);
    const hasLaterContent = lines.slice(firstIndex + 1).some((value) =>
      value.trim()
    );
    state.emitted = true;
    if (codePoints.length > LINE_LIMIT || hasLaterContent) {
      state.truncated = true;
      return `${codePoints.slice(0, LINE_LIMIT).join("")}...`;
    }
    return first;
  }

  #releaseCompletedToolResultStream(event: ActivityEvent): void {
    if (
      event.tag !== "TOOL" || event.toolState !== "completed" || !event.itemId
    ) {
      return;
    }
    deleteStreamState(this.#excerpts, "TOOL_RESULT", event.itemId);
    deleteStreamState(this.#lines, "TOOL_RESULT", event.itemId);
  }
}

function rendered(
  output: string,
  reason: OutputDecisionReason,
  progressTail?: ProgressTail,
): OutputPipelineDecision {
  return {
    output,
    disposition: "rendered",
    reason,
    ...(progressTail ? { progressTail } : {}),
  };
}

function suppressed(reason: OutputDecisionReason): OutputPipelineDecision {
  return { output: null, disposition: "suppressed", reason };
}

function sourceText(event: ActivityEvent): string | null {
  const parts = [event.summary, event.body].filter((value): value is string =>
    value !== undefined
  );
  return parts.length === 0 ? null : parts.join("\n");
}

function renderLabel(
  settings: OutputSettings,
  tag: ActivityEvent["tag"],
  text: string,
): string {
  return settings.labels[tag] === "show"
    ? `[${tag.toLowerCase()}] ${text}`
    : text;
}

function italicizeFullLineBold(source: string): string {
  return source.split(/(\r?\n)/).map((part, index) =>
    index % 2 === 0 ? italicizeBoldLine(part) : part
  ).join("");
}

function italicizeBoldLine(line: string): string {
  const trimmed = line.trim();
  if (
    !trimmed.startsWith("**") || !trimmed.endsWith("**") ||
    trimmed.includes("`") || isEscapedAt(trimmed, trimmed.length - 2) ||
    countBoldMarkers(trimmed) !== 2
  ) {
    return line;
  }

  const content = trimmed.slice(2, -2);
  if (!content.trim()) return line;

  const start = line.indexOf(trimmed);
  return `${line.slice(0, start)}*${content}*${
    line.slice(start + trimmed.length)
  }`;
}

function countBoldMarkers(value: string): number {
  let count = 0;
  for (let index = 0; index < value.length - 1; index += 1) {
    if (value[index] === "*" && value[index + 1] === "*") count += 1;
  }
  return count;
}

function isEscapedAt(value: string, index: number): boolean {
  let backslashes = 0;
  for (
    let cursor = index - 1;
    cursor >= 0 && value[cursor] === "\\";
    cursor--
  ) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function summaryExcerpt(source: string): string {
  const codePoints = Array.from(source);
  return codePoints.length <= EXCERPT_LIMIT
    ? source
    : `${codePoints.slice(0, EXCERPT_LIMIT).join("")}...`;
}

function summaryLine(source: string): string | null {
  const lines = source.split(/\r?\n/);
  const firstIndex = lines.findIndex((value) => value.trim());
  if (firstIndex === -1) return null;

  const first = lines[firstIndex].trim();
  const codePoints = Array.from(first);
  const hasLaterContent = lines.slice(firstIndex + 1).some((value) =>
    value.trim()
  );
  return codePoints.length > LINE_LIMIT || hasLaterContent
    ? `${codePoints.slice(0, LINE_LIMIT).join("")}...`
    : first;
}

function streamState<T>(
  states: StreamStates<T>,
  tag: string,
  itemId: string | undefined,
  create: () => T,
): T {
  let items = states.get(tag);
  if (!items) {
    items = new Map();
    states.set(tag, items);
  }

  const key = itemId ?? FALLBACK_ITEM;
  let state = items.get(key);
  if (!state) {
    state = create();
    items.set(key, state);
  }
  return state;
}

function deleteStreamState<T>(
  states: StreamStates<T>,
  tag: string,
  itemId: string,
): void {
  const items = states.get(tag);
  if (!items) return;

  items.delete(itemId);
  if (items.size === 0) states.delete(tag);
}
