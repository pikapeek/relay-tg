// ---------------------------------------------------------------------------
// Shared migration runner (task 10.2). Applies pending migrations in version
// order, records each applied version in `schema_migrations`, and never drops
// or recreates the database. The migrations themselves are provided by the
// caller so this module stays platform-neutral: the Docker runtime loads them
// from migrations/*.sql (node-migrations.ts), the Cloudflare DO imports them
// as ?raw strings from the bundle.
// ---------------------------------------------------------------------------

import type { SqlDb } from "./sql-db.ts";

export interface Migration {
  /** Monotonic version label, e.g. "001_initial". */
  version: string;
  sql: string;
}

/** @returns the versions applied on this call (empty when up to date). */
export async function applyMigrations(db: SqlDb, migrations: Migration[]): Promise<string[]> {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const applied = new Set(db.prepare("SELECT version FROM schema_migrations").all().map((r) => String(r.version)));
  const pending = migrations
    .slice()
    .sort((a, b) => a.version.localeCompare(b.version))
    .filter((m) => !applied.has(m.version));

  const appliedNow: string[] = [];
  for (const migration of pending) {
    // The schema change and its version marker commit atomically: a failure
    // mid-migration rolls the DDL back, so a restart never re-runs a partially
    // applied migration against an inconsistent schema.
    await db.transaction(() => {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        migration.version,
        new Date().toISOString(),
      );
    });
    appliedNow.push(migration.version);
  }
  return appliedNow;
}

/** Highest applied version label, or null on a fresh database. */
export function currentSchemaVersion(db: SqlDb): string | null {
  const rows = db.prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1").all();
  return rows.length > 0 ? String(rows[0].version) : null;
}