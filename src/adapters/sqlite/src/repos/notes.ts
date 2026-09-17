// ---------------------------------------------------------------------------
// SqliteNotes: the core NoteRepository over SqlDb.
// ---------------------------------------------------------------------------

import type { ConversationNoteRecord, NoteCreateInput } from "@relaytg/shared";
import type { NoteRepository } from "@relaytg/core";
import type { SqlDb } from "../sql-db.ts";
import { iso, mapRows, newId } from "./mapping.ts";

export class SqliteNotes implements NoteRepository {
  constructor(private readonly sql: SqlDb) {}

  async create(input: NoteCreateInput, now: Date): Promise<ConversationNoteRecord> {
    const createdAt = iso(now);
    const row: ConversationNoteRecord = {
      id: newId(),
      conversationId: input.conversationId,
      operatorId: input.operatorId,
      text: input.text,
      createdAt,
    };
    this.sql
      .prepare(
        "INSERT INTO conversation_notes (id, conversation_id, operator_id, text, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(row.id, row.conversationId, row.operatorId, row.text, row.createdAt);
    return row;
  }

  async listByConversation(conversationId: string): Promise<ConversationNoteRecord[]> {
    return mapRows<ConversationNoteRecord>(
      this.sql
        .prepare("SELECT * FROM conversation_notes WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC")
        .all(conversationId),
    );
  }

  async deleteByConversationId(conversationId: string): Promise<void> {
    this.sql.prepare("DELETE FROM conversation_notes WHERE conversation_id = ?").run(conversationId);
  }
}
