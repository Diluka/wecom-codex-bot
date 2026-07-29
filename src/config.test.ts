import {
  assertEquals,
  assertInstanceOf,
  assertMatch,
  assertNotMatch,
  assertRejects,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { loadConfig } from "./config.ts";

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
});
