export const OUTPUT_TAGS = [
  "QUEUE",
  "TURN",
  "TOOL",
  "TOOL_RESULT",
  "CONTENT",
  "PLAN",
  "WARNING",
  "ERROR",
  "SHUTDOWN",
] as const;

export type OutputTag = (typeof OUTPUT_TAGS)[number];

export const OUTPUT_LEVELS = ["off", "line", "excerpt", "full"] as const;

export type OutputLevel = (typeof OUTPUT_LEVELS)[number];

export const OUTPUT_LABELS = ["show", "hide"] as const;

export type OutputLabel = (typeof OUTPUT_LABELS)[number];

export const TOOL_OUTPUT_FORMATS = [
  "individual",
  "merge_same",
  "merge_all",
] as const;

export type ToolOutputFormat = (typeof TOOL_OUTPUT_FORMATS)[number];

export interface OutputSettings {
  level: OutputLevel;
  levels: Record<OutputTag, OutputLevel>;
  label: OutputLabel;
  labels: Record<OutputTag, OutputLabel>;
  toolFormat: ToolOutputFormat;
}

function tagValues<T>(value: T): Record<OutputTag, T> {
  return Object.fromEntries(
    OUTPUT_TAGS.map((tag) => [tag, value]),
  ) as Record<OutputTag, T>;
}

export const DEFAULT_OUTPUT_SETTINGS: OutputSettings = {
  level: "full",
  levels: tagValues("full"),
  label: "show",
  labels: tagValues("show"),
  toolFormat: "individual",
};

function optionalEnum<T extends string>(
  env: Record<string, string | undefined>,
  name: string,
  values: readonly T[],
  defaultValue: T,
): T {
  const value = env[name]?.trim();
  if (!value) return defaultValue;
  if ((values as readonly string[]).includes(value)) return value as T;
  throw new Error(`Invalid environment variable: ${name}`);
}

export function parseOutputSettings(
  env: Record<string, string | undefined>,
): OutputSettings {
  const level = optionalEnum(
    env,
    "OUTPUT_LEVEL",
    OUTPUT_LEVELS,
    DEFAULT_OUTPUT_SETTINGS.level,
  );
  const label = optionalEnum(
    env,
    "OUTPUT_LABEL",
    OUTPUT_LABELS,
    DEFAULT_OUTPUT_SETTINGS.label,
  );

  return {
    level,
    levels: Object.fromEntries(
      OUTPUT_TAGS.map((tag) => [
        tag,
        optionalEnum(env, `OUTPUT_LEVEL_${tag}`, OUTPUT_LEVELS, level),
      ]),
    ) as Record<OutputTag, OutputLevel>,
    label,
    labels: Object.fromEntries(
      OUTPUT_TAGS.map((tag) => [
        tag,
        optionalEnum(env, `OUTPUT_LABEL_${tag}`, OUTPUT_LABELS, label),
      ]),
    ) as Record<OutputTag, OutputLabel>,
    toolFormat: optionalEnum(
      env,
      "OUTPUT_FORMAT_TOOL",
      TOOL_OUTPUT_FORMATS,
      DEFAULT_OUTPUT_SETTINGS.toolFormat,
    ),
  };
}

// Temporary runtime compatibility. New configuration uses OutputSettings only.
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

export const DEFAULT_PROGRESS_SETTINGS = {
  intermediateOutput: "full",
  statusDetail: "verbose",
} as const satisfies ProgressSettings;

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
