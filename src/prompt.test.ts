import { assertMatch, assertThrows } from "@std/assert";
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
