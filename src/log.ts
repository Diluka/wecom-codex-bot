import { redactSecrets } from "./output.ts";

export type TerminalLogLevel = "info" | "error";

export interface TerminalLogger {
  log(message: string): void;
  error(message: string): void;
}

export function logTerminal(
  level: TerminalLogLevel,
  value: unknown,
  secrets: Iterable<string>,
  logger: TerminalLogger = console,
): void {
  const message = redactSecrets(errorMessage(value), secrets);
  if (level === "error") logger.error(`[wecom-codex-bot] ${message}`);
  else logger.log(`[wecom-codex-bot] ${message}`);
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;
  return String(value);
}
