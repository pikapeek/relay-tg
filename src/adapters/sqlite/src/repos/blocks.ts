// ---------------------------------------------------------------------------
// SqliteBlocks: the core BlockRepository over SqlDb.
// ---------------------------------------------------------------------------

import type { BlockCreateInput, BlockRecord } from "@relaytg/shared";
import type { BlockRepository } from "@relaytg/core";
import type { SqlDb } from "../sql-db.ts";
import { iso, mapRow, newId } from "./mapping.ts";

export class SqliteBlocks implements BlockRepository {
  constructor(private readonly sql: SqlDb) {}

  async getByTelegramUserId(telegramUserId: number): Promise<BlockRecord | null> {
    return mapRow<BlockRecord>(
      this.sql.prepare("SELECT * FROM blocks WHERE telegram_user_id = ?").get(telegramUserId),
    );
  }

  async create(input: BlockCreateInput, now: Date): Promise<BlockRecord> {
    // Re-blocking keeps the original row id; blocking is keyed by user id.
    this.sql
      .prepare(
        `INSERT INTO blocks (id, telegram_user_id, created_by_telegram_user_id, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(telegram_user_id) DO UPDATE SET
           created_by_telegram_user_id = excluded.created_by_telegram_user_id,
           created_at = excluded.created_at`,
      )
      .run(newId(), input.telegramUserId, input.createdByTelegramUserId, iso(now));
    return (await this.getByTelegramUserId(input.telegramUserId)) as BlockRecord;
  }

  async deleteByTelegramUserId(telegramUserId: number): Promise<void> {
    this.sql.prepare("DELETE FROM blocks WHERE telegram_user_id = ?").run(telegramUserId);
  }
}
