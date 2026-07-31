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
  | "tool_aggregation"
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

/** Applies per-turn aggregation, detail filtering, and label rendering to activity events. */
export class TurnOutputPipeline {
  readonly #settings: OutputSettings;
  readonly #sameToolByItemId = new Map<string, string>();
  readonly #sameToolCounts = new Map<string, number>();
  readonly #sameFallbackCounts = new Map<string, number>();
  readonly #allToolItems = new Set<string>();
  readonly #excerpts: StreamStates<ExcerptState> = new Map();
  readonly #lines: StreamStates<LineState> = new Map();
  #allFallbackCount = 0;

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

    const aggregated = this.#aggregate(event);
    if (!aggregated) return suppressed("tool_aggregation");

    const level = this.#settings.levels[aggregated.tag];
    if (level === "off") return suppressed("level_off");

    const source = sourceText(aggregated);
    if (source === null) return suppressed("no_source");

    let visible: string | null;
    let reason: OutputDecisionReason;
    if (level === "line") {
      visible = this.#line(aggregated, source);
      reason = visible === null ? "line_complete" : "line";
    } else if (level === "excerpt") {
      visible = this.#excerpt(aggregated, source);
      reason = visible === null ? "excerpt_complete" : "excerpt";
    } else {
      visible = source;
      reason = "full";
    }
    if (!visible) {
      return suppressed(visible === null ? reason : "no_visible_text");
    }

    const output = this.#settings.labels[aggregated.tag] === "show"
      ? `[${aggregated.tag.toLowerCase()}] ${visible}`
      : visible;
    return rendered(output, reason);
  }

  clear(): void {
    this.#sameToolByItemId.clear();
    this.#sameToolCounts.clear();
    this.#sameFallbackCounts.clear();
    this.#allToolItems.clear();
    this.#allFallbackCount = 0;
    this.#excerpts.clear();
    this.#lines.clear();
  }

  #aggregate(event: ActivityEvent): ActivityEvent | null {
    if (event.tag !== "TOOL" || !event.toolState) return event;

    switch (this.#settings.toolFormat) {
      case "merge_same":
        return this.#mergeSame(event);
      case "merge_all":
        return this.#mergeAll(event);
      default:
        return event;
    }
  }

  #mergeSame(event: ActivityEvent): ActivityEvent | null {
    const toolId = this.#toolId(event);
    const firstOrFinal = event.toolState === "started"
      ? this.#startSame(event.itemId, toolId)
      : this.#completeSame(event.itemId, toolId);
    return firstOrFinal ? event : null;
  }

  #startSame(itemId: string | undefined, toolId: string): boolean {
    if (itemId) {
      if (this.#sameToolByItemId.has(itemId)) return false;
      this.#sameToolByItemId.set(itemId, toolId);
    } else {
      const fallbackCount = this.#sameFallbackCounts.get(toolId) ?? 0;
      this.#sameFallbackCounts.set(toolId, fallbackCount + 1);
    }

    const count = this.#sameToolCounts.get(toolId) ?? 0;
    this.#sameToolCounts.set(toolId, count + 1);
    return count === 0;
  }

  #completeSame(itemId: string | undefined, fallbackToolId: string): boolean {
    let toolId = fallbackToolId;
    if (itemId) {
      const knownToolId = this.#sameToolByItemId.get(itemId);
      if (!knownToolId) return false;
      this.#sameToolByItemId.delete(itemId);
      toolId = knownToolId;
    } else {
      const fallbackCount = this.#sameFallbackCounts.get(toolId) ?? 0;
      if (fallbackCount <= 0) return false;
      if (fallbackCount === 1) this.#sameFallbackCounts.delete(toolId);
      else this.#sameFallbackCounts.set(toolId, fallbackCount - 1);
    }

    const count = this.#sameToolCounts.get(toolId) ?? 0;
    if (count <= 0) return false;
    if (count === 1) {
      this.#sameToolCounts.delete(toolId);
      return true;
    }
    this.#sameToolCounts.set(toolId, count - 1);
    return false;
  }

  #mergeAll(event: ActivityEvent): ActivityEvent | null {
    const firstOrFinal = event.toolState === "started"
      ? this.#startAll(event.itemId)
      : this.#completeAll(event.itemId);
    if (!firstOrFinal) return null;

    return {
      tag: "TOOL",
      body: event.toolState === "started" ? "tools started" : "tools completed",
      delivery: "progress",
    };
  }

  #startAll(itemId: string | undefined): boolean {
    const wasEmpty = this.#activeAllToolCount() === 0;
    if (itemId) {
      if (this.#allToolItems.has(itemId)) return false;
      this.#allToolItems.add(itemId);
    } else {
      this.#allFallbackCount++;
    }
    return wasEmpty;
  }

  #completeAll(itemId: string | undefined): boolean {
    if (itemId) {
      if (!this.#allToolItems.delete(itemId)) return false;
    } else {
      if (this.#allFallbackCount <= 0) return false;
      this.#allFallbackCount--;
    }
    return this.#activeAllToolCount() === 0;
  }

  #activeAllToolCount(): number {
    return this.#allToolItems.size + this.#allFallbackCount;
  }

  #toolId(event: ActivityEvent): string {
    return event.toolId ?? "__turn_fallback_tool__";
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
