import { assertEquals, assertMatch, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { basename, dirname } from "node:path";

import { ImagePreparationError, ImageTempStore } from "./image-temp-store.ts";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const PNG = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
const WEBP = new Uint8Array([
  0x52,
  0x49,
  0x46,
  0x46,
  0,
  0,
  0,
  0,
  0x57,
  0x45,
  0x42,
  0x50,
]);
const VALID_IMAGE = {
  url: "https://example.invalid/image",
  aesKey: "key-1",
} as const;

async function assertPreparationFailure(
  operation: () => Promise<unknown>,
): Promise<void> {
  await assertRejects(operation, ImagePreparationError);
}

async function directoryEntries(path: string): Promise<string[]> {
  const entries: string[] = [];
  for await (const entry of Deno.readDir(path)) entries.push(entry.name);
  return entries.sort();
}

describe("ImageTempStore", () => {
  it("creates a 0700 process directory and 0600 signature-derived files", async () => {
    const store = new ImageTempStore(() => Promise.resolve(PNG));
    let root: string | undefined;
    let lease: Awaited<ReturnType<ImageTempStore["prepare"]>> | undefined;

    await store.start();
    try {
      lease = await store.prepare(
        VALID_IMAGE,
        new AbortController().signal,
      );
      root = dirname(lease.path);
      assertMatch(root, /^\/tmp\/wecom-codex-bot-/);
      assertEquals((await Deno.stat(root)).mode! & 0o777, 0o700);
      assertMatch(basename(lease.path), /^[0-9a-f-]+\.png$/);
      assertEquals((await Deno.stat(lease.path)).mode! & 0o777, 0o600);
    } finally {
      await lease?.release();
      await store.close();
    }

    await assertRejects(() => Deno.stat(root!), Deno.errors.NotFound);
  });

  it("maps supported image signatures to file extensions", async () => {
    const downloads = [JPEG, PNG, GIF, WEBP];
    const store = new ImageTempStore(() => Promise.resolve(downloads.shift()!));
    await store.start();

    try {
      for (const extension of ["jpg", "png", "gif", "webp"]) {
        const lease = await store.prepare(
          VALID_IMAGE,
          new AbortController().signal,
        );
        assertMatch(
          basename(lease.path),
          new RegExp(`^[0-9a-f-]+\\.${extension}$`),
        );
        await lease.release();
      }
    } finally {
      await store.close();
    }
  });

  it("keeps the file until every retained lease is released", async () => {
    const store = new ImageTempStore(() => Promise.resolve(JPEG));
    await store.start();
    const owner = await store.prepare(
      VALID_IMAGE,
      new AbortController().signal,
    );
    const consumer = owner.retain();

    try {
      await owner.release();
      assertEquals((await Deno.stat(consumer.path)).isFile, true);
      await consumer.release();
      await assertRejects(
        () => Deno.stat(consumer.path),
        Deno.errors.NotFound,
      );
    } finally {
      await store.close();
    }
  });

  it("rejects downloader failures", async () => {
    const store = new ImageTempStore(() =>
      Promise.reject(new Error("download failed"))
    );
    await store.start();

    try {
      await assertPreparationFailure(
        () => store.prepare(VALID_IMAGE, new AbortController().signal),
      );
    } finally {
      await store.close();
    }
  });

  it("rejects bytes without a supported image signature", async () => {
    const store = new ImageTempStore(() =>
      Promise.resolve(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
    );
    await store.start();

    try {
      await assertPreparationFailure(
        () => store.prepare(VALID_IMAGE, new AbortController().signal),
      );
    } finally {
      await store.close();
    }
  });

  it("cancels promptly and never writes a late external download", async () => {
    const download = Promise.withResolvers<Uint8Array>();
    const downloadStarted = Promise.withResolvers<void>();
    const downloads = [
      () => Promise.resolve(PNG),
      () => {
        downloadStarted.resolve();
        return download.promise;
      },
    ];
    const store = new ImageTempStore(() => downloads.shift()!());
    const caller = new AbortController();
    await store.start();
    const rootLease = await store.prepare(
      VALID_IMAGE,
      new AbortController().signal,
    );
    const root = dirname(rootLease.path);
    await rootLease.release();

    const preparing = store.prepare(VALID_IMAGE, caller.signal);
    const rejected = assertPreparationFailure(() => preparing);
    await downloadStarted.promise;
    caller.abort();
    await rejected;

    download.resolve(PNG);
    await download.promise;
    await Promise.resolve();
    await Promise.resolve();

    try {
      assertEquals(await directoryEntries(root), []);
    } finally {
      await store.close();
    }
  });

  it("closes without waiting for a downloader and ignores its late result", async () => {
    const hangingDownload = Promise.withResolvers<Uint8Array>();
    const hangingStarted = Promise.withResolvers<void>();
    const downloads = [
      () => Promise.resolve(PNG),
      () => {
        hangingStarted.resolve();
        return hangingDownload.promise;
      },
    ];
    const store = new ImageTempStore(() => downloads.shift()!());
    await store.start();
    const lease = await store.prepare(
      VALID_IMAGE,
      new AbortController().signal,
    );
    const root = dirname(lease.path);

    const preparing = store.prepare(
      VALID_IMAGE,
      new AbortController().signal,
    );
    const rejected = assertPreparationFailure(() => preparing);
    await hangingStarted.promise;
    const closing = store.close();
    await rejected;
    await closing;
    await assertRejects(() => Deno.stat(root), Deno.errors.NotFound);
    hangingDownload.resolve(PNG);
    await hangingDownload.promise;
    await Promise.resolve();
    await Promise.resolve();

    await assertRejects(() => Deno.stat(root), Deno.errors.NotFound);
    await lease.release();
  });

  it("waits for an in-flight local write before deleting its temporary directory", async () => {
    const originalWriteFile = Deno.writeFile;
    const originalRemove = Deno.remove;
    const writeStarted = Promise.withResolvers<void>();
    const allowWrite = Promise.withResolvers<void>();
    let writePath: string | undefined;
    let rootRemovalStarted = false;
    let preparing:
      | Promise<Awaited<ReturnType<ImageTempStore["prepare"]>>>
      | undefined;
    let closing: Promise<void> | undefined;

    Deno.writeFile = async (...args: Parameters<typeof originalWriteFile>) => {
      writePath = String(args[0]);
      writeStarted.resolve();
      await allowWrite.promise;
      await originalWriteFile(...args);
    };
    Deno.remove = async (...args: Parameters<typeof originalRemove>) => {
      if (
        args[1]?.recursive && writePath !== undefined &&
        String(args[0]) === dirname(writePath)
      ) {
        rootRemovalStarted = true;
      }
      await originalRemove(...args);
    };

    const store = new ImageTempStore(() => Promise.resolve(PNG));
    try {
      await store.start();
      preparing = store.prepare(
        VALID_IMAGE,
        new AbortController().signal,
      );
      const rejected = assertPreparationFailure(() => preparing!);
      await writeStarted.promise;

      closing = store.close();
      await Promise.resolve();
      assertEquals(rootRemovalStarted, false);

      allowWrite.resolve();
      await rejected;
      await closing;
      assertEquals(rootRemovalStarted, true);
      await assertRejects(
        () => Deno.stat(dirname(writePath!)),
        Deno.errors.NotFound,
      );
    } finally {
      allowWrite.resolve();
      await Promise.allSettled([preparing, closing].filter(Boolean));
      Deno.writeFile = originalWriteFile;
      Deno.remove = originalRemove;
      await store.close();
    }
  });
});
