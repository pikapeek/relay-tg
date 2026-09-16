// ---------------------------------------------------------------------------
// Embedded migrations for the Cloudflare runtime (tasks 12.2/13.x).
//
// Single source of truth lives in @relaytg/adapter-sqlite/migrations (shared
// with the Docker/CLI runtime). The drift test in index.test.ts reads
// `migrations/*.sql` from disk and asserts it equals MIGRATIONS, so the two
// cannot silently diverge.
// ---------------------------------------------------------------------------

export { MIGRATIONS } from "@relaytg/adapter-sqlite/migrations";
