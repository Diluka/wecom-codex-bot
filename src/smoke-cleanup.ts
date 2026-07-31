import type { Logger } from "pino";

type MaybePromise<T> = T | Promise<T>;

export async function finishSmoke(
  codexLogger: Logger,
  close: () => MaybePromise<unknown>,
  flush: () => void,
  hasPrimaryError: boolean,
): Promise<void> {
  try {
    await close();
  } catch (error) {
    codexLogger.error({ error }, "close_failed");
    if (!hasPrimaryError) throw error;
  } finally {
    flush();
  }
}
