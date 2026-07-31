import { CodexAppServerClient } from "../src/codex-app-server.ts";
import { createLogger } from "../src/log.ts";
import { finishSmoke } from "../src/smoke-cleanup.ts";

const logger = createLogger();
const codexLogger = logger.child({ scope: "codex" });
const workspace = Deno.args[0] ?? Deno.cwd();
let client: CodexAppServerClient | undefined;
let hasPrimaryError = false;

try {
  client = await CodexAppServerClient.start({
    cwd: workspace,
    callbacks: {
      onDiagnostic: (message) =>
        codexLogger.info({ source: "app_server" }, message.trimEnd()),
    },
  });
  codexLogger.info({ workspace }, "handshake_succeeded");
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
