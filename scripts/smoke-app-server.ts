import { CodexAppServerClient } from "../src/codex-app-server.ts";

const client = await CodexAppServerClient.start({
  cwd: Deno.args[0] ?? Deno.cwd(),
  callbacks: {
    onDiagnostic: (message) =>
      Deno.stderr.write(
        new TextEncoder().encode(message),
      ).then(() => undefined),
  },
});

console.log("Codex App Server handshake succeeded");
await client.close();
