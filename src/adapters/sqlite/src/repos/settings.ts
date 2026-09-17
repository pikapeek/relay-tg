// ---------------------------------------------------------------------------
// SqliteSettings: the core SettingsRepository over SqlDb.
// ---------------------------------------------------------------------------

import type { SettingsRepository } from "@relaytg/core";
import type { SqlDb } from "../sql-db.ts";

export class SqliteSettings implements SettingsRepository {
  constructor(private readonly sql: SqlDb) {}

  async get(key: string): Promise<string | null> {
    const row = this.sql.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    return row != null ? String(row.value) : null;
  }

  async set(key: string, value: string): Promise<void> {
    this.sql
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }
}
