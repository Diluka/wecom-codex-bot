import { assertEquals, assertMatch, assertThrows } from "@std/assert";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { StateStore } from "./state.ts";

describe("StateStore", () => {
  describe("in-memory state", () => {
    let store: StateStore;

    beforeEach(() => {
      store = new StateStore(":memory:");
    });

    afterEach(() => {
      store.close();
    });

    it("binds and reads a conversation", () => {
      assertEquals(store.getConversation("single:alice"), undefined);

      const record = store.bindConversation(
        "single:alice",
        "single",
        "thread-1",
      );

      assertEquals(store.getConversation("single:alice"), record);
      assertEquals(record.conversationKey, "single:alice");
      assertEquals(record.chatType, "single");
      assertEquals(record.threadId, "thread-1");
      assertEquals(record.activeTurnId, null);
      assertEquals(record.lastStatus, null);
      assertEquals(record.lastError, null);
      assertMatch(record.createdAt, /^\d{4}-\d{2}-\d{2}T/);
      assertMatch(record.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
    });

    it("enforces unique thread bindings and replaces a conversation thread", () => {
      store.bindConversation("single:alice", "single", "thread-1");

      const error = assertThrows(
        () => store.bindConversation("single:bob", "single", "thread-1"),
        Error,
      );
      assertMatch(error.message, /unique|constraint/i);
      assertEquals(store.getConversation("single:bob"), undefined);

      store.beginTurn("single:alice", "turn-old");
      const rebound = store.bindConversation(
        "single:alice",
        "single",
        "thread-2",
      );
      assertEquals(rebound.threadId, "thread-2");
      assertEquals(rebound.activeTurnId, null);
      assertEquals(rebound.lastStatus, null);
      assertEquals(rebound.lastError, null);
    });

    it("claims every message id at most once", () => {
      assertEquals(store.claimMessage("msg-1", "single:alice"), true);
      assertEquals(store.claimMessage("msg-1", "single:alice"), false);
      assertEquals(
        store.claimMessage("msg-1", "group:engineering"),
        false,
      );
      assertEquals(store.claimMessage("msg-2", "single:alice"), true);
    });

    it("tracks a turn from running to its final status", () => {
      store.bindConversation("single:alice", "single", "thread-1");

      const running = store.beginTurn("single:alice", "turn-1");
      assertEquals(running.activeTurnId, "turn-1");
      assertEquals(running.lastStatus, "running");
      assertEquals(running.lastError, null);

      const failed = store.finishTurn(
        "single:alice",
        "turn-1",
        "failed",
        "app server exited",
      );
      assertEquals(failed.activeTurnId, null);
      assertEquals(failed.lastStatus, "failed");
      assertEquals(failed.lastError, "app server exited");

      const error = assertThrows(
        () => store.finishTurn("single:alice", "turn-1", "completed"),
        Error,
      );
      assertMatch(error.message, /active turn/i);
    });

    it("rejects starting an unknown or second active turn", () => {
      const missingError = assertThrows(
        () => store.beginTurn("single:missing", "turn-1"),
        Error,
      );
      assertMatch(missingError.message, /conversation/i);

      store.bindConversation("single:alice", "single", "thread-1");
      store.beginTurn("single:alice", "turn-1");
      const activeError = assertThrows(
        () => store.beginTurn("single:alice", "turn-2"),
        Error,
      );
      assertMatch(activeError.message, /active turn/i);
    });

    it("marks only active conversations as runtime lost", () => {
      store.bindConversation("single:alice", "single", "thread-1");
      store.bindConversation("single:bob", "single", "thread-2");
      store.bindConversation("group:engineering", "group", "thread-3");
      store.beginTurn("single:alice", "turn-1");
      store.beginTurn("single:bob", "turn-2");
      store.beginTurn("group:engineering", "turn-3");
      store.finishTurn("group:engineering", "turn-3", "completed");

      assertEquals(store.markRuntimeLost(), 2);

      const alice = store.getConversation("single:alice");
      const bob = store.getConversation("single:bob");
      const group = store.getConversation("group:engineering");
      assertEquals(alice?.activeTurnId, null);
      assertEquals(alice?.lastStatus, "runtime_lost");
      assertEquals(bob?.activeTurnId, null);
      assertEquals(bob?.lastStatus, "runtime_lost");
      assertEquals(group?.lastStatus, "completed");
      assertEquals(store.markRuntimeLost(), 0);
    });
  });

  describe("file persistence", () => {
    let tempDirectory: string;
    let store: StateStore | undefined;

    beforeEach(async () => {
      tempDirectory = await Deno.makeTempDir();
    });

    afterEach(async () => {
      store?.close();
      await Deno.remove(tempDirectory, { recursive: true });
    });

    it("migrates and preserves state across reopen", () => {
      const databasePath = join(tempDirectory, "state.sqlite");
      store = new StateStore(databasePath);
      const original = store.bindConversation(
        "group:engineering",
        "group",
        "thread-group",
      );
      assertEquals(
        store.claimMessage("msg-persisted", "group:engineering"),
        true,
      );
      store.close();

      store = new StateStore(databasePath);
      assertEquals(store.getConversation("group:engineering"), original);
      assertEquals(
        store.claimMessage("msg-persisted", "group:engineering"),
        false,
      );
    });

    it("persists metadata columns only and has no chat or reply body fields", () => {
      const databasePath = join(tempDirectory, "metadata-only.sqlite");
      store = new StateStore(databasePath);
      store.bindConversation("single:alice", "single", "thread-1");
      store.claimMessage("msg-1", "single:alice");
      store.close();
      store = undefined;

      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const columns = database.prepare(`
          SELECT m.name
          FROM sqlite_master AS s
          JOIN pragma_table_info(s.name) AS m
          WHERE s.type = 'table'
          ORDER BY s.name, m.cid
        `).all() as Array<{ name: string }>;
        assertEquals(columns.map((column) => column.name), [
          "conversation_key",
          "chat_type",
          "thread_id",
          "active_turn_id",
          "last_status",
          "last_error",
          "created_at",
          "updated_at",
          "msgid",
          "conversation_key",
          "processed_at",
        ]);
      } finally {
        database.close();
      }
    });
  });
});
