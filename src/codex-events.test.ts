import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  describeCodexNotification,
  renderCodexNotification,
} from "./codex-events.ts";

describe("renderCodexNotification", () => {
  it("exposes reasoning summaries but never raw reasoning", () => {
    assertEquals(
      renderCodexNotification({
        method: "item/reasoning/summaryTextDelta",
        params: { delta: "正在定位调用链" },
      }),
      "正在定位调用链",
    );
    assertEquals(
      renderCodexNotification({
        method: "item/reasoning/textDelta",
        params: { delta: "private chain of thought" },
      }),
      null,
    );
  });

  it("shows commentary but reserves final answers", () => {
    assertEquals(
      renderCodexNotification({
        method: "item/completed",
        params: {
          item: {
            type: "agentMessage",
            phase: "commentary",
            text: "我在运行测试。",
          },
        },
      }),
      "\n[Codex] 我在运行测试。\n",
    );
    assertEquals(
      renderCodexNotification({
        method: "item/completed",
        params: {
          item: { type: "agentMessage", phase: "final_answer", text: "完成" },
        },
      }),
      null,
    );
  });

  it("renders command lifecycle and output", () => {
    assertEquals(
      renderCodexNotification({
        method: "item/started",
        params: { item: { type: "commandExecution", command: "deno test" } },
      }),
      "\n$ deno test\n",
    );
    assertEquals(
      renderCodexNotification({
        method: "item/commandExecution/outputDelta",
        params: { delta: "3 passed\n" },
      }),
      "3 passed\n",
    );
    assertEquals(
      renderCodexNotification({
        method: "item/completed",
        params: {
          item: { type: "commandExecution", status: "completed", exitCode: 0 },
        },
      }),
      "[command completed, exit 0]\n",
    );
  });

  it("summarizes file and tool changes", () => {
    assertEquals(
      renderCodexNotification({
        method: "item/completed",
        params: {
          item: {
            type: "fileChange",
            status: "completed",
            changes: [
              { path: "/repo/a.ts", kind: "update" },
              { path: "/repo/b.ts", kind: "add" },
            ],
          },
        },
      }),
      "[files completed] update /repo/a.ts, add /repo/b.ts\n",
    );
    assertEquals(
      renderCodexNotification({
        method: "item/mcpToolCall/progress",
        params: { message: "正在查询" },
      }),
      "[tool] 正在查询\n",
    );
    assertEquals(
      renderCodexNotification({
        method: "item/started",
        params: { item: { type: "collabToolCall", tool: "spawnAgent" } },
      }),
      "\n[agent] spawnAgent\n",
    );
    assertEquals(
      renderCodexNotification({
        method: "item/completed",
        params: {
          item: {
            type: "collabToolCall",
            tool: "spawnAgent",
            status: "completed",
          },
        },
      }),
      "[agent spawnAgent completed]\n",
    );
  });

  it("ignores unknown notifications", () => {
    assertEquals(
      renderCodexNotification({ method: "future/notification", params: {} }),
      null,
    );
  });
});

describe("describeCodexNotification", () => {
  it("classifies lifecycle events with stable item and tool identities", () => {
    assertEquals(
      describeCodexNotification({
        method: "item/started",
        params: {
          itemId: "command-param-id",
          item: {
            id: "command-item-id",
            type: "commandExecution",
            command: "deno test --all",
          },
        },
      }),
      {
        category: "tool_started",
        text: "\n$ deno test --all\n",
        itemId: "command-param-id",
        toolKey: "deno test --all",
      },
    );

    const cases = [
      {
        item: { id: "file-1", type: "fileChange" },
        toolKey: "fileChange",
      },
      {
        item: {
          id: "mcp-1",
          type: "mcpToolCall",
          server: "dbhub",
          tool: "execute_sql",
        },
        toolKey: "dbhub/execute_sql",
      },
      {
        item: {
          id: "dynamic-1",
          type: "dynamicToolCall",
          namespace: "functions",
          tool: "exec",
        },
        toolKey: "functions/exec",
      },
      {
        item: {
          id: "collab-1",
          type: "collabToolCall",
          tool: "spawn_agent",
        },
        toolKey: "spawn_agent",
      },
      {
        item: {
          id: "search-1",
          type: "webSearch",
          query: "Codex app server",
        },
        toolKey: "Codex app server",
      },
    ];

    for (const { item, toolKey } of cases) {
      const event = describeCodexNotification({
        method: "item/started",
        params: { item },
      });
      assertEquals(event?.category, "tool_started");
      assertEquals(event?.itemId, item.id);
      assertEquals(event?.toolKey, toolKey);
    }
  });

  it("separates content, tool results, turn statuses, and critical events", () => {
    const cases = [
      {
        notification: {
          method: "item/reasoning/summaryTextDelta",
          params: { delta: "safe summary" },
        },
        category: "content",
      },
      {
        notification: {
          method: "process/outputDelta",
          params: { delta: "stdout" },
        },
        category: "tool_result",
      },
      {
        notification: { method: "turn/started", params: {} },
        category: "turn_status",
      },
      {
        notification: {
          method: "warning",
          params: { message: "watch out" },
        },
        category: "critical",
      },
    ] as const;

    for (const { notification, category } of cases) {
      assertEquals(describeCodexNotification(notification)?.category, category);
    }
  });

  it("classifies a web-search completion even when legacy rendering has no text", () => {
    const notification = {
      method: "item/completed",
      params: {
        item: {
          id: "search-1",
          type: "webSearch",
          query: "Codex app server",
          status: "completed",
        },
      },
    };

    assertEquals(renderCodexNotification(notification), null);
    assertEquals(describeCodexNotification(notification), {
      category: "tool_completed",
      text: null,
      itemId: "search-1",
      toolKey: "Codex app server",
    });
  });
});
