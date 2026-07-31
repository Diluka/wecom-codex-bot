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
  "SUBAGENT",
] as const;

export type OutputTag = (typeof OUTPUT_TAGS)[number];

export const OUTPUT_LEVELS = ["off", "line", "excerpt", "full"] as const;

export type OutputLevel = (typeof OUTPUT_LEVELS)[number];

export const OUTPUT_LABELS = ["show", "hide"] as const;

export type OutputLabel = (typeof OUTPUT_LABELS)[number];

export const TOOL_OUTPUT_FORMATS = [
  "individual",
  "summary",
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

function readOptionalEnum<T extends string>(
  env: Record<string, string | undefined>,
  name: string,
  values: readonly T[],
): T | undefined {
  const value = env[name]?.trim();
  if (!value) return undefined;
  if ((values as readonly string[]).includes(value)) return value as T;
  throw new Error(`Invalid environment variable: ${name}`);
}

function optionalEnum<T extends string>(
  env: Record<string, string | undefined>,
  name: string,
  values: readonly T[],
  defaultValue: T,
): T {
  return readOptionalEnum(env, name, values) ?? defaultValue;
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

export function parseGroupOutputSettings(
  env: Record<string, string | undefined>,
  defaults: OutputSettings,
): OutputSettings {
  const level = readOptionalEnum(
    env,
    "OUTPUT_GROUP_LEVEL",
    OUTPUT_LEVELS,
  );
  const label = readOptionalEnum(
    env,
    "OUTPUT_GROUP_LABEL",
    OUTPUT_LABELS,
  );

  return {
    level: level ?? defaults.level,
    levels: Object.fromEntries(
      OUTPUT_TAGS.map((tag) => [
        tag,
        readOptionalEnum(
          env,
          `OUTPUT_GROUP_LEVEL_${tag}`,
          OUTPUT_LEVELS,
        ) ?? level ?? defaults.levels[tag],
      ]),
    ) as Record<OutputTag, OutputLevel>,
    label: label ?? defaults.label,
    labels: Object.fromEntries(
      OUTPUT_TAGS.map((tag) => [
        tag,
        readOptionalEnum(
          env,
          `OUTPUT_GROUP_LABEL_${tag}`,
          OUTPUT_LABELS,
        ) ?? label ?? defaults.labels[tag],
      ]),
    ) as Record<OutputTag, OutputLabel>,
    toolFormat: readOptionalEnum(
      env,
      "OUTPUT_GROUP_FORMAT_TOOL",
      TOOL_OUTPUT_FORMATS,
    ) ?? defaults.toolFormat,
  };
}
