import type { ActivityEvent, ActivityToolState } from "./activity-event.ts";

export interface CodexNotification {
  method: string;
  params?: Record<string, unknown>;
}

interface ToolIdentity {
  itemId?: string;
  toolId: string;
  summary: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function status(value: unknown): string {
  return text(value) ?? "unknown";
}

function changeKind(value: unknown): string {
  if (typeof value === "string") return value;
  return text(record(value)?.type) ?? "change";
}

function scopedEvent(
  params: Record<string, unknown>,
  event: Omit<ActivityEvent, "delivery" | "threadId" | "turnId">,
): ActivityEvent {
  const turn = record(params.turn);
  const threadId = text(params.threadId);
  const turnId = text(params.turnId) ?? text(turn?.id);
  return {
    ...event,
    ...(threadId ? { threadId } : {}),
    ...(turnId ? { turnId } : {}),
    delivery: "progress",
  };
}

function itemId(params: Record<string, unknown>): string | undefined {
  return text(params.itemId) ?? text(record(params.item)?.id);
}

function toolIdentity(
  item: Record<string, unknown>,
  params: Record<string, unknown>,
): ToolIdentity | null {
  const id = text(params.itemId) ?? text(item.id);

  switch (item.type) {
    case "commandExecution": {
      const command = text(item.command) ?? "commandExecution";
      return { itemId: id, toolId: `command:${command}`, summary: command };
    }
    case "fileChange":
      return { itemId: id, toolId: "file:fileChange", summary: "file change" };
    case "mcpToolCall": {
      const tool = `${text(item.server) ?? "mcp"}/${
        text(item.tool) ?? "unknown"
      }`;
      return { itemId: id, toolId: `mcp:${tool}`, summary: tool };
    }
    case "dynamicToolCall": {
      const tool = `${text(item.namespace) ?? "dynamic"}/${
        text(item.tool) ?? "unknown"
      }`;
      return { itemId: id, toolId: `dynamic:${tool}`, summary: tool };
    }
    case "collabToolCall":
    case "collabAgentToolCall": {
      const tool = text(item.tool) ?? "collaboration";
      return { itemId: id, toolId: `collaboration:${tool}`, summary: tool };
    }
    case "webSearch": {
      const query = text(item.query) ?? "web search";
      return { itemId: id, toolId: `web-search:${query}`, summary: query };
    }
    default:
      return null;
  }
}

function completedToolBody(item: Record<string, unknown>): string | undefined {
  switch (item.type) {
    case "commandExecution": {
      const exit = typeof item.exitCode === "number"
        ? `, exit ${item.exitCode}`
        : "";
      return `${status(item.status)}${exit}`;
    }
    case "fileChange": {
      const changes = Array.isArray(item.changes)
        ? item.changes.flatMap((value) => {
          const change = record(value);
          const path = text(change?.path);
          return path ? [`${changeKind(change?.kind)} ${path}`] : [];
        })
        : [];
      return [status(item.status), ...changes].join("\n");
    }
    case "mcpToolCall":
    case "dynamicToolCall":
    case "collabToolCall":
    case "collabAgentToolCall":
      return status(item.status);
    // Web-search completion is intentionally textless but still closes a tool.
    case "webSearch":
      return undefined;
    default:
      return undefined;
  }
}

function toolLifecycle(
  state: ActivityToolState,
  item: Record<string, unknown>,
  params: Record<string, unknown>,
): ActivityEvent | null {
  const identity = toolIdentity(item, params);
  if (!identity) return null;
  const body = state === "completed" ? completedToolBody(item) : undefined;

  return scopedEvent(params, {
    tag: "TOOL",
    summary: identity.summary,
    ...(body !== undefined ? { body } : {}),
    ...(identity.itemId ? { itemId: identity.itemId } : {}),
    toolId: identity.toolId,
    toolState: state,
  });
}

function toolResult(
  params: Record<string, unknown>,
  value: unknown,
  toolId?: string,
): ActivityEvent {
  const body = text(value);
  const id = itemId(params);
  return scopedEvent(params, {
    tag: "TOOL_RESULT",
    ...(body !== undefined ? { body } : {}),
    ...(id ? { itemId: id } : {}),
    ...(toolId ? { toolId } : {}),
  });
}

export function describeCodexNotification(
  notification: CodexNotification,
): ActivityEvent | null {
  const params = notification.params ?? {};

  switch (notification.method) {
    case "item/reasoning/summaryTextDelta": {
      const body = text(params.delta);
      return scopedEvent(params, {
        tag: "CONTENT",
        ...(body !== undefined ? { body } : {}),
      });
    }
    case "item/reasoning/textDelta":
    case "item/reasoning/summaryPartAdded":
    case "item/agentMessage/delta":
      return null;
    case "item/commandExecution/outputDelta":
    case "command/exec/outputDelta":
    case "process/outputDelta":
    case "item/fileChange/outputDelta":
      return toolResult(params, params.delta);
    case "item/mcpToolCall/progress":
      return toolResult(params, params.message, "mcpToolCall");
    case "item/started": {
      const item = record(params.item);
      return item ? toolLifecycle("started", item, params) : null;
    }
    case "item/completed": {
      const item = record(params.item);
      if (!item) return null;
      const tool = toolLifecycle("completed", item, params);
      if (tool) return tool;
      if (item.type === "agentMessage" && item.phase === "commentary") {
        const body = text(item.text);
        return scopedEvent(params, {
          tag: "CONTENT",
          summary: "Codex",
          ...(body !== undefined ? { body } : {}),
        });
      }
      if (item.type === "plan") {
        const body = text(item.text);
        return scopedEvent(params, {
          tag: "PLAN",
          ...(body !== undefined ? { body } : {}),
        });
      }
      return null;
    }
    case "turn/started":
      return scopedEvent(params, {
        tag: "TURN",
        body: "started",
      });
    case "turn/completed": {
      const turn = record(params.turn);
      return scopedEvent(params, {
        tag: "TURN",
        body: status(turn?.status),
      });
    }
    case "error": {
      const error = record(params.error);
      const body = text(error?.message);
      return scopedEvent(params, {
        tag: "ERROR",
        ...(body !== undefined ? { body } : {}),
      });
    }
    case "warning":
    case "guardianWarning":
    case "configWarning": {
      const body = text(params.message);
      return scopedEvent(params, {
        tag: "WARNING",
        ...(body !== undefined ? { body } : {}),
      });
    }
    default:
      return null;
  }
}
