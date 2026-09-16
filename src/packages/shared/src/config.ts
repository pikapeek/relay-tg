// ---------------------------------------------------------------------------
// Typed configuration loader. Pure: reads a `Record<string, string|undefined>`
// (process.env on Docker, worker env bindings on Cloudflare) and produces a
// typed Config with every threshold configurable — nothing is hardcoded.
// ---------------------------------------------------------------------------

import { ValidationError } from "./errors.ts";

export interface VerificationConfig {
  attempts: number;
  ttlSeconds: number;
}

export interface SpamConfig {
  enabled: boolean;
  rateLimitMax: number;
  rateLimitWindowSeconds: number;
  floodMax: number;
  floodWindowSeconds: number;
  floodRestrictSeconds: number;
  maxMessageLength: number;
  maxMediaSizeBytes: number;
}

/** Ad-text detection (广告防护). Keyword/regex lists can be extended at runtime
 *  via `/ad`; these env vars only seed the defaults. */
export interface AdConfig {
  enabled: boolean;
  /** Default keyword blocklist (substring match, case-insensitive). */
  keywords: string[];
  /** Default regex blocklist, tested against the whole text. */
  patterns: string[];
  /** Default keyword whitelist — an allow match always overrides a blocklist
   *  hit (checked first). Runtime-extensible via `/ad allow`. */
  allowKeywords: string[];
  /** Default regex whitelist (env-only; no runtime management). */
  allowPatterns: string[];
  /** Reject text with at least this many links (0 = off). A runtime `/ad links`
   *  value overrides this default. */
  maxLinks: number;
  /** When an ad is detected: block the user (in addition to dropping the
   *  message and notifying the support group). */
  autoBlock: boolean;
}

export interface TelegramRetryConfig {
  retries: number;
  baseBackoffMs: number;
}

export interface Config {
  botToken: string;
  supportGroupId: number;
  adminIds: number[];
  operatorIds: number[];
  databasePath: string;
  /** Empty string disables webhook auth; when set, /webhook requires the
   *  matching `X-Telegram-Bot-Api-Secret-Token` header (see setWebhook). */
  webhookSecret: string;
  /** Global no-reply auto-hide hard cap (hours, default 168 = 7 days): every
   *  conversation idle past this is swept and hidden regardless of its policy.
   *  `/hide N` can only set a *sooner* per-conversation threshold. */
  autoHideHours: number;
  verification: VerificationConfig;
  spam: SpamConfig;
  ad: AdConfig;
  telegramRetry: TelegramRetryConfig;
}

export type EnvSource = Record<string, string | undefined>;

export const DEFAULTS = {
  databasePath: "data/relaytg.db",
  autoHideHours: 168,
  verifyAttempts: 3,
  verifyTtlSeconds: 300,
  spamEnabled: true,
  rateLimitMax: 10,
  rateLimitWindowSeconds: 60,
  floodMax: 30,
  floodWindowSeconds: 60,
  floodRestrictSeconds: 300,
  maxMessageLength: 4096,
  maxMediaSizeBytes: 20 * 1024 * 1024,
  adEnabled: true,
  adAutoBlock: true,
  adMaxLinks: 0,
  /** Built-in ad keyword blacklist, active only when `AD_KEYWORDS` is unset.
   *  Covers the common 兼职/网赚/引流/博彩/贷款/理财 spam; tune per-instance by
   *  setting `AD_KEYWORDS` or clearing hits via `AD_ALLOW_KEYWORDS`. */
  adKeywords: [
    "兼职", "网赚", "返利", "返佣", "刷单", "刷赞", "代购", "垫付", "日结", "日赚", "月入", "躺赚", "稳赚", "赚钱", "高佣金", "宝妈", "做任务", "薅羊毛",
    "加微信", "加V", "加QQ", "引流", "私聊", "免费领取", "领红包", "抽奖", "中奖", "优惠券",
    "赌博", "博彩", "菠菜", "六合彩", "彩票", "开奖", "出款", "跑分", "贷款", "放款", "炒股", "荐股", "投资", "理财", "虚拟币",
  ],
  telegramRetries: 3,
  telegramBaseBackoffMs: 500,
};

/** Strict canonical-integer parse: `Number()` would silently coerce "0x10"→16,
 *  "1e3"→1000 and "+42"→42 into "valid" ids; only plain signed decimals pass. */
function parseIntStrict(raw: string, key: string): number {
  const trimmed = raw.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new ValidationError(`Invalid integer for ${key}: "${raw}"`);
  }
  return Number(trimmed);
}

function intFrom(env: EnvSource, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw === null || raw.trim() === "") return fallback;
  return parseIntStrict(raw, key);
}

function requiredInt(env: EnvSource, key: string): number {
  const raw = env[key];
  if (raw === undefined || raw === null || raw.trim() === "") {
    throw new ValidationError(`Missing required integer config: ${key}`);
  }
  return parseIntStrict(raw, key);
}

/** Comma-separated string list (e.g. ad keywords/patterns): trimmed, empties
 *  dropped. An unset variable falls back to `fallback`; an explicitly empty
 *  variable means "no built-in list" (empty string is distinct from unset). */
function stringList(env: EnvSource, key: string, fallback: string[] = []): string[] {
  const raw = env[key];
  if (raw === undefined || raw === null) return fallback;
  if (raw.trim() === "") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

function intList(env: EnvSource, key: string): number[] {
  const raw = env[key];
  if (raw === undefined || raw === null || raw.trim() === "") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .map((s) => parseIntStrict(s, key));
}

function boolFrom(env: EnvSource, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === null || raw.trim() === "") return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no") return false;
  throw new ValidationError(`Invalid boolean for ${key}: "${raw}"`);
}

function nonNegative(value: number, key: string): number {
  if (value < 0) throw new ValidationError(`${key} must be >= 0`);
  return value;
}

/** Parse the environment into a typed, validated Config. */
export function loadConfig(env: EnvSource): Config {
  const botToken = env.BOT_TOKEN;
  if (!botToken || botToken.trim() === "") {
    throw new ValidationError("Missing required config: BOT_TOKEN");
  }

  const supportGroupId = requiredInt(env, "GROUP_ID");
  if (supportGroupId === 0) throw new ValidationError("GROUP_ID must not be 0");
  const autoHideHours = nonNegative(intFrom(env, "AUTO_HIDE_HOURS", DEFAULTS.autoHideHours), "AUTO_HIDE_HOURS");

  return {
    botToken: botToken.trim(),
    supportGroupId,
    adminIds: intList(env, "ADMIN_IDS"),
    operatorIds: intList(env, "OPERATOR_IDS"),
    databasePath: env.DATABASE_PATH?.trim() || DEFAULTS.databasePath,
    webhookSecret: env.WEBHOOK_SECRET?.trim() ?? "",
    autoHideHours,
    verification: {
      attempts: nonNegative(intFrom(env, "VERIFY_ATTEMPTS", DEFAULTS.verifyAttempts), "VERIFY_ATTEMPTS"),
      ttlSeconds: nonNegative(intFrom(env, "VERIFY_TTL_SECONDS", DEFAULTS.verifyTtlSeconds), "VERIFY_TTL_SECONDS"),
    },
    spam: {
      enabled: boolFrom(env, "SPAM_ENABLED", DEFAULTS.spamEnabled),
      rateLimitMax: nonNegative(intFrom(env, "SPAM_RATE_LIMIT_MAX", DEFAULTS.rateLimitMax), "SPAM_RATE_LIMIT_MAX"),
      rateLimitWindowSeconds: nonNegative(
        intFrom(env, "SPAM_RATE_LIMIT_WINDOW_SECONDS", DEFAULTS.rateLimitWindowSeconds),
        "SPAM_RATE_LIMIT_WINDOW_SECONDS",
      ),
      floodMax: nonNegative(intFrom(env, "SPAM_FLOOD_MAX", DEFAULTS.floodMax), "SPAM_FLOOD_MAX"),
      floodWindowSeconds: nonNegative(intFrom(env, "SPAM_FLOOD_WINDOW_SECONDS", DEFAULTS.floodWindowSeconds), "SPAM_FLOOD_WINDOW_SECONDS"),
      floodRestrictSeconds: nonNegative(
        intFrom(env, "SPAM_FLOOD_RESTRICT_SECONDS", DEFAULTS.floodRestrictSeconds),
        "SPAM_FLOOD_RESTRICT_SECONDS",
      ),
      maxMessageLength: nonNegative(intFrom(env, "SPAM_MAX_MESSAGE_LENGTH", DEFAULTS.maxMessageLength), "SPAM_MAX_MESSAGE_LENGTH"),
      maxMediaSizeBytes: nonNegative(intFrom(env, "SPAM_MAX_MEDIA_SIZE_BYTES", DEFAULTS.maxMediaSizeBytes), "SPAM_MAX_MEDIA_SIZE_BYTES"),
    },
    ad: {
      enabled: boolFrom(env, "AD_ENABLED", DEFAULTS.adEnabled),
      keywords: stringList(env, "AD_KEYWORDS", DEFAULTS.adKeywords),
      patterns: stringList(env, "AD_PATTERNS"),
      allowKeywords: stringList(env, "AD_ALLOW_KEYWORDS"),
      allowPatterns: stringList(env, "AD_ALLOW_PATTERNS"),
      maxLinks: nonNegative(intFrom(env, "AD_MAX_LINKS", DEFAULTS.adMaxLinks), "AD_MAX_LINKS"),
      autoBlock: boolFrom(env, "AD_AUTO_BLOCK", DEFAULTS.adAutoBlock),
    },
    telegramRetry: {
      retries: nonNegative(intFrom(env, "TELEGRAM_RETRIES", DEFAULTS.telegramRetries), "TELEGRAM_RETRIES"),
      baseBackoffMs: nonNegative(intFrom(env, "TELEGRAM_BASE_BACKOFF_MS", DEFAULTS.telegramBaseBackoffMs), "TELEGRAM_BASE_BACKOFF_MS"),
    },
  };
}
