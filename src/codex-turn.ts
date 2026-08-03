export type CodexReasoningSummary = "auto" | "concise" | "detailed" | "none";

export interface CodexTurnInput {
  readonly text: string;
  readonly localImagePaths: readonly string[];
}

export interface CodexTurnOptions {
  summary?: CodexReasoningSummary;
}
