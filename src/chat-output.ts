import type {
  ChatOutput,
  ProgressHandle,
  RoutedMessage,
  RoutedText,
} from "./orchestrator.ts";
import {
  ConversationSendQueue,
  redactSecrets,
  splitUtf8,
  StreamController,
  type StreamControllerOptions,
  WeComSink,
} from "./output.ts";
import {
  DEFAULT_PROGRESS_SETTINGS,
  type ProgressSettings,
  shouldShowStatus,
} from "./output-settings.ts";

export interface WeComReplyGateway {
  reply(frame: unknown, body: Record<string, unknown>): Promise<boolean>;
  replyStream(
    frame: unknown,
    streamId: string,
    content: string,
    finish?: boolean,
  ): Promise<boolean>;
}

export interface WeComChatOutputOptions {
  gateway: WeComReplyGateway;
  secrets: Iterable<string>;
  progressSettings?: ProgressSettings;
  onError?: (error: Error) => void;
  queue?: ConversationSendQueue;
  streamControllerOptions?: Pick<
    StreamControllerOptions,
    "maxFinishAttempts" | "retryDelayMs" | "timers"
  >;
}

export class WeComChatOutput implements ChatOutput {
  readonly #gateway: WeComReplyGateway;
  readonly #secrets: string[];
  readonly #onError?: (error: Error) => void;
  readonly #progressSettings: ProgressSettings;
  readonly #streamControllerOptions: WeComChatOutputOptions[
    "streamControllerOptions"
  ];
  readonly #queue: ConversationSendQueue;
  readonly #sink: WeComSink;
  readonly #active = new Set<StreamController>();

  constructor(options: WeComChatOutputOptions) {
    this.#gateway = options.gateway;
    this.#secrets = [...options.secrets];
    this.#onError = options.onError;
    this.#progressSettings = options.progressSettings ??
      DEFAULT_PROGRESS_SETTINGS;
    this.#queue = options.queue ?? new ConversationSendQueue();
    this.#streamControllerOptions = options.streamControllerOptions;
    this.#sink = new WeComSink({
      queue: this.#queue,
      send: async (frame, streamId, content, finish) => {
        const sent = await this.#gateway.replyStream(
          frame,
          streamId,
          content,
          finish,
        );
        if (!sent) throw new Error("Enterprise WeChat stream reply failed");
      },
      onError: (error) => this.#report(error),
    });
  }

  async send(
    message: RoutedMessage,
    content: string,
    final = false,
  ): Promise<void> {
    const safeContent = redactSecrets(content, this.#secrets);
    const parts = splitUtf8(safeContent);

    for (const part of parts) {
      const operation = async () => {
        try {
          const sent = await this.#gateway.reply(message.frame, {
            msgtype: "markdown",
            markdown: { content: part },
          });
          if (!sent) throw new Error("Enterprise WeChat Markdown reply failed");
        } catch (error) {
          const reportedError = toError(error);
          this.#report(reportedError);
          throw reportedError;
        }
      };
      if (final) {
        const attempt = await this.#queue.enqueueCritical(
          message.conversationKey,
          operation,
        );
        if (!attempt.accepted) {
          throw new Error(
            "Enterprise WeChat final reply rate limit is exhausted",
          );
        }
      } else {
        await this.#queue.enqueue(message.conversationKey, operation);
      }
    }
  }

  startProgress(message: RoutedText): Promise<ProgressHandle> {
    const controller = new StreamController({
      ...this.#streamControllerOptions,
      conversationKey: message.conversationKey,
      frame: message.frame,
      sink: this.#sink,
      secrets: this.#secrets,
    });
    this.#active.add(controller);

    return Promise.resolve({
      append: (content) => {
        controller.append(content);
      },
      finish: async () => {
        try {
          const finished = await controller.finish();
          if (!finished) {
            throw new Error(
              "Failed to finish Enterprise WeChat progress stream",
            );
          }
        } finally {
          this.#active.delete(controller);
        }
      },
    });
  }

  beginShutdown(): void {
    this.#queue.beginShutdown();
  }

  async finishAll(): Promise<void> {
    this.beginShutdown();
    try {
      const results = await Promise.allSettled(
        [...this.#active].map(async (controller) => {
          try {
            const finished = await controller.finish(
              shouldShowStatus(this.#progressSettings, "verbose")
                ? "\n[bot shutting down]\n"
                : "",
            );
            if (!finished) {
              throw new Error(
                "Failed to finish Enterprise WeChat progress streams during shutdown",
              );
            }
          } finally {
            this.#active.delete(controller);
          }
        }),
      );
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
      );
      if (errors.length > 0) {
        throw new AggregateError(
          errors,
          "Failed to finish Enterprise WeChat progress streams during shutdown",
        );
      }
    } finally {
      this.#queue.close();
    }
  }

  #report(error: Error): void {
    try {
      this.#onError?.(error);
    } catch {
      // Output error reporting must not break message processing.
    }
  }
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
