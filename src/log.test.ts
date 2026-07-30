import { assertEquals, assertNotMatch } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { logTerminal } from "./log.ts";

describe("logTerminal", () => {
  it("redacts configured secrets before printing diagnostics", () => {
    const lines: string[] = [];
    const logger = {
      log: (line: string) => lines.push(`info:${line}`),
      error: (line: string) => lines.push(`error:${line}`),
    };

    logTerminal(
      "error",
      new Error("Codex callback failed for secret-value"),
      ["secret-value"],
      logger,
    );

    assertEquals(lines.length, 1);
    assertEquals(lines[0].startsWith("error:[wecom-codex-bot] "), true);
    assertNotMatch(lines[0], /secret-value/);
    assertEquals(lines[0].includes("[REDACTED]"), true);
  });
});
