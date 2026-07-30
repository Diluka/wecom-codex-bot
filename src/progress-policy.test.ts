import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import {
  type CodexNotification,
  describeCodexNotification,
} from "./codex-events.ts";
import type { ActivityEvent } from "./activity-event.ts";
import type { ProgressSettings } from "./output-settings.ts";
import { TurnProgressPolicy } from "./progress-policy.ts";

const fullVerbose: ProgressSettings = {
  intermediateOutput: "full",
  statusDetail: "verbose",
};

function eventFor(notification: CodexNotification): ActivityEvent {
  const event = describeCodexNotification(notification);
  if (!event) throw new Error(`Expected event for ${notification.method}`);
  return event;
}

function commandStarted(
  itemId: string,
  command = "deno test",
): ActivityEvent {
  return eventFor({
    method: "item/started",
    params: { item: { id: itemId, type: "commandExecution", command } },
  });
}

function commandCompleted(
  itemId: string,
  command = "deno test",
): ActivityEvent {
  return eventFor({
    method: "item/completed",
    params: {
      item: {
        id: itemId,
        type: "commandExecution",
        command,
        status: "completed",
        exitCode: 0,
      },
    },
  });
}

describe("TurnProgressPolicy", () => {
  it("preserves content, tool results, and lifecycle output by default", () => {
    const policy = new TurnProgressPolicy(fullVerbose);

    assertEquals(
      policy.apply(eventFor({
        method: "item/reasoning/summaryTextDelta",
        params: { delta: "safe summary" },
      })),
      "safe summary",
    );
    assertEquals(
      policy.apply(eventFor({
        method: "process/outputDelta",
        params: { delta: "stdout\n" },
      })),
      "stdout\n",
    );
    assertEquals(
      policy.apply(eventFor({
        method: "item/mcpToolCall/progress",
        params: { message: "querying" },
      })),
      "[tool] querying\n",
    );
    assertEquals(policy.apply(commandStarted("command-1")), "\n$ deno test\n");
    assertEquals(
      policy.apply(commandCompleted("command-1")),
      "[command completed, exit 0]\n",
    );
  });

  it("hides only tool result content in no_tool_results mode", () => {
    const policy = new TurnProgressPolicy({
      intermediateOutput: "no_tool_results",
      statusDetail: "verbose",
    });

    assertEquals(
      policy.apply(eventFor({
        method: "item/commandExecution/outputDelta",
        params: { delta: "stdout\n" },
      })),
      null,
    );
    assertEquals(policy.apply(commandStarted("command-1")), "\n$ deno test\n");
  });

  it("uses per-tool reference counts until the final matching completion", () => {
    const policy = new TurnProgressPolicy({
      intermediateOutput: "merge_same_tool",
      statusDetail: "verbose",
    });

    assertEquals(policy.apply(commandStarted("command-1")), "\n$ deno test\n");
    assertEquals(policy.apply(commandStarted("command-2")), null);
    assertEquals(policy.apply(commandStarted("command-2")), null);
    assertEquals(policy.apply(commandCompleted("command-1")), null);
    assertEquals(policy.apply(commandCompleted("command-1")), null);
    assertEquals(
      policy.apply(commandCompleted("command-2")),
      "[command completed, exit 0]\n",
    );
    assertEquals(policy.apply(commandStarted("command-3")), "\n$ deno test\n");
  });

  it("aggregates all tools and ignores unknown or duplicate completions", () => {
    const policy = new TurnProgressPolicy({
      intermediateOutput: "merge_all_tools",
      statusDetail: "verbose",
    });

    assertEquals(
      policy.apply(commandStarted("command-1", "deno test")),
      "[tools] running\n",
    );
    assertEquals(policy.apply(commandStarted("command-2", "git status")), null);
    assertEquals(policy.apply(commandCompleted("unknown")), null);
    assertEquals(policy.apply(commandCompleted("command-1")), null);
    assertEquals(policy.apply(commandCompleted("command-1")), null);
    assertEquals(
      policy.apply(commandCompleted("command-2", "git status")),
      "[tools completed]\n",
    );
  });

  it("releases every active-tool cache entry when cleared", () => {
    const policy = new TurnProgressPolicy({
      intermediateOutput: "merge_same_tool",
      statusDetail: "verbose",
    });

    assertEquals(policy.apply(commandStarted("command-1")), "\n$ deno test\n");
    policy.clear();
    assertEquals(policy.apply(commandCompleted("command-1")), null);
    assertEquals(policy.apply(commandStarted("command-2")), "\n$ deno test\n");
  });

  it("preserves legacy file and provider tool lifecycle lines during transition", () => {
    const policy = new TurnProgressPolicy(fullVerbose);

    assertEquals(
      policy.apply(eventFor({
        method: "item/started",
        params: { item: { id: "file-1", type: "fileChange" } },
      })),
      "\n[files] applying changes\n",
    );
    assertEquals(
      policy.apply(eventFor({
        method: "item/completed",
        params: {
          item: {
            id: "file-1",
            type: "fileChange",
            status: "completed",
            changes: [
              { path: "/repo/a.ts", kind: "update" },
              { path: "/repo/b.ts", kind: "add" },
            ],
          },
        },
      })),
      "[files completed] update /repo/a.ts, add /repo/b.ts\n",
    );
    assertEquals(
      policy.apply(eventFor({
        method: "item/completed",
        params: {
          item: {
            id: "mcp-1",
            type: "mcpToolCall",
            server: "dbhub",
            tool: "execute_sql",
            status: "completed",
          },
        },
      })),
      "[tool dbhub/execute_sql completed]\n",
    );
  });

  it("keeps textless legacy commentary hidden while retaining its raw event", () => {
    const policy = new TurnProgressPolicy(fullVerbose);

    assertEquals(
      policy.apply(eventFor({
        method: "item/completed",
        params: {
          item: { type: "agentMessage", phase: "commentary" },
        },
      })),
      null,
    );
  });

  it("keeps only turn statuses at turn detail and preserves critical errors at none", () => {
    const turnOnly = new TurnProgressPolicy({
      intermediateOutput: "full",
      statusDetail: "turn",
    });
    assertEquals(turnOnly.apply(commandStarted("command-1")), null);
    assertEquals(
      turnOnly.apply(eventFor({ method: "turn/started", params: {} })),
      "[turn started]\n",
    );

    const noIntermediate = new TurnProgressPolicy({
      intermediateOutput: "none",
      statusDetail: "verbose",
    });
    assertEquals(
      noIntermediate.apply(eventFor({
        method: "item/reasoning/summaryTextDelta",
        params: { delta: "safe summary" },
      })),
      null,
    );
    assertEquals(noIntermediate.apply(commandStarted("command-1")), null);
    assertEquals(
      noIntermediate.apply(eventFor({
        method: "error",
        params: { error: { message: "failed" } },
      })),
      "[error] failed\n",
    );
    assertEquals(
      noIntermediate.apply(eventFor({ method: "warning", params: {} })),
      null,
    );
    assertEquals(
      noIntermediate.apply(
        eventFor({ method: "error", params: { error: {} } }),
      ),
      "[error]\n",
    );
  });
});
