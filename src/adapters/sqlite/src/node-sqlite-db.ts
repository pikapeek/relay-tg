// ---------------------------------------------------------------------------
// Docker-path SqlDb binding over node:sqlite (task 10.3). Normalizes the small
// driver differences so the shared repository layer sees one surface:
// a missing `.get()` row becomes null, and `.run()` reports changes.
// ---------------------------------------------------------------------------

import { DatabaseSync } from "node:sqlite";
import type { StatementSync } from "node:sqlite";
import type { SqlDb, SqlRow, SqlStatement, SqlValue } from "./sql-db.ts";

class NodeStatement implements SqlStatement {
  constructor(private readonly stmt: StatementSync) {}

  run(...params: SqlValue[]): { changes: number } {
    // SqlValue is a subset of node:sqlite's SQLInputValue, so no cast needed.
    const result = this.stmt.run(...params);
    return { changes: Number(result.changes) };
  }

  get(...params: SqlValue[]): SqlRow | null {
    const row = this.stmt.get(...params);
    if (row === undefined) return null;
    return row as SqlRow;
  }

  all(...params: SqlValue[]): SqlRow[] {
    return this.stmt.all(...params) as SqlRow[];
  }
}

export class NodeSqliteDb implements SqlDb {
  private readonly db: DatabaseSync;
  private txDepth = 0;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Open a DatabaseSync and wrap it. Callers own the lifecycle. */
  static open(path: string): NodeSqliteDb {
    return new NodeSqliteDb(new DatabaseSync(path));
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  /** Close the underlying database. Driver-specific; SqlDb implementations may
   *  omit lifecycle methods, so callers guard on availability. */
  close(): void {
    this.db.close();
  }

  prepare(sql: string): SqlStatement {
    return new NodeStatement(this.db.prepare(sql));
  }

  /** node:sqlite is synchronous, so a transaction can span awaited calls that
   *  only touch this connection — nothing else can interleave. Nested calls
   *  reuse the open transaction. */
  async transaction<T>(fn: () => T | Promise<T>): Promise<T> {
    if (this.txDepth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.txDepth += 1;
    try {
      const result = await fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    } finally {
      this.txDepth -= 1;
    }
  }
}

/** Convenience: open a file-backed (or `:memory:`) SQLite database. */
export function openSqliteDatabase(path: string): NodeSqliteDb {
  return NodeSqliteDb.open(path);
}