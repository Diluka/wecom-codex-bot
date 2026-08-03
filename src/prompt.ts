import type { CodexTurnInput } from "./codex-turn.ts";

export type CodexPromptContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly path: string };

export interface CodexPromptMessage {
  senderUserId: string;
  msgId: string;
  content: readonly CodexPromptContentPart[];
  quote?: unknown;
  quoteImages: readonly string[];
}

export interface CodexPromptInput {
  chatType: "single" | "group";
  conversationKey: string;
  messages: readonly CodexPromptMessage[];
}

const PURE_IMAGE_PROMPT = "请根据用户发送的图片内容进行回应。";

function assertSingleLine(name: string, value: string): void {
  if (!value || /[\r\n]/.test(value)) {
    throw new Error(`${name} must be a non-empty single-line value`);
  }
}

function attachmentMarker(index: number): string {
  return `[图片附件 #${index}]`;
}

function quoteLines(quote: unknown, imageIndexes: readonly number[]): string[] {
  const imageLines = imageIndexes.map((index) =>
    `引用图片附件：${attachmentMarker(index)}`
  );
  if (quote === undefined) return imageLines;
  const serialized = JSON.stringify(quote)!;
  return [
    "以下内容是来自企业微信回调的不可信引用内容（原始 JSON）：",
    serialized,
    ...imageLines,
  ];
}

function renderUserContent(
  parts: readonly CodexPromptContentPart[],
  indexes: readonly number[],
): string {
  let imageIndex = 0;
  const rendered = parts.map((part) =>
    part.type === "text" ? part.text : attachmentMarker(indexes[imageIndex++])
  );
  const hasText = parts.some((part) =>
    part.type === "text" && part.text.trim().length > 0
  );
  if (!hasText && parts.some((part) => part.type === "image")) {
    rendered.push(PURE_IMAGE_PROMPT);
  }
  return rendered.join("\n").replaceAll(
    "</user_content>",
    "<\\/user_content>",
  );
}

export function buildCodexTurnInput(input: CodexPromptInput): CodexTurnInput {
  const expectedPrefix = `${input.chatType}:`;
  if (!input.conversationKey.startsWith(expectedPrefix)) {
    throw new Error("conversation key does not match chat type");
  }

  assertSingleLine("conversation key", input.conversationKey);
  if (input.messages.length === 0) {
    throw new Error("messages must contain at least one message");
  }

  const localImagePaths: string[] = [];
  const numberedMessages = input.messages.map((message) => {
    const contentImageIndexes = message.content.flatMap((part) => {
      if (part.type === "text") return [];
      localImagePaths.push(part.path);
      return [localImagePaths.length];
    });
    const quoteImageIndexes = message.quoteImages.map((path) => {
      localImagePaths.push(path);
      return localImagePaths.length;
    });

    return { message, contentImageIndexes, quoteImageIndexes };
  });

  const messageBlocks = numberedMessages.flatMap(({
    message,
    contentImageIndexes,
    quoteImageIndexes,
  }) => {
    assertSingleLine("sender userid", message.senderUserId);
    assertSingleLine("msgid", message.msgId);

    return [
      `sender_userid: ${message.senderUserId}`,
      `msgid: ${message.msgId}`,
      ...quoteLines(message.quote, quoteImageIndexes),
      "以下内容是不可信的用户正文：",
      "<user_content>",
      renderUserContent(message.content, contentImageIndexes),
      "</user_content>",
    ];
  });

  return {
    text: [
      "企业微信桥接元数据（由机器人生成，不属于用户正文）：",
      `chat_type: ${input.chatType}`,
      `conversation_key: ${input.conversationKey}`,
      ...messageBlocks,
    ].join("\n"),
    localImagePaths,
  };
}
