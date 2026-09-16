// ---------------------------------------------------------------------------
// HideService (task 5.6): the inactivity hide and its inverse.
//
// sweep(): find conversations whose last_activity_at is past the global
// auto-hide hard cap (AUTO_HIDE_HOURS, default 168 h = 7 days) — which applies
// to EVERY conversation, permanent-policy ones included — OR past a custom
// /hide N threshold (a sooner cap, only). Close+hide the topic best-effort
// (never delete), then set hidden_at.
//
// restore(): reopen the existing topic, clear hidden_at, and refresh
// last_activity_at — used by /restore, /hide, and the auto-restore that runs
// before relaying a message from a hidden conversation.
// ---------------------------------------------------------------------------

import type { ConversationRecord, Config, Logger } from "@relaytg/shared";
import type { Database, Runtime, TelegramClient } from "../ports.ts";
import type { ServiceContext } from "./service-context.ts";

export class HideService {
  private readonly db: Database;
  private readonly telegram: TelegramClient;
  private readonly runtime: Runtime;
  private readonly config: Config;
  private readonly logger: Logger;

  constructor(ctx: ServiceContext) {
    this.db = ctx.db;
    this.telegram = ctx.telegram;
    this.runtime = ctx.runtime;
    this.config = ctx.config;
    this.logger = ctx.logger;
  }

  /** Hide all due conversations; returns how many were hidden. */
  async sweep(now: Date): Promise<number> {
    const candidates = await this.db.conversations.listStaleHiddenCandidates(now, this.config.autoHideHours);
    let hidden = 0;
    for (const conversation of candidates) {
      if (conversation.telegramTopicId == null) continue;
      if (conversation.hiddenAt != null) continue; // idempotent re-hide skip
      try {
        await this.telegram.hideForumTopic({
          chatId: this.config.supportGroupId,
          messageThreadId: conversation.telegramTopicId,
        });
        await this.db.conversations.setHidden(conversation.id, now.toISOString());
        this.logger.info("conversation_hidden", {
          conversationId: conversation.id,
          telegramUserId: conversation.telegramUserId,
          topicId: conversation.telegramTopicId,
        });
        hidden += 1;
      } catch {
        this.logger.warn("sweep_skip", { conversationId: conversation.id, telegramUserId: conversation.telegramUserId });
      }
    }
    return hidden;
  }

  /**
   * Restore a hidden (or never-hidden) conversation: reopen the topic
   * best-effort, clear the hidden flag, and refresh the activity timer.
   */
  async restore(conversation: ConversationRecord): Promise<void> {
    const now = this.runtime.now();
    if (conversation.telegramTopicId != null) {
      try {
        await this.telegram.restoreForumTopic({
          chatId: this.config.supportGroupId,
          messageThreadId: conversation.telegramTopicId,
        });
        this.logger.info("topic_restored", { conversationId: conversation.id, topicId: conversation.telegramTopicId });
      } catch {
        // Best-effort: a failed reopen is logged; the next relay attempt's
        // topic_closed handling restores again before retrying.
        this.logger.warn("topic_restored", {
          conversationId: conversation.id,
          topicId: conversation.telegramTopicId,
          status: "reopen_failed",
        });
      }
    }
    if (conversation.hiddenAt != null) {
      await this.db.conversations.setHidden(conversation.id, null);
    }
    await this.db.conversations.touchActivity(conversation.id, now);
    this.logger.info("conversation_restored", {
      conversationId: conversation.id,
      telegramUserId: conversation.telegramUserId,
    });
  }
}
