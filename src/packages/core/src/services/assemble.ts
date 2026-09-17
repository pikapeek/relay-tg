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
import { buildServices, type CoreServices } from "./index.ts";
import { setCommandMenu, syncPreferredLanguageMenus } from "./command-menu.ts";

export interface BootServicesOptions {
  config: Config;
  logger: Logger;
  db: Database;
  telegram: TelegramClient;
  runtime: Runtime;
  serializer: Serializer;
  verificationStore: VerificationStore;
  /** When set, skip the getMe identity probe (tests inject it). When unset the
   *  probe runs and its failure only logs — the /delete bot-guard stays unarmed. */
  botTelegramUserId?: number;
  /** Gate the fire-and-forget boot self-check. Workers pass a once-per-isolate
   *  guard; Docker leaves it unset (runs on every boot). */
  selfCheckGate?: () => boolean;
}

/** Wire every core service, seed operators, install the command menus and
 *  fire the boot config self-check. Returns the assembled services. */
export async function bootServices(o: BootServicesOptions): Promise<CoreServices> {
  // Resolve the bot's own identity once so /delete can refuse the bot's own
  // conversation alongside the requester's and staff's. Boot must not fail on
  // a Telegram hiccup — a failed probe just leaves that guard unarmed.
  let botTelegramUserId = o.botTelegramUserId;
  if (botTelegramUserId === undefined) {
    try {
      botTelegramUserId = (await o.telegram.getMe()).id;
    } catch {
      o.logger.warn("system_error", { errorKind: "bot_identity_unavailable" });
    }
  }

  const services = buildServices({
    db: o.db,
    telegram: o.telegram,
    runtime: o.runtime,
    config: o.config,
    logger: o.logger,
    verificationStore: o.verificationStore,
    serializer: o.serializer,
    botTelegramUserId,
  });
  await services.operators.seed();
  // Register the Telegram command menu: /start in every private chat, plus
  // per-person admin/operator menus in the support group from the operator
  // registry. Each scope is guarded internally, so a Telegram hiccup at boot
  // never blocks the runtime from starting.
  await setCommandMenu(o.telegram, o.config, o.logger, () => services.operators.list());
  // Re-apply any persisted `/lang` preferences so a user who chose 简体中文
  // keeps the Chinese suggestion menu across restarts (Workers: across cold
  // isolates).
  await syncPreferredLanguageMenus(o.db, o.telegram, o.config, o.logger, () => services.operators.list());

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

  return services;
}