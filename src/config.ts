import { join, resolve } from "node:path";
import {
  INTERMEDIATE_OUTPUT_MODES,
  type IntermediateOutputMode,
  STATUS_DETAILS,
  type StatusDetail,
} from "./output-settings.ts";

export interface BotConfig {
  botId: string;
  botSecret: string;
  workspace: string;
  stateDbPath: string;
  botRoot: string;
  intermediateOutput: IntermediateOutputMode;
  statusDetail: StatusDetail;
}

function required(
  env: Record<string, string | undefined>,
  name: string,
): string {
  const value = env[name];
  if (!value?.trim()) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnum<T extends string>(
  env: Record<string, string | undefined>,
  name: string,
  values: readonly T[],
  defaultValue: T,
): T {
  const value = env[name]?.trim();
  if (!value) {
    return defaultValue;
  }
  if ((values as readonly string[]).includes(value)) {
    return value as T;
  }
  throw new Error(`Invalid environment variable: ${name}`);
}

export async function loadConfig(
  env: Record<string, string | undefined> = Deno.env.toObject(),
  baseDir = Deno.cwd(),
): Promise<BotConfig> {
  const botId = required(env, "BOT_ID");
  const botSecret = required(env, "BOT_SECRET");
  const workspaceValue = required(env, "CODEX_WORKSPACE");
  const intermediateOutput = optionalEnum(
    env,
    "CODEX_INTERMEDIATE_OUTPUT",
    INTERMEDIATE_OUTPUT_MODES,
    "full",
  );
  const statusDetail = optionalEnum(
    env,
    "CODEX_STATUS_DETAIL",
    STATUS_DETAILS,
    "verbose",
  );
  const botRoot = await Deno.realPath(baseDir);
  const workspace = await Deno.realPath(resolve(botRoot, workspaceValue));
  const stat = await Deno.stat(workspace);

  if (!stat.isDirectory) {
    throw new Error("CODEX_WORKSPACE must resolve to a directory");
  }

  return {
    botId,
    botSecret,
    workspace,
    stateDbPath: join(botRoot, ".data", "bot.sqlite"),
    botRoot,
    intermediateOutput,
    statusDetail,
  };
}
