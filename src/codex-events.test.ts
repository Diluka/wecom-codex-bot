import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { renderCodexNotification } from "./codex-events.ts";

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
