// ---------------------------------------------------------------------------
// Minimal SQLite surface shared by both runtimes.
//
// Lines up with what the node:sqlite DatabaseSync and the Cloudflare Durable
// Object SqlStorage actually expose, normalizing the small differences:
//   - node:sqlite .get() returns undefined for a missing row, the DO binding
//     returns null; here it is always null.
//   - rows are returned keyed by (snake_case) column name on both drivers.
// The repository layer (repository.ts) maps these rows to the core records and
// never touches a concrete driver directly.
// ---------------------------------------------------------------------------

export type SqlValue = string | number | bigint | Uint8Array | null;

export interface SqlRow {
  [column: string]: SqlValue;
}

export interface SqlStatement {
  run(...params: SqlValue[]): { changes: number };
  get(...params: SqlValue[]): SqlRow | null;
  all(...params: SqlValue[]): SqlRow[];
}

export interface SqlDb {
  exec(sql: string): void;
  prepare(sql: string): SqlStatement;
  /** Bracket a unit of work. node:sqlite uses BEGIN/COMMIT/ROLLBACK; the DO
   *  binding is a no-op passthrough because a Durable Object instance already
   *  serializes requests. */
  transaction<T>(fn: () => T | Promise<T>): Promise<T>;
}