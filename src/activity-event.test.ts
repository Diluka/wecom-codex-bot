import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import type { ActivityEvent } from "./activity-event.ts";

describe("ActivityEvent", () => {
  it("carries source-neutral raw progress text and applicable identities", () => {
    const event: ActivityEvent = {
      tag: "TOOL",
      summary: "Run project tests",
      body: "Test output\nsecond output line",
      turnId: "turn-123",
      itemId: "item-456",
      toolId: "command:deno-test",
      delivery: "progress",
    };

    assertEquals(event.tag, "TOOL");
    assertEquals(event.summary, "Run project tests");
    assertEquals(event.body, "Test output\nsecond output line");
    assertEquals(event.turnId, "turn-123");
    assertEquals(event.itemId, "item-456");
    assertEquals(event.toolId, "command:deno-test");
    assertEquals(event.delivery, "progress");
  });

  it("allows a direct user-input prompt without a dedicated tag or identity", () => {
    const event: ActivityEvent = {
      tag: "CONTENT",
      summary: "Codex needs user input",
      body: "Which deployment environment should I use?",
      delivery: "direct",
    };

    assertEquals(event.tag, "CONTENT");
    assertEquals(event.delivery, "direct");
    assertEquals(event.toolId, undefined);
    assertEquals(event.itemId, undefined);
  });
});
