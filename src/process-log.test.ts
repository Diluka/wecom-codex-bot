import { assertEquals, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { prepareProcessLog } from "./process-log.ts";

const STARTED_AT = new Date("2026-07-31T08:13:22.123Z");

describe("prepareProcessLog", () => {
  it("prepares one active path without implementing file writes", async () => {
    const root = await Deno.makeTempDir();

    try {
      const processLog = await prepareProcessLog(root, {
        now: () => STARTED_AT,
      });

      assertEquals(processLog, {
        activePath: `${root}/logs/wecom-codex-bot.log`,
      });
      await assertRejects(
        () => Deno.stat(processLog.activePath),
        Deno.errors.NotFound,
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("archives the previous process log without overwriting a collision", async () => {
    const root = await Deno.makeTempDir();
    const logs = `${root}/logs`;

    try {
      await Deno.mkdir(logs);
      await Deno.writeTextFile(`${logs}/wecom-codex-bot.log`, "previous\n");
      await Deno.writeTextFile(
        `${logs}/wecom-codex-bot.20260731T081322123Z.log`,
        "collision\n",
      );

      const processLog = await prepareProcessLog(root, {
        now: () => STARTED_AT,
      });
      assertEquals(
        processLog.archivePath,
        `${logs}/wecom-codex-bot.20260731T081322123Z-1.log`,
      );
      assertEquals(
        await Deno.readTextFile(
          `${logs}/wecom-codex-bot.20260731T081322123Z.log`,
        ),
        "collision\n",
      );
      assertEquals(
        await Deno.readTextFile(processLog.archivePath!),
        "previous\n",
      );
      await assertRejects(
        () => Deno.stat(processLog.activePath),
        Deno.errors.NotFound,
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});
