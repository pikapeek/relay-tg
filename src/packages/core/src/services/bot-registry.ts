// ---------------------------------------------------------------------------
// BotRegistry: the (botId → client + identity) index every core service routes
// per-bot sends through. The support group is shared, but a conversation's
// user-facing side belongs to exactly one bot: a (bot × user) topic's replies
// go out through that bot, and a user's private-chat messages arrive from it.
// The FIRST configured bot is the PRIMARY bot — it owns the support-group
// control surface (every operator command / callback in the group is handled
// only once, by the primary bot's webhook event stream).
// ---------------------------------------------------------------------------

import type { Logger } from "@relaytg/shared";
import type { TelegramClient } from "../ports.ts";

export interface BotEntry {
  botId: string;
  client: TelegramClient;
}

/** A bot with its resolved identity (from getMe at boot, or injected in tests). */
export interface BotInfo extends BotEntry {
  botUsername: string;
  botTelegramUserId: number;
}

/** The identity override injected at boot by the runtimes / tests, keyed by
 *  botId. When provided, the getMe round-trip for that bot is skipped. */
export interface BotIdentity {
  botTelegramUserId: number;
  botUsername: string;
}

export interface BotRegistry {
  /** All bots in BOTS order; the first is the primary. */
  list(): BotInfo[];
  get(botId: string): BotInfo;
  primary(): BotInfo;
  primaryBotId: string;
}

function registryFrom(infos: BotInfo[]): BotRegistry {
  if (infos.length === 0) throw new Error("BotRegistry requires at least one bot");
  const byId = new Map(infos.map((info) => [info.botId, info]));
  const primaryBotId = infos[0]!.botId;
  return {
    list: () => infos,
    get: (botId) => {
      const info = byId.get(botId);
      if (!info) throw new Error(`Unknown bot id: ${botId}`);
      return info;
    },
    primary: () => byId.get(primaryBotId)!,
    primaryBotId,
  };
}

/** Synchronous registry from already-resolved identities — the test harness
 *  path, where fakes carry their identities and no getMe round-trip is wanted. */
export function botRegistryFrom(infos: BotInfo[]): BotRegistry {
  return registryFrom(infos);
}

/** Resolve every bot's identity via getMe. Boot must not fail on a Telegram
 *  hiccup: an unresolvable bot keeps its client but registers with a zero id
 *  and empty username (the /delete bot-guard simply never matches it).
 *  `identities` overrides the probe per bot when provided. */
export async function resolveBots(
  entries: BotEntry[],
  logger: Logger,
  identities?: (botId: string) => BotIdentity | undefined,
): Promise<BotRegistry> {
  const infos: BotInfo[] = [];
  for (const entry of entries) {
    const override = identities?.(entry.botId);
    if (override) {
      infos.push({ ...entry, ...override });
      continue;
    }
    try {
      const me = await entry.client.getMe();
      infos.push({ ...entry, botTelegramUserId: me.id, botUsername: me.username });
    } catch {
      logger.warn("system_error", { errorKind: "bot_identity_unavailable" });
      infos.push({ ...entry, botTelegramUserId: 0, botUsername: "" });
    }
  }
  return registryFrom(infos);
}