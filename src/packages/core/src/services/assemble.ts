// ---------------------------------------------------------------------------
// bootServices: the boot assembly both runtimes share. Every runtime goes:
// config → storage → telegram → buildServices → seed → command menus → boot
// self-check. Docker (apps/docker) and Cloudflare (apps/worker) used to each
// reproduce this ~50-line block; it lives here so the two can't drift.
//
// The only runtime differences — which Database/Serializer/VerificationStore
// to use and whether the self-check may fire (Workers once per isolate) — are
// passed in. Boot must never fail on a Telegram hiccup: a failed getMe probe
// or remote menu/self-check call only logs.
// ---------------------------------------------------------------------------

import type { Config, Logger } from "@relaytg/shared";
import type { Database, Runtime, Serializer, TelegramClient, VerificationStore } from "../ports.ts";
import { resolveBots, type BotEntry, type BotIdentity, type BotRegistry } from "./bot-registry.ts";
import { buildServices, type CoreServices } from "./index.ts";
import { setCommandMenu, syncPreferredLanguageMenus } from "./command-menu.ts";

export interface BootServicesOptions {
  config: Config;
  logger: Logger;
  db: Database;
  /** The PRIMARY bot's client — `config.bots[0]`. The support-group control
   *  surface (operator commands, self-check) goes through it. */
  telegram: TelegramClient;
  /** Every other configured bot, one client per `bots` entry. Together with
   *  `telegram` these must cover every `config.bots` id, primaries first. */
  bots?: BotEntry[];
  runtime: Runtime;
  serializer: Serializer;
  verificationStore: VerificationStore;
  /** Per-bot identity override, keyed by botId: skips that bot's getMe probe.
   *  Tests inject identities so no round-trip is recorded. */
  botIdentities?: (botId: string) => BotIdentity | undefined;
  /** Legacy pre-registry override for the primary bot's id (tests). When both
   *  this and `botIdentities` are set, `botIdentities` wins. */
  botTelegramUserId?: number;
  /** Gate the fire-and-forget boot self-check. Workers pass a once-per-isolate
   *  guard; Docker leaves it unset (runs on every boot). */
  selfCheckGate?: () => boolean;
}

/** Wire every core service, seed operators, install the command menus and
 *  fire the boot config self-check. Returns the assembled services plus the
 *  resolved bot registry (`bots`), so runtimes can route `/webhook/<botId>`
 *  to the right client and expose primary/`get` lookups. */
export async function bootServices(o: BootServicesOptions): Promise<CoreServices & { bots: BotRegistry }> {
  // Every entry, primary first: `telegram` (config.bots[0]) plus the injected
  // additional bots. Boot must not fail on a Telegram hiccup — an unresolvable
  // bot keeps its client with a zero identity (the /delete bot-guard simply
  // never matches it).
  const entries: BotEntry[] = [{ botId: o.config.bots[0]!.id, client: o.telegram }, ...(o.bots ?? [])];
  const bots: BotRegistry = await resolveBots(entries, o.logger, (botId) => {
    const override = o.botIdentities?.(botId);
    if (override) return override;
    if (botId === o.config.bots[0]!.id && o.botTelegramUserId !== undefined) {
      return { botTelegramUserId: o.botTelegramUserId, botUsername: "" };
    }
    return undefined;
  });
  // Primary id as the numeric /delete guard (0 = unknown → guard unarmed).
  const botTelegramUserId = bots.primary().botTelegramUserId || undefined;

  const services = buildServices({
    db: o.db,
    telegram: o.telegram,
    bots,
    runtime: o.runtime,
    config: o.config,
    logger: o.logger,
    verificationStore: o.verificationStore,
    serializer: o.serializer,
    botTelegramUserId,
  });
  await services.operators.seed();
  // Register the Telegram command menu per bot (the menus are per-bot state):
  // /start in every private chat, plus per-person admin/operator menus in the
  // support group from the operator registry. Each scope is guarded internally,
  // so a Telegram hiccup at boot never blocks the runtime from starting.
  for (const bot of bots.list()) {
    await setCommandMenu(bot.client, o.config, o.logger, () => services.operators.list());
    // Re-apply any persisted `/lang` preferences so a user who chose 简体中文
    // keeps the Chinese suggestion menu across restarts (Workers: across cold
    // isolates).
    await syncPreferredLanguageMenus(o.db, bot.client, o.config, o.logger, () => services.operators.list());
  }

  // Boot config self-check: verify the token resolves to a bot, the support
  // group is a forum, and the bot is an admin there — then log the verdict.
  // Fire-and-forget: a misconfigured deployment must never block the runtime
  // from starting. selfCheckGate lets the Worker run this once per isolate.
  if (o.selfCheckGate?.() ?? true) {
    void services.selfCheck
      .run()
      .then((report) => o.logger.info("selfcheck", { status: report.allOk ? "ok" : "failed" }))
      .catch(() => {});
  }

  return { ...services, bots };
}