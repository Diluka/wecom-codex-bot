import { dirname } from "node:path";
import { WeComChatOutput } from "./src/chat-output.ts";
import { CodexRuntime } from "./src/codex-runtime.ts";
import { loadConfig } from "./src/config.ts";
import { BotLifecycle } from "./src/lifecycle.ts";
import { createLogger, logRequestStatus, summarizeRequest } from "./src/log.ts";
import { ConversationOrchestrator } from "./src/orchestrator.ts";
import { StateStore } from "./src/state.ts";
import { WeComGateway } from "./src/wecom.ts";

const config = await loadConfig();
const logger = createLogger({ secrets: [config.botSecret] });
const requestLogger = logger.child({ scope: "request" });
const codexLogger = logger.child({ scope: "codex" });
const wecomLogger = logger.child({ scope: "wecom" });
const outputLogger = logger.child({ scope: "output" });
const lifecycleLogger = logger.child({ scope: "lifecycle" });
await Deno.mkdir(dirname(config.stateDbPath), { recursive: true });

const state = new StateStore(config.stateDbPath);
const context: {
  lifecycle?: BotLifecycle;
  orchestrator?: ConversationOrchestrator;
} = {};
let shutdownPromise: Promise<void> | undefined;
let exitCode = 0;
let signalListenersInstalled = false;

type ShutdownSignal = "SIGINT" | "SIGTERM";

const shutdown = (code: number, signal?: ShutdownSignal): Promise<void> => {
  exitCode = Math.max(exitCode, code);
  Deno.exitCode = exitCode;
  if (!shutdownPromise) {
    lifecycleLogger.info({ signal, exit_code: exitCode }, "stopping");
    shutdownPromise = (async () => {
      try {
        if (signalListenersInstalled) {
          Deno.removeSignalListener("SIGINT", onSigint);
          Deno.removeSignalListener("SIGTERM", onSigterm);
          signalListenersInstalled = false;
        }
        await context.lifecycle?.stop();
      } finally {
        Deno.exitCode = exitCode;
        lifecycleLogger.info({ exit_code: exitCode }, "stopped");
        logger.flush();
      }
    })();
  }
  return shutdownPromise;
};

const runtime = new CodexRuntime({
  workspace: config.workspace,
  onDiagnostic: (message) =>
    codexLogger.info({ source: "app_server" }, message.trimEnd()),
  onFatal: (error) => {
    codexLogger.error({ error }, "fatal");
    return shutdown(1);
  },
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
  onReady: () => wecomLogger.info({}, "authenticated"),
  onFatal: (error) => {
    wecomLogger.error({ error }, "fatal");
    return shutdown(1);
  },
  onError: (error) => wecomLogger.error({ error }, "error"),
  onSdkLog: (level, message) => wecomLogger[level]({ source: "sdk" }, message),
});

const output = new WeComChatOutput({
  gateway,
  secrets: [config.botSecret],
  onError: (error) => outputLogger.error({ error }, "error"),
});

const orchestrator = new ConversationOrchestrator({
  state,
  codex: runtime,
  output,
  workspace: config.workspace,
  outputSettings: config.outputSettings,
  groupOutputSettings: config.groupOutputSettings,
  onError: (error) => requestLogger.error({ error }, "error"),
  onRequestStatus: (event) => logRequestStatus(requestLogger, event),
  summarizeRequest: (text) => summarizeRequest(text, [config.botSecret]),
});
context.orchestrator = orchestrator;

const lifecycle = new BotLifecycle({
  state,
  runtime,
  gateway,
  orchestrator,
  output,
  onError: (error) => lifecycleLogger.error({ error }, "cleanup_failed"),
});
context.lifecycle = lifecycle;

const onSigint = (): void => {
  void shutdown(0, "SIGINT");
};
const onSigterm = (): void => {
  void shutdown(0, "SIGTERM");
};
Deno.addSignalListener("SIGINT", onSigint);
Deno.addSignalListener("SIGTERM", onSigterm);
signalListenersInstalled = true;

lifecycleLogger.info({ workspace: config.workspace }, "starting");
try {
  const runtimeLost = await lifecycle.start();
  lifecycleLogger.info({
    workspace: config.workspace,
    stale_turns: runtimeLost,
  }, "started");
} catch (error) {
  lifecycleLogger.error({ error }, "start_failed");
  await shutdown(1);
}
