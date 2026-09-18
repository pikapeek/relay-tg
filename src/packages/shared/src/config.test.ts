import { describe, expect, it } from "vitest";
import { DEFAULTS, loadConfig } from "./config.ts";
import { ValidationError } from "./errors.ts";

const BASE = {
  BOTS: "main:123456:ABC",
  GROUP_ID: "-1001234567890",
};

describe("config loader", () => {
  it("parses ADMIN_IDS and OPERATOR_IDS lists", () => {
    const cfg = loadConfig({ ...BASE, ADMIN_IDS: "123, 456,789", OPERATOR_IDS: "111" });
    expect(cfg.adminIds).toEqual([123, 456, 789]);
    expect(cfg.operatorIds).toEqual([111]);
  });

  it("defaults spam to 10 msgs / 60 s and verification when unset", () => {
    const cfg = loadConfig(BASE);
    expect(cfg.spam.rateLimitMax).toBe(10);
    expect(cfg.spam.rateLimitWindowSeconds).toBe(60);
    expect(cfg.spam.enabled).toBe(true);
    expect(cfg.verification.attempts).toBe(3);
    expect(cfg.verification.ttlSeconds).toBe(300);
  });

  it("defaults the auto-hide hard cap to 7 days (168 hours)", () => {
    const cfg = loadConfig(BASE);
    expect(cfg.autoHideHours).toBe(168);
  });

  it("parses overridden values", () => {
    const cfg = loadConfig({
      ...BASE,
      AUTO_HIDE_HOURS: "48",
      SPAM_RATE_LIMIT_MAX: "5",
      SPAM_RATE_LIMIT_WINDOW_SECONDS: "30",
      SPAM_ENABLED: "false",
      VERIFY_ATTEMPTS: "4",
      VERIFY_TTL_SECONDS: "120",
    });
    expect(cfg.autoHideHours).toBe(48);
    expect(cfg.spam.rateLimitMax).toBe(5);
    expect(cfg.spam.rateLimitWindowSeconds).toBe(30);
    expect(cfg.spam.enabled).toBe(false);
    expect(cfg.verification.attempts).toBe(4);
    expect(cfg.verification.ttlSeconds).toBe(120);
  });

  it("rejects a missing BOTS and bad ids", () => {
    expect(() => loadConfig({ GROUP_ID: "-1001" })).toThrow(ValidationError);
    expect(() => loadConfig({ ...BASE, ADMIN_IDS: "abc" })).toThrow(ValidationError);
    expect(() => loadConfig({ ...BASE, GROUP_ID: "not-a-number" })).toThrow(ValidationError);
  });

  it("parses a single BOTS entry, splitting name and token on the FIRST colon", () => {
    const cfg = loadConfig({ ...BASE, BOTS: "bot1:123456:AA-Token" });
    expect(cfg.bots).toEqual([{ id: "bot1", token: "123456:AA-Token" }]);
  });

  it("parses multiple BOTS entries in order (first bot is primary)", () => {
    const cfg = loadConfig({ ...BASE, BOTS: "bot1:t1:a, bot2:t2:b ,bot3:t3:c" });
    expect(cfg.bots).toEqual([
      { id: "bot1", token: "t1:a" },
      { id: "bot2", token: "t2:b" },
      { id: "bot3", token: "t3:c" },
    ]);
  });

  it("rejects malformed BOTS entries", () => {
    expect(() => loadConfig({ ...BASE, BOTS: "" })).toThrow(ValidationError);
    expect(() => loadConfig({ ...BASE, BOTS: "no-token-here" })).toThrow(ValidationError);
    expect(() => loadConfig({ ...BASE, BOTS: ":abc" })).toThrow(ValidationError);
    expect(() => loadConfig({ ...BASE, BOTS: "bad name:abc" })).toThrow(ValidationError);
  });

  it("defaults ad detection to enabled, auto-block on, and the built-in keyword blocklist", () => {
    const cfg = loadConfig(BASE);
    expect(cfg.ad.enabled).toBe(true);
    expect(cfg.ad.autoBlock).toBe(true);
    expect(cfg.ad.keywords).toEqual(DEFAULTS.adKeywords);
    expect(cfg.ad.keywords.length).toBeGreaterThanOrEqual(30);
    expect(cfg.ad.patterns).toEqual([]);
  });

  it("treats an explicitly empty AD_KEYWORDS as no env keywords (runtime `/ad` only)", () => {
    const cfg = loadConfig({ ...BASE, AD_KEYWORDS: "" });
    expect(cfg.ad.keywords).toEqual([]);
    expect(cfg.ad.patterns).toEqual([]);
  });

  it("parses AD_KEYWORDS and AD_PATTERNS as comma-separated lists", () => {
    const cfg = loadConfig({
      ...BASE,
      AD_KEYWORDS: "加微信, 优惠 ,t.me",
      AD_PATTERNS: "t\\.me/[a-z0-9_]+\\b, https?://\\S+",
    });
    expect(cfg.ad.keywords).toEqual(["加微信", "优惠", "t.me"]);
    expect(cfg.ad.patterns).toEqual(["t\\.me/[a-z0-9_]+\\b", "https?://\\S+"]);
  });

  it("parses AD_ENABLED and AD_AUTO_BLOCK booleans", () => {
    const cfg = loadConfig({ ...BASE, AD_ENABLED: "false", AD_AUTO_BLOCK: "false" });
    expect(cfg.ad.enabled).toBe(false);
    expect(cfg.ad.autoBlock).toBe(false);
  });

  it("parses AD_ALLOW_KEYWORDS / AD_ALLOW_PATTERNS and defaults AD_MAX_LINKS to 0 (off)", () => {
    const cfg = loadConfig({ ...BASE, AD_ALLOW_KEYWORDS: "官网, 优惠券", AD_ALLOW_PATTERNS: "\\btrusted\\b" });
    expect(cfg.ad.allowKeywords).toEqual(["官网", "优惠券"]);
    expect(cfg.ad.allowPatterns).toEqual(["\\btrusted\\b"]);
    expect(cfg.ad.maxLinks).toBe(0);
  });

  it("parses AD_MAX_LINKS and rejects a negative or non-numeric value", () => {
    const cfg = loadConfig({ ...BASE, AD_MAX_LINKS: "3" });
    expect(cfg.ad.maxLinks).toBe(3);
    expect(() => loadConfig({ ...BASE, AD_MAX_LINKS: "-1" })).toThrow(ValidationError);
    expect(() => loadConfig({ ...BASE, AD_MAX_LINKS: "abc" })).toThrow(ValidationError);
  });
});
