// ---------------------------------------------------------------------------
// Database-path anchoring (regression for the 09/2026 "duplicate topics":
// a relative DATABASE_PATH resolved against the launch cwd and split the
// database between the repo root and src/apps/docker/data). See app.ts.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { MONOREPO_ROOT, resolveDatabasePath } from "./app.ts";

describe("resolveDatabasePath", () => {
  it("leaves an in-memory database untouched", () => {
    expect(resolveDatabasePath(":memory:")).toBe(":memory:");
  });

  it("leaves absolute paths untouched", () => {
    expect(resolveDatabasePath("/tmp/relaytg.db")).toBe("/tmp/relaytg.db");
  });

  it("anchors a relative path at the monorepo root, not the launch cwd", () => {
    const p = resolveDatabasePath("data/relaytg.db");
    expect(p).toBe(resolve(MONOREPO_ROOT, "data/relaytg.db"));
    expect(isAbsolute(p)).toBe(true);
  });

  it("the monorepo root is the directory that owns pnpm-workspace.yaml", () => {
    expect(existsSync(resolve(MONOREPO_ROOT, "pnpm-workspace.yaml"))).toBe(true);
  });
});