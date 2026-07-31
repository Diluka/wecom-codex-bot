import type { ActivityEvent, ActivityToolState } from "./activity-event.ts";

export interface CodexNotification {
  method: string;
  params?: Record<string, unknown>;
}

export type SubagentStatus =
  | "starting"
  | "working"
  | "cancelled"
  | "completed"
  | "failed";

export interface SubagentStatusUpdate {
  threadId?: string;
  turnId?: string;
  agentThreadId: string;
  status: SubagentStatus;
}

interface ToolMetadata {
  itemId?: string;
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

const COLLAB_AGENT_STATUSES: Readonly<Record<string, SubagentStatus>> = {
  pendingInit: "starting",
  running: "working",
  completed: "completed",
  errored: "failed",
  notFound: "failed",
  shutdown: "cancelled",
};

const SUBAGENT_ACTIVITY_STATUSES: Readonly<Record<string, SubagentStatus>> = {
  started: "working",
  interacted: "working",
  interrupted: "cancelled",
};

function subagentStatusUpdate(
  params: Record<string, unknown>,
  agentThreadId: string,
  status: SubagentStatus,
): SubagentStatusUpdate {
  const threadId = text(params.threadId);
  const turnId = text(params.turnId);
  return {
    ...(threadId ? { threadId } : {}),
    ...(turnId ? { turnId } : {}),
    agentThreadId,
    status,
  };
}

function collaborationStatusUpdates(
  params: Record<string, unknown>,
  item: Record<string, unknown>,
): SubagentStatusUpdate[] {
  const statuses = new Map<string, SubagentStatus>();
  const receiverThreadIds = Array.isArray(item.receiverThreadIds)
    ? item.receiverThreadIds
    : [];

  for (const receiverThreadId of receiverThreadIds) {
    const agentThreadId = text(receiverThreadId);
    if (agentThreadId) statuses.set(agentThreadId, "starting");
  }

  const agentsStates = record(item.agentsStates);
  if (agentsStates) {
    for (const [agentThreadId, agentState] of Object.entries(agentsStates)) {
      const protocolStatus = text(record(agentState)?.status);
      const status = protocolStatus
        ? COLLAB_AGENT_STATUSES[protocolStatus]
        : undefined;
      if (!agentThreadId) continue;
      if (status) {
        statuses.set(agentThreadId, status);
      } else {
        statuses.delete(agentThreadId);
      }
    }
  }

  return [...statuses].map(([agentThreadId, status]) =>
    subagentStatusUpdate(params, agentThreadId, status)
  );
}

export function describeSubagentStatusUpdates(
  notification: CodexNotification,
): SubagentStatusUpdate[] {
  const params = notification.params;
  const item = record(params?.item);
  if (!params || !item) return [];

  if (item.type === "collabAgentToolCall") {
    return collaborationStatusUpdates(params, item);
  }
  if (item.type !== "subAgentActivity") return [];

  const agentThreadId = text(item.agentThreadId);
  const kind = text(item.kind);
  const status = kind ? SUBAGENT_ACTIVITY_STATUSES[kind] : undefined;
  return agentThreadId && status
    ? [subagentStatusUpdate(params, agentThreadId, status)]
    : [];
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

function toolMetadata(
  item: Record<string, unknown>,
  params: Record<string, unknown>,
): ToolMetadata | null {
  const id = text(params.itemId) ?? text(item.id);

  switch (item.type) {
    case "commandExecution": {
      const command = text(item.command) ?? "commandExecution";
      return { itemId: id, summary: command };
    }
    case "fileChange":
      return { itemId: id, summary: "file change" };
    case "mcpToolCall": {
      const tool = `${text(item.server) ?? "mcp"}/${
        text(item.tool) ?? "unknown"
      }`;
      return { itemId: id, summary: tool };
    }
    case "dynamicToolCall": {
      const tool = `${text(item.namespace) ?? "dynamic"}/${
        text(item.tool) ?? "unknown"
      }`;
      return { itemId: id, summary: tool };
    }
    case "collabToolCall":
    case "collabAgentToolCall": {
      const tool = text(item.tool) ?? "collaboration";
      return { itemId: id, summary: tool };
    }
    case "webSearch": {
      const query = text(item.query) ?? "web search";
      return { itemId: id, summary: query };
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
  const metadata = toolMetadata(item, params);
  if (!metadata) return null;
  const body = state === "completed" ? completedToolBody(item) : undefined;

  return scopedEvent(params, {
    tag: "TOOL",
    summary: metadata.summary,
    ...(body !== undefined ? { body } : {}),
    ...(metadata.itemId ? { itemId: metadata.itemId } : {}),
    toolState: state,
  });
}

function toolResult(
  params: Record<string, unknown>,
  value: unknown,
): ActivityEvent {
  const body = text(value);
  const id = itemId(params);
  return scopedEvent(params, {
    tag: "TOOL_RESULT",
    ...(body !== undefined ? { body } : {}),
    ...(id ? { itemId: id } : {}),
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
      return toolResult(params, params.message);
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
