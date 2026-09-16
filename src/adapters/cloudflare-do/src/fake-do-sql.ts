// ---------------------------------------------------------------------------
// Test double for ctx.storage.sql (the DO SqlStorage API shape), shared by the
// adapter's unit tests and the shared relay scenario suite (task 13.1).
//
// Backed by an in-memory node:sqlite DatabaseSync. Migration/schema exec can be
// multi-statement DDL (with leading SQL comments); those are routed to
// DatabaseSync.exec (multi-statement-aware). Data statements go through
// prepare(): reads return rows, writes report the affected count.
// ---------------------------------------------------------------------------

import { DatabaseSync } from "node:sqlite";
import type { SqlValue } from "@relaytg/adapter-sqlite/sql-db";
import type { DurableObjectCursor, DurableObjectSqlHandle } from "./db.ts";

export class FakeDoSqlHandle implements DurableObjectSqlHandle {
  private readonly inner = new DatabaseSync(":memory:");

  exec(query: string, ...bindings: SqlValue[]): DurableObjectCursor {
    const stripped = query.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    const isDdl = /^\s*(CREATE|ALTER|DROP|BEGIN|COMMIT|ROLLBACK)\b/i.test(stripped);
    if (isDdl) {
      this.inner.exec(query);
      return { toArray: () => [], rowsWritten: 0 };
    }
    const stmt = this.inner.prepare(query);
    const returnsRows = /^\s*(SELECT|WITH|PRAGMA|EXPLAIN)\b/i.test(stripped);
    if (returnsRows) {
      const rows = stmt.all(...bindings) as Array<Record<string, SqlValue>>;
      return { toArray: () => rows, rowsWritten: rows.length };
    }
    const result = stmt.run(...bindings);
    return { toArray: () => [], rowsWritten: Number(result.changes) };
  }
}
