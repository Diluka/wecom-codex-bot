import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import type { ActivityEvent } from "./activity-event.ts";
import {
  OUTPUT_TAGS,
  type OutputLabel,
  type OutputLevel,
  type OutputSettings,
  type OutputTag,
  type ToolOutputFormat,
} from "./output-settings.ts";
import { TurnOutputPipeline } from "./output-pipeline.ts";

function outputSettings(
  options: {
    level?: OutputLevel;
    levels?: Partial<Record<OutputTag, OutputLevel>>;
    label?: OutputLabel;
    labels?: Partial<Record<OutputTag, OutputLabel>>;
    toolFormat?: ToolOutputFormat;
  } = {},
): OutputSettings {
  const level = options.level ?? "full";
  const label = options.label ?? "show";
  return {
    level,
    levels: {
      ...Object.fromEntries(OUTPUT_TAGS.map((tag) => [tag, level])),
      ...options.levels,
    } as Record<OutputTag, OutputLevel>,
    label,
    labels: {
      ...Object.fromEntries(OUTPUT_TAGS.map((tag) => [tag, label])),
      ...options.labels,
    } as Record<OutputTag, OutputLabel>,
    toolFormat: options.toolFormat ?? "individual",
  };
}

function progress(
  event:
    & Omit<Partial<ActivityEvent>, "delivery">
    & Pick<ActivityEvent, "tag">,
): ActivityEvent {
  return { delivery: "progress", ...event };
}

function toolStarted(
  itemId: string | undefined,
  toolId = "command:deno test",
): ActivityEvent {
  return progress({
    tag: "TOOL",
    summary: "deno test",
    body: "started",
    ...(itemId ? { itemId } : {}),
    toolId,
    toolState: "started",
  });
}

function toolCompleted(
  itemId: string | undefined,
  toolId = "command:deno test",
): ActivityEvent {
  return progress({
    tag: "TOOL",
    summary: "deno test",
    body: "completed",
    ...(itemId ? { itemId } : {}),
    toolId,
    toolState: "completed",
  });
}

describe("TurnOutputPipeline", () => {
  it("renders individual raw events with lowercase generated tag labels", () => {
    const pipeline = new TurnOutputPipeline(outputSettings());

    assertEquals(
      pipeline.apply(progress({ tag: "CONTENT", body: "safe summary" })),
      "[content] safe summary",
    );
    assertEquals(
      pipeline.apply(toolStarted("tool-1")),
      "[tool] deno test\nstarted",
    );
    assertEquals(
      pipeline.apply(toolCompleted("tool-1")),
      "[tool] deno test\ncompleted",
    );
  });

  it("merges matching concurrent tool lifecycles by their tool identity", () => {
    const pipeline = new TurnOutputPipeline(
      outputSettings({ toolFormat: "merge_same" }),
    );

    assertEquals(
      pipeline.apply(toolStarted("tool-1")),
      "[tool] deno test\nstarted",
    );
    assertEquals(pipeline.apply(toolStarted("tool-2")), null);
    assertEquals(pipeline.apply(toolCompleted("tool-1")), null);
    assertEquals(
      pipeline.apply(toolCompleted("tool-2")),
      "[tool] deno test\ncompleted",
    );
  });

  it("merges all active tools while ignoring duplicate and unknown completions", () => {
    const pipeline = new TurnOutputPipeline(
      outputSettings({ toolFormat: "merge_all" }),
    );

    assertEquals(pipeline.apply(toolStarted("tool-1")), "[tool] tools started");
    assertEquals(
      pipeline.apply(toolStarted("tool-2", "command:git status")),
      null,
    );
    assertEquals(pipeline.apply(toolCompleted("unknown")), null);
    assertEquals(pipeline.apply(toolCompleted("tool-1")), null);
    assertEquals(pipeline.apply(toolCompleted("tool-1")), null);
    assertEquals(
      pipeline.apply(toolCompleted("tool-2", "command:git status")),
      "[tool] tools completed",
    );
    assertEquals(
      pipeline.apply(toolStarted("tool-3", "command:git diff")),
      "[tool] tools started",
    );
  });

  it("tracks hidden tool starts before deciding whether to render their final completion", () => {
    const settings = outputSettings({
      toolFormat: "merge_all",
      levels: { TOOL: "off" },
    });
    const pipeline = new TurnOutputPipeline(settings);

    assertEquals(pipeline.apply(toolStarted("tool-1")), null);
    settings.levels.TOOL = "full";
    assertEquals(
      pipeline.apply(toolCompleted("tool-1")),
      "[tool] tools completed",
    );
  });

  it("uses a per-turn fallback stream for tool lifecycles without item ids", () => {
    const pipeline = new TurnOutputPipeline(
      outputSettings({ toolFormat: "merge_same" }),
    );

    assertEquals(
      pipeline.apply(toolStarted(undefined)),
      "[tool] deno test\nstarted",
    );
    assertEquals(pipeline.apply(toolStarted(undefined)), null);
    assertEquals(pipeline.apply(toolCompleted(undefined)), null);
    assertEquals(
      pipeline.apply(toolCompleted(undefined)),
      "[tool] deno test\ncompleted",
    );
  });

  it("releases textless tool completions and all state on clear", () => {
    const pipeline = new TurnOutputPipeline(
      outputSettings({ toolFormat: "merge_same" }),
    );
    const webSearch = "web-search:Codex app server";

    assertEquals(
      pipeline.apply(progress({
        tag: "TOOL",
        summary: "Codex app server",
        itemId: "search-1",
        toolId: webSearch,
        toolState: "started",
      })),
      "[tool] Codex app server",
    );
    assertEquals(
      pipeline.apply(progress({
        tag: "TOOL",
        summary: "Codex app server",
        itemId: "search-1",
        toolId: webSearch,
        toolState: "completed",
      })),
      "[tool] Codex app server",
    );
    assertEquals(
      pipeline.apply(progress({
        tag: "TOOL",
        summary: "Codex app server",
        itemId: "search-2",
        toolId: webSearch,
        toolState: "started",
      })),
      "[tool] Codex app server",
    );

    pipeline.clear();
    assertEquals(pipeline.apply(toolCompleted("search-2", webSearch)), null);
    assertEquals(
      pipeline.apply(toolStarted("tool-after-clear")),
      "[tool] deno test\nstarted",
    );
  });

  it("applies line, full, off, and label settings after choosing the raw source", () => {
    const line = new TurnOutputPipeline(
      outputSettings({ levels: { CONTENT: "line" } }),
    );
    assertEquals(
      line.apply(progress({
        tag: "CONTENT",
        body: `\n  \n${"🙂".repeat(161)}\nsecond line`,
      })),
      `[content] ${"🙂".repeat(160)}...`,
    );

    const full = new TurnOutputPipeline(outputSettings());
    assertEquals(
      full.apply(progress({ tag: "CONTENT", body: "  raw\nvalue\n" })),
      "[content]   raw\nvalue\n",
    );

    const hidden = new TurnOutputPipeline(
      outputSettings({ label: "hide", levels: { CONTENT: "full" } }),
    );
    assertEquals(
      hidden.apply(progress({ tag: "CONTENT", body: "unformatted" })),
      "unformatted",
    );

    const off = new TurnOutputPipeline(
      outputSettings({ levels: { CONTENT: "off" } }),
    );
    assertEquals(off.apply(progress({ tag: "CONTENT", body: "hidden" })), null);
  });

  it("keeps one logical line per source stream and marks omitted later content once", () => {
    const inlineBody = new TurnOutputPipeline(
      outputSettings({ levels: { TOOL_RESULT: "line" } }),
    );
    assertEquals(
      inlineBody.apply(progress({
        tag: "TOOL_RESULT",
        itemId: "inline",
        body: "\nfirst line\nsecond line",
      })),
      "[tool_result] first line...",
    );
    assertEquals(
      inlineBody.apply(progress({
        tag: "TOOL_RESULT",
        itemId: "inline",
        body: "third line",
      })),
      null,
    );

    const fragments = new TurnOutputPipeline(
      outputSettings({ levels: { TOOL_RESULT: "line" } }),
    );
    assertEquals(
      fragments.apply(progress({
        tag: "TOOL_RESULT",
        itemId: "fragments",
        body: "first fragment",
      })),
      "[tool_result] first fragment",
    );
    assertEquals(
      fragments.apply(progress({
        tag: "TOOL_RESULT",
        itemId: "fragments",
        body: "later fragment",
      })),
      "[tool_result] ...",
    );
    assertEquals(
      fragments.apply(progress({
        tag: "TOOL_RESULT",
        itemId: "fragments",
        body: "suppressed fragment",
      })),
      null,
    );
  });

  it("limits excerpts by Unicode code point across item and fallback source streams", () => {
    const pipeline = new TurnOutputPipeline(
      outputSettings({ levels: { TOOL_RESULT: "excerpt" } }),
    );
    const first = "🙂".repeat(799);

    assertEquals(
      pipeline.apply(progress({
        tag: "TOOL_RESULT",
        itemId: "tool-1",
        body: first,
      })),
      `[tool_result] ${first}`,
    );
    assertEquals(
      pipeline.apply(progress({
        tag: "TOOL_RESULT",
        itemId: "tool-1",
        body: "🙂later",
      })),
      "[tool_result] 🙂...",
    );
    assertEquals(
      pipeline.apply(progress({
        tag: "TOOL_RESULT",
        itemId: "tool-1",
        body: "suppressed",
      })),
      null,
    );
    assertEquals(
      pipeline.apply(progress({
        tag: "TOOL_RESULT",
        itemId: "tool-2",
        body: "other tool stays independent",
      })),
      "[tool_result] other tool stays independent",
    );

    const fallback = new TurnOutputPipeline(
      outputSettings({
        levels: { TOOL_RESULT: "excerpt", CONTENT: "excerpt" },
      }),
    );
    assertEquals(
      fallback.apply(progress({
        tag: "TOOL_RESULT",
        body: "a".repeat(799),
      })),
      `[tool_result] ${"a".repeat(799)}`,
    );
    assertEquals(
      fallback.apply(progress({ tag: "TOOL_RESULT", body: "bc" })),
      "[tool_result] b...",
    );
    assertEquals(
      fallback.apply(progress({ tag: "TOOL_RESULT", body: "later" })),
      null,
    );
    assertEquals(
      fallback.apply(progress({
        tag: "CONTENT",
        body: "a different tag has its own fallback stream",
      })),
      "[content] a different tag has its own fallback stream",
    );
  });

  it("releases tool-result source state at item completion and clear", () => {
    const excerpt = new TurnOutputPipeline(
      outputSettings({ levels: { TOOL_RESULT: "excerpt" } }),
    );
    const itemId = "reused-excerpt";
    assertEquals(
      excerpt.apply(progress({
        tag: "TOOL_RESULT",
        itemId,
        body: "a".repeat(800),
      })),
      `[tool_result] ${"a".repeat(800)}`,
    );
    assertEquals(
      excerpt.apply(progress({
        tag: "TOOL",
        summary: "web search",
        itemId,
        toolId: "web-search:query",
        toolState: "completed",
      })),
      "[tool] web search",
    );
    assertEquals(
      excerpt.apply(progress({
        tag: "TOOL_RESULT",
        itemId,
        body: "fresh result",
      })),
      "[tool_result] fresh result",
    );

    const line = new TurnOutputPipeline(
      outputSettings({ levels: { TOOL_RESULT: "line" } }),
    );
    assertEquals(
      line.apply(progress({
        tag: "TOOL_RESULT",
        itemId: "reused-line",
        body: "first result",
      })),
      "[tool_result] first result",
    );
    assertEquals(
      line.apply(progress({
        tag: "TOOL",
        summary: "web search",
        itemId: "reused-line",
        toolId: "web-search:query",
        toolState: "completed",
      })),
      "[tool] web search",
    );
    assertEquals(
      line.apply(progress({
        tag: "TOOL_RESULT",
        itemId: "reused-line",
        body: "fresh line",
      })),
      "[tool_result] fresh line",
    );

    line.clear();
    assertEquals(
      line.apply(progress({
        tag: "TOOL_RESULT",
        itemId: "reused-line",
        body: "line after clear",
      })),
      "[tool_result] line after clear",
    );
  });

  it("passes direct bodies through without applying levels or labels", () => {
    const pipeline = new TurnOutputPipeline(
      outputSettings({ level: "off", label: "hide" }),
    );

    assertEquals(
      pipeline.apply({
        tag: "CONTENT",
        body: "direct\nunchanged",
        delivery: "direct",
      }),
      "direct\nunchanged",
    );
  });
});
