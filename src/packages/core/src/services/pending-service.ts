// ---------------------------------------------------------------------------
// PendingService (未验证消息暂存队列): while a user is still behind the
// verification/purpose gate, their messages can't be relayed — the gate rejects
// them and asks for proof. Rather than silently dropping what the user wrote,
// the update processor queues those messages here (settings-backed, keyed by
// telegram_user_id) and flushes them in order once the user passes the gate, so
// the pre-gate "hello" reaches the operator after all.
//
// Storage lives in the settings table (no migration): `pending:<userId>` holds
// a JSON array of { messageId, contentType, replyToMessageId }. Entries are
// deduplicated by message id and capped at PENDING_MAX (oldest dropped).
//
// Only the *ordinary* pre-gate message path feeds the queue — ad hits and
// rate/flood-limited messages are rejected earlier and never enqueued. The
// flush therefore does no re-checking: by the time it runs, the user is
// verified/approved (trusted) and the queue only ever held messages that
// passed the ad and spam gates.
// ---------------------------------------------------------------------------

import type { MessageContent, Logger } from "@relaytg/shared";
import type { Database } from "../ports.ts";
import type { ServiceContext } from "./service-context.ts";

export interface PendingEntry {
  messageId: number;
  contentType: MessageContent["type"];
  replyToMessageId: number | null;
}

/** Queue cap per (bot, user); the oldest entry is dropped beyond this. */
export const PENDING_MAX = 50;

const PENDING_KEY = (botId: string, telegramUserId: number): string => `pending:${botId}:${telegramUserId}`;

export class PendingService {
  private readonly db: Database;
  private readonly logger: Logger;

  constructor(ctx: ServiceContext) {
    this.db = ctx.db;
    this.logger = ctx.logger;
  }

  /** Append a message to the (bot, user) pending queue (dedupe by message id,
   *  cap at PENDING_MAX dropping the oldest). The queue is keyed per bot so a
   *  pre-verification message to bot2 is flushed by bot2's conversation — the
   *  bot that received it is the only one that can forward it. */
  async enqueue(botId: string, telegramUserId: number, messageId: number, contentType: MessageContent["type"], replyToMessageId: number | null): Promise<void> {
    const current = await this.list(botId, telegramUserId);
    if (current.some((e) => e.messageId === messageId)) return;
    const next = [...current, { messageId, contentType, replyToMessageId }];
    if (next.length > PENDING_MAX) next.splice(0, next.length - PENDING_MAX);
    await this.db.settings.set(PENDING_KEY(botId, telegramUserId), JSON.stringify(next));
    this.logger.info("message_queued", { telegramUserId, botId, contentType });
  }

  /** Read (without clearing) the pending queue. */
  async list(botId: string, telegramUserId: number): Promise<PendingEntry[]> {
    const raw = await this.db.settings.get(PENDING_KEY(botId, telegramUserId));
    if (raw == null || raw.length === 0) return [];
    try {
      const parsed = JSON.parse(raw) as PendingEntry[];
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((e) => typeof e?.messageId === "number" && typeof e?.contentType === "string");
    } catch {
      return [];
    }
  }

  /** Read and clear the queue, returning what was queued. */
  async drain(botId: string, telegramUserId: number): Promise<PendingEntry[]> {
    const entries = await this.list(botId, telegramUserId);
    if (entries.length > 0) await this.db.settings.set(PENDING_KEY(botId, telegramUserId), "");
    return entries;
  }
}