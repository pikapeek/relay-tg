// ---------------------------------------------------------------------------
// Docker runtime wiring (tasks 11.1, 11.3). Assembles the same core services
// the Cloudflare runtime uses, over node:sqlite + node:http. The HTTP surface
// is deliberately tiny: POST /webhook (Telegram ingestion) and GET /health.
// Every outbound side effect goes through the injected TelegramClient, so
// tests swap in the fake and the whole graph stays real.
// ---------------------------------------------------------------------------

import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { ConsoleLogger, loadConfig, type Config, type EnvSource, type Logger } from "@relaytg/shared";
import type { ProcessResult } from "@relaytg/shared";
import { HttpTelegramClient, parseUpdate } from "@relaytg/telegram";
import { NodeSqliteDb, SqliteDatabase, applyMigrations, loadMigrationsFromDir } from "@relaytg/adapter-sqlite";
import {
  InMemoryVerificationStore,
  KeyedMutexSerializer,
  WallClockRuntime,
  buildServices,
  setCommandMenu,
  syncPreferredLanguageMenus,
  type CoreServices,
} from "@relaytg/core";
import type { Database, Runtime, Serializer, TelegramClient, VerificationStore } from "@relaytg/core";

/** Repo migrations directory, resolved relative to this source file so the
 *  path holds both in the working tree and inside the Docker image. */
const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "migrations");

/** Hourly hide sweep cadence (task 11.3). */
export const HIDE_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

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
  /** Override with the fake for tests; default is the real Bot API client. */
  telegram?: TelegramClient;
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
  /** Run one hide sweep against the given reference time (default: now). */
  sweepHidden(now?: Date): Promise<number>;
  /** Close the HTTP server and the SQLite connection. */
  close(): Promise<void>;
}

/** Wire config, storage, telegram adapter and core services together. */
export async function createApp(deps: AppDeps): Promise<RelayApp> {
  const config = loadConfig(deps.env);
  const logger = deps.logger ?? new ConsoleLogger({ component: "docker" });

  const dbPath = deps.databasePath ?? config.databasePath;
  mkdirSync(dirname(dbPath), { recursive: true });
  const sql = NodeSqliteDb.open(dbPath);
  if (deps.migrateOnBoot !== false) {
    const applied = await applyMigrations(sql, loadMigrationsFromDir(deps.migrations ?? migrationsDir));
    if (applied.length > 0) logger.info("system_start", { status: `migrations:${applied.join(",")}` });
  }
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
    serializer: deps.serializer ?? new KeyedMutexSerializer(),
    botTelegramUserId,
  });
  await services.operators.seed();
  // Register the Telegram command menu: /start in every private chat, plus
  // per-person admin/operator menus in the support group from the operator
  // registry. Each scope is guarded internally, so a Telegram hiccup at boot
  // never blocks the webhook server.
  await setCommandMenu(telegram, config, logger, () => services.operators.list());
  // Re-apply any persisted `/lang` preferences so a user who chose 简体中文
  // keeps the Chinese suggestion menu across restarts.
  await syncPreferredLanguageMenus(db, telegram, config, logger, () => services.operators.list());

  // Boot config self-check: verify the token resolves to a bot, the support
  // group is a forum, and the bot is an admin there — then log the verdict.
  // Fire-and-forget: a misconfigured deployment must never block the webhook
  // server from starting.
  void services.selfCheck
    .run()
    .then((report) => logger.info("selfcheck", { status: report.allOk ? "ok" : "failed" }))
    .catch(() => {});

  return {
    config,
    logger,
    services,
    db,
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
): Promise<{ updateId: number; result: ProcessResult }> {
  const update = parseUpdate(body as Parameters<typeof parseUpdate>[0]);
  const result = await services.processor.process(update.updateId, update.event);
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
        const { updateId, result } = await handleWebhookJson(app.services, body);
        app.logger.info("update_processed", { updateId, status: result.status });
        sendJson(res, 200, { ok: true, status: result.status });
      } catch (err) {
        if (err instanceof BodyTooLargeError) {
          sendJson(res, 413, { ok: false, error: "payload_too_large" });
          return;
        }
        app.logger.error("system_error", { errorKind: "webhook" });
        sendJson(res, 400, { ok: false, error: "bad_request" });
      }
      return;
    }
    sendJson(res, 404, { ok: false, error: "not_found" });
  });
}