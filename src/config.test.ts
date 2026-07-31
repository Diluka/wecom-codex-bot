import {
  assertEquals,
  assertInstanceOf,
  assertMatch,
  assertNotMatch,
  assertRejects,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { loadConfig } from "./config.ts";
import {
  DEFAULT_OUTPUT_SETTINGS,
  OUTPUT_LABELS,
  OUTPUT_LEVELS,
  OUTPUT_TAGS,
  type OutputSettings,
  parseOutputSettings,
  TOOL_OUTPUT_FORMATS,
} from "./output-settings.ts";

function configEnv(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    BOT_ID: "bot-id",
    BOT_SECRET: "bot-secret",
    CODEX_WORKSPACE: ".",
    ...overrides,
  };
}

function expectedSettings(
  level: OutputSettings["level"] = "full",
  label: OutputSettings["label"] = "show",
  toolFormat: OutputSettings["toolFormat"] = "individual",
): OutputSettings {
  return {
    level,
    levels: Object.fromEntries(
      OUTPUT_TAGS.map((tag) => [tag, level]),
    ) as OutputSettings["levels"],
    label,
    labels: Object.fromEntries(
      OUTPUT_TAGS.map((tag) => [tag, label]),
    ) as OutputSettings["labels"],
    toolFormat,
  };
}

describe("loadConfig", () => {
  it("resolves a relative Codex workspace from the bot directory", async () => {
    const root = await Deno.makeTempDir();

    try {
      const config = await loadConfig(
        configEnv(),
        root,
      );

      assertEquals(config.workspace, await Deno.realPath(root));
      assertEquals(
        config.stateDbPath,
        `${await Deno.realPath(root)}/.data/bot.sqlite`,
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("rejects missing required variables without echoing secrets", async () => {
    const error = await assertRejects(() =>
      loadConfig({ BOT_SECRET: "do-not-print" }, Deno.cwd())
    );
    assertInstanceOf(error, Error);
    assertMatch(error.message, /BOT_ID/);
    assertNotMatch(error.message, /do-not-print/);
  });

  it("rejects a workspace that is not a directory", async () => {
    const file = await Deno.makeTempFile();

    try {
      await assertRejects(
        () =>
          loadConfig(
            configEnv({ CODEX_WORKSPACE: file }),
            Deno.cwd(),
          ),
        Error,
        "directory",
      );
    } finally {
      await Deno.remove(file);
    }
  });

  it("uses output-only defaults for every tag", async () => {
    assertEquals(OUTPUT_TAGS, [
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
    ]);
    assertEquals(OUTPUT_LEVELS, ["off", "line", "excerpt", "full"]);
    assertEquals(OUTPUT_LABELS, ["show", "hide"]);
    assertEquals(TOOL_OUTPUT_FORMATS, [
      "individual",
      "merge_same",
      "merge_all",
    ]);

    const config = await loadConfig(configEnv(), Deno.cwd());

    assertEquals(config.outputSettings, expectedSettings());
    assertEquals(DEFAULT_OUTPUT_SETTINGS, expectedSettings());
  });

  it("trims global and per-tag output settings", async () => {
    const config = await loadConfig(
      configEnv({
        OUTPUT_LEVEL: " excerpt ",
        OUTPUT_LEVEL_TOOL: " full ",
        OUTPUT_LABEL: " hide ",
        OUTPUT_LABEL_CONTENT: " show ",
        OUTPUT_FORMAT_TOOL: " merge_all ",
      }),
      Deno.cwd(),
    );

    assertEquals(config.outputSettings.level, "excerpt");
    assertEquals(config.outputSettings.levels.TOOL, "full");
    assertEquals(config.outputSettings.levels.CONTENT, "excerpt");
    assertEquals(config.outputSettings.label, "hide");
    assertEquals(config.outputSettings.labels.CONTENT, "show");
    assertEquals(config.outputSettings.labels.TOOL, "hide");
    assertEquals(config.outputSettings.toolFormat, "merge_all");
  });

  it("accepts subagent output-level and label overrides", () => {
    const settings = parseOutputSettings({
      OUTPUT_LEVEL_SUBAGENT: " off ",
      OUTPUT_LABEL_SUBAGENT: " hide ",
    });

    assertEquals(settings.levels.SUBAGENT, "off");
    assertEquals(settings.labels.SUBAGENT, "hide");
  });

  it("inherits global values for absent or blank per-tag settings", async () => {
    const config = await loadConfig(
      configEnv({
        OUTPUT_LEVEL: "line",
        OUTPUT_LABEL: "hide",
        OUTPUT_LEVEL_QUEUE: "   ",
        OUTPUT_LABEL_QUEUE: "\t",
      }),
      Deno.cwd(),
    );

    for (const tag of OUTPUT_TAGS) {
      assertEquals(config.outputSettings.levels[tag], "line");
      assertEquals(config.outputSettings.labels[tag], "hide");
    }
  });

  it("rejects invalid output settings by naming only the invalid variable", async () => {
    for (
      const name of [
        "OUTPUT_LEVEL",
        "OUTPUT_LEVEL_TOOL_RESULT",
        "OUTPUT_LABEL",
        "OUTPUT_LABEL_WARNING",
        "OUTPUT_FORMAT_TOOL",
      ]
    ) {
      const error = await assertRejects(() =>
        loadConfig(
          configEnv({
            BOT_SECRET: "do-not-print",
            ANOTHER_SECRET: "also-do-not-print",
            [name]: "invalid-setting-value",
          }),
          Deno.cwd(),
        )
      );

      assertInstanceOf(error, Error);
      assertEquals(error.message, `Invalid environment variable: ${name}`);
      assertNotMatch(error.message, /invalid-setting-value/);
      assertNotMatch(error.message, /do-not-print/);
    }
  });
});
