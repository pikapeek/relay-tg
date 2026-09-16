import { describe, expect, it } from "vitest";
import type { Database, Runtime, TelegramClient, UserRepository, VerificationStore } from "./index.ts";

describe("core ports", () => {
  it("defines the Runtime port", () => {
    const runtime: Runtime = { now: () => new Date("2026-01-01T00:00:00.000Z"), randomId: () => "id", schedule: () => {} };
    expect(runtime.now().getTime()).toBe(new Date("2026-01-01T00:00:00.000Z").getTime());
    expect(runtime.randomId()).toBe("id");
  });

  it("exposes repository ports on the Database shape", () => {
    const db: Database | null = null;
    const users: UserRepository | null = null;
    const verification: VerificationStore | null = null;
    const telegram: TelegramClient | null = null;
    expect(db).toBeNull();
    expect(users).toBeNull();
    expect(verification).toBeNull();
    expect(telegram).toBeNull();
  });
});
