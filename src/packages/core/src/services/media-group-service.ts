// ---------------------------------------------------------------------------
// MediaGroupService (album merge). Telegram delivers album items as separate
// updates within a second; this service buffers them per conversation for a
// short window and flushes the whole album into the topic with one
// sendMediaGroup, so operators see a single gallery instead of N forwards.
//
// Each item is still a claimed update — the webhook acks immediately and the
// flush is async, so a flush failure can only be logged (Telegram will not
// retry). The flush re-reads the conversation and re-runs under the same
// per-user serializer as ingestion, so topic recovery / topic-mapping writes
// never race a concurrent message.
// ---------------------------------------------------------------------------

import type { ConversationRecord, Logger, UserMessageEvent } from "@relaytg/shared";
import type { Database, Runtime, Serializer } from "../ports.ts";
import type { ServiceContext } from "./service-context.ts";
import type { Relayer } from "./relayer.ts";

/** How long an album keeps aggregating after its first item arrives. Album
 *  items arrive back-to-back (Telegram delivers them within a second), so a
 *  2 s window merges them while keeping message latency bounded. */
export const MEDIA_GROUP_WINDOW_MS = 2_000;

export class MediaGroupService {
  private readonly db: Database;
  private readonly runtime: Runtime;
  private readonly serializer: Serializer;
  private readonly logger: Logger;
  private readonly relayer: Relayer;
  /** Items still inside the aggregation window, keyed by conversation id. */
  private readonly buffers = new Map<string, UserMessageEvent[]>();
  /** Conversations whose flush is already armed. */
  private readonly scheduled = new Set<string>();

  constructor(ctx: ServiceContext, relayer: Relayer) {
    this.db = ctx.db;
    this.runtime = ctx.runtime;
    this.serializer = ctx.serializer;
    this.logger = ctx.logger;
    this.relayer = relayer;
  }

  /** Buffer one album item; the first item of a conversation arms the window.
   *  The conversation is looked up again at flush time, so a /delete in the
   *  window simply drops the buffer. */
  push(conversation: ConversationRecord, event: UserMessageEvent): void {
    const list = this.buffers.get(conversation.id) ?? [];
    list.push(event);
    this.buffers.set(conversation.id, list);
    if (!this.scheduled.has(conversation.id)) {
      this.scheduled.add(conversation.id);
      this.runtime.schedule(MEDIA_GROUP_WINDOW_MS, () => {
        void this.flush(conversation.id);
      });
    }
  }

  private async flush(conversationId: string): Promise<void> {
    this.scheduled.delete(conversationId);
    const items = this.buffers.get(conversationId);
    this.buffers.delete(conversationId);
    if (!items || items.length === 0) return;

    const conversation = await this.db.conversations.getById(conversationId);
    if (!conversation) return; // conversation deleted mid-album — drop silently

    // Serialize with the same conversation's ingestion so the topic-recovery /
    // topic-mapping writes never race a concurrent message. The updates that
    // buffered these items were already claimed; a failure here is async and
    // only logged (Telegram won't retry them). The key matches ingestion's
    // per-(bot, user) serializer key.
    await this.serializer.runExclusive(`u:${conversation.botId}:${conversation.telegramUserId}`, () => this.deliver(conversation, items));
  }

  private async deliver(conversation: ConversationRecord, items: UserMessageEvent[]): Promise<void> {
    try {
      await this.relayer.relayUserMediaGroup(conversation, items);
    } catch {
      this.logger.error("system_error", { errorKind: "media_group" });
    }
  }
}
