// ---------------------------------------------------------------------------
// Unit tests for SpamService (task 9): per-user rolling-window rate limit,
// flood / temporary restriction, message-length and media-size caps, all driven
// by config thresholds (9.1-9.3). Temporary restriction is in-memory only and
// never writes a user-level block record.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { type SpamConfig } from "@relaytg/shared";
import { SpamService } from "./spam-service.ts";
import { baseConfig, makeHarness, profile, text, photo, userMessage } from "./harness.ts";
import { buildServices } from "./index.ts";

function svc(overrides: Partial<SpamConfig> = {}): SpamService {
  return new SpamService({ ...baseConfig().spam, ...overrides });
}

function at(tMs: number): Date {
  return new Date(tMs);
}

const MINUTE = 60_000;

// ---------------------------------------------------------------------------
// 9.1 Per-user rate limit
// ---------------------------------------------------------------------------

describe("rate limit (9.1)", () => {
  it("allows up to the limit and rate-limits beyond it", () => {
    const service = svc(); // default 10 / 60s
    const now = at(1_000_000_000_000);
    for (let i = 0; i < 10; i++) {
      expect(service.checkAllowed(42, now)).toBe("ok");
    }
    expect(service.checkAllowed(42, now)).toBe("rate_limited");
    // Other users are unaffected.
    expect(service.checkAllowed(43, now)).toBe("ok");
  });

  it("releases after the window elapses", () => {
    const service = svc(); // default 10 / 60s
    const t0 = at(0);
    for (let i = 0; i < 10; i++) service.checkAllowed(42, t0);
    expect(service.checkAllowed(42, t0)).toBe("rate_limited");
    // At exactly the window boundary the old timestamps fall out.
    expect(service.checkAllowed(42, at(MINUTE))).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// 9.2 Flood restriction + content caps
// ---------------------------------------------------------------------------

describe("flood restriction (9.2)", () => {
  it("restricts a burst within the flood window and expires the restriction", () => {
    const service = svc({ rateLimitMax: 100, floodMax: 3, floodWindowSeconds: 60, floodRestrictSeconds: 300 });
    const now = at(0);
    expect(service.checkAllowed(42, now)).toBe("ok");
    expect(service.checkAllowed(42, now)).toBe("ok");
    expect(service.checkAllowed(42, now)).toBe("ok");
    expect(service.checkAllowed(42, now)).toBe("flood_restricted");
    // During the restriction the user is held out entirely.
    expect(service.checkAllowed(42, at(60_000))).toBe("flood_restricted");
    // After floodRestrictSeconds the restriction lifts (fresh window).
    expect(service.checkAllowed(42, at(301_000))).toBe("ok");
  });

  it("is reachable with the default thresholds once the burst exceeds floodMax", () => {
    const service = svc(); // floodMax 30 / 60s, rateLimitMax 10 / 60s
    const now = at(0);
    let last = "ok" as string;
    for (let i = 0; i < 30; i++) last = service.checkAllowed(42, now);
    expect(last).toBe("rate_limited"); // messages 10..30 are rate-limited
    last = service.checkAllowed(42, now);
    expect(last).toBe("flood_restricted"); // the 31st escalates past floodMax
  });

  it("temporary restriction never writes a user-level block record", async () => {
    const config = baseConfig();
    config.spam = { ...config.spam, rateLimitMax: 100, floodMax: 3 };
    const h = makeHarness(config);
    const services = buildServices(h.ctx);
    const { user } = await services.users.getOrCreate(profile(42));
    await services.users.markVerified(user.telegramUserId, h.bots.primary());
    // A statement of purpose opens their conversation, so every burst message
    // below hits the relay path instead of being consumed as the first message.
    await services.users.setPurpose(user.telegramUserId, "test purpose");

    for (let i = 1; i <= 4; i++) {
      await services.processor.process(i, userMessage(42, 100 + i, profile(42), text(`m${i}`)));
    }

    // The 4th burst message was flood-restricted and never relayed; the
    // restriction leaves no trace in the block repository.
    expect(h.db.blocks.rows.size).toBe(0);
    expect(h.db.messages.rows.size).toBe(3);
  });
});

describe("content caps (9.2)", () => {
  it("rejects over-long text and accepts the boundary", () => {
    const service = svc(); // maxMessageLength 4096
    expect(service.checkContent(text("x".repeat(4096)))).toBe("ok");
    expect(service.checkContent(text("x".repeat(4097)))).toBe("too_long");
  });

  it("rejects oversized media and accepts within-limit media", () => {
    const service = svc(); // maxMediaSizeBytes 20 MiB
    expect(service.checkContent(photo("f", "cap"))).toBe("ok"); // fileSize 10
    expect(service.checkContent({ type: "photo", fileId: "f", caption: null, fileSize: 21 * 1024 * 1024 })).toBe("too_large");
    // Non-media content with no size is never too_large.
    expect(service.checkContent(text("hi"))).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// 9.3 Config-driven thresholds
// ---------------------------------------------------------------------------

describe("config-driven thresholds (9.3)", () => {
  it("enforces overridden limits, not the defaults", () => {
    const service = svc({ rateLimitMax: 2, rateLimitWindowSeconds: 5, maxMessageLength: 10 });
    const now = at(0);
    expect(service.checkAllowed(42, now)).toBe("ok");
    expect(service.checkAllowed(42, now)).toBe("ok");
    expect(service.checkAllowed(42, now)).toBe("rate_limited");
    expect(service.checkContent(text("12345678901"))).toBe("too_long");

    // Disabled anti-spam allows everything.
    const off = svc({ enabled: false });
    expect(off.checkAllowed(42, at(0))).toBe("ok");
    expect(off.checkContent(text("x".repeat(10_000)))).toBe("ok");
  });
});