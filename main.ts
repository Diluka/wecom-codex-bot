import { dirname } from "node:path";
import { WeComChatOutput } from "./src/chat-output.ts";
import { CodexRuntime } from "./src/codex-runtime.ts";
import { loadConfig } from "./src/config.ts";
import { BotLifecycle } from "./src/lifecycle.ts";
import { logTerminal } from "./src/log.ts";
import { ConversationOrchestrator } from "./src/orchestrator.ts";
import { StateStore } from "./src/state.ts";
import { WeComGateway } from "./src/wecom.ts";

const config = await loadConfig();
await Deno.mkdir(dirname(config.stateDbPath), { recursive: true });

const safeLog = (level: "info" | "error", value: unknown): void => {
  logTerminal(level, value, [config.botSecret]);
};

const state = new StateStore(config.stateDbPath);
const context: {
  lifecycle?: BotLifecycle;
  orchestrator?: ConversationOrchestrator;
} = {};
let shutdownPromise: Promise<void> | undefined;
let exitCode = 0;
let signalListenersInstalled = false;

const shutdown = (code: number, reason?: unknown): Promise<void> => {
  exitCode = Math.max(exitCode, code);
  if (reason !== undefined) safeLog("error", reason);
  if (!shutdownPromise) {
    shutdownPromise = (async () => {
      if (signalListenersInstalled) {
        Deno.removeSignalListener("SIGINT", onSignal);
        Deno.removeSignalListener("SIGTERM", onSignal);
        signalListenersInstalled = false;
      }
      await context.lifecycle?.stop();
      Deno.exitCode = exitCode;
    })();
  }
  return shutdownPromise;
};

const runtime = new CodexRuntime({
  workspace: config.workspace,
  onDiagnostic: (message) => safeLog("info", message.trimEnd()),
  onFatal: (error) => shutdown(1, error),
});

const gateway = new WeComGateway({
  botId: config.botId,
  secret: config.botSecret,
  onText: (message, frame) =>
    context.orchestrator!.handleText({ ...message, frame }),
  onUnsupported: (message, frame, messageType) =>
    context.orchestrator!.handleUnsupported(
      { ...message, frame },
      messageType,
    ),
  onReady: () => safeLog("info", "Enterprise WeChat bot authenticated"),
  onFatal: (error) => shutdown(1, error),
  onError: (error) => safeLog("error", error),
});

const output = new WeComChatOutput({
  gateway,
  secrets: [config.botSecret],
  onError: (error) => safeLog("error", error),
});

const orchestrator = new ConversationOrchestrator({
  state,
  codex: runtime,
  output,
  workspace: config.workspace,
  outputSettings: config.outputSettings,
  onError: (error) => safeLog("error", error),
});
context.orchestrator = orchestrator;

const lifecycle = new BotLifecycle({
  state,
  runtime,
  gateway,
  orchestrator,
  output,
  onError: (error) => safeLog("error", error),
});
context.lifecycle = lifecycle;

const onSignal = (): void => {
  void shutdown(0, "Received shutdown signal");
};
Deno.addSignalListener("SIGINT", onSignal);
Deno.addSignalListener("SIGTERM", onSignal);
signalListenersInstalled = true;

try {
  const runtimeLost = await lifecycle.start();
  safeLog(
    "info",
    `Bot started in ${config.workspace}; recovered ${runtimeLost} stale turn(s)`,
  );
} catch (error) {
  await shutdown(1, error);
}
