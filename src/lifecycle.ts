export interface LifecycleState {
  markRuntimeLost(): number;
  close(): void;
}

export interface LifecycleRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface LifecycleGateway {
  connect(): unknown;
  disconnect(): void;
}

export interface LifecycleOrchestrator {
  interruptAll(): Promise<void>;
}

export interface LifecycleOutput {
  beginShutdown(): void;
  finishAll(): Promise<void>;
}

export interface BotLifecycleOptions {
  state: LifecycleState;
  runtime: LifecycleRuntime;
  gateway: LifecycleGateway;
  orchestrator: LifecycleOrchestrator;
  output: LifecycleOutput;
  onError?: (error: Error) => void;
}

export class BotLifecycle {
  readonly #options: BotLifecycleOptions;
  #started = false;
  #closed = false;
  #stateClosed = false;
  #startPromise?: Promise<number>;
  #stopPromise?: Promise<void>;

  constructor(options: BotLifecycleOptions) {
    this.#options = options;
  }

  start(): Promise<number> {
    if (this.#closed) {
      return Promise.reject(new Error("bot lifecycle is already closed"));
    }
    if (this.#started) return Promise.resolve(0);
    if (this.#startPromise) return this.#startPromise;

    const startPromise = this.#start();
    this.#startPromise = startPromise;
    void startPromise.then(
      () => this.#clearStartPromise(startPromise),
      () => this.#clearStartPromise(startPromise),
    );
    return startPromise;
  }

  async #start(): Promise<number> {
    const runtimeLost = this.#options.state.markRuntimeLost();
    let runtimeStarted = false;
    try {
      await this.#options.runtime.start();
      runtimeStarted = true;
      if (this.#closed) {
        throw new Error("bot lifecycle stopped while starting");
      }
      this.#options.gateway.connect();
      this.#started = true;
      return runtimeLost;
    } catch (error) {
      if (runtimeStarted) {
        await this.#attempt(() => this.#options.runtime.stop());
      }
      this.#closeState();
      throw error;
    }
  }

  stop(): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    if (this.#closed) return Promise.resolve();

    this.#stopPromise = this.#stop();
    return this.#stopPromise;
  }

  async #stop(): Promise<void> {
    this.#closed = true;
    const startPromise = this.#startPromise;
    if (startPromise) {
      try {
        await startPromise;
      } catch {
        // Startup owns cleanup when shutdown wins the race.
      }
    }
    if (this.#started) {
      // interruptAll synchronously closes the orchestrator's intake gate.
      let interrupting: Promise<void>;
      try {
        interrupting = this.#options.orchestrator.interruptAll();
      } catch (error) {
        this.#report(toError(error));
        interrupting = Promise.resolve();
      }
      try {
        this.#options.output.beginShutdown();
      } catch (error) {
        this.#report(toError(error));
      }
      await this.#attempt(() => interrupting);
      await this.#attempt(() => this.#options.output.finishAll());
      await this.#attempt(() => this.#options.gateway.disconnect());
      await this.#attempt(() => this.#options.runtime.stop());
    }
    this.#closeState();
  }

  async #attempt(operation: () => unknown | Promise<unknown>): Promise<void> {
    try {
      await operation();
    } catch (error) {
      this.#report(toError(error));
    }
  }

  #closeState(): void {
    if (this.#stateClosed) return;
    try {
      this.#options.state.close();
    } catch (error) {
      this.#report(toError(error));
    }
    this.#stateClosed = true;
    this.#closed = true;
    this.#started = false;
  }

  #clearStartPromise(startPromise: Promise<number>): void {
    if (this.#startPromise === startPromise) {
      this.#startPromise = undefined;
    }
  }

  #report(error: Error): void {
    try {
      this.#options.onError?.(error);
    } catch {
      // Shutdown error reporting must not prevent later cleanup steps.
    }
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
