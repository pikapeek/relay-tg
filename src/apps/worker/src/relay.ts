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
  bootServices,
  immediateSerializer,
  type BotEntry,
  type BotRegistry,
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
  /** The PRIMARY bot's client override (config.bots[0]) for tests. */
  telegram?: TelegramClient;
  /** Additional (non-primary) bot clients for tests; covers the remaining
   *  `config.bots` entries. Defaults to one real client per bot. */
  bots?: BotEntry[];
  runtime?: Runtime;
  serializer?: Serializer;
  verificationStore?: VerificationStore;
}

/** The dependency subset the runtime (or a test) may override. */
export type RelayOverrides = Pick<RelayDeps, "logger" | "telegram" | "bots" | "runtime" | "serializer" | "verificationStore">;

export interface Relay {
  config: Config;
  logger: Logger;
  db: Database;
  services: CoreServices;
  /** Every configured bot, indexed by botId (`primary()` = `config.bots[0]`). */
  bots: BotRegistry;
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

  // One HTTP client per configured bot: `telegram` is the PRIMARY bot
  // (`config.bots[0]`), the rest come from `config.bots` or an explicit inject
  // for tests. The DO parses `/webhook/<botId>` and routes through the
  // matching client's event stream.
  const telegram =
    deps.telegram ??
    new HttpTelegramClient({
      botToken: config.bots[0]!.token,
      retries: config.telegramRetry.retries,
      baseBackoffMs: config.telegramRetry.baseBackoffMs,
    });
  const additionalBots: BotEntry[] =
    deps.bots ??
    config.bots.slice(1).map((b) => ({
      botId: b.id,
      client: new HttpTelegramClient({
        botToken: b.token,
        retries: config.telegramRetry.retries,
        baseBackoffMs: config.telegramRetry.baseBackoffMs,
      }),
    }));
  const services = await bootServices({
    config,
    logger,
    db,
    telegram,
    bots: additionalBots,
    runtime: deps.runtime ?? new WallClockRuntime(),
    verificationStore: deps.verificationStore ?? new InMemoryVerificationStore(),
    serializer: deps.serializer ?? immediateSerializer,
    // Boot self-check, logged once per isolate (see the guard above).
    selfCheckGate: () => {
      if (selfChecked) return false;
      selfChecked = true;
      return true;
    },
  });

  return {
    config,
    logger,
    db,
    services,
    bots: services.bots,
    sweepHidden: (now = new Date()): Promise<number> => services.hides.sweep(now),
  };
}