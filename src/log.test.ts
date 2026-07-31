import { assertEquals, assertMatch } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { Writable } from "node:stream";
import type { Logger } from "pino";
import {
  closeLogTransport,
  createLogger,
  createLogTransport,
  logAppServerLifecycle,
  logAppServerStderr,
  logRequestStatus,
  summarizeRequest,
  waitForLogTransport,
} from "./log.ts";

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

async function withDeadline<T>(
  promise: Promise<T>,
  operation: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${operation} timed out`)),
          2_000,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

describe("createLogger", () => {
  it("keeps terminal logging active after the file transport fails", async () => {
    const terminal = captureLogs();
    const directory = await Deno.makeTempDir();
    const filePath = `${directory}/process.log`;
    let fileErrors = 0;
    const transport = createLogTransport({
      level: "info",
      filePath,
      terminalDestination: terminal.destination,
      onFileError: () => fileErrors++,
    });

    try {
      await withDeadline(waitForLogTransport(transport), "transport startup");
      const logger = createLogger({ stream: transport.stream }).child({
        scope: "lifecycle",
      });
      logger.info("before_failure");
      transport.file.emit("error", new Error("disk full"));
      logger.info("after_failure");
      logger.flush();

      assertEquals(fileErrors, 1);
      assertMatch(terminal.output(), /INFO: \[lifecycle\] before_failure/);
      assertMatch(terminal.output(), /INFO: \[lifecycle\] after_failure/);
    } finally {
      await withDeadline(closeLogTransport(transport), "transport shutdown");
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("uses one configured threshold for scoped loggers", () => {
    const infoCapture = captureLogs();
    const infoLogger = createLogger({
      level: "info",
      destination: infoCapture.destination,
    }).child({ scope: "codex" });
    infoLogger.debug({ method: "safe/method" }, "notification");
    infoLogger.info("ready");

    const debugCapture = captureLogs();
    const debugLogger = createLogger({
      level: "debug",
      destination: debugCapture.destination,
    }).child({ scope: "codex" });
    debugLogger.debug({ method: "safe/method" }, "notification");
    debugLogger.info("ready");

    assertEquals(infoCapture.output().includes("notification"), false);
    assertMatch(infoCapture.output(), /INFO: \[codex\] ready/);
    assertMatch(debugCapture.output(), /DEBUG: \[codex\] notification/);
    assertMatch(debugCapture.output(), /INFO: \[codex\] ready/);
  });

  it("formats scoped structured logs and preserves values", () => {
    const capture = captureLogs();
    const logger: Logger = createLogger({
      destination: capture.destination,
    });
    const requestLogger = logger.child({ scope: "request" });
    const codexLogger = logger.child({ scope: "codex" });

    requestLogger.info({
      chat_id: "room-1",
      user_id: "alice",
      msg_id: "m1",
      summary: "hello actual-secret",
      nested: { values: ["safe", "actual-secret"] },
    }, "received");
    codexLogger.error({
      error: new Error("failed actual-secret"),
    }, "failed");
    logger.flush();

    const output = capture.output();
    const lines = output.trimEnd().split("\n");
    assertEquals(lines.length, 2);
    assertMatch(
      lines[0],
      /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3} [+-]\d{4}\] INFO: \[request\] received /,
    );
    assertMatch(lines[0], /"chat_id":"room-1"/);
    assertMatch(
      lines[1],
      / ERROR: \[codex\] failed .*"error":\{"type":"Error","message":"failed actual-secret","stack":"at Object\.<anonymous> \(.*src\/log\.test\.ts:\d+:\d+\)"/,
    );
    assertEquals(output.includes("actual-secret"), true);
    assertEquals(output.includes("time="), false);
    assertEquals(output.includes("level="), false);
  });

  it("creates native child loggers for every project scope", () => {
    const capture = captureLogs();
    const logger: Logger = createLogger({ destination: capture.destination });

    for (
      const scope of [
        "request",
        "codex",
        "wecom",
        "output",
        "lifecycle",
      ] as const
    ) {
      logger.child({ scope }).info("ready");
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

  it("drops nested JSON hooks and other unsafe values", () => {
    const capture = captureLogs();
    const logger: Logger = createLogger({
      destination: capture.destination,
    });
    const requestLogger = logger.child({ scope: "request" });

    requestLogger.info({
      nested: {
        ordinary: "hello actual-secret",
        callback: () => "actual-secret",
        symbolValue: Symbol("actual-secret"),
        toJSON() {
          return {
            forged: "actual-secret",
            ordinary: "forged",
          };
        },
      },
    }, "received");
    logger.flush();

    const output = capture.output();
    assertEquals(output.includes("actual-secret"), true);
    assertMatch(output, /"nested":\{"ordinary":"hello actual-secret"\}/);
    for (const omitted of ["forged", "callback", "symbolValue", "toJSON"]) {
      assertEquals(output.includes(omitted), false);
    }
  });

  it("keeps multiline messages on one physical log line", () => {
    const capture = captureLogs();
    const logger: Logger = createLogger({ destination: capture.destination });

    logger.child({ scope: "codex" }).info(
      { source: "app_server" },
      "first line\nsecond line\r\nthird line",
    );
    logger.flush();

    const output = capture.output().trimEnd();
    assertEquals(output.split("\n").length, 1);
    assertMatch(output, /first line\\nsecond line\\nthird line/);
  });

  it("truncates log messages and string fields to 100 graphemes", () => {
    const capture = captureLogs();
    const logger: Logger = createLogger({
      level: "debug",
      destination: capture.destination,
    });

    logger.child({ scope: "codex" }).debug({
      payload: `${"p".repeat(101)}field-tail`,
    }, `${"m".repeat(101)}message-tail`);
    logger.flush();

    const output = capture.output();
    assertEquals(output.includes("m".repeat(99) + "…"), true);
    assertEquals(output.includes("p".repeat(99) + "…"), true);
    assertEquals(output.includes("message-tail"), false);
    assertEquals(output.includes("field-tail"), false);
  });

  it("preserves bounded structured error diagnostics and message values", () => {
    const capture = captureLogs();
    const logger: Logger = createLogger({
      destination: capture.destination,
    });
    const error = new Error("failed actual-secret", {
      cause: new Error("caused by actual-secret"),
    });
    error.stack = `Error: failed actual-secret\n    at ${
      "veryLongFunctionName".repeat(8)
    } (/workspace/src/example.ts:42:7)`;

    logger.child({ scope: "lifecycle" }).error({ error }, "failed");
    logger.flush();

    const output = capture.output().trimEnd();
    assertEquals(output.split("\n").length, 1);
    assertEquals(output.includes("actual-secret"), true);
    assertMatch(output, /"error":\{"type":"Error"/);
    assertMatch(output, /"message":"failed actual-secret"/);
    assertMatch(output, /"stack":"at veryLongFunctionName/);
    assertMatch(output, /\/workspace\/src\/example\.ts:42:7\)"/);
    assertMatch(output, /"cause":\{"type":"Error"/);
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

  it("does not inspect secret-like values", () => {
    assertEquals(
      summarizeRequest("token12345 trailing"),
      "token12345…",
    );
  });
});

describe("logRequestStatus", () => {
  it("maps event fields and request states to Pino levels", () => {
    const capture = captureLogs();
    const logger: Logger = createLogger({
      destination: capture.destination,
    });
    const requestLogger = logger.child({ scope: "request" });
    const base = {
      chatType: "group",
      chatId: "room-1",
      userId: "alice",
      msgId: "m1",
      activeCount: 1,
      pendingCount: 0,
    };

    logRequestStatus(requestLogger, {
      ...base,
      state: "received",
      summary: "hello",
    });
    logRequestStatus(requestLogger, {
      ...base,
      state: "runtime_unavailable",
      reason: "offline",
    });
    logRequestStatus(requestLogger, {
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
    assertEquals(output.includes("actual-secret"), true);
  });
});

describe("logAppServerLifecycle", () => {
  it("uses the event level and maps safe lifecycle metadata", () => {
    const capture = captureLogs();
    const logger = createLogger({
      level: "debug",
      destination: capture.destination,
    }).child({ scope: "codex" });

    logAppServerLifecycle(logger, {
      level: "debug",
      event: "item_delta",
      method: "item/reasoning/summaryTextDelta",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "reasoning-1",
      deltaLength: 17,
      deltaChunks: 4,
    });
    logAppServerLifecycle(logger, {
      level: "warn",
      event: "rpc_failed",
      method: "turn/start",
      requestId: 4,
      elapsedMs: 30_000,
      failure: "timeout",
    });
    logger.flush();

    const lines = capture.output().trimEnd().split("\n");
    assertMatch(lines[0], / DEBUG: \[codex\] item_delta /);
    assertMatch(lines[0], /"item_id":"reasoning-1"/);
    assertMatch(lines[0], /"delta_length":17/);
    assertMatch(lines[0], /"delta_chunks":4/);
    assertMatch(lines[1], / WARN: \[codex\] rpc_failed /);
    assertMatch(lines[1], /"request_id":4/);
    assertMatch(lines[1], /"failure":"timeout"/);
  });
});

describe("logAppServerStderr", () => {
  it("records only the chunk length", () => {
    const capture = captureLogs();
    const logger = createLogger({
      level: "debug",
      destination: capture.destination,
    }).child({ scope: "codex" });
    const message = "private command --token actual-secret";

    logAppServerStderr(logger, message);
    logger.flush();

    const output = capture.output();
    assertMatch(output, / DEBUG: \[codex\] app_server_stderr /);
    assertMatch(output, new RegExp(`"chunk_length":${message.length}`));
    assertEquals(output.includes(message), false);
    assertEquals(output.includes("actual-secret"), false);
  });
});
