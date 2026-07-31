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

function reasoningSummary(
  body: string,
  summaryIndex = 0,
  itemId = "reasoning-1",
): ActivityEvent {
  return progress({
    tag: "CONTENT",
    body,
    reasoningSummary: { itemId, summaryIndex },
  });
}

function toolStarted(itemId: string | undefined): ActivityEvent {
  return progress({
    tag: "TOOL",
    summary: "deno test",
    body: "started",
    ...(itemId ? { itemId } : {}),
    toolState: "started",
  });
}

function toolCompleted(itemId: string | undefined): ActivityEvent {
  return progress({
    tag: "TOOL",
    summary: "deno test",
    body: "completed",
    ...(itemId ? { itemId } : {}),
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

  it("keeps content while suppressing tool details in summary format", () => {
    const pipeline = new TurnOutputPipeline(
      outputSettings({ toolFormat: "summary" }),
    );

    assertEquals(
      pipeline.apply(progress({
        tag: "CONTENT",
        body: "Deciding sequential tool execution",
      })),
      "[content] Deciding sequential tool execution",
    );
    assertEquals(pipeline.apply(toolStarted("tool-1")), null);
    assertEquals(
      pipeline.apply(progress({
        tag: "TOOL_RESULT",
        itemId: "tool-1",
        body: "command output",
      })),
      null,
    );
    assertEquals(
      pipeline.apply(progress({
        tag: "TOOL_RESULT",
        body: "fallback tool output",
      })),
      null,
    );
    assertEquals(pipeline.apply(toolCompleted("tool-1")), null);
  });

  it("reports why summary content is rendered and tool detail is hidden", () => {
    const pipeline = new TurnOutputPipeline(
      outputSettings({ toolFormat: "summary" }),
    );

    assertEquals(
      pipeline.applyWithDecision(
        progress({ tag: "CONTENT", body: "safe summary" }),
      ),
      {
        output: "[content] safe summary",
        disposition: "rendered",
        reason: "full",
      },
    );
    assertEquals(pipeline.applyWithDecision(toolStarted("tool-1")), {
      output: null,
      disposition: "suppressed",
      reason: "tool_format_summary",
    });
  });

  it("renders keyed italic snapshots for reasoning summary deltas", () => {
    const pipeline = new TurnOutputPipeline(
      outputSettings({ toolFormat: "summary" }),
    );

    assertEquals(
      pipeline.applyWithDecision(reasoningSummary("**Checking tests**", 0)),
      {
        output: "[content] *Checking tests*",
        disposition: "rendered",
        reason: "full",
        progressTail: {
          key: JSON.stringify(["reasoning-1", 0]),
          completedText: "[content] *已完成上一阶段，继续处理中…*",
        },
      },
    );
    assertEquals(
      pipeline.applyWithDecision(reasoningSummary("**Running**", 1)),
      {
        output: "[content] *Running*",
        disposition: "rendered",
        reason: "full",
        progressTail: {
          key: JSON.stringify(["reasoning-1", 1]),
          completedText: "[content] *已完成上一阶段，继续处理中…*",
        },
      },
    );
    assertEquals(
      new TurnOutputPipeline(
        outputSettings({
          labels: { CONTENT: "hide" },
          toolFormat: "summary",
        }),
      ).applyWithDecision(reasoningSummary("**Hidden label**")),
      {
        output: "*Hidden label*",
        disposition: "rendered",
        reason: "full",
        progressTail: {
          key: JSON.stringify(["reasoning-1", 0]),
          completedText: "*已完成上一阶段，继续处理中…*",
        },
      },
    );
    assertEquals(
      pipeline.applyWithDecision(
        progress({ tag: "CONTENT", body: "ordinary commentary" }),
      ),
      {
        output: "[content] ordinary commentary",
        disposition: "rendered",
        reason: "full",
      },
    );
  });

  it("waits for a complete outer bold pair before italicizing a snapshot", () => {
    const pipeline = new TurnOutputPipeline(
      outputSettings({ toolFormat: "summary" }),
    );

    assertEquals(
      pipeline.applyWithDecision(reasoningSummary("**Checking ")),
      {
        output: "[content] **Checking ",
        disposition: "rendered",
        reason: "full",
        progressTail: {
          key: JSON.stringify(["reasoning-1", 0]),
          completedText: "[content] *已完成上一阶段，继续处理中…*",
        },
      },
    );
    assertEquals(
      pipeline.applyWithDecision(reasoningSummary("tests**")),
      {
        output: "[content] *Checking tests*",
        disposition: "rendered",
        reason: "full",
        progressTail: {
          key: JSON.stringify(["reasoning-1", 0]),
          completedText: "[content] *已完成上一阶段，继续处理中…*",
        },
      },
    );
  });

  it("only italicizes complete full-line bold reasoning summaries", () => {
    const pipeline = new TurnOutputPipeline(
      outputSettings({ toolFormat: "summary" }),
    );

    for (
      const [summaryIndex, body] of [
        "before **inline** after",
        "`**code**`",
        "\\**escaped**",
        "**escaped\\**",
        "**incomplete",
      ].entries()
    ) {
      assertEquals(
        pipeline.apply(reasoningSummary(body, summaryIndex)),
        `[content] ${body}`,
      );
    }
    assertEquals(
      pipeline.apply(progress({ tag: "CONTENT", body: "**ordinary**" })),
      "[content] **ordinary**",
    );
  });

  it("preserves full-line bold inside backtick fenced code", () => {
    const pipeline = new TurnOutputPipeline(
      outputSettings({ toolFormat: "summary" }),
    );
    const summary = [
      "**before**",
      "```ts",
      "**literal**",
      "```",
      "**after**",
    ].join("\n");

    assertEquals(
      pipeline.apply(reasoningSummary(summary)),
      [
        "[content] *before*",
        "```ts",
        "**literal**",
        "```",
        "*after*",
      ].join("\n"),
    );
  });

  it("preserves full-line bold inside tilde fenced code", () => {
    const pipeline = new TurnOutputPipeline(
      outputSettings({ toolFormat: "summary" }),
    );
    const summary = [
      "**before**",
      "~~~ markdown",
      "**literal**",
      "~~~",
      "**after**",
    ].join("\n");

    assertEquals(
      pipeline.apply(reasoningSummary(summary)),
      [
        "[content] *before*",
        "~~~ markdown",
        "**literal**",
        "~~~",
        "*after*",
      ].join("\n"),
    );
  });

  it("preserves full-line bold inside four-space indented code", () => {
    const pipeline = new TurnOutputPipeline(
      outputSettings({ toolFormat: "summary" }),
    );
    const summary = "**before**\n    **literal**\n**after**";

    assertEquals(
      pipeline.apply(reasoningSummary(summary)),
      "[content] *before*\n    **literal**\n*after*",
    );
  });

  it("preserves full-line bold inside tab-indented code", () => {
    const pipeline = new TurnOutputPipeline(
      outputSettings({ toolFormat: "summary" }),
    );
    const summary = "**before**\n\t**literal**\n**after**";

    assertEquals(
      pipeline.apply(reasoningSummary(summary)),
      "[content] *before*\n\t**literal**\n*after*",
    );
  });

  it("preserves full-line bold after one to three spaces and a tab", () => {
    const pipeline = new TurnOutputPipeline(
      outputSettings({ toolFormat: "summary" }),
    );
    const summary = [
      "**before**",
      " \t**literal**",
      "  \t**literal**",
      "   \t**literal**",
      "**after**",
    ].join("\n");

    assertEquals(
      pipeline.apply(reasoningSummary(summary)),
      [
        "[content] *before*",
        " \t**literal**",
        "  \t**literal**",
        "   \t**literal**",
        "*after*",
      ].join("\n"),
    );
  });

  it("italicizes summary lines before line and excerpt projection", () => {
    const line = new TurnOutputPipeline(
      outputSettings({
        levels: { CONTENT: "line" },
        toolFormat: "summary",
      }),
    );
    assertEquals(
      line.apply(reasoningSummary("**First**\n**Second**")),
      "[content] *First*...",
    );

    const excerpt = new TurnOutputPipeline(
      outputSettings({
        levels: { CONTENT: "excerpt" },
        toolFormat: "summary",
      }),
    );
    assertEquals(
      excerpt.apply(reasoningSummary("**Excerpt**")),
      "[content] *Excerpt*",
    );
  });

  it("keeps reasoning summary deltas independent outside summary format", () => {
    const pipeline = new TurnOutputPipeline(outputSettings());

    assertEquals(
      pipeline.apply(reasoningSummary("Checking ")),
      "[content] Checking ",
    );
    assertEquals(
      pipeline.apply(reasoningSummary("tests")),
      "[content] tests",
    );
  });

  it("recomputes limited summary snapshots and clears their accumulated text", () => {
    const line = new TurnOutputPipeline(
      outputSettings({
        levels: { CONTENT: "line" },
        label: "hide",
        toolFormat: "summary",
      }),
    );
    assertEquals(line.apply(reasoningSummary("Checking ")), "Checking");
    assertEquals(line.apply(reasoningSummary("tests")), "Checking tests");

    const excerpt = new TurnOutputPipeline(
      outputSettings({
        levels: { CONTENT: "excerpt" },
        label: "hide",
        toolFormat: "summary",
      }),
    );
    const first = "🙂".repeat(799);
    assertEquals(excerpt.apply(reasoningSummary(first)), first);
    assertEquals(
      excerpt.apply(reasoningSummary("ab")),
      `${first}a...`,
    );

    excerpt.clear();
    assertEquals(excerpt.apply(reasoningSummary("fresh")), "fresh");
  });

  it("preserves non-tool progress in summary format", () => {
    const pipeline = new TurnOutputPipeline(
      outputSettings({ toolFormat: "summary" }),
    );

    for (
      const [tag, body] of [
        ["PLAN", "1. Run tests"],
        ["SUBAGENT", "amber-otter：正在工作"],
        ["WARNING", "watch out"],
        ["ERROR", "failed"],
      ] as const
    ) {
      assertEquals(
        pipeline.apply(progress({ tag, body })),
        `[${tag.toLowerCase()}] ${body}`,
      );
    }
  });

  it("keeps direct delivery visible in summary format", () => {
    const pipeline = new TurnOutputPipeline(
      outputSettings({
        level: "off",
        label: "hide",
        toolFormat: "summary",
      }),
    );

    assertEquals(
      pipeline.apply({
        tag: "TOOL_RESULT",
        body: "direct\nunchanged",
        delivery: "direct",
      }),
      "direct\nunchanged",
    );
  });

  it("filters summary content through the content output level", () => {
    const pipeline = new TurnOutputPipeline(
      outputSettings({
        levels: { CONTENT: "off" },
        toolFormat: "summary",
      }),
    );

    assertEquals(
      pipeline.apply(progress({
        tag: "CONTENT",
        body: "Deciding sequential tool execution",
      })),
      null,
    );
  });

  it("applies subagent labels and levels in summary format", () => {
    const event = progress({
      tag: "SUBAGENT",
      body: "amber-otter：正在工作",
      itemId: "child-1",
    });

    assertEquals(
      new TurnOutputPipeline(outputSettings({ toolFormat: "summary" })).apply(
        event,
      ),
      "[subagent] amber-otter：正在工作",
    );
    assertEquals(
      new TurnOutputPipeline(
        outputSettings({ labels: { SUBAGENT: "hide" } }),
      ).apply(event),
      "amber-otter：正在工作",
    );
    assertEquals(
      new TurnOutputPipeline(
        outputSettings({ levels: { SUBAGENT: "off" } }),
      ).apply(event),
      null,
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

  it("keeps one logical line per source stream and marks inline omitted content", () => {
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

  it("keeps excerpt fallback streams separate from real fallback-shaped item ids", () => {
    const pipeline = new TurnOutputPipeline(
      outputSettings({ levels: { TOOL_RESULT: "excerpt" } }),
    );

    assertEquals(
      pipeline.apply(progress({
        tag: "TOOL_RESULT",
        body: "a".repeat(799),
      })),
      `[tool_result] ${"a".repeat(799)}`,
    );
    assertEquals(
      pipeline.apply(progress({
        tag: "TOOL_RESULT",
        itemId: "fallback:TOOL_RESULT",
        body: "real item",
      })),
      "[tool_result] real item",
    );
  });

  it("keeps line fallback streams separate from real fallback-shaped item ids", () => {
    const pipeline = new TurnOutputPipeline(
      outputSettings({ levels: { TOOL_RESULT: "line" } }),
    );

    assertEquals(
      pipeline.apply(progress({
        tag: "TOOL_RESULT",
        body: "fallback item",
      })),
      "[tool_result] fallback item",
    );
    assertEquals(
      pipeline.apply(progress({
        tag: "TOOL_RESULT",
        itemId: "fallback:TOOL_RESULT",
        body: "real item",
      })),
      "[tool_result] real item",
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
