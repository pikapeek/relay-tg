// ---------------------------------------------------------------------------
// SqliteApplications: the core ApplicationRepository over SqlDb.
// ---------------------------------------------------------------------------

import type { ApplicationCreateInput, ApplicationRecord } from "@relaytg/shared";
import type { ApplicationRepository } from "@relaytg/core";
import type { SqlDb } from "../sql-db.ts";
import { iso, mapRow, newId } from "./mapping.ts";

export class SqliteApplications implements ApplicationRepository {
  constructor(private readonly sql: SqlDb) {}

  async getById(id: string): Promise<ApplicationRecord | null> {
    return mapRow<ApplicationRecord>(this.sql.prepare("SELECT * FROM applications WHERE id = ?").get(id));
  }

  async getLatestByTelegramUserId(telegramUserId: number): Promise<ApplicationRecord | null> {
    return mapRow<ApplicationRecord>(
      this.sql
        .prepare("SELECT * FROM applications WHERE telegram_user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
        .get(telegramUserId),
    );
  }

  async create(input: ApplicationCreateInput, now: Date): Promise<ApplicationRecord> {
    const createdAt = iso(now);
    const row: ApplicationRecord = {
      id: newId(),
      telegramUserId: input.telegramUserId,
      status: "pending",
      createdAt,
      decidedAt: null,
      decidedByTelegramUserId: null,
    };
    this.sql
      .prepare(
        "INSERT INTO applications (id, telegram_user_id, status, created_at, decided_at, decided_by_telegram_user_id) VALUES (?, ?, 'pending', ?, NULL, NULL)",
      )
      .run(row.id, row.telegramUserId, row.createdAt);
    return row;
  }

  async update(input: {
    id: string;
    status: "pending" | "approved" | "rejected";
    decidedAt: Date;
    decidedByTelegramUserId: number;
  }): Promise<void> {
    this.sql
      .prepare(
        "UPDATE applications SET status = ?, decided_at = ?, decided_by_telegram_user_id = ? WHERE id = ?",
      )
      .run(input.status, iso(input.decidedAt), input.decidedByTelegramUserId, input.id);
  }
}
