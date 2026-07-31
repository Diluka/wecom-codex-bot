import { resolve } from "node:path";
import {
  CodexAppServerClient,
  type TurnCompletedEvent,
} from "../src/codex-app-server.ts";
import { createLogger } from "../src/log.ts";
import { finishSmoke } from "../src/smoke-cleanup.ts";

if (Deno.env.get("RUN_CODEX_TURN") !== "1") {
  throw new Error(
    "Refusing to call the model without explicit opt-in: set RUN_CODEX_TURN=1",
  );
}

const workspace = await Deno.realPath(
  resolve(Deno.cwd(), Deno.env.get("CODEX_WORKSPACE") ?? "."),
);
const secret = Deno.env.get("BOT_SECRET") ?? "";
const logger = createLogger({ secrets: [secret] });
const codexLogger = logger.child({ scope: "codex" });
const completed = Promise.withResolvers<TurnCompletedEvent>();
let client: CodexAppServerClient | undefined;
let hasPrimaryError = false;

try {
  client = await CodexAppServerClient.start({
    cwd: workspace,
    callbacks: {
      onTurnCompleted: completed.resolve,
      onDiagnostic: (message) =>
        codexLogger.info({ source: "app_server" }, message.trimEnd()),
    },
  });
  const threadId = await client.startThread();
  const turnId = await client.startTurn(
    threadId,
    "Reply with one short sentence confirming that this Codex turn works. Do not use tools.",
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
