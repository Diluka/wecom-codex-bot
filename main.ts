import { dirname } from "node:path";
import { WeComChatOutput } from "./src/chat-output.ts";
import { CodexRuntime } from "./src/codex-runtime.ts";
import { loadConfig } from "./src/config.ts";
import { BotLifecycle } from "./src/lifecycle.ts";
import {
  closeLogTransport,
  createLogger,
  createLogTransport,
  logAppServerLifecycle,
  logAppServerStderr,
  logRequestStatus,
  type LogTransport,
  summarizeRequest,
  waitForLogTransport,
} from "./src/log.ts";
import { buildOwnerDeveloperInstructions } from "./src/owner-policy.ts";
import { ConversationOrchestrator } from "./src/orchestrator.ts";
import { prepareProcessLog } from "./src/process-log.ts";
import { StateStore } from "./src/state.ts";
import { WeComGateway } from "./src/wecom.ts";

const config = await loadConfig();
let logTransport: LogTransport | undefined;
let processLogError: unknown;
let activeLogPath: string | undefined;
let archivedLogPath: string | undefined;
try {
  const processLog = await prepareProcessLog(Deno.cwd());
  activeLogPath = processLog.activePath;
  archivedLogPath = processLog.archivePath;
  logTransport = createLogTransport({
    level: config.logLevel,
    filePath: processLog.activePath,
    onFileError: () =>
      console.error(
        "Pino file transport failed; terminal logging remains active",
      ),
  });
  await waitForLogTransport(logTransport);
} catch (error) {
  processLogError = error;
}
const logger = createLogger({
  secrets: [config.botSecret],
  level: config.logLevel,
  stream: logTransport?.stream,
});
const requestLogger = logger.child({ scope: "request" });
const codexLogger = logger.child({ scope: "codex" });
const wecomLogger = logger.child({ scope: "wecom" });
const outputLogger = logger.child({ scope: "output" });
const lifecycleLogger = logger.child({ scope: "lifecycle" });
if (processLogError !== undefined) {
  lifecycleLogger.warn({ error: processLogError }, "file_log_unavailable");
} else {
  lifecycleLogger.info({
    log_level: config.logLevel,
    log_file: activeLogPath,
    archived_log: archivedLogPath,
  }, "logging_ready");
}
await Deno.mkdir(dirname(config.stateDbPath), { recursive: true });

const state = new StateStore(config.stateDbPath);
const context: {
  lifecycle?: BotLifecycle;
  orchestrator?: ConversationOrchestrator;
} = {};
let shutdownPromise: Promise<void> | undefined;
let exitCode = 0;
let signalListenersInstalled = false;

async function closeProcessLog(): Promise<void> {
  if (!logTransport) return;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      closeLogTransport(logTransport),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Process log close timed out")),
          2_000,
        );
      }),
    ]);
  } catch {
    console.error("Failed to close process log");
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

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
        try {
          logger.flush();
        } finally {
          await closeProcessLog();
        }
      }
    })();
  }
  return shutdownPromise;
};

const runtime = new CodexRuntime({
  workspace: config.workspace,
  developerInstructions: buildOwnerDeveloperInstructions(config.ownerUserId),
  onAppServerLifecycle: (event) => logAppServerLifecycle(codexLogger, event),
  onAppServerStderr: (message) => logAppServerStderr(codexLogger, message),
  onTrace: (trace) => {
    if (
      trace.method.endsWith("Delta") || trace.method.endsWith("/delta")
    ) {
      return;
    }
    codexLogger.debug({
      method: trace.method,
      decision: trace.decision,
      reason: trace.reason,
      generation: trace.generation,
      thread_id: trace.threadId,
      turn_id: trace.turnId,
      tag: trace.tag,
    }, "notification_route");
  },
  onDiagnostic: (message) =>
    codexLogger.warn({ source: "runtime" }, message.trimEnd()),
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
  ownerUserId: config.ownerUserId,
  outputSettings: config.outputSettings,
  groupOutputSettings: config.groupOutputSettings,
  onError: (error) => requestLogger.error({ error }, "error"),
  onRequestStatus: (event) => logRequestStatus(requestLogger, event),
  onOutputDecision: (event) => {
    if (event.tag === "TOOL_RESULT") return;
    outputLogger.debug({
      tag: event.tag,
      delivery: event.delivery,
      disposition: event.disposition,
      reason: event.reason,
      thread_id: event.threadId,
      turn_id: event.turnId,
    }, "activity_decision");
  },
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
