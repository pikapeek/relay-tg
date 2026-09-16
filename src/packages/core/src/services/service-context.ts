// ---------------------------------------------------------------------------
// The dependency bundle every core service is constructed with. Both runtimes
// build one of these (Docker wiring in apps/docker, Workers wiring in
// apps/worker) and hand it to buildServices(); tests build it with fakes.
// ---------------------------------------------------------------------------

import type { Config, Logger } from "@relaytg/shared";
import type { Database, Runtime, Serializer, TelegramClient, VerificationStore } from "../ports.ts";

export interface ServiceContext {
  db: Database;
  telegram: TelegramClient;
  runtime: Runtime;
  config: Config;
  logger: Logger;
  verificationStore: VerificationStore;
  /** Per-conversation serialization (task 7.5): keyed mutex on Docker, queue-backed on Cloudflare. */
  serializer: Serializer;
  /** The bot's own telegram_user_id, resolved at boot via getMe. Used by /delete
   *  protection to refuse deleting the bot's own conversation; unset when the
   *  boot probe failed (guard simply stays unarmed). */
  botTelegramUserId?: number;
}
