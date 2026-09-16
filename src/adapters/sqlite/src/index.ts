export { NodeSqliteDb, openSqliteDatabase } from "./node-sqlite-db.ts";
export { SqliteDatabase } from "./repository.ts";
export { applyMigrations, currentSchemaVersion } from "./migrate.ts";
export type { Migration } from "./migrate.ts";
export { loadMigrationsFromDir } from "./node-migrations.ts";
export { MIGRATIONS } from "./migrations.ts";

// Subpath-exported for the Cloudflare DO adapter, which must not pull in
// node:sqlite. Re-exported from the barrel too for convenience.
export type { SqlDb, SqlRow, SqlStatement, SqlValue } from "./sql-db.ts";

export const sqliteAdapterVersion = "0.1.0";