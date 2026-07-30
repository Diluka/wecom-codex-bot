import { type CodexProgressEvent } from "./codex-events.ts";
import { type ProgressSettings, shouldShowStatus } from "./output-settings.ts";

export class TurnProgressPolicy {
  readonly #settings: ProgressSettings;
  readonly #toolByItemId = new Map<string, string>();
  readonly #activeToolCounts = new Map<string, number>();
  readonly #activeToolItems = new Set<string>();

  constructor(settings: ProgressSettings) {
    this.#settings = settings;
  }

  apply(event: CodexProgressEvent): string | null {
    switch (event.category) {
      case "content":
        return this.#settings.intermediateOutput === "none" ? null : event.text;
      case "tool_result":
        return this.#settings.intermediateOutput === "full" ? event.text : null;
      case "turn_status":
        return shouldShowStatus(this.#settings, "turn") ? event.text : null;
      case "critical":
        return event.text;
      case "tool_started":
        return this.#toolStarted(event);
      case "tool_completed":
        return this.#toolCompleted(event);
    }
  }

  clear(): void {
    this.#toolByItemId.clear();
    this.#activeToolCounts.clear();
    this.#activeToolItems.clear();
  }

  #toolStarted(event: CodexProgressEvent): string | null {
    switch (this.#settings.intermediateOutput) {
      case "merge_same_tool": {
        const first = this.#startSameTool(event);
        if (first === undefined) return this.#visibleToolStatus(event.text);
        return first ? this.#visibleToolStatus(event.text) : null;
      }
      case "merge_all_tools": {
        const first = this.#startAnyTool(event);
        if (first === undefined) return this.#visibleToolStatus(event.text);
        return first && shouldShowStatus(this.#settings, "verbose")
          ? "[tools] running\n"
          : null;
      }
      default:
        return this.#visibleToolStatus(event.text);
    }
  }

  #toolCompleted(event: CodexProgressEvent): string | null {
    switch (this.#settings.intermediateOutput) {
      case "merge_same_tool": {
        const final = this.#completeSameTool(event);
        if (final === undefined) return this.#visibleToolStatus(event.text);
        return final ? this.#visibleToolStatus(event.text) : null;
      }
      case "merge_all_tools": {
        const final = this.#completeAnyTool(event);
        if (final === undefined) return this.#visibleToolStatus(event.text);
        return final && shouldShowStatus(this.#settings, "verbose")
          ? "[tools completed]\n"
          : null;
      }
      default:
        return this.#visibleToolStatus(event.text);
    }
  }

  #visibleToolStatus(text: string | null): string | null {
    return shouldShowStatus(this.#settings, "verbose") ? text : null;
  }

  #startSameTool(event: CodexProgressEvent): boolean | undefined {
    if (!event.itemId || !event.toolKey) return undefined;
    if (this.#toolByItemId.has(event.itemId)) return false;

    this.#toolByItemId.set(event.itemId, event.toolKey);
    const count = this.#activeToolCounts.get(event.toolKey) ?? 0;
    this.#activeToolCounts.set(event.toolKey, count + 1);
    return count === 0;
  }

  #completeSameTool(event: CodexProgressEvent): boolean | undefined {
    if (!event.itemId) return undefined;
    const toolKey = this.#toolByItemId.get(event.itemId);
    if (!toolKey) return false;

    this.#toolByItemId.delete(event.itemId);
    const count = this.#activeToolCounts.get(toolKey) ?? 0;
    if (count <= 1) {
      this.#activeToolCounts.delete(toolKey);
      return count === 1;
    }
    this.#activeToolCounts.set(toolKey, count - 1);
    return false;
  }

  #startAnyTool(event: CodexProgressEvent): boolean | undefined {
    if (!event.itemId) return undefined;
    if (this.#activeToolItems.has(event.itemId)) return false;

    const wasEmpty = this.#activeToolItems.size === 0;
    this.#activeToolItems.add(event.itemId);
    return wasEmpty;
  }

  #completeAnyTool(event: CodexProgressEvent): boolean | undefined {
    if (!event.itemId) return undefined;
    if (!this.#activeToolItems.delete(event.itemId)) return false;
    return this.#activeToolItems.size === 0;
  }
}
