import type { ActivityEvent } from "./activity-event.ts";
import { type ProgressSettings, shouldShowStatus } from "./output-settings.ts";

// Temporary compatibility for the untouched runtime. New output behavior lives
// exclusively in TurnOutputPipeline and will replace this policy on integration.
export class TurnProgressPolicy {
  readonly #settings: ProgressSettings;
  readonly #toolByItemId = new Map<string, string>();
  readonly #activeToolCounts = new Map<string, number>();
  readonly #activeToolItems = new Set<string>();

  constructor(settings: ProgressSettings) {
    this.#settings = settings;
  }

  apply(event: ActivityEvent): string | null {
    switch (event.tag) {
      case "CONTENT":
        return this.#settings.intermediateOutput === "none"
          ? null
          : legacyContent(event);
      case "TOOL_RESULT":
        return this.#settings.intermediateOutput === "full"
          ? legacyToolResult(event)
          : null;
      case "TURN":
        return shouldShowStatus(this.#settings, "turn")
          ? legacyTurn(event)
          : null;
      case "WARNING":
        return event.body === undefined
          ? null
          : legacyTagged("warning", event.body);
      case "ERROR":
        return legacyTagged("error", event.body);
      case "PLAN":
        return this.#settings.intermediateOutput === "none"
          ? null
          : event.body === undefined
          ? null
          : `\n[plan]\n${event.body}\n`;
      case "TOOL":
        return event.toolState === "started"
          ? this.#toolStarted(event)
          : event.toolState === "completed"
          ? this.#toolCompleted(event)
          : null;
      default:
        return null;
    }
  }

  clear(): void {
    this.#toolByItemId.clear();
    this.#activeToolCounts.clear();
    this.#activeToolItems.clear();
  }

  #toolStarted(event: ActivityEvent): string | null {
    const rendered = legacyTool(event);
    switch (this.#settings.intermediateOutput) {
      case "merge_same_tool": {
        const first = this.#startSameTool(event);
        if (first === undefined) return this.#visibleToolStatus(rendered);
        return first ? this.#visibleToolStatus(rendered) : null;
      }
      case "merge_all_tools": {
        const first = this.#startAnyTool(event);
        if (first === undefined) return this.#visibleToolStatus(rendered);
        return first && shouldShowStatus(this.#settings, "verbose")
          ? "[tools] running\n"
          : null;
      }
      default:
        return this.#visibleToolStatus(rendered);
    }
  }

  #toolCompleted(event: ActivityEvent): string | null {
    const rendered = legacyTool(event);
    switch (this.#settings.intermediateOutput) {
      case "merge_same_tool": {
        const final = this.#completeSameTool(event);
        if (final === undefined) return this.#visibleToolStatus(rendered);
        return final ? this.#visibleToolStatus(rendered) : null;
      }
      case "merge_all_tools": {
        const final = this.#completeAnyTool(event);
        if (final === undefined) return this.#visibleToolStatus(rendered);
        return final && shouldShowStatus(this.#settings, "verbose")
          ? "[tools completed]\n"
          : null;
      }
      default:
        return this.#visibleToolStatus(rendered);
    }
  }

  #visibleToolStatus(text: string | null): string | null {
    return shouldShowStatus(this.#settings, "verbose") ? text : null;
  }

  #startSameTool(event: ActivityEvent): boolean | undefined {
    if (!event.itemId || !event.toolId) return undefined;
    if (this.#toolByItemId.has(event.itemId)) return false;

    this.#toolByItemId.set(event.itemId, event.toolId);
    const count = this.#activeToolCounts.get(event.toolId) ?? 0;
    this.#activeToolCounts.set(event.toolId, count + 1);
    return count === 0;
  }

  #completeSameTool(event: ActivityEvent): boolean | undefined {
    if (!event.itemId) return undefined;
    const toolId = this.#toolByItemId.get(event.itemId);
    if (!toolId) return false;

    this.#toolByItemId.delete(event.itemId);
    const count = this.#activeToolCounts.get(toolId) ?? 0;
    if (count <= 1) {
      this.#activeToolCounts.delete(toolId);
      return count === 1;
    }
    this.#activeToolCounts.set(toolId, count - 1);
    return false;
  }

  #startAnyTool(event: ActivityEvent): boolean | undefined {
    if (!event.itemId) return undefined;
    if (this.#activeToolItems.has(event.itemId)) return false;

    const wasEmpty = this.#activeToolItems.size === 0;
    this.#activeToolItems.add(event.itemId);
    return wasEmpty;
  }

  #completeAnyTool(event: ActivityEvent): boolean | undefined {
    if (!event.itemId) return undefined;
    if (!this.#activeToolItems.delete(event.itemId)) return false;
    return this.#activeToolItems.size === 0;
  }
}

function legacyContent(event: ActivityEvent): string | null {
  if (event.summary === "Codex") {
    return event.body === undefined ? null : `\n[Codex] ${event.body}\n`;
  }
  return event.body ?? event.summary ?? null;
}

function legacyToolResult(event: ActivityEvent): string | null {
  if (event.body === undefined) return null;
  return event.toolId === "mcpToolCall" ? `[tool] ${event.body}\n` : event.body;
}

function legacyTurn(event: ActivityEvent): string {
  return `[turn ${event.body ?? "unknown"}]\n`;
}

function legacyTagged(tag: string, body: string | undefined): string {
  return body === undefined ? `[${tag}]\n` : `[${tag}] ${body}\n`;
}

function legacyTool(event: ActivityEvent): string | null {
  const [kind] = event.toolId?.split(":", 1) ?? [];
  const summary = event.summary ?? "unknown";

  switch (kind) {
    case "command":
      return event.toolState === "started"
        ? `\n$ ${summary}\n`
        : `[command ${event.body ?? "unknown"}]\n`;
    case "file":
      if (event.toolState === "started") return "\n[files] applying changes\n";
      return legacyFileCompletion(event.body);
    case "mcp":
    case "dynamic":
      return event.toolState === "started"
        ? `\n[tool] ${summary}\n`
        : `[tool ${summary} ${event.body ?? "unknown"}]\n`;
    case "collaboration":
      return event.toolState === "started"
        ? `\n[agent] ${summary}\n`
        : `[agent ${summary} ${event.body ?? "unknown"}]\n`;
    case "web-search":
      return event.toolState === "started"
        ? `\n[web search] ${summary}\n`
        : null;
    default:
      return null;
  }
}

function legacyFileCompletion(body: string | undefined): string {
  const [status = "unknown", ...changes] = (body ?? "unknown").split("\n");
  const suffix = changes.length ? ` ${changes.join(", ")}` : "";
  return `[files ${status}]${suffix}\n`;
}
