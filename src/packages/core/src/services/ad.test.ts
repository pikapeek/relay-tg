// ---------------------------------------------------------------------------
// AdDetectionService (广告防护) unit tests: keyword/regex classification of
// text and captions, runtime keyword management via settings, and the guards
// that keep detection from ever taking down the message pipeline.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { loadConfig } from "@relaytg/shared";
import { makeHarness, text, photo } from "./harness.ts";
import { AdDetectionService } from "./index.ts";

function adHarness(env: Record<string, string> = {}) {
  const h = makeHarness(
    loadConfig({
      BOT_TOKEN: "test-token",
      GROUP_ID: "-100123456789",
      ADMIN_IDS: "111",
      OPERATOR_IDS: "222",
      ...env,
    }),
  );
  return { h, ad: new AdDetectionService(h.ctx) };
}

describe("AdDetectionService — detect", () => {
  it("matches a config keyword case-insensitively", async () => {
    const { ad } = adHarness({ AD_KEYWORDS: "加微信,优惠,telegram" });
    await expect(ad.detect(text("点击加入 加微信 联系"))).resolves.toEqual({ detected: true, reason: "加微信" });
    await expect(ad.detect(text("限时优惠!@#"))).resolves.toEqual({ detected: true, reason: "优惠" });
    // Case-insensitive for latin keywords.
    await expect(ad.detect(text("Contact us on TELEGRAM"))).resolves.toEqual({ detected: true, reason: "telegram" });
  });

  it("matches a runtime keyword stored in settings", async () => {
    const { ad, h } = adHarness();
    await h.db.settings.set("ad_keywords", "返利\n刷单");
    await expect(ad.detect(text("进群返利 5 元"))).resolves.toEqual({ detected: true, reason: "返利" });
  });

  it("matches a config regex pattern against the whole text", async () => {
    const { ad } = adHarness({ AD_PATTERNS: "t\\.me/[a-z0-9_]+\\b" });
    await expect(ad.detect(text("加入 https://t.me/some_channel"))).resolves.toEqual({ detected: true, reason: "t\\.me/[a-z0-9_]+\\b" });
  });

  it("checks media captions, not just text", async () => {
    const { ad } = adHarness({ AD_KEYWORDS: "代购" });
    await expect(ad.detect(photo("f1", "海外 代购 直邮"))).resolves.toEqual({ detected: true, reason: "代购" });
  });

  it("never matches a sticker (no text)", async () => {
    const { ad } = adHarness({ AD_KEYWORDS: "加微信" });
    await expect(ad.detect({ type: "sticker", fileId: "st1", fileSize: 5 })).resolves.toEqual({ detected: false, reason: null });
  });

  it("returns ok when no blocklists are configured", async () => {
    const { ad } = adHarness();
    await expect(ad.detect(text("hello support"))).resolves.toEqual({ detected: false, reason: null });
  });

  it("is disabled by AD_ENABLED=false", async () => {
    const { ad } = adHarness({ AD_ENABLED: "false", AD_KEYWORDS: "加微信" });
    await expect(ad.detect(text("加微信联系"))).resolves.toEqual({ detected: false, reason: null });
  });

  it("skips an invalid runtime regex without throwing", async () => {
    const { ad, h } = adHarness();
    await h.db.settings.set("ad_patterns", "[unclosed");
    await expect(ad.detect(text("anything"))).resolves.toEqual({ detected: false, reason: null });
  });
});

describe("AdDetectionService — runtime keyword management", () => {
  it("addKeyword persists a new keyword and dedupes case-insensitively", async () => {
    const { ad, h } = adHarness();
    await ad.addKeyword(" 加微信 ");
    await ad.addKeyword("返利");
    await ad.addKeyword("加微信"); // dup, different case/trimmed form
    expect(await ad.listKeywords()).toEqual(["加微信", "返利"]);
    expect(await h.db.settings.get("ad_keywords")).toBe("加微信\n返利");
    // The added keyword now flags messages.
    await expect(ad.detect(text("加微信私聊"))).resolves.toEqual({ detected: true, reason: "加微信" });
  });

  it("removeKeyword removes an existing keyword and reports a missing one", async () => {
    const { ad } = adHarness();
    await ad.addKeyword("刷单");
    expect(await ad.removeKeyword("刷单")).toBe(true);
    expect(await ad.removeKeyword("刷单")).toBe(false);
    expect(await ad.listKeywords()).toEqual([]);
  });

  it("addKeyword ignores a blank word", async () => {
    const { ad } = adHarness();
    await ad.addKeyword("   ");
    expect(await ad.listKeywords()).toEqual([]);
  });
});

describe("AdDetectionService — allowlist & link-count rules", () => {
  it("an allow keyword overrides a blacklist hit (env and settings merged)", async () => {
    const { ad, h } = adHarness({ AD_KEYWORDS: "加微信", AD_ALLOW_KEYWORDS: "官网" });
    await expect(ad.detect(text("扫码 加微信 访问官网"))).resolves.toEqual({ detected: false, reason: null });
    // A runtime allow keyword behaves the same way.
    await h.db.settings.set("ad_allow_keywords", "优惠");
    await expect(ad.detect(text("加微信 限时优惠"))).resolves.toEqual({ detected: false, reason: null });
  });

  it("an allow pattern overrides a blacklist hit", async () => {
    const { ad } = adHarness({ AD_PATTERNS: "t\\.me/[a-z0-9_]+", AD_ALLOW_PATTERNS: "\\bproduct\\b" });
    await expect(ad.detect(text("see our product at t.me/x"))).resolves.toEqual({ detected: false, reason: null });
    await expect(ad.detect(text("check t.me/x"))).resolves.toEqual({ detected: true, reason: "t\\.me/[a-z0-9_]+" });
  });

  it("counts http links and t.me handles against AD_MAX_LINKS", async () => {
    const { ad } = adHarness({ AD_MAX_LINKS: "2" });
    await expect(ad.detect(text("hello"))).resolves.toEqual({ detected: false, reason: null });
    await expect(ad.detect(text("one https://example.com"))).resolves.toEqual({ detected: false, reason: null });
    await expect(ad.detect(text("https://a.com https://b.com"))).resolves.toEqual({
      detected: true,
      reason: "too many links (2/2)",
    });
    await expect(ad.detect(text("t.me/join x telegram.me/y"))).resolves.toEqual({
      detected: true,
      reason: "too many links (2/2)",
    });
  });

  it("the link rule runs after the allowlist — an allow keyword clears even a multi-link message", async () => {
    const { ad } = adHarness({ AD_MAX_LINKS: "1", AD_ALLOW_KEYWORDS: "官网" });
    await expect(ad.detect(text("官网 https://a.com https://b.com"))).resolves.toEqual({ detected: false, reason: null });
  });

  it("setMaxLinks overrides the env default at runtime (0 = off)", async () => {
    const { ad } = adHarness();
    expect(await ad.getMaxLinks()).toBe(0);
    await ad.setMaxLinks(1);
    expect(await ad.getMaxLinks()).toBe(1);
    await expect(ad.detect(text("https://example.com"))).resolves.toEqual({ detected: true, reason: "too many links (1/1)" });
    await ad.setMaxLinks(0);
    await expect(ad.detect(text("https://example.com"))).resolves.toEqual({ detected: false, reason: null });
  });

  it("runtime allowlist management persists and dedupes", async () => {
    const { ad, h } = adHarness({ AD_KEYWORDS: "加微信" });
    await ad.addAllowKeyword(" 官网 ");
    await ad.addAllowKeyword("官网"); // dup (trimmed + case-insensitive paths)
    expect(await ad.listAllowKeywords()).toEqual(["官网"]);
    expect(await h.db.settings.get("ad_allow_keywords")).toBe("官网");
    expect(await ad.removeAllowKeyword("官网")).toBe(true);
    expect(await ad.removeAllowKeyword("官网")).toBe(false);
    expect(await ad.listAllowKeywords()).toEqual([]);
  });
});
