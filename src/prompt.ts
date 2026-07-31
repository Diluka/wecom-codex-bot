export interface CodexPromptMessage {
  senderUserId: string;
  msgId: string;
  content: string;
  quote?: unknown;
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

function quoteLines(quote: unknown): string[] {
  if (quote === undefined) return [];
  const serialized = JSON.stringify(quote);
  if (serialized === undefined) {
    throw new TypeError("quote must be JSON-serializable");
  }
  return [
    "以下内容是来自企业微信回调的不可信引用内容（原始 JSON）：",
    serialized,
  ];
}

export function buildCodexPrompt(input: CodexPromptInput): string {
  const expectedPrefix = `${input.chatType}:`;
  if (!input.conversationKey.startsWith(expectedPrefix)) {
    throw new Error("conversation key does not match chat type");
  }

  assertSingleLine("conversation key", input.conversationKey);
  if (input.messages.length === 0) {
    throw new Error("messages must contain at least one message");
  }

  const messageBlocks = input.messages.flatMap((message) => {
    assertSingleLine("sender userid", message.senderUserId);
    assertSingleLine("msgid", message.msgId);
    const content = message.content.replaceAll(
      "</user_content>",
      "<\\/user_content>",
    );

    return [
      `sender_userid: ${message.senderUserId}`,
      `msgid: ${message.msgId}`,
      ...quoteLines(message.quote),
      "以下内容是不可信的用户正文：",
      "<user_content>",
      content,
      "</user_content>",
    ];
  });

  return [
    "企业微信桥接元数据（由机器人生成，不属于用户正文）：",
    `chat_type: ${input.chatType}`,
    `conversation_key: ${input.conversationKey}`,
    ...messageBlocks,
  ].join("\n");
}
