// ---------------------------------------------------------------------------
// SqliteConversations: the core ConversationRepository over SqlDb.
// ---------------------------------------------------------------------------

import type { ConversationCreateInput, ConversationRecord } from "@relaytg/shared";
import type { ConversationRepository } from "@relaytg/core";
import type { SqlDb } from "../sql-db.ts";
import { iso, mapRow, mapRows, newId } from "./mapping.ts";

export class SqliteConversations implements ConversationRepository {
  constructor(private readonly sql: SqlDb) {}

  async getById(id: string): Promise<ConversationRecord | null> {
    return mapRow<ConversationRecord>(this.sql.prepare("SELECT * FROM conversations WHERE id = ?").get(id));
  }

  async getByTelegramUserId(telegramUserId: number): Promise<ConversationRecord | null> {
    return mapRow<ConversationRecord>(
      this.sql.prepare("SELECT * FROM conversations WHERE telegram_user_id = ?").get(telegramUserId),
    );
  }

  async getByTopicId(telegramTopicId: number): Promise<ConversationRecord | null> {
    return mapRow<ConversationRecord>(
      this.sql.prepare("SELECT * FROM conversations WHERE telegram_topic_id = ?").get(telegramTopicId),
    );
  }

  async create(input: ConversationCreateInput, now: Date): Promise<ConversationRecord> {
    const createdAt = iso(now);
    const row: ConversationRecord = {
      id: newId(),
      telegramUserId: input.telegramUserId,
      telegramTopicId: input.telegramTopicId,
      assignedOperatorId: input.assignedOperatorId,
      lastActivityAt: createdAt,
      hiddenAt: null,
      hideAfterHours: null,
      createdAt,
    };
    this.sql
      .prepare(
        `INSERT INTO conversations
           (id, telegram_user_id, telegram_topic_id, assigned_operator_id, last_activity_at, hidden_at, hide_after_hours, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
      )
      .run(row.id, row.telegramUserId, row.telegramTopicId, row.assignedOperatorId, row.lastActivityAt, row.createdAt);
    return row;
  }

  async updateTopicId(id: string, telegramTopicId: number): Promise<void> {
    this.sql.prepare("UPDATE conversations SET telegram_topic_id = ? WHERE id = ?").run(telegramTopicId, id);
  }

  async setAssignedOperatorId(id: string, operatorId: string | null): Promise<void> {
    this.sql.prepare("UPDATE conversations SET assigned_operator_id = ? WHERE id = ?").run(operatorId, id);
  }

  async touchActivity(id: string, at: Date): Promise<void> {
    this.sql.prepare("UPDATE conversations SET last_activity_at = ? WHERE id = ?").run(iso(at), id);
  }

  async setHidden(id: string, hiddenAt: string | null): Promise<void> {
    this.sql.prepare("UPDATE conversations SET hidden_at = ? WHERE id = ?").run(hiddenAt, id);
  }

  async setHideAfterHours(id: string, hideAfterHours: number | null): Promise<void> {
    this.sql.prepare("UPDATE conversations SET hide_after_hours = ? WHERE id = ?").run(hideAfterHours, id);
  }

  async list(): Promise<ConversationRecord[]> {
    return mapRows<ConversationRecord>(this.sql.prepare("SELECT * FROM conversations ORDER BY created_at").all());
  }

  async listStaleHiddenCandidates(now: Date, autoHideHours: number): Promise<ConversationRecord[]> {
    // The global auto-hide cap applies to EVERY conversation (permanent-policy
    // and never-hide included); a custom hide_after_hours > 0 only makes the
    // threshold sooner. Computing per-row cutoffs needs date math that differs
    // subtly across SQLite bindings, so the scan filters in JS — identical to
    // the in-memory port.
    const rows = this.sql
      .prepare(
        `SELECT * FROM conversations
          WHERE hidden_at IS NULL
            AND telegram_topic_id IS NOT NULL`,
      )
      .all();
    const out: ConversationRecord[] = [];
    for (const row of rows) {
      const record = mapRow<ConversationRecord>(row) as ConversationRecord;
      const last = new Date(record.lastActivityAt).getTime();
      const nowMs = now.getTime();
      const staleByHardCap = last < nowMs - autoHideHours * 3_600_000;
      const custom = record.hideAfterHours;
      const staleByPolicy = custom != null && custom > 0 && last < nowMs - custom * 3_600_000;
      if (staleByHardCap || staleByPolicy) out.push(record);
    }
    return out;
  }

  async delete(id: string): Promise<void> {
    this.sql.prepare("DELETE FROM conversations WHERE id = ?").run(id);
  }
}
