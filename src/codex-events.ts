export interface CodexNotification {
  method: string;
  params?: Record<string, unknown>;
}

export type CodexProgressCategory =
  | "content"
  | "tool_result"
  | "turn_status"
  | "critical"
  | "tool_started"
  | "tool_completed";

export interface CodexProgressEvent {
  category: CodexProgressCategory;
  text: string | null;
  itemId?: string;
  toolKey?: string;
}

interface ToolIdentity {
  itemId?: string;
  toolKey: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function status(value: unknown): string {
  return text(value) ?? "unknown";
}

function changeKind(value: unknown): string {
  if (typeof value === "string") return value;
  return text(record(value)?.type) ?? "change";
}

function toolIdentity(
  item: Record<string, unknown>,
  params: Record<string, unknown>,
): ToolIdentity | null {
  const itemId = text(params.itemId) ?? text(item.id) ?? undefined;

  switch (item.type) {
    case "commandExecution":
      return { itemId, toolKey: text(item.command) ?? "commandExecution" };
    case "fileChange":
      return { itemId, toolKey: "fileChange" };
    case "mcpToolCall":
      return {
        itemId,
        toolKey: `${text(item.server) ?? "mcp"}/${
          text(item.tool) ?? "unknown"
        }`,
      };
    case "dynamicToolCall":
      return {
        itemId,
        toolKey: `${text(item.namespace) ?? "dynamic"}/${
          text(item.tool) ?? "unknown"
        }`,
      };
    case "collabToolCall":
    case "collabAgentToolCall":
      return {
        itemId,
        toolKey: text(item.tool) ?? "collaboration",
      };
    case "webSearch":
      return { itemId, toolKey: text(item.query) ?? "webSearch" };
    default:
      return null;
  }
}

function renderStarted(item: Record<string, unknown>): string | null {
  switch (item.type) {
    case "commandExecution":
      return text(item.command) ? `\n$ ${item.command}\n` : null;
    case "fileChange":
      return "\n[files] applying changes\n";
    case "mcpToolCall":
      return `\n[tool] ${String(item.server ?? "mcp")}/${
        String(item.tool ?? "unknown")
      }\n`;
    case "dynamicToolCall":
      return `\n[tool] ${String(item.namespace ?? "dynamic")}/${
        String(item.tool ?? "unknown")
      }\n`;
    case "collabToolCall":
    case "collabAgentToolCall":
      return `\n[agent] ${String(item.tool ?? "collaboration")}\n`;
    case "webSearch":
      return text(item.query)
        ? `\n[web search] ${item.query}\n`
        : "\n[web search]\n";
    default:
      return null;
  }
}

function renderCompleted(item: Record<string, unknown>): string | null {
  switch (item.type) {
    case "agentMessage":
      return item.phase === "commentary" && text(item.text)
        ? `\n[Codex] ${item.text}\n`
        : null;
    case "commandExecution": {
      const exit = typeof item.exitCode === "number"
        ? `, exit ${item.exitCode}`
        : "";
      return `[command ${status(item.status)}${exit}]\n`;
    }
    case "fileChange": {
      const changes = Array.isArray(item.changes)
        ? item.changes.flatMap((value) => {
          const change = record(value);
          const path = text(change?.path);
          return path ? [`${changeKind(change?.kind)} ${path}`] : [];
        })
        : [];
      const suffix = changes.length ? ` ${changes.join(", ")}` : "";
      return `[files ${status(item.status)}]${suffix}\n`;
    }
    case "mcpToolCall":
      return `[tool ${String(item.server ?? "mcp")}/${
        String(item.tool ?? "unknown")
      } ${status(item.status)}]\n`;
    case "dynamicToolCall":
      return `[tool ${String(item.namespace ?? "dynamic")}/${
        String(item.tool ?? "unknown")
      } ${status(item.status)}]\n`;
    case "collabToolCall":
    case "collabAgentToolCall":
      return `[agent ${String(item.tool ?? "collaboration")} ${
        status(item.status)
      }]\n`;
    case "plan":
      return text(item.text) ? `\n[plan]\n${item.text}\n` : null;
    default:
      return null;
  }
}

function withToolIdentity(
  category: "tool_started" | "tool_completed",
  item: Record<string, unknown>,
  params: Record<string, unknown>,
): CodexProgressEvent | null {
  const identity = toolIdentity(item, params);
  if (!identity) return null;
  return {
    category,
    text: category === "tool_started"
      ? renderStarted(item)
      : renderCompleted(item),
    ...(identity.itemId ? { itemId: identity.itemId } : {}),
    toolKey: identity.toolKey,
  };
}

export function describeCodexNotification(
  notification: CodexNotification,
): CodexProgressEvent | null {
  const params = notification.params ?? {};

  switch (notification.method) {
    case "item/reasoning/summaryTextDelta":
      return { category: "content", text: text(params.delta) };
    case "item/reasoning/textDelta":
    case "item/reasoning/summaryPartAdded":
    case "item/agentMessage/delta":
      return null;
    case "item/commandExecution/outputDelta":
    case "command/exec/outputDelta":
    case "process/outputDelta":
    case "item/fileChange/outputDelta":
      return { category: "tool_result", text: text(params.delta) };
    case "item/mcpToolCall/progress":
      return {
        category: "tool_result",
        text: text(params.message) ? `[tool] ${params.message}\n` : null,
      };
    case "item/started": {
      const item = record(params.item);
      return item ? withToolIdentity("tool_started", item, params) : null;
    }
    case "item/completed": {
      const item = record(params.item);
      if (!item) return null;
      const tool = withToolIdentity("tool_completed", item, params);
      if (tool) return tool;
      if (item.type === "agentMessage" || item.type === "plan") {
        return { category: "content", text: renderCompleted(item) };
      }
      return null;
    }
    case "turn/started":
      return { category: "turn_status", text: "[turn started]\n" };
    case "turn/completed": {
      const turn = record(params.turn);
      return {
        category: "turn_status",
        text: `[turn ${status(turn?.status)}]\n`,
      };
    }
    case "error": {
      const error = record(params.error);
      const message = text(error?.message);
      return {
        category: "critical",
        text: message ? `[error] ${message}\n` : "[error]\n",
      };
    }
    case "warning":
    case "guardianWarning":
    case "configWarning":
      return {
        category: "critical",
        text: text(params.message) ? `[warning] ${params.message}\n` : null,
      };
    default:
      return null;
  }
}

export function renderCodexNotification(
  notification: CodexNotification,
): string | null {
  return describeCodexNotification(notification)?.text ?? null;
}
