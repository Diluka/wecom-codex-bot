import { CodexAppServerClient } from "../src/codex-app-server.ts";
import { createLogger } from "../src/log.ts";

const logger = createLogger();
const codexLogger = logger.child({ scope: "codex" });
const workspace = Deno.args[0] ?? Deno.cwd();
let client: CodexAppServerClient | undefined;

try {
  client = await CodexAppServerClient.start({
    cwd: workspace,
    callbacks: {
      onDiagnostic: (message) =>
        codexLogger.info({ source: "app_server" }, message.trimEnd()),
    },
  });
  codexLogger.info({ workspace }, "handshake_succeeded");
} finally {
  try {
    await client?.close();
  } finally {
    logger.flush();
  }
}
