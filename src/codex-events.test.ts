import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { describeCodexNotification } from "./codex-events.ts";

describe("describeCodexNotification", () => {
  it("keeps safe reasoning summaries as raw content and omits private deltas", () => {
    assertEquals(
      describeCodexNotification({
        method: "item/reasoning/summaryTextDelta",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          delta: "正在定位调用链",
        },
      }),
      {
        tag: "CONTENT",
        body: "正在定位调用链",
        threadId: "thread-1",
        turnId: "turn-1",
        delivery: "progress",
      },
    );
    assertEquals(
      describeCodexNotification({
        method: "item/reasoning/textDelta",
        params: { delta: "private chain of thought" },
      }),
      null,
    );
    assertEquals(
      describeCodexNotification({
        method: "item/agentMessage/delta",
        params: { delta: "draft answer" },
      }),
      null,
    );
  });

  it("keeps commentary raw and reserves final answers for turn outcomes", () => {
    assertEquals(
      describeCodexNotification({
        method: "item/completed",
        params: {
          item: {
            type: "agentMessage",
            phase: "commentary",
            text: "我在运行测试。",
          },
        },
      }),
      {
        tag: "CONTENT",
        body: "我在运行测试。",
        delivery: "progress",
      },
    );
    assertEquals(
      describeCodexNotification({
        method: "item/completed",
        params: {
          item: { type: "agentMessage", phase: "final_answer", text: "完成" },
        },
      }),
      null,
    );
  });

  it("adapts tool lifecycle events with raw identities and state", () => {
    assertEquals(
      describeCodexNotification({
        method: "item/started",
        params: {
          threadId: "thread-2",
          turnId: "turn-2",
          itemId: "command-param-id",
          item: {
            id: "command-item-id",
            type: "commandExecution",
            command: "deno test --all",
          },
        },
      }),
      {
        tag: "TOOL",
        summary: "deno test --all",
        threadId: "thread-2",
        turnId: "turn-2",
        itemId: "command-param-id",
        toolId: "command:deno test --all",
        toolState: "started",
        delivery: "progress",
      },
    );

    const cases = [
      {
        item: { id: "file-1", type: "fileChange" },
        toolId: "file:fileChange",
      },
      {
        item: {
          id: "mcp-1",
          type: "mcpToolCall",
          server: "dbhub",
          tool: "execute_sql",
        },
        toolId: "mcp:dbhub/execute_sql",
      },
      {
        item: {
          id: "dynamic-1",
          type: "dynamicToolCall",
          namespace: "functions",
          tool: "exec",
        },
        toolId: "dynamic:functions/exec",
      },
      {
        item: {
          id: "collab-1",
          type: "collabToolCall",
          tool: "spawn_agent",
        },
        toolId: "collaboration:spawn_agent",
      },
      {
        item: {
          id: "search-1",
          type: "webSearch",
          query: "Codex app server",
        },
        toolId: "web-search:Codex app server",
      },
    ];

    for (const { item, toolId } of cases) {
      const event = describeCodexNotification({
        method: "item/started",
        params: { item },
      });
      assertEquals(event?.tag, "TOOL");
      assertEquals(event?.itemId, item.id);
      assertEquals(event?.toolId, toolId);
      assertEquals(event?.toolState, "started");
      assertEquals(event?.delivery, "progress");
    }
  });

  it("classifies plans, turn statuses, warnings, errors, and raw tool deltas", () => {
    assertEquals(
      describeCodexNotification({
        method: "item/commandExecution/outputDelta",
        params: {
          threadId: "thread-3",
          turnId: "turn-3",
          itemId: "command-3",
          delta: "stdout\\n",
        },
      }),
      {
        tag: "TOOL_RESULT",
        body: "stdout\\n",
        threadId: "thread-3",
        turnId: "turn-3",
        itemId: "command-3",
        delivery: "progress",
      },
    );
    assertEquals(
      describeCodexNotification({
        method: "item/mcpToolCall/progress",
        params: { itemId: "mcp-3", message: "正在查询" },
      }),
      {
        tag: "TOOL_RESULT",
        body: "正在查询",
        itemId: "mcp-3",
        toolId: "mcpToolCall",
        delivery: "progress",
      },
    );
    assertEquals(
      describeCodexNotification({
        method: "item/completed",
        params: { item: { type: "plan", text: "1. Run tests" } },
      }),
      { tag: "PLAN", body: "1. Run tests", delivery: "progress" },
    );
    assertEquals(
      describeCodexNotification({ method: "turn/started", params: {} }),
      { tag: "TURN", body: "started", delivery: "progress" },
    );
    assertEquals(
      describeCodexNotification({
        method: "turn/completed",
        params: { turn: { status: "completed" } },
      }),
      { tag: "TURN", body: "completed", delivery: "progress" },
    );
    assertEquals(
      describeCodexNotification({
        method: "warning",
        params: { message: "watch out" },
      }),
      { tag: "WARNING", body: "watch out", delivery: "progress" },
    );
    assertEquals(
      describeCodexNotification({
        method: "error",
        params: { error: { message: "failed" } },
      }),
      { tag: "ERROR", body: "failed", delivery: "progress" },
    );
  });

  it("preserves a textless web-search completion so aggregation can release it", () => {
    const event = describeCodexNotification({
      method: "item/completed",
      params: {
        item: {
          id: "search-1",
          type: "webSearch",
          query: "Codex app server",
          status: "completed",
        },
      },
    });

    assertEquals(event, {
      tag: "TOOL",
      summary: "Codex app server",
      itemId: "search-1",
      toolId: "web-search:Codex app server",
      toolState: "completed",
      delivery: "progress",
    });
    assertEquals(event?.body, undefined);
  });

  it("ignores unknown notifications", () => {
    assertEquals(
      describeCodexNotification({ method: "future/notification", params: {} }),
      null,
    );
  });
});
