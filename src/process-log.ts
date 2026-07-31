import { join } from "node:path";

const ACTIVE_LOG_NAME = "wecom-codex-bot.log";

export interface ProcessLogOptions {
  now?: () => Date;
}

export interface ProcessLogPaths {
  activePath: string;
  archivePath?: string;
}

/** Rotates the previous process log before Pino opens the new active file. */
export async function prepareProcessLog(
  baseDir = Deno.cwd(),
  options: ProcessLogOptions = {},
): Promise<ProcessLogPaths> {
  const logsDir = join(baseDir, "logs");
  const activePath = join(logsDir, ACTIVE_LOG_NAME);
  await Deno.mkdir(logsDir, { recursive: true, mode: 0o700 });

  const archivePath = await rotateActiveLog(
    activePath,
    logsDir,
    options.now?.() ?? new Date(),
  );
  return {
    activePath,
    ...(archivePath ? { archivePath } : {}),
  };
}

async function rotateActiveLog(
  activePath: string,
  logsDir: string,
  now: Date,
): Promise<string | undefined> {
  if (!await exists(activePath)) return undefined;

  const stem = `wecom-codex-bot.${archiveStamp(now)}`;
  let suffix = 0;
  let archivePath: string;
  do {
    archivePath = join(
      logsDir,
      `${stem}${suffix === 0 ? "" : `-${suffix}`}.log`,
    );
    suffix++;
  } while (await exists(archivePath));

  await Deno.rename(activePath, archivePath);
  return archivePath;
}

function archiveStamp(date: Date): string {
  return date.toISOString().replace(/[-:.]/gu, "");
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}
