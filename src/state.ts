import { DatabaseSync } from "node:sqlite";

export type ChatType = "single" | "group";

export interface ConversationRecord {
  conversationKey: string;
  chatType: ChatType;
  threadId: string;
  activeTurnId: string | null;
  lastStatus: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

interface ConversationRow {
  conversation_key: string;
  chat_type: ChatType;
  thread_id: string;
  active_turn_id: string | null;
  last_status: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

const SCHEMA_VERSION = 1;

const CONVERSATION_COLUMNS = `
  conversation_key,
  chat_type,
  thread_id,
  active_turn_id,
  last_status,
  last_error,
  created_at,
  updated_at
`;

/** Persists conversation bindings, deduplication keys, and turn state in SQLite. */
export class StateStore {
  readonly #database: DatabaseSync;

  constructor(path: string) {
    this.#database = new DatabaseSync(path);

    try {
      this.#migrate();
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  close(): void {
    this.#database.close();
  }

  getConversation(conversationKey: string): ConversationRecord | undefined {
    const row = this.#database.prepare(`
      SELECT ${CONVERSATION_COLUMNS}
      FROM conversations
      WHERE conversation_key = ?
    `).get(conversationKey) as ConversationRow | undefined;

    return row === undefined ? undefined : toConversationRecord(row);
  }

  bindConversation(
    conversationKey: string,
    chatType: ChatType,
    threadId: string,
  ): ConversationRecord {
    const timestamp = new Date().toISOString();
    const row = this.#database.prepare(`
      INSERT INTO conversations (
        conversation_key,
        chat_type,
        thread_id,
        active_turn_id,
        last_status,
        last_error,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, NULL, NULL, NULL, ?, ?)
      ON CONFLICT (conversation_key) DO UPDATE SET
        chat_type = excluded.chat_type,
        thread_id = excluded.thread_id,
        active_turn_id = NULL,
        last_status = NULL,
        last_error = NULL,
        updated_at = excluded.updated_at
      RETURNING ${CONVERSATION_COLUMNS}
    `).get(conversationKey, chatType, threadId, timestamp, timestamp) as
      | ConversationRow
      | undefined;

    if (row === undefined) {
      throw new Error(`Failed to bind conversation: ${conversationKey}`);
    }

    return toConversationRecord(row);
  }

  claimMessage(msgid: string, conversationKey: string): boolean {
    const result = this.#database.prepare(`
      INSERT OR IGNORE INTO processed_messages (
        msgid,
        conversation_key,
        processed_at
      ) VALUES (?, ?, ?)
    `).run(msgid, conversationKey, new Date().toISOString());

    return Number(result.changes) === 1;
  }

  beginTurn(conversationKey: string, turnId: string): ConversationRecord {
    const row = this.#database.prepare(`
      UPDATE conversations
      SET
        active_turn_id = ?,
        last_status = 'running',
        last_error = NULL,
        updated_at = ?
      WHERE conversation_key = ? AND active_turn_id IS NULL
      RETURNING ${CONVERSATION_COLUMNS}
    `).get(turnId, new Date().toISOString(), conversationKey) as
      | ConversationRow
      | undefined;

    if (row !== undefined) {
      return toConversationRecord(row);
    }

    if (this.getConversation(conversationKey) === undefined) {
      throw new Error(`Conversation not found: ${conversationKey}`);
    }

    throw new Error(
      `Conversation already has an active turn: ${conversationKey}`,
    );
  }

  finishTurn(
    conversationKey: string,
    turnId: string,
    status: string,
    lastError: string | null = null,
  ): ConversationRecord {
    const row = this.#database.prepare(`
      UPDATE conversations
      SET
        active_turn_id = NULL,
        last_status = ?,
        last_error = ?,
        updated_at = ?
      WHERE conversation_key = ? AND active_turn_id = ?
      RETURNING ${CONVERSATION_COLUMNS}
    `).get(
      status,
      lastError,
      new Date().toISOString(),
      conversationKey,
      turnId,
    ) as ConversationRow | undefined;

    if (row !== undefined) {
      return toConversationRecord(row);
    }

    if (this.getConversation(conversationKey) === undefined) {
      throw new Error(`Conversation not found: ${conversationKey}`);
    }

    throw new Error(
      `Conversation has no matching active turn: ${conversationKey}`,
    );
  }

  markRuntimeLost(): number {
    const result = this.#database.prepare(`
      UPDATE conversations
      SET
        active_turn_id = NULL,
        last_status = 'runtime_lost',
        updated_at = ?
      WHERE active_turn_id IS NOT NULL
    `).run(new Date().toISOString());

    return Number(result.changes);
  }

  #migrate(): void {
    const versionRow = this.#database.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };

    if (versionRow.user_version > SCHEMA_VERSION) {
      throw new Error(
        `Unsupported state schema version: ${versionRow.user_version}`,
      );
    }

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS conversations (
          conversation_key TEXT PRIMARY KEY,
          chat_type TEXT NOT NULL CHECK (chat_type IN ('single', 'group')),
          thread_id TEXT NOT NULL UNIQUE,
          active_turn_id TEXT,
          last_status TEXT,
          last_error TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS processed_messages (
          msgid TEXT PRIMARY KEY,
          conversation_key TEXT NOT NULL,
          processed_at TEXT NOT NULL
        );

        PRAGMA user_version = ${SCHEMA_VERSION};
      `);
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }
}

function toConversationRecord(row: ConversationRow): ConversationRecord {
  return {
    conversationKey: row.conversation_key,
    chatType: row.chat_type,
    threadId: row.thread_id,
    activeTurnId: row.active_turn_id,
    lastStatus: row.last_status,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
