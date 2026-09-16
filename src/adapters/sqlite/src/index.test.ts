import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { NodeSqliteDb } from "./node-sqlite-db.ts";
import { loadMigrationsFromDir } from "./node-migrations.ts";
import { applyMigrations } from "./migrate.ts";
import { SqliteDatabase } from "./repository.ts";
import { storageSuite } from "./storage-suite.ts";
import { sqliteAdapterVersion } from "./index.ts";

// Repo root, reached from adapters/sqlite/src/.
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "migrations");
const migrations = loadMigrationsFromDir(migrationsDir);

describe("sqlite adapter", () => {
  it("exports a version marker", () => {
    expect(sqliteAdapterVersion).toBe("0.1.0");
  });

  it("transaction rolls back on throw (node:sqlite BEGIN/COMMIT semantics)", async () => {
    const sql = NodeSqliteDb.open(":memory:");
    await applyMigrations(sql, migrations);
    const db = new SqliteDatabase(sql);

    await expect(
      db.transaction(async (tx) => {
        await tx.users.upsertProfile(
          { telegramUserId: 3, username: "u3", firstName: null, lastName: null, languageCode: null, isBot: false },
          new Date("2026-01-01T00:00:00.000Z"),
        );
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db.users.getByTelegramUserId(3)).toBeNull();
  });
});

// Run the shared storage suite (migrations + every repository method) against
// an in-memory node:sqlite database with the real migrations from disk.
storageSuite("node:sqlite", async () => NodeSqliteDb.open(":memory:"), migrations);