import { resolve } from "node:path";
import {
  CodexAppServerClient,
  type TurnCompletedEvent,
} from "../src/codex-app-server.ts";
import {
  createLogger,
  logAppServerLifecycle,
  logAppServerStderr,
} from "../src/log.ts";
import { finishSmoke } from "../src/smoke-cleanup.ts";

if (Deno.env.get("RUN_CODEX_TURN") !== "1") {
  throw new Error(
    "Refusing to call the model without explicit opt-in: set RUN_CODEX_TURN=1",
  );
}

const workspace = await Deno.realPath(
  resolve(Deno.cwd(), Deno.env.get("CODEX_WORKSPACE") ?? "."),
);
const logger = createLogger({
  level: Deno.env.get("LOG_LEVEL") === "debug" ? "debug" : "info",
});
const codexLogger = logger.child({ scope: "codex" });
const completed = Promise.withResolvers<TurnCompletedEvent>();
let client: CodexAppServerClient | undefined;
let hasPrimaryError = false;

try {
  client = await CodexAppServerClient.start({
    cwd: workspace,
    callbacks: {
      onLifecycle: (event) => logAppServerLifecycle(codexLogger, event),
      onTurnCompleted: completed.resolve,
      onStderr: (message) => logAppServerStderr(codexLogger, message),
      onDiagnostic: (message) =>
        codexLogger.warn({ source: "client" }, message.trimEnd()),
    },
  });
  const { threadId } = await client.startThread();
  const turnId = await client.startTurn(
    threadId,
    {
      text:
        "Reply with one short sentence confirming that this Codex turn works. Do not use tools.",
      localImagePaths: [],
    },
    "restricted",
  );
  const result = await withTimeout(completed.promise, 120_000);
  if (result.threadId !== threadId || result.turnId !== turnId) {
    throw new Error("Codex App Server completed an unexpected turn");
  }
  if (result.status !== "completed" || !result.finalMessage?.trim()) {
    throw new Error(`Codex turn ended with status ${result.status}`);
  }
  codexLogger.info({
    workspace,
    thread_id: threadId,
    turn_id: turnId,
  }, "model_turn_succeeded");
} catch (error) {
  hasPrimaryError = true;
  throw error;
} finally {
  await finishSmoke(
    codexLogger,
    () => client?.close(),
    () => logger.flush(),
    hasPrimaryError,
    () => undefined,
  );
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`Codex turn timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
