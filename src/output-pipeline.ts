import type { ActivityEvent } from "./activity-event.ts";
import type { OutputSettings } from "./output-settings.ts";

const EXCERPT_LIMIT = 800;
const LINE_LIMIT = 160;

interface ExcerptState {
  used: number;
  truncated: boolean;
}

interface LineState {
  emitted: boolean;
  truncated: boolean;
}

export class TurnOutputPipeline {
  readonly #settings: OutputSettings;
  readonly #sameToolByItemId = new Map<string, string>();
  readonly #sameToolCounts = new Map<string, number>();
  readonly #sameFallbackCounts = new Map<string, number>();
  readonly #allToolItems = new Set<string>();
  readonly #excerpts = new Map<string, ExcerptState>();
  readonly #lines = new Map<string, LineState>();
  #allFallbackCount = 0;

  constructor(settings: OutputSettings) {
    this.#settings = settings;
  }

  apply(event: ActivityEvent): string | null {
    this.#releaseCompletedToolResultStream(event);
    if (event.delivery === "direct") return event.body ?? null;

    const aggregated = this.#aggregate(event);
    return aggregated ? this.#render(aggregated) : null;
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

  #render(event: ActivityEvent): string | null {
    const level = this.#settings.levels[event.tag];
    if (level === "off") return null;

    const source = sourceText(event);
    if (source === null) return null;

    const rendered = level === "line"
      ? this.#line(event, source)
      : level === "excerpt"
      ? this.#excerpt(event, source)
      : source;
    if (!rendered) return null;

    return this.#settings.labels[event.tag] === "show"
      ? `[${event.tag.toLowerCase()}] ${rendered}`
      : rendered;
  }

  #excerpt(event: ActivityEvent, source: string): string | null {
    const key = sourceKey(event.tag, event.itemId);
    const state = this.#excerpts.get(key) ?? { used: 0, truncated: false };
    this.#excerpts.set(key, state);
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
    const key = sourceKey(event.tag, event.itemId);
    const state = this.#lines.get(key) ?? { emitted: false, truncated: false };
    this.#lines.set(key, state);
    if (state.truncated) return null;

    const lines = source.split(/\r?\n/);
    const firstIndex = lines.findIndex((value) => value.trim());
    if (firstIndex === -1) return null;

    if (state.emitted) {
      state.truncated = true;
      return "...";
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
    const key = sourceKey("TOOL_RESULT", event.itemId);
    this.#excerpts.delete(key);
    this.#lines.delete(key);
  }
}

function sourceText(event: ActivityEvent): string | null {
  const parts = [event.summary, event.body].filter((value): value is string =>
    value !== undefined
  );
  return parts.length === 0 ? null : parts.join("\n");
}

function sourceKey(tag: string, itemId: string | undefined): string {
  return `${tag}:${itemId ?? `fallback:${tag}`}`;
}
