// ---------------------------------------------------------------------------
// Barrel for the platform-neutral repository layer. The implementation now
// lives in ./repos/ (one file per domain, composed by sqlite-database.ts) so
// this file keeps every import reaching the `@relaytg/adapter-sqlite/repository`
// subpath — the worker runtime and both integration suites — unchanged.
// ---------------------------------------------------------------------------

export { SqliteDatabase } from "./repos/sqlite-database.ts";