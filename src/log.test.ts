import { assertEquals, assertMatch } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Writable } from "node:stream";
import { createLogger, logRequestStatus, summarizeRequest } from "./log.ts";

function captureLogs(): {
  destination: Writable;
  output: () => string;
} {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return { destination, output: () => chunks.join("") };
}

describe("createLogger", () => {
  it("formats scoped structured logs and recursively redacts secrets", () => {
    const capture = captureLogs();
    const logger = createLogger({
      secrets: ["actual-secret"],
      destination: capture.destination,
    });

    logger.request.info("received", {
      chat_id: "room-1",
      user_id: "alice",
      msg_id: "m1",
      summary: "hello actual-secret",
      nested: { values: ["safe", "actual-secret"] },
    });
    logger.codex.error(new Error("failed actual-secret"));
    logger.flush();

    const output = capture.output();
    const lines = output.trimEnd().split("\n");
    assertEquals(lines.length, 2);
    assertMatch(
      lines[0],
      /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3} [+-]\d{4}\] INFO: \[request\] received /,
    );
    assertMatch(lines[0], /"chat_id":"room-1"/);
    assertMatch(lines[1], / ERROR: \[codex\] Error: failed \[REDACTED\]/);
    assertEquals(output.includes("actual-secret"), false);
    assertEquals(output.includes("[REDACTED]"), true);
    assertEquals(output.includes("time="), false);
    assertEquals(output.includes("level="), false);
  });

  it("exposes every fixed logging scope", () => {
    const capture = captureLogs();
    const logger = createLogger({ destination: capture.destination });

    for (
      const scope of [
        "request",
        "codex",
        "wecom",
        "output",
        "lifecycle",
      ] as const
    ) {
      logger[scope].info("ready");
    }
    logger.flush();

    const output = capture.output();
    for (
      const scope of [
        "request",
        "codex",
        "wecom",
        "output",
        "lifecycle",
      ]
    ) {
      assertEquals(output.includes(`[${scope}] ready`), true);
    }
  });

  it("prevents top-level fields from overriding logger metadata", () => {
    const capture = captureLogs();
    const logger = createLogger({ destination: capture.destination });

    logger.request.info("received", {
      scope: "spoofed-scope",
      time: 0,
      level: 60,
      pid: 991_001,
      hostname: "spoofed-host",
      msg: "spoofed-msg",
      name: "spoofed-name",
      v: 991_002,
      regular: "kept",
      nested: {
        scope: "nested-scope",
        time: 123,
        level: 30,
        pid: 992_001,
        hostname: "nested-host",
        msg: "nested-msg",
        name: "nested-name",
        v: 992_002,
      },
    });
    logger.flush();

    const line = capture.output().trimEnd();
    assertMatch(
      line,
      /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3} [+-]\d{4}\] INFO: \[request\] received /,
    );
    for (
      const spoofed of [
        "spoofed-scope",
        "spoofed-host",
        "spoofed-msg",
        "spoofed-name",
        "991001",
        "991002",
      ]
    ) {
      assertEquals(line.includes(spoofed), false);
    }
    assertMatch(line, /"regular":"kept"/);
    assertMatch(
      line,
      /"nested":\{"scope":"nested-scope","time":123,"level":30,"pid":992001,"hostname":"nested-host","msg":"nested-msg","name":"nested-name","v":992002\}/,
    );
  });
});

describe("summarizeRequest", () => {
  const cases = [
    {
      name: "collapses and trims whitespace",
      input: "  hi \n\t there  ",
      expected: "hi there",
    },
    {
      name: "keeps emoji and combining marks as whole graphemes",
      input: "👩🏽‍💻e\u0301abcdefghij",
      expected: "👩🏽‍💻e\u0301abcdefgh…",
    },
    {
      name: "does not mark exactly ten graphemes as truncated",
      input: "abcdefghij",
      expected: "abcdefghij",
    },
    {
      name: "marks eleven graphemes as truncated",
      input: "abcdefghijk",
      expected: "abcdefghij…",
    },
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      assertEquals(summarizeRequest(testCase.input), testCase.expected);
    });
  }

  it("redacts secrets before applying the grapheme limit", () => {
    assertEquals(
      summarizeRequest("actual-secret trailing", ["actual-secret"]),
      "[REDACTED]…",
    );
  });
});

describe("logRequestStatus", () => {
  it("maps event fields and request states to Pino levels", () => {
    const capture = captureLogs();
    const logger = createLogger({
      secrets: ["actual-secret"],
      destination: capture.destination,
    });
    const base = {
      chatType: "group",
      chatId: "room-1",
      userId: "alice",
      msgId: "m1",
      activeCount: 1,
      pendingCount: 0,
    };

    logRequestStatus(logger, {
      ...base,
      state: "received",
      summary: "hello",
    });
    logRequestStatus(logger, {
      ...base,
      state: "runtime_unavailable",
      reason: "offline",
    });
    logRequestStatus(logger, {
      ...base,
      state: "failed",
      threadId: "thread-1",
      turnId: "turn-1",
      elapsedMs: 12,
      error: new Error("failed actual-secret"),
    });
    logger.flush();

    const output = capture.output();
    const lines = output.trimEnd().split("\n");
    assertMatch(lines[0], / INFO: \[request\] received /);
    assertMatch(lines[0], /"chat_type":"group"/);
    assertMatch(lines[0], /"summary":"hello"/);
    assertMatch(lines[1], / WARN: \[request\] runtime_unavailable /);
    assertMatch(lines[1], /"reason":"offline"/);
    assertMatch(lines[2], / ERROR: \[request\] failed /);
    assertMatch(lines[2], /"thread_id":"thread-1"/);
    assertMatch(lines[2], /"turn_id":"turn-1"/);
    assertMatch(lines[2], /"elapsed_ms":12/);
    assertEquals(output.includes("actual-secret"), false);
  });
});
