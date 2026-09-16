// ---------------------------------------------------------------------------
// Shared relay scenario suite (task 13.1) — Cloudflare DO stack.
//
// Runs the exact same scenarios as the Docker/sqlite stack against the DO
// SqlStorage API shape (a fake sql handle over node:sqlite), with the migration
// SQL embedded as raw strings just like the worker's runtime bundle. Proves the
// relay pipeline behaves identically on both storage backends.
// ---------------------------------------------------------------------------

import { relaySuite } from "@relaytg/adapter-sqlite/relay-suite";
import { DurableObjectSqlDb } from "./index.ts";
import { FakeDoSqlHandle } from "./fake-do-sql.ts";

// The migration SQL embedded for the runtime bundle, mirroring how the worker
// imports migrations/*.sql as raw strings.
import initialSql from "../../../migrations/001_initial.sql?raw";
import preferredLanguageSql from "../../../migrations/002_preferred_language.sql?raw";
import purposeSql from "../../../migrations/003_purpose.sql?raw";

relaySuite(
  "cloudflare-do (fake sql handle)",
  async () => new DurableObjectSqlDb(new FakeDoSqlHandle()),
  [
    { version: "001_initial", sql: initialSql },
    { version: "002_preferred_language", sql: preferredLanguageSql },
    { version: "003_purpose", sql: purposeSql },
  ],
);