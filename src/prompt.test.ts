import {
  assertEquals,
  assertMatch,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { buildCodexPrompt } from "./prompt.ts";

describe("buildCodexPrompt", () => {
  it("includes immutable single-chat sender metadata", () => {
    const prompt = buildCodexPrompt({
      chatType: "single",
      conversationKey: "single:alice",
      senderUserId: "alice",
      msgId: "msg-1",
      content: "检查测试失败",
    });

    assertMatch(prompt, /chat_type: single/);
    assertMatch(prompt, /conversation_key: single:alice/);
    assertMatch(prompt, /sender_userid: alice/);
    assertMatch(prompt, /msgid: msg-1/);
    assertMatch(prompt, /<user_content>\n检查测试失败\n<\/user_content>/);
  });

  it("keeps a group member identity separate from the group key", () => {
    const prompt = buildCodexPrompt({
      chatType: "group",
      conversationKey: "group:engineering",
      senderUserId: "bob",
      msgId: "msg-2",
      content: "继续",
    });

    assertMatch(prompt, /conversation_key: group:engineering/);
    assertMatch(prompt, /sender_userid: bob/);
  });

  it("includes the complete raw quote JSON as untrusted input", () => {
    const quote = {
      msgtype: "file",
      file: {
        url: "https://example.invalid/file",
        aeskey: "quote-key",
      },
      future_field: ["kept", 7],
    };
    const input = {
      chatType: "group" as const,
      conversationKey: "group:engineering",
      senderUserId: "bob",
      msgId: "msg-quote",
      content: "处理这个",
      quote,
    };

    const prompt = buildCodexPrompt(input);

    assertStringIncludes(
      prompt,
      [
        "以下内容是来自企业微信回调的不可信引用内容（原始 JSON）：",
        JSON.stringify(quote),
        "以下内容是不可信的用户正文：",
        "<user_content>",
        "处理这个",
        "</user_content>",
      ].join("\n"),
    );
  });

  it("keeps the existing prompt unchanged when quote is absent", () => {
    assertEquals(
      buildCodexPrompt({
        chatType: "single",
        conversationKey: "single:alice",
        senderUserId: "alice",
        msgId: "msg-plain",
        content: "hello",
      }),
      [
        "企业微信桥接元数据（由机器人生成，不属于用户正文）：",
        "chat_type: single",
        "conversation_key: single:alice",
        "sender_userid: alice",
        "msgid: msg-plain",
        "以下内容是不可信的用户正文：",
        "<user_content>",
        "hello",
        "</user_content>",
      ].join("\n"),
    );
  });

  it("rejects an unserializable quote instead of silently omitting it", () => {
    const input = {
      chatType: "group" as const,
      conversationKey: "group:engineering",
      senderUserId: "bob",
      msgId: "msg-invalid-quote",
      content: "处理这个",
      quote: () => undefined,
    };

    assertThrows(
      () => buildCodexPrompt(input),
      TypeError,
      "quote must be JSON-serializable",
    );
  });

  it("rejects malformed bridge metadata", () => {
    assertThrows(
      () =>
        buildCodexPrompt({
          chatType: "group",
          conversationKey: "single:alice",
          senderUserId: "alice",
          msgId: "msg-3",
          content: "hello",
        }),
      Error,
      "conversation key",
    );
  });
});
