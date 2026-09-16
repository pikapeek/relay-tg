// ---------------------------------------------------------------------------
// SpamService (task 9): per-user rate limiting (rolling window), flood /
// temporary restriction, message-length cap, and media-size cap. All
// thresholds come from config. State is transient (in-memory) only — a
// temporary restriction never creates a user-level block record.
// ---------------------------------------------------------------------------

import type { MessageContent, SpamConfig } from "@relaytg/shared";

export type SpamCheckResult = "ok" | "rate_limited" | "flood_restricted";
export type ContentCheckResult = "ok" | "too_long" | "too_large";

/** Bounded-state cap: past users who never message again must not accumulate
 *  forever. At the cap, the least recently active entry is evicted. */
const MAX_TRACKED_USERS = 10_000;

export class SpamService {
  private readonly config: SpamConfig;
  private readonly timestamps = new Map<number, number[]>();
  private readonly restrictions = new Map<number, number>();

  constructor(config: SpamConfig) {
    this.config = config;
  }

  /** Per-user rolling-window rate limit + flood restriction. The message is
   * recorded for flood detection even when it is rate-limited. */
  checkAllowed(telegramUserId: number, now: Date): SpamCheckResult {
    if (!this.config.enabled) return "ok";
    const nowMs = now.getTime();

    const until = this.restrictions.get(telegramUserId);
    if (until !== undefined) {
      if (nowMs < until) return "flood_restricted";
      // Expired restrictions clear lazily; there is no separate eviction.
      this.restrictions.delete(telegramUserId);
    }
    this.evictIfNeeded(this.timestamps, telegramUserId, (_, ts) => ts[ts.length - 1] ?? 0);

    const windowMs = this.config.rateLimitWindowSeconds * 1000;
    let recent = this.timestamps.get(telegramUserId) ?? [];
    recent = recent.filter((t) => nowMs - t < windowMs);
    recent.push(nowMs);
    this.timestamps.set(telegramUserId, recent);

    // Flood is the more severe verdict: check it before the rate-limit early
    // return so the restriction is reachable even when rateLimitMax < floodMax
    // (the defaults are 10/60-sliding and 30/60). With the early return first,
    // flood protection would be dead code under any default-like config.
    const floodWindowMs = this.config.floodWindowSeconds * 1000;
    const floodCount = recent.filter((t) => nowMs - t < floodWindowMs).length;
    if (floodCount > this.config.floodMax) {
      this.restrictions.set(telegramUserId, nowMs + this.config.floodRestrictSeconds * 1000);
      return "flood_restricted";
    }

    if (recent.length > this.config.rateLimitMax) return "rate_limited";
    return "ok";
  }

  /** Content-size caps. Disabled anti-spam also lifts the content caps. */
  checkContent(content: MessageContent): ContentCheckResult {
    if (!this.config.enabled) return "ok";
    if (content.type === "text") {
      return content.text.length > this.config.maxMessageLength ? "too_long" : "ok";
    }
    if (content.fileSize != null && content.fileSize > this.config.maxMediaSizeBytes) {
      return "too_large";
    }
    return "ok";
  }

  /** When the map is at its cap and this user isn't tracked yet, drop the least
   *  recently active entry so state stays bounded. Deterministic tie-break:
   *  the smallest user id wins, so behavior is reproducible across runs. */
  private evictIfNeeded<K extends number, V>(
    map: Map<K, V>,
    telegramUserId: K,
    recency: (id: K, value: V) => number,
  ): void {
    if (map.size < MAX_TRACKED_USERS || map.has(telegramUserId)) return;
    let evictKey: K | null = null;
    let leastRecent = Infinity;
    for (const [id, value] of map) {
      const last = recency(id, value);
      if (last < leastRecent || (last === leastRecent && (evictKey == null || id < evictKey))) {
        leastRecent = last;
        evictKey = id;
      }
    }
    if (evictKey != null) map.delete(evictKey);
  }
}
