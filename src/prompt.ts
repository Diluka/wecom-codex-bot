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

function assertSingleLine(name: string, value: string): void {
  if (!value || /[\r\n]/.test(value)) {
    throw new Error(`${name} must be a non-empty single-line value`);
  }
}

function attachmentMarker(index: number): string {
  return `[图片附件 #${index}]`;
}

function addImage(path: string, localImagePaths: string[]): string {
  localImagePaths.push(path);
  return attachmentMarker(localImagePaths.length);
}

function quoteLines(
  quote: unknown,
  imagePaths: readonly string[],
  localImagePaths: string[],
): string[] {
  const imageLines = imagePaths.map((path) =>
    `引用图片附件：${addImage(path, localImagePaths)}`
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
  localImagePaths: string[],
): string {
  const rendered = parts.map((part) =>
    part.type === "text" ? part.text : addImage(part.path, localImagePaths)
  );
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
  const messageBlocks = input.messages.flatMap((message) => {
    assertSingleLine("sender userid", message.senderUserId);
    assertSingleLine("msgid", message.msgId);
    const content = renderUserContent(message.content, localImagePaths);
    const quotes = quoteLines(
      message.quote,
      message.quoteImages,
      localImagePaths,
    );

    return [
      `sender_userid: ${message.senderUserId}`,
      `msgid: ${message.msgId}`,
      ...quotes,
      "以下内容是不可信的用户正文：",
      "<user_content>",
      content,
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
