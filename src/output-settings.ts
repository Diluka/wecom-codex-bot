export const INTERMEDIATE_OUTPUT_MODES = [
  "full",
  "no_tool_results",
  "merge_same_tool",
  "merge_all_tools",
  "none",
] as const;

export type IntermediateOutputMode = (typeof INTERMEDIATE_OUTPUT_MODES)[number];

export const STATUS_DETAILS = ["verbose", "turn", "none"] as const;

export type StatusDetail = (typeof STATUS_DETAILS)[number];

export interface ProgressSettings {
  intermediateOutput: IntermediateOutputMode;
  statusDetail: StatusDetail;
}

export function shouldShowStatus(
  settings: ProgressSettings,
  level: "turn" | "verbose",
): boolean {
  if (
    settings.intermediateOutput === "none" ||
    settings.statusDetail === "none"
  ) {
    return false;
  }

  return level === "turn" || settings.statusDetail === "verbose";
}
