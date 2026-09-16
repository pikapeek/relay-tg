// ---------------------------------------------------------------------------
// Node-only migration loader: reads migrations/*.sql from disk (Docker path).
// Kept out of migrate.ts so the Cloudflare DO build never pulls in node:fs.
// ---------------------------------------------------------------------------

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Migration } from "./migrate.ts";

/** Load every `*.sql` file in `dir`, ordered by filename (== version). */
export function loadMigrationsFromDir(dir: string): Migration[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => ({
      version: file.replace(/\.sql$/, ""),
      sql: readFileSync(join(dir, file), "utf8"),
    }));
}