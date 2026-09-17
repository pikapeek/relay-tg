// ---------------------------------------------------------------------------
// SqliteOperators: the core OperatorRepository over SqlDb.
// ---------------------------------------------------------------------------

import type { OperatorRecord, OperatorUpsertInput } from "@relaytg/shared";
import type { OperatorRepository } from "@relaytg/core";
import type { SqlDb } from "../sql-db.ts";
import { iso, mapRow, mapRows, newId } from "./mapping.ts";

export class SqliteOperators implements OperatorRepository {
  constructor(private readonly sql: SqlDb) {}

  async getByTelegramUserId(telegramUserId: number): Promise<OperatorRecord | null> {
    return mapRow<OperatorRecord>(
      this.sql.prepare("SELECT * FROM operators WHERE telegram_user_id = ?").get(telegramUserId),
    );
  }

  async upsert(input: OperatorUpsertInput, now: Date): Promise<OperatorRecord> {
    const existing = this.sql
      .prepare("SELECT * FROM operators WHERE telegram_user_id = ?")
      .get(input.telegramUserId);
    if (existing) {
      // Admins are never demoted.
      if (existing.role === "ADMIN") return mapRow<OperatorRecord>(existing) as OperatorRecord;
      this.sql.prepare("UPDATE operators SET role = ? WHERE telegram_user_id = ?").run(input.role, input.telegramUserId);
      return mapRow<OperatorRecord>(
        this.sql.prepare("SELECT * FROM operators WHERE telegram_user_id = ?").get(input.telegramUserId),
      ) as OperatorRecord;
    }
    const createdAt = iso(now);
    const row: OperatorRecord = {
      id: newId(),
      telegramUserId: input.telegramUserId,
      role: input.role,
      createdAt,
    };
    this.sql
      .prepare("INSERT INTO operators (id, telegram_user_id, role, created_at) VALUES (?, ?, ?, ?)")
      .run(row.id, row.telegramUserId, row.role, row.createdAt);
    return row;
  }

  async list(): Promise<OperatorRecord[]> {
    return mapRows<OperatorRecord>(this.sql.prepare("SELECT * FROM operators ORDER BY created_at ASC, rowid ASC").all());
  }
}
