// ---------------------------------------------------------------------------
// ConversationDO (tasks 12.2, 12.3): the single Durable Object that owns the
// SQLite-backed store and processes every update through core. Kept in its own
// module (not the worker entry) so the entry only exports what the Workers
// runtime expects — the DO class and the default handler.
//
// The DO runtime serializes incoming requests, so the per-conversation
// serializer is a no-op on this stack (immediateSerializer, wired in relay.ts).
// ---------------------------------------------------------------------------

import { ConsoleLogger, type EnvSource } from "@relaytg/shared";
import { parseUpdate } from "@relaytg/telegram";
import type { DurableObjectSqlHandle } from "@relaytg/adapter-cloudflare-do";
import { buildRelay, type Relay, type RelayOverrides } from "./relay.ts";

/** Hourly hide sweep cadence (task 12.3), aligned with the Docker runtime. */
export const HIDE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Copy only the string environment bindings out of the runtime env, so the
 *  typed Config loader never sees the DO namespace binding. */
function configEnv(env: Env): EnvSource {
  const out: EnvSource = {};
  for (const key of Object.keys(env)) {
    const value = (env as unknown as Record<string, unknown>)[key];
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

export interface Env {
  BOTS: string;
  GROUP_ID: string;
  ADMIN_IDS?: string;
  OPERATOR_IDS?: string;
  WEBHOOK_SECRET?: string;
  AUTO_HIDE_HOURS?: string;
  VERIFY_ATTEMPTS?: string;
  VERIFY_TTL_SECONDS?: string;
  SPAM_ENABLED?: string;
  SPAM_RATE_LIMIT_MAX?: string;
  SPAM_RATE_LIMIT_WINDOW_SECONDS?: string;
  SPAM_FLOOD_MAX?: string;
  SPAM_FLOOD_WINDOW_SECONDS?: string;
  SPAM_FLOOD_RESTRICT_SECONDS?: string;
  SPAM_MAX_MESSAGE_LENGTH?: string;
  SPAM_MAX_MEDIA_SIZE_BYTES?: string;
  TELEGRAM_RETRIES?: string;
  TELEGRAM_BASE_BACKOFF_MS?: string;
  /** DO binding wired in wrangler.jsonc. */
  CONVERSATION: DurableObjectNamespace;
}

/**
 * The single Durable Object: owns SQLite-backed storage and processes every
 * update through core.
 */
export class ConversationDO {
  private readonly ctx: DurableObjectState;
  private readonly env: Env;
  private readonly overrides: RelayOverrides;
  private readonly logger = new ConsoleLogger({ component: "worker" });
  private relayPromise: Promise<Relay> | null = null;

  constructor(ctx: DurableObjectState, env: Env, overrides: RelayOverrides = {}) {
    this.ctx = ctx;
    this.env = env;
    this.overrides = overrides;
    // Arm the self-scheduled hide sweep (task 12.3) only when none is already
    // pending. A cold start must not reset an in-flight sweep interval — every
    // webhook hit would otherwise push the next hide back by a full hour.
    void this.ctx.storage
      .getAlarm()
      .then((existing) => {
        if (existing == null) return this.ctx.storage.setAlarm(Date.now() + HIDE_SWEEP_INTERVAL_MS);
      })
      .catch(() => {});
  }

  private relay(): Promise<Relay> {
    if (!this.relayPromise) {
      this.relayPromise = buildRelay({
        sql: this.ctx.storage.sql as unknown as DurableObjectSqlHandle,
        env: configEnv(this.env),
        ...this.overrides,
      });
    }
    return this.relayPromise;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json(200, { status: "ok" });
    }
    if (request.method !== "POST") return json(404, { ok: false, error: "not_found" });

    // POST /webhook routes to the primary bot; POST /webhook/<botId> to a
    // specific configured bot (each registers its own webhook URL with the
    // same WEBHOOK_SECRET; the path picks the client, the header authenticates).
    let botId: string | undefined;
    if (url.pathname !== "/webhook") {
      const match = /^\/webhook\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
      if (!match) return json(404, { ok: false, error: "not_found" });
      botId = match[1];
    }

    try {
      const relay = await this.relay();
      // Unknown bot id → 404 so a misregistered webhook is caught loudly
      // instead of silently landing on the primary bot.
      if (botId !== undefined && !relay.bots.list().some((b) => b.botId === botId)) {
        return json(404, { ok: false, error: "unknown_bot" });
      }
      // See the Docker /webhook handler: with WEBHOOK_SECRET configured, reject
      // every request missing the token Telegram pairs with secret_token.
      if (relay.config.webhookSecret !== "" && request.headers.get("x-telegram-bot-api-secret-token") !== relay.config.webhookSecret) {
        return json(401, { ok: false, error: "unauthorized" });
      }
      const update = parseUpdate((await request.json()) as Parameters<typeof parseUpdate>[0]);
      const result = await relay.services.processor.process(update.updateId, update.event, botId);
      relay.logger.info("update_processed", {
        updateId: update.updateId,
        status: result.status,
        conversationId: result.conversationId,
        botId,
      });
      return json(200, { ok: true, status: result.status });
    } catch (err) {
      this.logger.error("system_error", { errorKind: "webhook" });
      return json(400, { ok: false, error: "bad_request" });
    }
  }

  /** Self-scheduled hide sweep: run it, then re-arm one hour out — the re-arm
   *  happens even when the sweep itself throws, so the cadence never dies. The
   *  runtime invokes this with no arguments; the `now` parameter is test-only. */
  async alarm(now: Date = new Date()): Promise<void> {
    const relay = await this.relay();
    try {
      const hidden = await relay.sweepHidden(now);
      if (hidden > 0) relay.logger.info("sweep_hide", { status: `hidden:${hidden}` });
    } catch (err) {
      relay.logger.error("system_error", { errorKind: "sweep" });
    } finally {
      await this.ctx.storage.setAlarm(Date.now() + HIDE_SWEEP_INTERVAL_MS);
    }
  }
}