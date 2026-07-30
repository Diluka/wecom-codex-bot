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
  INTERMEDIATE_OUTPUT_MODES,
  type ProgressSettings,
  shouldShowStatus,
  STATUS_DETAILS,
} from "./output-settings.ts";

describe("loadConfig", () => {
  it("resolves a relative Codex workspace from the bot directory", async () => {
    const root = await Deno.makeTempDir();

    try {
      const config = await loadConfig(
        {
          BOT_ID: "bot-id",
          BOT_SECRET: "bot-secret",
          CODEX_WORKSPACE: ".",
        },
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
            {
              BOT_ID: "bot-id",
              BOT_SECRET: "bot-secret",
              CODEX_WORKSPACE: file,
            },
            Deno.cwd(),
          ),
        Error,
        "directory",
      );
    } finally {
      await Deno.remove(file);
    }
  });

  it("uses full intermediate output and verbose statuses by default", async () => {
    const config = await loadConfig(
      {
        BOT_ID: "bot-id",
        BOT_SECRET: "bot-secret",
        CODEX_WORKSPACE: ".",
      },
      Deno.cwd(),
    );

    assertEquals(config.intermediateOutput, "full");
    assertEquals(config.statusDetail, "verbose");
  });

  it("accepts every listed intermediate-output mode", async () => {
    assertEquals(INTERMEDIATE_OUTPUT_MODES, [
      "full",
      "no_tool_results",
      "merge_same_tool",
      "merge_all_tools",
      "none",
    ]);

    for (const intermediateOutput of INTERMEDIATE_OUTPUT_MODES) {
      const config = await loadConfig(
        {
          BOT_ID: "bot-id",
          BOT_SECRET: "bot-secret",
          CODEX_WORKSPACE: ".",
          CODEX_INTERMEDIATE_OUTPUT: intermediateOutput,
        },
        Deno.cwd(),
      );

      assertEquals(config.intermediateOutput, intermediateOutput);
    }
  });

  it("accepts every listed status-detail level", async () => {
    assertEquals(STATUS_DETAILS, ["verbose", "turn", "none"]);

    for (const statusDetail of STATUS_DETAILS) {
      const config = await loadConfig(
        {
          BOT_ID: "bot-id",
          BOT_SECRET: "bot-secret",
          CODEX_WORKSPACE: ".",
          CODEX_STATUS_DETAIL: statusDetail,
        },
        Deno.cwd(),
      );

      assertEquals(config.statusDetail, statusDetail);
    }
  });

  it("trims output settings and treats blank values as defaults", async () => {
    const config = await loadConfig(
      {
        BOT_ID: "bot-id",
        BOT_SECRET: "bot-secret",
        CODEX_WORKSPACE: ".",
        CODEX_INTERMEDIATE_OUTPUT: " merge_same_tool ",
        CODEX_STATUS_DETAIL: "   ",
      },
      Deno.cwd(),
    );

    assertEquals(config.intermediateOutput, "merge_same_tool");
    assertEquals(config.statusDetail, "verbose");
  });

  it("rejects invalid intermediate-output settings without echoing secrets", async () => {
    const error = await assertRejects(() =>
      loadConfig(
        {
          BOT_ID: "bot-id",
          BOT_SECRET: "do-not-print",
          CODEX_WORKSPACE: ".",
          CODEX_INTERMEDIATE_OUTPUT: "unexpected",
        },
        Deno.cwd(),
      )
    );

    assertInstanceOf(error, Error);
    assertMatch(error.message, /CODEX_INTERMEDIATE_OUTPUT/);
    assertNotMatch(error.message, /do-not-print/);
  });

  it("rejects invalid status-detail settings without echoing secrets", async () => {
    const error = await assertRejects(() =>
      loadConfig(
        {
          BOT_ID: "bot-id",
          BOT_SECRET: "do-not-print",
          CODEX_WORKSPACE: ".",
          CODEX_STATUS_DETAIL: "unexpected",
        },
        Deno.cwd(),
      )
    );

    assertInstanceOf(error, Error);
    assertMatch(error.message, /CODEX_STATUS_DETAIL/);
    assertNotMatch(error.message, /do-not-print/);
  });

  it("shows statuses at the configured detail level", () => {
    const cases: Array<{
      settings: ProgressSettings;
      turn: boolean;
      verbose: boolean;
    }> = [
      {
        settings: { intermediateOutput: "full", statusDetail: "verbose" },
        turn: true,
        verbose: true,
      },
      {
        settings: { intermediateOutput: "full", statusDetail: "turn" },
        turn: true,
        verbose: false,
      },
      {
        settings: { intermediateOutput: "full", statusDetail: "none" },
        turn: false,
        verbose: false,
      },
      {
        settings: { intermediateOutput: "none", statusDetail: "verbose" },
        turn: false,
        verbose: false,
      },
    ];

    for (const { settings, turn, verbose } of cases) {
      assertEquals(shouldShowStatus(settings, "turn"), turn);
      assertEquals(shouldShowStatus(settings, "verbose"), verbose);
    }
  });
});
