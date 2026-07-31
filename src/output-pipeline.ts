import type { ActivityEvent } from "./activity-event.ts";
import type { OutputSettings } from "./output-settings.ts";

const EXCERPT_LIMIT = 800;
const LINE_LIMIT = 160;
const FALLBACK_ITEM = Symbol("fallback item");

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
}

/** Applies per-turn detail filtering and label rendering to activity events. */
export class TurnOutputPipeline {
  readonly #settings: OutputSettings;
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

    const level = this.#settings.levels[event.tag];
    if (level === "off") return suppressed("level_off");

    const source = sourceText(event);
    if (source === null) return suppressed("no_source");

    let visible: string | null;
    let reason: OutputDecisionReason;
    if (level === "line") {
      visible = this.#line(event, source);
      reason = visible === null ? "line_complete" : "line";
    } else if (level === "excerpt") {
      visible = this.#excerpt(event, source);
      reason = visible === null ? "excerpt_complete" : "excerpt";
    } else {
      visible = source;
      reason = "full";
    }
    if (!visible) {
      return suppressed(visible === null ? reason : "no_visible_text");
    }

    const output = this.#settings.labels[event.tag] === "show"
      ? `[${event.tag.toLowerCase()}] ${visible}`
      : visible;
    return rendered(output, reason);
  }

  clear(): void {
    this.#excerpts.clear();
    this.#lines.clear();
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
): OutputPipelineDecision {
  return { output, disposition: "rendered", reason };
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
