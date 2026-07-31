import { join, resolve } from "node:path";
import {
  type OutputSettings,
  parseGroupOutputSettings,
  parseOutputSettings,
} from "./output-settings.ts";
import { normalizeOwnerUserId } from "./owner-policy.ts";

export const LOG_LEVELS = ["debug", "info"] as const;
export type LogLevel = typeof LOG_LEVELS[number];

export interface BotConfig {
  botId: string;
  botSecret: string;
  ownerUserId?: string;
  workspace: string;
  stateDbPath: string;
  logLevel: LogLevel;
  outputSettings: OutputSettings;
  groupOutputSettings: OutputSettings;
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

function parseLogLevel(
  env: Record<string, string | undefined>,
): LogLevel {
  const value = env.LOG_LEVEL?.trim();
  if (!value) return "info";
  if ((LOG_LEVELS as readonly string[]).includes(value)) {
    return value as LogLevel;
  }
  throw new Error("Invalid environment variable: LOG_LEVEL");
}

export async function loadConfig(
  env: Record<string, string | undefined> = Deno.env.toObject(),
  baseDir = Deno.cwd(),
): Promise<BotConfig> {
  const botId = required(env, "BOT_ID");
  const botSecret = required(env, "BOT_SECRET");
  const ownerUserId = normalizeOwnerUserId(env.WECOM_OWNER_USER_ID);
  const workspaceValue = required(env, "CODEX_WORKSPACE");
  const logLevel = parseLogLevel(env);
  const outputSettings = parseOutputSettings(env);
  const groupOutputSettings = parseGroupOutputSettings(env, outputSettings);
  const botRoot = await Deno.realPath(baseDir);
  const workspace = await Deno.realPath(resolve(botRoot, workspaceValue));
  const stat = await Deno.stat(workspace);

  if (!stat.isDirectory) {
    throw new Error("CODEX_WORKSPACE must resolve to a directory");
  }

  return {
    botId,
    botSecret,
    ownerUserId,
    workspace,
    stateDbPath: join(botRoot, ".data", "bot.sqlite"),
    logLevel,
    outputSettings,
    groupOutputSettings,
  };
}
