import { CodexAppServerClient } from "../src/codex-app-server.ts";
import { createLogger } from "../src/log.ts";
import {
  assertGeneratedSchemaSupportsApplicationContext,
  finishSmoke,
} from "../src/smoke-cleanup.ts";
import { join } from "node:path";

const logger = createLogger();
const codexLogger = logger.child({ scope: "codex" });
const workspace = Deno.args[0] ?? Deno.cwd();
let client: CodexAppServerClient | undefined;
let schemaDirectory: string | undefined;
let hasPrimaryError = false;

try {
  const schemaParent = join(workspace, ".data");
  await Deno.mkdir(schemaParent, { recursive: true });
  schemaDirectory = await Deno.makeTempDir({
    dir: schemaParent,
    prefix: "app-server-schema-",
  });
  const schemaResult = await new Deno.Command("codex", {
    args: [
      "app-server",
      "generate-json-schema",
      "--experimental",
      "--out",
      schemaDirectory,
    ],
    cwd: workspace,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!schemaResult.success) {
    const detail = new TextDecoder().decode(schemaResult.stderr).trim();
    throw new Error(
      `Codex App Server schema generation failed with exit code ${schemaResult.code}${
        detail ? `: ${detail}` : ""
      }`,
    );
  }
  await assertGeneratedSchemaSupportsApplicationContext(schemaDirectory);

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
    async () => {
      if (schemaDirectory === undefined) return;
      try {
        await Deno.remove(schemaDirectory, { recursive: true });
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    },
  );
}
