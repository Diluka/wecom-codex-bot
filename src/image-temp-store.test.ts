import {
  assertEquals,
  assertMatch,
  assertRejects,
  assertStrictEquals,
  assertThrows,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { FakeTime } from "@std/testing/time";
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
const VALID_IMAGE = {
  status: "valid",
  url: "https://example.invalid/image",
  aesKey: "key-1",
} as const;

async function assertPreparationFailure(
  operation: () => Promise<unknown>,
  failure: ImagePreparationError["failure"],
): Promise<ImagePreparationError> {
  const error = await assertRejects(
    operation,
    ImagePreparationError,
    failure,
  ) as ImagePreparationError;
  assertEquals(error.failure, failure);
  assertEquals(error.message, `Image preparation failed: ${failure}`);
  assertEquals((error as Error & { cause?: unknown }).cause, undefined);
  return error;
}

function assertSynchronousPreparationFailure(
  operation: () => unknown,
  failure: ImagePreparationError["failure"],
): ImagePreparationError {
  const error = assertThrows(
    operation,
    ImagePreparationError,
    failure,
  ) as ImagePreparationError;
  assertEquals(error.failure, failure);
  assertEquals(error.message, `Image preparation failed: ${failure}`);
  assertEquals((error as Error & { cause?: unknown }).cause, undefined);
  return error;
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

  it("derives .jpg and .png extensions only from complete signatures", async () => {
    const downloads = [JPEG, PNG];
    const store = new ImageTempStore(() => Promise.resolve(downloads.shift()!));
    await store.start();

    try {
      const jpeg = await store.prepare(
        VALID_IMAGE,
        new AbortController().signal,
      );
      const png = await store.prepare(
        VALID_IMAGE,
        new AbortController().signal,
      );
      try {
        assertMatch(basename(jpeg.path), /^[0-9a-f-]+\.jpg$/);
        assertMatch(basename(png.path), /^[0-9a-f-]+\.png$/);
      } finally {
        await Promise.all([jpeg.release(), png.release()]);
      }
    } finally {
      await store.close();
    }
  });

  it("accepts exactly 10 MiB and rejects one byte more", async () => {
    const atLimit = new Uint8Array(10 * 1024 * 1024);
    atLimit.set(JPEG);
    const overLimit = new Uint8Array(10 * 1024 * 1024 + 1);
    overLimit.set(JPEG);
    const downloads = [atLimit, overLimit];
    const store = new ImageTempStore(() => Promise.resolve(downloads.shift()!));
    await store.start();

    try {
      const lease = await store.prepare(
        VALID_IMAGE,
        new AbortController().signal,
      );
      await lease.release();
      await assertPreparationFailure(
        () => store.prepare(VALID_IMAGE, new AbortController().signal),
        "too_large",
      );
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
      await owner.release();
      assertEquals((await Deno.stat(consumer.path)).isFile, true);
      await consumer.release();
      await assertRejects(
        () => Deno.stat(consumer.path),
        Deno.errors.NotFound,
      );
      await consumer.release();
    } finally {
      await store.close();
    }
  });

  it("rejects an invalid reference without invoking the downloader", async () => {
    let downloads = 0;
    const store = new ImageTempStore(() => {
      downloads++;
      return Promise.resolve(PNG);
    });
    await store.start();

    try {
      await assertPreparationFailure(
        () =>
          store.prepare(
            { status: "invalid" },
            new AbortController().signal,
          ),
        "invalid_reference",
      );
      assertEquals(downloads, 0);
    } finally {
      await store.close();
    }
  });

  it("rejects an already-aborted caller without invoking the downloader", async () => {
    let downloads = 0;
    const store = new ImageTempStore(() => {
      downloads++;
      return Promise.resolve(PNG);
    });
    const caller = new AbortController();
    caller.abort();
    await store.start();

    try {
      await assertPreparationFailure(
        () => store.prepare(VALID_IMAGE, caller.signal),
        "cancelled",
      );
      assertEquals(downloads, 0);
    } finally {
      await store.close();
    }
  });

  it("sanitizes downloader failures", async () => {
    const store = new ImageTempStore(() =>
      Promise.reject(new Error("download exposed /tmp/private-image"))
    );
    await store.start();

    try {
      await assertPreparationFailure(
        () => store.prepare(VALID_IMAGE, new AbortController().signal),
        "download_failed",
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
        "unsupported_format",
      );
    } finally {
      await store.close();
    }
  });

  it("sanitizes write failures and removes partial random files", async () => {
    const store = new ImageTempStore(() => Promise.resolve(PNG));
    await store.start();
    const first = await store.prepare(
      VALID_IMAGE,
      new AbortController().signal,
    );
    const root = dirname(first.path);
    await first.release();
    await Deno.chmod(root, 0o500);

    try {
      await assertPreparationFailure(
        () => store.prepare(VALID_IMAGE, new AbortController().signal),
        "write_failed",
      );
      assertEquals(await directoryEntries(root), []);
    } finally {
      await Deno.chmod(root, 0o700);
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
    const rejected = assertPreparationFailure(() => preparing, "cancelled");
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

  it("bounds close at five seconds when a downloader never settles", async () => {
    using time = new FakeTime();
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
    await lease.release();

    const preparing = store.prepare(
      VALID_IMAGE,
      new AbortController().signal,
    );
    const rejected = assertPreparationFailure(() => preparing, "cancelled");
    await hangingStarted.promise;
    const closing = store.close();
    let closed = false;
    void closing.then(() => closed = true);
    await rejected;
    await time.runMicrotasks();

    await time.tickAsync(4_999);
    assertEquals(closed, false);
    assertEquals((await Deno.stat(root)).isDirectory, true);
    await time.tickAsync(1);
    await closing;
    assertEquals(closed, true);
    await assertRejects(() => Deno.stat(root), Deno.errors.NotFound);
  });

  it("does not write or recreate its root when a download resolves after forced close", async () => {
    using time = new FakeTime();
    const lateDownload = Promise.withResolvers<Uint8Array>();
    const lateStarted = Promise.withResolvers<void>();
    const downloads = [
      () => Promise.resolve(JPEG),
      () => {
        lateStarted.resolve();
        return lateDownload.promise;
      },
    ];
    const store = new ImageTempStore(() => downloads.shift()!());
    await store.start();
    const lease = await store.prepare(
      VALID_IMAGE,
      new AbortController().signal,
    );
    const root = dirname(lease.path);
    await lease.release();

    const preparing = store.prepare(
      VALID_IMAGE,
      new AbortController().signal,
    );
    const rejected = assertPreparationFailure(() => preparing, "cancelled");
    await lateStarted.promise;
    const closing = store.close();
    await rejected;
    await time.runMicrotasks();
    await time.tickAsync(5_000);
    await closing;
    await assertRejects(() => Deno.stat(root), Deno.errors.NotFound);

    lateDownload.resolve(PNG);
    await lateDownload.promise;
    await time.runMicrotasks();
    await time.runMicrotasks();
    await assertRejects(() => Deno.stat(root), Deno.errors.NotFound);
  });

  it("keeps start, release, and close idempotent in valid lifecycle directions", async () => {
    const store = new ImageTempStore(() => Promise.resolve(JPEG));
    const firstStart = store.start();
    const secondStart = store.start();
    assertStrictEquals(secondStart, firstStart);
    await Promise.all([firstStart, secondStart]);
    await store.start();

    const lease = await store.prepare(
      VALID_IMAGE,
      new AbortController().signal,
    );
    const root = dirname(lease.path);
    await Promise.all([lease.release(), lease.release()]);

    const firstClose = store.close();
    const secondClose = store.close();
    assertStrictEquals(secondClose, firstClose);
    await Promise.all([firstClose, secondClose]);
    await store.close();
    await assertRejects(() => Deno.stat(root), Deno.errors.NotFound);
    await assertPreparationFailure(
      () => store.prepare(VALID_IMAGE, new AbortController().signal),
      "store_not_ready",
    );
    await assertPreparationFailure(() => store.start(), "store_not_ready");
  });

  it("prevents a released owner handle from retaining the live file", async () => {
    const store = new ImageTempStore(() => Promise.resolve(JPEG));
    await store.start();
    const owner = await store.prepare(
      VALID_IMAGE,
      new AbortController().signal,
    );
    const consumer = owner.retain();

    try {
      await owner.release();
      assertSynchronousPreparationFailure(
        () => owner.retain(),
        "store_not_ready",
      );
      assertEquals((await Deno.stat(consumer.path)).isFile, true);
      await consumer.release();
    } finally {
      await store.close();
    }
  });

  it("removes live leases on close and never lets them revive the file", async () => {
    const store = new ImageTempStore(() => Promise.resolve(PNG));
    await store.start();
    const owner = await store.prepare(
      VALID_IMAGE,
      new AbortController().signal,
    );
    const consumer = owner.retain();
    const root = dirname(owner.path);

    await store.close();
    await assertRejects(() => Deno.stat(root), Deno.errors.NotFound);
    assertSynchronousPreparationFailure(
      () => owner.retain(),
      "store_not_ready",
    );
    assertSynchronousPreparationFailure(
      () => consumer.retain(),
      "store_not_ready",
    );
    await Promise.all([owner.release(), consumer.release()]);
    await assertRejects(() => Deno.stat(root), Deno.errors.NotFound);
  });
});
