// ---------------------------------------------------------------------------
// Docker runtime wiring (tasks 11.1, 11.3). Assembles the same core services
// the Cloudflare runtime uses, over node:sqlite + node:http. The HTTP surface
// is deliberately tiny: POST /webhook (Telegram ingestion) and GET /health.
// Every outbound side effect goes through the injected TelegramClient, so
// tests swap in the fake and the whole graph stays real.
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { ConsoleLogger, loadConfig, type Config, type EnvSource, type Logger } from "@relaytg/shared";
import type { ProcessResult } from "@relaytg/shared";
import { HttpTelegramClient, parseUpdate } from "@relaytg/telegram";
import { NodeSqliteDb, SqliteDatabase, applyMigrations, loadMigrationsFromDir, MIGRATIONS } from "@relaytg/adapter-sqlite";
import {
  InMemoryVerificationStore,
  KeyedMutexSerializer,
  WallClockRuntime,
  bootServices,
  type CoreServices,
} from "@relaytg/core";
import type { BotEntry, BotRegistry, Database, Runtime, Serializer, TelegramClient, VerificationStore } from "@relaytg/core";

/** Hourly hide sweep cadence (task 11.3). */
export const HIDE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Database path anchoring. This package is usually started through
// `pnpm --filter @relaytg/app-docker start`, which runs the script from the
// workspace package directory — so a *relative* DATABASE_PATH in .env would
// resolve against the wrong cwd and silently split the database in two (the
// "duplicate topics" incident: the new data landed in src/apps/docker/data/
// while the historic one stayed at the repo root). Relative paths resolve
// against the monorepo root (the directory owning pnpm-workspace.yaml), so the
// same .env means the same file regardless of where the script is launched
// from. ":memory:" and absolute paths pass through untouched (tests / Docker).
// ---------------------------------------------------------------------------

const APP_SRC_DIR = dirname(fileURLToPath(import.meta.url));

/** Walk up from a dir until a directory holding pnpm-workspace.yaml; fall back
 *  to the starting dir (standalone checkout without the monorepo marker). */
function findMonorepoRoot(fromDir: string): string {
  let dir = fromDir;
  for (let i = 0; i < 12; i++) {
    if (existsSync(resolve(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return fromDir;
}

/** Monorepo root anchor (repo root when run inside the repo, else app dir). */
export const MONOREPO_ROOT = findMonorepoRoot(APP_SRC_DIR);

/** Absolute SQLite file location for a config databasePath. */
export function resolveDatabasePath(dbPath: string): string {
  if (dbPath === ":memory:") return dbPath;
  if (isAbsolute(dbPath)) return dbPath;
  return resolve(MONOREPO_ROOT, dbPath);
}

/** Webhook body cap. Telegram update payloads are small (media arrive as
 *  file_id references), so a bigger body is a misdirected client or an abuse
 *  attempt — buffering it would pin memory for the request's lifetime. */
export const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

class BodyTooLargeError extends Error {
  constructor() {
    super("payload_too_large");
    this.name = "BodyTooLargeError";
  }
}

export interface AppDeps {
  /** Environment source (process.env at runtime, literal in tests). */
  env: EnvSource;
  /** Override for tests; default logs via ConsoleLogger. */
  logger?: Logger;
  /** Override with the fake for tests; default is the real Bot API client.
   *  This is the PRIMARY bot's client (`config.bots[0]`). */
  telegram?: TelegramClient;
  /** Additional (non-primary) bot clients for tests; each must cover one of the
   *  remaining `config.bots` entries. Defaults to one real client per bot. */
  bots?: BotEntry[];
  runtime?: Runtime;
  serializer?: Serializer;
  verificationStore?: VerificationStore;
  /** SQLite file path; defaults to config.databasePath. Tests use ":memory:". */
  databasePath?: string;
  /** Directory holding migrations/*.sql; defaults to repo migrations. */
  migrations?: string;
  /** Set false to skip migration-on-boot (caller owns schema). */
  migrateOnBoot?: boolean;
}

export interface RelayApp {
  config: Config;
  logger: Logger;
  services: CoreServices;
  db: Database;
  /** Every configured bot, indexed by botId (`primary()` = `config.bots[0]`). */
  bots: BotRegistry;
  /** Run one hide sweep against the given reference time (default: now). */
  sweepHidden(now?: Date): Promise<number>;
  /** Close the HTTP server and the SQLite connection. */
  close(): Promise<void>;
}

/** Wire config, storage, telegram adapter and core services together. */
export async function createApp(deps: AppDeps): Promise<RelayApp> {
  const config = loadConfig(deps.env);
  const logger = deps.logger ?? new ConsoleLogger({ component: "docker" });

  const dbPath = deps.databasePath ?? resolveDatabasePath(config.databasePath);
  mkdirSync(dirname(dbPath), { recursive: true });
  const sql = NodeSqliteDb.open(dbPath);
  if (deps.migrateOnBoot !== false) {
    // Embedded by default (single source of truth in @relaytg/adapter-sqlite,
    // guarded by the drift test); the dir override is kept for tests.
    const migrations = deps.migrations ? loadMigrationsFromDir(deps.migrations) : MIGRATIONS;
    const applied = await applyMigrations(sql, migrations);
    if (applied.length > 0) logger.info("system_start", { status: `migrations:${applied.join(",")}` });
  }
  const db = new SqliteDatabase(sql);

  // One HTTP client per configured bot: `telegram` is the PRIMARY bot
  // (`config.bots[0]`), the rest come from `config.bots` or an explicit inject
  // for tests. The DO/`handleWebhookJson` routing selects the client by the
  // `/webhook/<botId>` path segment.
  const telegram =
    deps.telegram ??
    new HttpTelegramClient({
      botToken: config.bots[0]!.token,
      retries: config.telegramRetry.retries,
      baseBackoffMs: config.telegramRetry.baseBackoffMs,
    });
  const additionalBots =
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
    serializer: deps.serializer ?? new KeyedMutexSerializer(),
  });

  return {
    config,
    logger,
    services,
    db,
    bots: services.bots,
    sweepHidden: (now = new Date()): Promise<number> => services.hides.sweep(now),
    close: async (): Promise<void> => {
      sql.close();
    },
  };
}

/** Process one raw webhook JSON body and return the update id together with
 *  the outcome, for logging. Injectable for tests and kept separate from the
 *  HTTP plumbing. */
export async function handleWebhookJson(
  services: CoreServices,
  body: unknown,
  botId?: string,
): Promise<{ updateId: number; result: ProcessResult }> {
  const update = parseUpdate(body as Parameters<typeof parseUpdate>[0]);
  const result = await services.processor.process(update.updateId, update.event, botId);
  return { updateId: update.updateId, result };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      // Past the cap, drop every further chunk — rejecting lets the handler
      // answer 413 while the connection stays open; destroying the socket
      // instead would race the response and look like a network error to the
      // caller. Memory stays bounded at the cap plus one chunk.
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_WEBHOOK_BODY_BYTES) {
        tooLarge = true;
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!tooLarge) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** Build the HTTP server. Callers own `.listen()`. */
export function createHttpServer(app: RelayApp): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { status: "ok" });
      return;
    }
    if (req.method === "POST" && url.pathname === "/webhook") {
      await handleWebhook(app, req, res);
      return;
    }
    // POST /webhook/<botId> routes the update to a specific configured bot
    // (e.g. the second entry of BOTS). Each bot registers its own webhook URL
    // with the same WEBHOOK_SECRET; the path picks the client, the header
    // authenticates.
    const match = /^\/webhook\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    if (req.method === "POST" && match) {
      const botId = match[1];
      // Unknown bot id → 404 so a misregistered webhook is caught loudly
      // instead of silently landing on the primary bot.
      if (!app.bots.list().some((b) => b.botId === botId)) {
        sendJson(res, 404, { ok: false, error: "unknown_bot" });
        return;
      }
      await handleWebhook(app, req, res, botId);
      return;
    }
    sendJson(res, 404, { ok: false, error: "not_found" });
  });
}

async function handleWebhook(app: RelayApp, req: IncomingMessage, res: ServerResponse, botId?: string): Promise<void> {
  // When WEBHOOK_SECRET is configured, require the token Telegram sends
  // alongside setWebhook's secret_token. Forged updates are the only way
  // in — an unauthenticated endpoint lets anyone impersonate users/operators.
  if (app.config.webhookSecret !== "" && req.headers["x-telegram-bot-api-secret-token"] !== app.config.webhookSecret) {
    sendJson(res, 401, { ok: false, error: "unauthorized" });
    return;
  }
  try {
    const raw = await readBody(req);
    const body = JSON.parse(raw) as unknown;
    const { updateId, result } = await handleWebhookJson(app.services, body, botId);
    app.logger.info("update_processed", { updateId, status: result.status, botId });
    sendJson(res, 200, { ok: true, status: result.status });
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      sendJson(res, 413, { ok: false, error: "payload_too_large" });
      return;
    }
    app.logger.error("system_error", { errorKind: "webhook" });
    sendJson(res, 400, { ok: false, error: "bad_request" });
  }
}