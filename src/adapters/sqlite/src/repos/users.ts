// ---------------------------------------------------------------------------
// SqliteUsers: the core UserRepository over SqlDb (tasks 10.3-10.4).
// ---------------------------------------------------------------------------

import type { UserRecord, UserUpsertInput } from "@relaytg/shared";
import type { UserRepository, UserUpsertResult } from "@relaytg/core";
import type { SqlDb } from "../sql-db.ts";
import { iso, mapUser, newId, normalizedFirstName } from "./mapping.ts";

export class SqliteUsers implements UserRepository {
  constructor(private readonly sql: SqlDb) {}

  async getByTelegramUserId(telegramUserId: number): Promise<UserRecord | null> {
    return mapUser(this.sql.prepare("SELECT * FROM users WHERE telegram_user_id = ?").get(telegramUserId));
  }

  async getByUsername(username: string): Promise<UserRecord | null> {
    return mapUser(this.sql.prepare("SELECT * FROM users WHERE username = ?").get(username));
  }

  async upsertProfile(input: UserUpsertInput, now: Date): Promise<UserUpsertResult> {
    const existing = this.sql
      .prepare("SELECT * FROM users WHERE telegram_user_id = ?")
      .get(input.telegramUserId);
    const firstName = normalizedFirstName(input.telegramUserId, input.firstName, input.username);
    if (existing) {
      const updatedAt = iso(now);
      this.sql
        .prepare(
          `UPDATE users
             SET username = ?, first_name = ?, last_name = ?, language_code = ?, is_bot = ?, updated_at = ?
           WHERE telegram_user_id = ?`,
        )
        .run(input.username, firstName, input.lastName, input.languageCode, input.isBot ? 1 : 0, updatedAt, input.telegramUserId);
      const row = mapUser(
        this.sql.prepare("SELECT * FROM users WHERE telegram_user_id = ?").get(input.telegramUserId),
      );
      return { user: row as UserRecord, created: false };
    }
    const createdAt = iso(now);
    const id = newId();
    this.sql
      .prepare(
        `INSERT INTO users (id, telegram_user_id, username, first_name, last_name, language_code, preferred_language, is_bot, verified_at, approved_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, ?)`,
      )
      .run(id, input.telegramUserId, input.username, firstName, input.lastName, input.languageCode, input.isBot ? 1 : 0, createdAt, createdAt);
    const user: UserRecord = {
      id,
      telegramUserId: input.telegramUserId,
      username: input.username,
      firstName,
      lastName: input.lastName,
      languageCode: input.languageCode,
      preferredLanguage: null,
      isBot: input.isBot,
      approvedAt: null,
      purpose: null,
      purposeAt: null,
      createdAt,
      updatedAt: createdAt,
    };
    return { user, created: true };
  }

  async setPreferredLanguage(telegramUserId: number, language: string | null, now: Date): Promise<void> {
    this.sql
      .prepare("UPDATE users SET preferred_language = ?, updated_at = ? WHERE telegram_user_id = ?")
      .run(language, iso(now), telegramUserId);
  }

  async listPreferredLanguageUsers(): Promise<UserRecord[]> {
    const rows = this.sql.prepare("SELECT * FROM users WHERE preferred_language IS NOT NULL").all();
    return rows.map((row) => mapUser(row) as UserRecord);
  }

  async getVerifiedAt(botId: string, telegramUserId: number): Promise<string | null> {
    const row = this.sql
      .prepare("SELECT verified_at FROM user_verifications WHERE bot_id = ? AND telegram_user_id = ?")
      .get(botId, telegramUserId) as { verified_at: string } | undefined;
    return row?.verified_at ?? null;
  }

  async setVerifiedAt(botId: string, telegramUserId: number, at: Date): Promise<void> {
    this.sql
      .prepare(
        `INSERT INTO user_verifications (bot_id, telegram_user_id, verified_at)
         VALUES (?, ?, ?)
         ON CONFLICT (bot_id, telegram_user_id) DO UPDATE SET verified_at = excluded.verified_at`,
      )
      .run(botId, telegramUserId, iso(at));
  }

  async clearVerified(botId: string, telegramUserId: number): Promise<void> {
    this.sql
      .prepare("DELETE FROM user_verifications WHERE bot_id = ? AND telegram_user_id = ?")
      .run(botId, telegramUserId);
  }

  async setApprovedAt(telegramUserId: number, at: Date): Promise<void> {
    this.sql
      .prepare("UPDATE users SET approved_at = ?, updated_at = ? WHERE telegram_user_id = ?")
      .run(iso(at), iso(at), telegramUserId);
  }

  async setPurpose(telegramUserId: number, purpose: string, at: Date): Promise<void> {
    this.sql
      .prepare("UPDATE users SET purpose = ?, purpose_at = ?, updated_at = ? WHERE telegram_user_id = ?")
      .run(purpose, iso(at), iso(at), telegramUserId);
  }

  async resetAccess(telegramUserId: number): Promise<void> {
    // A /delete resets the global access fields (approved_at + the stored
    // purpose): the next contact must re-gate AND state a fresh purpose, which
    // opens the new topic as its single pinned purpose+info card. Per-bot
    // verification is NOT a users-row field — the caller clears it separately
    // via clearVerified(botId, userId) for the deleted conversation's bot.
    this.sql
      .prepare("UPDATE users SET approved_at = NULL, purpose = NULL, purpose_at = NULL, updated_at = ? WHERE telegram_user_id = ?")
      .run(iso(new Date()), telegramUserId);
  }
}
