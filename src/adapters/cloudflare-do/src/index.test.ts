// ---------------------------------------------------------------------------
// cloudflare-do adapter tests (task 10.4).
//
// Runs the SHARED storage suite (same tests as the node:sqlite path) against a
// FAKE sql handle shaped like the DO SqlStorage API — `.get()` returns null
// for a missing row, `.run()` reports `{ success }` with no change count —
// proving the DurableObjectSqlDb adapter normalizes the driver differences and
// that core's repository layer behaves identically on both stacks.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { storageSuite } from "../../sqlite/src/storage-suite.ts";
import { DurableObjectSqlDb, cloudflareDoAdapterVersion } from "./index.ts";
import { FakeDoSqlHandle } from "./fake-do-sql.ts";

// The migration SQL embedded for the runtime bundle, mirroring how the worker
// imports migrations/*.sql as raw strings.
import initialSql from "../../../migrations/001_initial.sql?raw";
import preferredLanguageSql from "../../../migrations/002_preferred_language.sql?raw";
import purposeSql from "../../../migrations/003_purpose.sql?raw";

describe("cloudflare-do adapter", () => {
  it("exports a version marker", () => {
    expect(cloudflareDoAdapterVersion).toBe("0.1.0");
  });

  it("normalizes DO get()-returns-null into the shared row surface", async () => {
    const db = new DurableObjectSqlDb(new FakeDoSqlHandle());
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)");
    db.prepare("INSERT INTO t (id, v) VALUES (?, ?)").run(1, "x");
    expect(db.prepare("SELECT v FROM t WHERE id = 1").get()?.v).toBe("x");
    expect(db.prepare("SELECT v FROM t WHERE id = 2").get()).toBeNull();
  });

  it("commits a transaction that completes, matching the Docker path", async () => {
    const db = new DurableObjectSqlDb(new FakeDoSqlHandle());
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)");
    await db.transaction(() => {
      db.prepare("INSERT INTO t (id, v) VALUES (?, ?)").run(1, "a");
      db.prepare("INSERT INTO t (id, v) VALUES (?, ?)").run(2, "b");
    });
    expect(db.prepare("SELECT COUNT(*) AS c FROM t").get()?.c).toBe(2);
  });

  it("rolls back the whole unit when the body throws, leaving zero partial writes", async () => {
    const db = new DurableObjectSqlDb(new FakeDoSqlHandle());
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)");
    await db
      .transaction(() => {
        db.prepare("INSERT INTO t (id, v) VALUES (?, ?)").run(1, "a");
        db.prepare("INSERT INTO t (id, v) VALUES (?, ?)").run(2, "b");
        throw new Error("boom");
      })
      .catch(() => {});
    expect(db.prepare("SELECT COUNT(*) AS c FROM t").get()?.c).toBe(0);
  });

  it("rethrows the transaction error to the caller for handling", async () => {
    const db = new DurableObjectSqlDb(new FakeDoSqlHandle());
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL)");
    await expect(
      db.transaction(() => {
        db.prepare("INSERT INTO t (id, v) VALUES (?, ?)").run(1, "a");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(db.prepare("SELECT COUNT(*) AS c FROM t").get()?.c).toBe(0);
  });
});

// The same repository suite the node:sqlite path runs, driven through the DO
// adapter over the fake handle, with the real migration embedded as raw SQL.
storageSuite("cloudflare-do (fake sql handle)", async () => new DurableObjectSqlDb(new FakeDoSqlHandle()), [
  { version: "001_initial", sql: initialSql },
  { version: "002_preferred_language", sql: preferredLanguageSql },
  { version: "003_purpose", sql: purposeSql },
]);