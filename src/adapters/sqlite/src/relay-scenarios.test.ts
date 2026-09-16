// ---------------------------------------------------------------------------
// Shared relay scenario suite (task 13.1) — Docker/sqlite stack.
//
// Runs the exact same scenarios as the Cloudflare DO stack against a real
// node:sqlite database with the real migrations from disk, proving the relay
// pipeline behaves identically on both storage backends.
// ---------------------------------------------------------------------------

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { NodeSqliteDb } from "./node-sqlite-db.ts";
import { loadMigrationsFromDir } from "./node-migrations.ts";
import { relaySuite } from "./relay-suite.ts";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "migrations");
const migrations = loadMigrationsFromDir(migrationsDir);

relaySuite("node:sqlite (Docker)", async () => NodeSqliteDb.open(":memory:"), migrations);
