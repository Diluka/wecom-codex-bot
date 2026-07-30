import { join, resolve } from "node:path";
import { type OutputSettings, parseOutputSettings } from "./output-settings.ts";

export interface BotConfig {
  botId: string;
  botSecret: string;
  workspace: string;
  stateDbPath: string;
  botRoot: string;
  outputSettings: OutputSettings;
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

export async function loadConfig(
  env: Record<string, string | undefined> = Deno.env.toObject(),
  baseDir = Deno.cwd(),
): Promise<BotConfig> {
  const botId = required(env, "BOT_ID");
  const botSecret = required(env, "BOT_SECRET");
  const workspaceValue = required(env, "CODEX_WORKSPACE");
  const outputSettings = parseOutputSettings(env);
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
    outputSettings,
  };
}
