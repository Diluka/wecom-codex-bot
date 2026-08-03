import { join } from "node:path";

import type {
  InboundImageReference,
  ValidInboundImageReference,
} from "./wecom.ts";

export type ImagePreparationFailure =
  | "invalid_reference"
  | "download_failed"
  | "too_large"
  | "unsupported_format"
  | "write_failed"
  | "cancelled"
  | "store_not_ready"
  | "cleanup_failed";

export class ImagePreparationError extends Error {
  constructor(readonly failure: ImagePreparationFailure) {
    super(`Image preparation failed: ${failure}`);
    this.name = "ImagePreparationError";
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
  reference: ValidInboundImageReference,
) => Promise<Uint8Array>;

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_CLOSE_GRACE_MS = 5_000;
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
  removed: boolean;
}

export class ImageTempStore implements ImagePreparer {
  readonly #downloadImage: DownloadImage;
  readonly #controllers = new Set<AbortController>();
  readonly #tasks = new Set<Promise<void>>();
  readonly #files = new Map<string, ManagedImageFile>();
  readonly #cleanupRoots = new Set<string>();
  #root?: string;
  #startPromise?: Promise<void>;
  #closePromise?: Promise<void>;
  #closed = false;

  constructor(downloadImage: DownloadImage) {
    this.#downloadImage = downloadImage;
  }

  start(): Promise<void> {
    if (this.#closed) {
      return Promise.reject(new ImagePreparationError("store_not_ready"));
    }
    if (this.#root) return Promise.resolve();
    if (this.#startPromise) return this.#startPromise;
    this.#startPromise = this.#start();
    return this.#startPromise;
  }

  async #start(): Promise<void> {
    let createdRoot: string | undefined;
    try {
      createdRoot = await Deno.makeTempDir({
        dir: "/tmp",
        prefix: "wecom-codex-bot-",
      });
      await Deno.chmod(createdRoot, 0o700);
      if (this.#closed) {
        throw new ImagePreparationError("store_not_ready");
      }
      this.#root = createdRoot;
      createdRoot = undefined;
    } catch (error) {
      if (createdRoot !== undefined) {
        try {
          await this.#removePath(createdRoot, true);
        } catch {
          this.#cleanupRoots.add(createdRoot);
        }
      }
      if (error instanceof ImagePreparationError) throw error;
      throw new ImagePreparationError("write_failed");
    }
  }

  prepare(
    reference: InboundImageReference,
    signal: AbortSignal,
  ): Promise<ImageLease> {
    if (reference.status !== "valid") {
      return Promise.reject(
        new ImagePreparationError("invalid_reference"),
      );
    }
    if (this.#closed || this.#root === undefined) {
      return Promise.reject(new ImagePreparationError("store_not_ready"));
    }
    if (signal.aborted) {
      return Promise.reject(new ImagePreparationError("cancelled"));
    }

    const controller = new AbortController();
    this.#controllers.add(controller);
    const worker = this.#prepare(reference, signal, controller);
    const trackedWorker = worker.then(
      () => undefined,
      () => undefined,
    ).finally(() => {
      this.#controllers.delete(controller);
      this.#tasks.delete(trackedWorker);
    });
    this.#tasks.add(trackedWorker);

    let removeAbortListeners = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      const rejectCancelled = () => {
        reject(new ImagePreparationError("cancelled"));
      };
      signal.addEventListener("abort", rejectCancelled, { once: true });
      controller.signal.addEventListener("abort", rejectCancelled, {
        once: true,
      });
      removeAbortListeners = () => {
        signal.removeEventListener("abort", rejectCancelled);
        controller.signal.removeEventListener("abort", rejectCancelled);
      };
    });

    return Promise.race([worker, cancelled]).finally(removeAbortListeners);
  }

  async #prepare(
    reference: ValidInboundImageReference,
    callerSignal: AbortSignal,
    controller: AbortController,
  ): Promise<ImageLease> {
    this.#throwIfCancelled(callerSignal, controller.signal);

    let bytes: Uint8Array;
    try {
      bytes = await this.#downloadImage(reference);
    } catch {
      throw new ImagePreparationError("download_failed");
    }

    this.#throwIfCancelled(callerSignal, controller.signal);
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      throw new ImagePreparationError("too_large");
    }
    const extension = imageExtension(bytes);
    if (extension === undefined) {
      throw new ImagePreparationError("unsupported_format");
    }
    this.#throwIfCancelled(callerSignal, controller.signal);

    const root = this.#root;
    if (root === undefined) {
      throw new ImagePreparationError("cancelled");
    }
    const path = join(root, `${crypto.randomUUID()}${extension}`);
    try {
      await Deno.writeFile(path, bytes, {
        createNew: true,
        mode: 0o600,
      });
    } catch {
      await this.#removePathBestEffort(path);
      throw new ImagePreparationError("write_failed");
    }

    try {
      this.#throwIfCancelled(callerSignal, controller.signal);
    } catch (error) {
      await this.#removePathBestEffort(path);
      throw error;
    }

    const file: ManagedImageFile = {
      path,
      references: 1,
      removed: false,
    };
    this.#files.set(path, file);
    return this.#lease(file);
  }

  #throwIfCancelled(
    callerSignal: AbortSignal,
    storeSignal: AbortSignal,
  ): void {
    if (this.#closed || callerSignal.aborted || storeSignal.aborted) {
      throw new ImagePreparationError("cancelled");
    }
  }

  #lease(file: ManagedImageFile): ImageLease {
    let released = false;
    return {
      path: file.path,
      retain: (): ImageLease => {
        if (
          released || this.#closed || file.removed ||
          file.references <= 0 || this.#files.get(file.path) !== file
        ) {
          throw new ImagePreparationError("store_not_ready");
        }
        file.references++;
        return this.#lease(file);
      },
      release: async (): Promise<void> => {
        if (released) return;
        released = true;
        if (file.removed || file.references <= 0) return;
        file.references--;
        if (file.references > 0) return;
        await this.#removeManagedFile(file);
      },
    };
  }

  async #removeManagedFile(file: ManagedImageFile): Promise<void> {
    try {
      await this.#removePath(file.path, false);
    } catch {
      throw new ImagePreparationError("cleanup_failed");
    }
    file.removed = true;
    this.#files.delete(file.path);
  }

  async #removePath(path: string, recursive: boolean): Promise<void> {
    const removal = Deno.remove(path, { recursive });
    const tracked = this.#trackTask(removal);
    try {
      await removal;
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    } finally {
      await tracked;
    }
  }

  async #removePathBestEffort(path: string): Promise<void> {
    try {
      await this.#removePath(path, false);
    } catch {
      // The process-root cleanup is the final fallback for orphaned candidates.
    }
  }

  #trackTask<T>(task: Promise<T>): Promise<void> {
    const tracked = task.then(
      () => undefined,
      () => undefined,
    ).finally(() => this.#tasks.delete(tracked));
    this.#tasks.add(tracked);
    return tracked;
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    for (const controller of this.#controllers) controller.abort();
    this.#closePromise = this.#close();
    return this.#closePromise;
  }

  async #close(): Promise<void> {
    if (this.#startPromise) {
      try {
        await this.#startPromise;
      } catch {
        // Startup owns cleanup of any directory it failed to publish.
      }
    }

    const tasks = [...this.#tasks];
    if (tasks.length > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled(tasks).then(() => undefined),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, IMAGE_CLOSE_GRACE_MS);
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }

    const roots = new Set(this.#cleanupRoots);
    if (this.#root !== undefined) roots.add(this.#root);
    this.#root = undefined;
    let cleanupFailed = false;
    for (const root of roots) {
      try {
        await this.#removePath(root, true);
        this.#cleanupRoots.delete(root);
      } catch {
        cleanupFailed = true;
      }
    }

    for (const file of this.#files.values()) file.removed = true;
    this.#files.clear();
    if (cleanupFailed) {
      throw new ImagePreparationError("cleanup_failed");
    }
  }
}

function imageExtension(bytes: Uint8Array): ".jpg" | ".png" | undefined {
  if (
    bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return ".jpg";
  }
  if (hasPrefix(bytes, PNG_SIGNATURE)) return ".png";
  return undefined;
}

function hasPrefix(bytes: Uint8Array, signature: Uint8Array): boolean {
  if (bytes.byteLength < signature.byteLength) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}
