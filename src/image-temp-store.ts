import { join } from "node:path";

import type { InboundImageReference } from "./wecom.ts";

export class ImagePreparationError extends Error {
  constructor() {
    super("Image preparation failed");
  }
}

export interface ImageLease {
  readonly path: string;
  retain(): ImageLease;
  release(): Promise<void>;
}

export interface ImagePreparer {
  prepare(
    reference: InboundImageReference,
    signal: AbortSignal,
  ): Promise<ImageLease>;
}

export type DownloadImage = (
  reference: InboundImageReference,
) => Promise<Uint8Array>;

const PNG_SIGNATURE = new Uint8Array([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
]);

interface ManagedImageFile {
  readonly path: string;
  references: number;
}

export class ImageTempStore implements ImagePreparer {
  readonly #downloadImage: DownloadImage;
  readonly #abort = new AbortController();
  readonly #localWrites = new Set<Promise<void>>();
  #root?: string;
  #closed = false;

  constructor(downloadImage: DownloadImage) {
    this.#downloadImage = downloadImage;
  }

  async start(): Promise<void> {
    if (this.#closed) {
      throw new ImagePreparationError();
    }
    if (this.#root) return;
    let createdRoot: string | undefined;
    try {
      createdRoot = await Deno.makeTempDir({
        dir: "/tmp",
        prefix: "wecom-codex-bot-",
      });
      await Deno.chmod(createdRoot, 0o700);
      if (this.#closed) {
        throw new ImagePreparationError();
      }
      this.#root = createdRoot;
      createdRoot = undefined;
    } catch (error) {
      if (createdRoot !== undefined) {
        await this.#removePathBestEffort(createdRoot, true);
      }
      if (error instanceof ImagePreparationError) throw error;
      throw new ImagePreparationError();
    }
  }

  prepare(
    reference: InboundImageReference,
    signal: AbortSignal,
  ): Promise<ImageLease> {
    if (this.#closed || this.#root === undefined) {
      return Promise.reject(new ImagePreparationError());
    }
    if (signal.aborted) {
      return Promise.reject(new ImagePreparationError());
    }

    const combinedSignal = AbortSignal.any([signal, this.#abort.signal]);
    const worker = this.#prepare(reference, combinedSignal);

    let removeAbortListener = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      const rejectCancelled = () => {
        reject(new ImagePreparationError());
      };
      combinedSignal.addEventListener("abort", rejectCancelled, { once: true });
      removeAbortListener = () =>
        combinedSignal.removeEventListener("abort", rejectCancelled);
    });

    return Promise.race([worker, cancelled]).finally(removeAbortListener);
  }

  async #prepare(
    reference: InboundImageReference,
    signal: AbortSignal,
  ): Promise<ImageLease> {
    let bytes: Uint8Array;
    try {
      bytes = await this.#downloadImage(reference);
    } catch {
      throw new ImagePreparationError();
    }

    this.#throwIfCancelled(signal);
    const extension = imageExtension(bytes);
    if (extension === undefined) {
      throw new ImagePreparationError();
    }

    const root = this.#root;
    if (root === undefined) {
      throw new ImagePreparationError();
    }
    const path = join(root, `${crypto.randomUUID()}${extension}`);
    const writeFinished = Promise.withResolvers<void>();
    this.#localWrites.add(writeFinished.promise);
    try {
      try {
        await Deno.writeFile(path, bytes, {
          createNew: true,
          mode: 0o600,
        });
      } catch {
        await this.#removePathBestEffort(path);
        throw new ImagePreparationError();
      }

      try {
        this.#throwIfCancelled(signal);
      } catch (error) {
        await this.#removePathBestEffort(path);
        throw error;
      }

      const file: ManagedImageFile = {
        path,
        references: 1,
      };
      return this.#lease(file);
    } finally {
      this.#localWrites.delete(writeFinished.promise);
      writeFinished.resolve();
    }
  }

  #throwIfCancelled(signal: AbortSignal): void {
    if (signal.aborted) {
      throw new ImagePreparationError();
    }
  }

  #lease(file: ManagedImageFile): ImageLease {
    let released = false;
    return {
      path: file.path,
      retain: (): ImageLease => {
        if (
          released || this.#closed || file.references <= 0
        ) {
          throw new ImagePreparationError();
        }
        file.references++;
        return this.#lease(file);
      },
      release: async (): Promise<void> => {
        if (released) return;
        released = true;
        if (file.references <= 0) return;
        file.references--;
        if (file.references > 0) return;
        try {
          await this.#removePath(file.path, false);
        } catch {
          throw new ImagePreparationError();
        }
      },
    };
  }

  async #removePath(path: string, recursive: boolean): Promise<void> {
    try {
      await Deno.remove(path, { recursive });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }

  async #removePathBestEffort(
    path: string,
    recursive = false,
  ): Promise<void> {
    try {
      await this.#removePath(path, recursive);
    } catch {
      // Cleanup is best-effort on an already failing path.
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#abort.abort();
    const root = this.#root;
    this.#root = undefined;
    await Promise.all(this.#localWrites);
    if (root !== undefined) {
      try {
        await this.#removePath(root, true);
      } catch {
        throw new ImagePreparationError();
      }
    }
  }
}

function imageExtension(
  bytes: Uint8Array,
): ".jpg" | ".png" | ".gif" | ".webp" | undefined {
  if (
    bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return ".jpg";
  }
  if (hasPrefix(bytes, PNG_SIGNATURE)) return ".png";
  if (
    bytes.byteLength >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 &&
    bytes[2] === 0x46 && bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61
  ) {
    return ".gif";
  }
  if (
    bytes.byteLength >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 &&
    bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 &&
    bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) {
    return ".webp";
  }
  return undefined;
}

function hasPrefix(bytes: Uint8Array, signature: Uint8Array): boolean {
  if (bytes.byteLength < signature.byteLength) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}
