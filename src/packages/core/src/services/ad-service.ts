// ---------------------------------------------------------------------------
// AdDetectionService (广告防护): keyword/regex classification of user message
// text and media captions, plus a link-count rule. Detection is a pure text
// check; the enforcement (auto-block + quarantine) lives in UpdateProcessor.
//
// Evaluation order — allow decides first, so a false positive on a blocked
// keyword is avoided:
//   1. allow keywords (env AD_ALLOW_KEYWORDS + runtime `/ad allow`) — any
//      substring hit clears the message regardless of what else it contains;
//   2. allow patterns (env AD_ALLOW_PATTERNS) — a regex hit clears it;
//   3. link count (/ad links or AD_MAX_LINKS) — text with >= N links is ad;
//   4. block keywords (env AD_KEYWORDS + runtime `/ad`) — substring match;
//   5. block patterns (env AD_PATTERNS + runtime `/ad pattern` seeds) — regex.
// A single block hit flags the message as ad text.
// ---------------------------------------------------------------------------

import { messageText, type MessageContent } from "@relaytg/shared";
import type { Database } from "../ports.ts";
import type { ServiceContext } from "./service-context.ts";

export interface AdCheckResult {
  detected: boolean;
  /** The keyword/pattern/reason that matched, for the operator notification. */
  reason: string | null;
}

/** Settings keys for the runtime-managed lists (newline-separated) and the
 *  runtime link-count override. */
const KEYWORDS_KEY = "ad_keywords";
const PATTERNS_KEY = "ad_patterns";
const ALLOW_KEYWORDS_KEY = "ad_allow_keywords";
const MAX_LINKS_KEY = "ad_max_links";

export class AdDetectionService {
  private readonly db: Database;
  private readonly enabled: boolean;
  private readonly keywords: string[];
  private readonly patterns: string[];
  private readonly allowKeywords: string[];
  private readonly allowPatterns: string[];
  private readonly maxLinks: number;

  constructor(ctx: ServiceContext) {
    this.db = ctx.db;
    this.enabled = ctx.config.ad.enabled;
    this.keywords = ctx.config.ad.keywords;
    this.patterns = ctx.config.ad.patterns;
    this.allowKeywords = ctx.config.ad.allowKeywords;
    this.allowPatterns = ctx.config.ad.allowPatterns;
    this.maxLinks = ctx.config.ad.maxLinks;
  }

  /** Detect ad text in a message. Text and media captions qualify; a sticker
   *  (no text) never matches. Config and settings lists are merged per call so
   *  an `/ad` change takes effect on the very next message. */
  async detect(content: MessageContent): Promise<AdCheckResult> {
    if (!this.enabled) return { detected: false, reason: null };
    const text = messageText(content);
    if (text == null) return { detected: false, reason: null };

    const lower = text.toLowerCase();
    const settings = await this.loadSettings();

    // 1. Allow keywords override any blocklist hit.
    const allowHit = [...this.allowKeywords, ...settings.allowKeywords].find((w) => w.length > 0 && lower.includes(w.toLowerCase()));
    if (allowHit != null) return { detected: false, reason: null };

    // 2. Allow patterns (env-only) — same override.
    for (const pattern of this.allowPatterns) {
      if (safeTest(pattern, text)) return { detected: false, reason: null };
    }

    // 3. Link-count rule; a runtime /ad links value overrides the env default.
    const maxLinks = settings.maxLinks ?? this.maxLinks;
    if (maxLinks > 0) {
      const links = countLinks(text);
      if (links >= maxLinks) return { detected: true, reason: `too many links (${links}/${maxLinks})` };
    }

    // 4. Block keywords.
    for (const keyword of [...this.keywords, ...settings.keywords]) {
      if (keyword.length > 0 && lower.includes(keyword.toLowerCase())) {
        return { detected: true, reason: keyword };
      }
    }
    // 5. Block patterns.
    for (const pattern of [...this.patterns, ...settings.patterns]) {
      if (safeTest(pattern, text)) return { detected: true, reason: pattern };
    }
    return { detected: false, reason: null };
  }

  // -- runtime blocklist management (/ad) ------------------------------------

  async addKeyword(word: string): Promise<void> {
    await this.addToList(KEYWORDS_KEY, word);
  }

  async removeKeyword(word: string): Promise<boolean> {
    return this.removeFromList(KEYWORDS_KEY, word);
  }

  async listKeywords(): Promise<string[]> {
    return split(await this.db.settings.get(KEYWORDS_KEY));
  }

  // -- runtime allowlist management (/ad allow) -------------------------------

  async addAllowKeyword(word: string): Promise<void> {
    await this.addToList(ALLOW_KEYWORDS_KEY, word);
  }

  async removeAllowKeyword(word: string): Promise<boolean> {
    return this.removeFromList(ALLOW_KEYWORDS_KEY, word);
  }

  async listAllowKeywords(): Promise<string[]> {
    return split(await this.db.settings.get(ALLOW_KEYWORDS_KEY));
  }

  // -- runtime link-count rule (/ad links) ------------------------------------

  /** Set the link-count threshold; 0 turns the rule off. */
  async setMaxLinks(n: number): Promise<void> {
    const clamped = Math.max(0, Math.floor(n));
    await this.db.settings.set(MAX_LINKS_KEY, String(clamped));
  }

  /** The effective link threshold: runtime override, else the env default. */
  async getMaxLinks(): Promise<number> {
    return parseMaxLinks(await this.db.settings.get(MAX_LINKS_KEY)) ?? this.maxLinks;
  }

  // -- shared list helpers (blocklist and allowlist are the same shape) --------

  /** Append a word to a newline-separated settings list, deduped
   *  case-insensitively; a blank word is ignored. */
  private async addToList(key: string, word: string): Promise<void> {
    const clean = word.trim();
    if (clean.length === 0) return;
    const list = split(await this.db.settings.get(key));
    if (list.some((k) => k.toLowerCase() === clean.toLowerCase())) return;
    await this.db.settings.set(key, [...list, clean].join("\n"));
  }

  /** Remove a word from a newline-separated settings list; false when it
   *  wasn't present. */
  private async removeFromList(key: string, word: string): Promise<boolean> {
    const clean = word.trim();
    if (clean.length === 0) return false;
    const list = split(await this.db.settings.get(key));
    const remaining = list.filter((k) => k.toLowerCase() !== clean.toLowerCase());
    if (remaining.length === list.length) return false;
    await this.db.settings.set(key, remaining.join("\n"));
    return true;
  }

  private async loadSettings(): Promise<{
    keywords: string[];
    patterns: string[];
    allowKeywords: string[];
    maxLinks: number | null;
  }> {
    const [keywords, patterns, allowKeywords, maxLinksRaw] = await Promise.all([
      this.db.settings.get(KEYWORDS_KEY),
      this.db.settings.get(PATTERNS_KEY),
      this.db.settings.get(ALLOW_KEYWORDS_KEY),
      this.db.settings.get(MAX_LINKS_KEY),
    ]);
    return {
      keywords: split(keywords),
      patterns: split(patterns),
      allowKeywords: split(allowKeywords),
      maxLinks: parseMaxLinks(maxLinksRaw),
    };
  }
}

/** A runtime link-count override, or null when unset/invalid (→ env default). */
function parseMaxLinks(raw: string | null): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : null;
}

/** A hand-edited/invalid regex must never take down the message pipeline —
 *  skip it and keep checking the rest. */
function safeTest(pattern: string, text: string): boolean {
  try {
    return new RegExp(pattern, "i").test(text);
  } catch {
    return false;
  }
}

/** Count link tokens in a text: scheme URLs (http/https) plus bare
 *  t.me / telegram.me usernames. Each token counts once (a `https://t.me/x`
 *  URL is consumed by the scheme alternative before the bare-path ones). */
function countLinks(text: string): number {
  const matches = text.match(/(?:https?:\/\/\S+|\bt\.me\/[\w+_.-]+|\btelegram\.me\/[\w+_.-]+)/gi);
  return matches?.length ?? 0;
}

function split(value: string | null): string[] {
  return (value ?? "")
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}