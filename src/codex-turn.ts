export type CodexReasoningSummary = "auto" | "concise" | "detailed" | "none";

export interface CodexTurnOptions {
  summary?: CodexReasoningSummary;
}
