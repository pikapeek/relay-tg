// ---------------------------------------------------------------------------
// Row mapping helpers shared by every Sqlite repository. SqlDb returns rows
// keyed by snake_case column name; every repository maps them to the camelCase
// core records. Platform-neutral — never imports node:sqlite or the DO storage.
// ---------------------------------------------------------------------------

import type { UserRecord } from "@relaytg/shared";
import type { SqlRow } from "../sql-db.ts";

export function camelize(key: string): string {
  return key.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
}

export function mapRow<T>(row: SqlRow | null): T | null {
  if (row == null) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) out[camelize(key)] = value;
  return out as T;
}

export function mapRows<T>(rows: SqlRow[]): T[] {
  return rows.map((row) => mapRow<T>(row) as T);
}

export function iso(date: Date): string {
  return date.toISOString();
}

export function newId(): string {
  return crypto.randomUUID();
}

/** The `first_name` fallback mirrors UserService: profile first name, else
 *  username, else the numeric id. */
export function normalizedFirstName(telegramUserId: number, firstName: string | null, username: string | null): string {
  return firstName ?? username ?? String(telegramUserId);
}

/** users.is_bot is stored as 0/1; core records carry a real boolean. */
export function mapUser(row: SqlRow | null): UserRecord | null {
  // `users.verified_at` is a legacy column (pre-005) — verification now lives
  // per (bot, user) in `user_verifications`, so it is stripped here and never
  // surfaces on the record.
  const mapped = mapRow<UserRecord & { verifiedAt?: string }>(row);
  if (!mapped) return null;
  const { verifiedAt: _legacyVerified, ...rest } = mapped;
  return { ...rest, isBot: Number(rest.isBot) === 1 };
}
