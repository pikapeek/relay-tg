// ---------------------------------------------------------------------------
// Cloudflare relay builder (task 12.2). Assembles the SAME core services the
// Docker runtime uses, over the Durable Object SQLite-backed storage via the
// cloudflare-do adapter. Migration SQL is embedded as `?raw` strings (never
// read from disk on Workers); the per-conversation serializer is a no-op here
// because the DO queue already delivers requests serially per instance.
// Exported separately from index.ts so tests can drive it with a fake sql
// handle without touching workers runtime globals.
// ---------------------------------------------------------------------------

import { ConsoleLogger, loadConfig, type Config, type EnvSource, type Logger } from "@relaytg/shared";
import { HttpTelegramClient } from "@relaytg/telegram";
import { DurableObjectSqlDb, type DurableObjectSqlHandle } from "@relaytg/adapter-cloudflare-do";
import { applyMigrations } from "@relaytg/adapter-sqlite/migrate";
import { SqliteDatabase } from "@relaytg/adapter-sqlite/repository";
import {
  InMemoryVerificationStore,
  WallClockRuntime,
  buildServices,
  immediateSerializer,
  setCommandMenu,
  syncPreferredLanguageMenus,
  type CoreServices,
} from "@relaytg/core";
import type { Database, Runtime, Serializer, TelegramClient, VerificationStore } from "@relaytg/core";

import { MIGRATIONS } from "./migrations.ts";

/** Run the boot self-check once per isolate: buildRelay is lazy per Durable
 *  Object, so without this guard every conversation's cold start would fire a
 *  second batch of getMe/getChat/getChatMember calls. */
let selfChecked = false;

export interface RelayDeps {
  /** SQLite-backed DO storage handle (ctx.storage.sql at runtime, fake in tests). */
  sql: DurableObjectSqlHandle;
  /** Worker environment (config keys only; CONVERSATION binding stripped). */
  env: EnvSource;
  logger?: Logger;
  telegram?: TelegramClient;
  runtime?: Runtime;
  serializer?: Serializer;
  verificationStore?: VerificationStore;
}

/** The dependency subset the runtime (or a test) may override. */
export type RelayOverrides = Pick<RelayDeps, "logger" | "telegram" | "runtime" | "serializer" | "verificationStore">;

export interface Relay {
  config: Config;
  logger: Logger;
  db: Database;
  services: CoreServices;
  /** Run one hide sweep against the given reference time (default: now). */
  sweepHidden(now?: Date): Promise<number>;
}

/** Wire config, storage, telegram adapter and core services together. */
export async function buildRelay(deps: RelayDeps): Promise<Relay> {
  const config = loadConfig(deps.env);
  const logger = deps.logger ?? new ConsoleLogger({ component: "worker" });

  const sql = new DurableObjectSqlDb(deps.sql);
  const applied = await applyMigrations(sql, MIGRATIONS);
  if (applied.length > 0) logger.info("system_start", { status: `migrations:${applied.join(",")}` });
  const db = new SqliteDatabase(sql);

  const telegram =
    deps.telegram ??
    new HttpTelegramClient({
      botToken: config.botToken,
      retries: config.telegramRetry.retries,
      baseBackoffMs: config.telegramRetry.baseBackoffMs,
    });
  // Resolve the bot's own identity once so /delete can refuse the bot's own
  // conversation alongside the requester's and staff's. Boot must not fail on
  // a Telegram hiccup — a failed probe just leaves that guard unarmed.
  let botTelegramUserId: number | undefined;
  try {
    botTelegramUserId = (await telegram.getMe()).id;
  } catch {
    logger.warn("system_error", { errorKind: "bot_identity_unavailable" });
  }
  const services = buildServices({
    db,
    telegram,
    runtime: deps.runtime ?? new WallClockRuntime(),
    config,
    logger,
    verificationStore: deps.verificationStore ?? new InMemoryVerificationStore(),
    serializer: deps.serializer ?? immediateSerializer,
    botTelegramUserId,
  });
  await services.operators.seed();
  // Register the Telegram command menu: /start in every private chat, plus
  // per-person admin/operator menus in the support group from the operator
  // registry. Each scope is guarded internally, so a Telegram hiccup never
  // fails the relay build.
  await setCommandMenu(telegram, config, logger, () => services.operators.list());
  // Re-apply any persisted `/lang` preferences so the suggestion menu follows
  // the stored preference even when the Telegram client language differs.
  await syncPreferredLanguageMenus(db, telegram, config, logger, () => services.operators.list());

  // Boot config self-check, logged once per isolate (see the guard above).
  if (!selfChecked) {
    selfChecked = true;
    void services.selfCheck
      .run()
      .then((report) => logger.info("selfcheck", { status: report.allOk ? "ok" : "failed" }))
      .catch(() => {});
  }

  return {
    config,
    logger,
    db,
    services,
    sweepHidden: (now = new Date()): Promise<number> => services.hides.sweep(now),
  };
}