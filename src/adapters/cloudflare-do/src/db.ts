// ---------------------------------------------------------------------------
// Cloudflare Durable Object SqlDb binding (task 10.4).
//
// Wraps ctx.storage.sql into the shared SqlDb surface so the SAME repository
// layer (adapters/sqlite/src/repository.ts) runs on Workers. Two driver
// differences are normalized here: a missing `.get()` row comes back null, and
// `.run()` reports a change count conservatively (the repository layer never
// branches on the count — idempotency uses INSERT OR IGNORE plus a claim
// nonce).
//
// The real DO API has no `prepare()`: every query goes through
// `storage.sql.exec(query, ...bindings)`, which returns a cursor. The shared
// SqlStatement surface (get/all/run) is built on top of that cursor.
// ---------------------------------------------------------------------------

import type { Database } from "@relaytg/core";
import type { SqlDb, SqlRow, SqlStatement, SqlValue } from "@relaytg/adapter-sqlite/sql-db";
import { SqliteDatabase } from "@relaytg/adapter-sqlite/repository";

// Structural view of the DO SqlStorage exec() result we consume. rowsWritten
// (affected-row count) is used by Statement.run to report a truthful change
// count where the runtime exposes it.
export interface DurableObjectCursor {
  toArray(): Array<Record<string, SqlValue>>;
  rowsWritten?: number;
}

/** Structural view of the SQLite-backed DO storage (`ctx.storage.sql`):
 *  exec(query, ...bindings) → cursor. Mirrors the runtime SqlStorage API. */
export interface DurableObjectSqlHandle {
  exec(query: string, ...bindings: SqlValue[]): DurableObjectCursor;
}

class DurableObjectStatement implements SqlStatement {
  constructor(
    private readonly sql: DurableObjectSqlHandle,
    private readonly query: string,
  ) {}

  run(...params: SqlValue[]): { changes: number } {
    const cursor = this.sql.exec(this.query, ...params);
    // Workerd exposes affected rows via cursor.rowsWritten; fall back to 1 when
    // unavailable. The repository layer never branches on it (see file header).
    return { changes: cursor.rowsWritten ?? 1 };
  }

  get(...params: SqlValue[]): SqlRow | null {
    const rows = this.sql.exec(this.query, ...params).toArray();
    return (rows[0] as SqlRow | undefined) ?? null;
  }

  all(...params: SqlValue[]): SqlRow[] {
    return this.sql.exec(this.query, ...params).toArray() as SqlRow[];
  }
}

export class DurableObjectSqlDb implements SqlDb {
  private readonly sql: DurableObjectSqlHandle;

  constructor(sql: DurableObjectSqlHandle) {
    this.sql = sql;
  }

  exec(sqlQuery: string): void {
    this.sql.exec(sqlQuery);
  }

  prepare(sqlQuery: string): SqlStatement {
    return new DurableObjectStatement(this.sql, sqlQuery);
  }

  /** Bracket a unit of work with real SQLite transaction control, mirroring the
   *  Docker path. Per-instance request serialization covers isolation, but it
   *  does NOT make a mid-unit failure atomic — without BEGIN/COMMIT/ROLLBACK a
   *  thrown statement leaves the earlier writes applied while the Docker path
   *  leaves zero rows. */
  private txDepth = 0;
  async transaction<T>(fn: () => T | Promise<T>): Promise<T> {
    if (this.txDepth > 0) return fn();
    this.sql.exec("BEGIN IMMEDIATE");
    this.txDepth += 1;
    try {
      const result = await fn();
      this.sql.exec("COMMIT");
      return result;
    } catch (err) {
      this.sql.exec("ROLLBACK");
      throw err;
    } finally {
      this.txDepth -= 1;
    }
  }
}

/** Build the core Database port over a Durable Object's SQLite storage. */
export function createDurableObjectDatabase(storage: DurableObjectStorage): Database {
  return new SqliteDatabase(new DurableObjectSqlDb(storage.sql as unknown as DurableObjectSqlHandle));
}