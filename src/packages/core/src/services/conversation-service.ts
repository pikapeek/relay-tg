// ---------------------------------------------------------------------------
// ConversationService (task 5.2, 5.3): one conversation per user with no
// status lifecycle. last_activity_at feeds the inactivity hide; assignment is
// informational and never gates who may operate. Deletion cascades messages
// and notes in one transaction, then removes the topic best-effort.
// ---------------------------------------------------------------------------

import { TelegramError, type ConversationRecord, type Logger, type UserRecord } from "@relaytg/shared";
import type { Database, Runtime, TelegramClient } from "../ports.ts";
import { TOPIC_PIN_KEY } from "../ports.ts";
import type { ServiceContext } from "./service-context.ts";
import type { TopicService } from "./topic-service.ts";

export class ConversationService {
  private readonly db: Database;
  private readonly telegram: TelegramClient;
  private readonly runtime: Runtime;
  private readonly logger: Logger;
  private readonly topics: TopicService;

  constructor(ctx: ServiceContext, topics: TopicService) {
    this.db = ctx.db;
    this.telegram = ctx.telegram;
    this.runtime = ctx.runtime;
    this.logger = ctx.logger;
    this.topics = topics;
  }

  getByTelegramUserId(telegramUserId: number): Promise<ConversationRecord | null> {
    return this.db.conversations.getByTelegramUserId(telegramUserId);
  }

  getByTopicId(telegramTopicId: number): Promise<ConversationRecord | null> {
    return this.db.conversations.getByTopicId(telegramTopicId);
  }

  getById(id: string): Promise<ConversationRecord | null> {
    return this.db.conversations.getById(id);
  }

  /**
   * Reuse the user's existing conversation; otherwise create the forum topic
   * and the conversation row. Two concurrent callers for a brand-new user are
   * serialized by the per-conversation lock (Docker mutex / DO queue). After the
   * topic is created the row insert is re-checked: a conversation may have
   * appeared since our first read, so the topic is only linked to the winner —
   * the loser's fresh topic is deleted again to avoid a permanently orphaned
   * forum topic.
   *
   * The user-info card is posted for the winner only (never for a topic that is
   * about to be dropped), and can be deferred with `postCard: false` so the
   * caller controls where the card lands — e.g. the first-contact purpose path
   * posts its own single pinned purpose+info card instead.
   */
  async ensureForUser(
    user: UserRecord,
    opts: { postCard?: boolean } = {},
  ): Promise<{ conversation: ConversationRecord; created: boolean }> {
    const existing = await this.db.conversations.getByTelegramUserId(user.telegramUserId);
    if (existing) return { conversation: existing, created: false };

    const topicId = await this.topics.createTopic(user);
    const res = await this.db.transaction(async (tx) => {
      const winner = await tx.conversations.getByTelegramUserId(user.telegramUserId);
      if (winner) return { conversation: winner, created: false, droppedTopicId: topicId };
      const conversation = await tx.conversations.create(
        {
          telegramUserId: user.telegramUserId,
          telegramTopicId: topicId,
          assignedOperatorId: null,
        },
        this.runtime.now(),
      );
      return { conversation, created: true, droppedTopicId: null };
    });

    if (res.droppedTopicId != null) {
      // Lost the create race: another conversation owns the user now. Remove the
      // topic we built for nothing; failures here are best-effort.
      await this.topics.deleteTopic(res.droppedTopicId);
      this.logger.info("conversation_lost_race", {
        telegramUserId: user.telegramUserId,
        droppedTopicId: res.droppedTopicId,
      });
      return { conversation: res.conversation, created: false };
    }
    // The winner's topic gets its user-info card — unless the caller deferred it
    // (the purpose-gate path posts its own single pinned purpose+info card).
    if (opts.postCard !== false) {
      await this.topics.postIdentityCard(topicId, user);
    }
    this.logger.info("conversation_created", {
      conversationId: res.conversation.id,
      telegramUserId: user.telegramUserId,
      topicId,
    });
    return { conversation: res.conversation, created: true };
  }

  /** Create-or-reuse the conversation. No welcome message is sent to the
   *  user's private chat — the topic's pinned purpose+info card is the only
   *  opening message the user relates to. */
  async grantAccess(user: UserRecord, opts: { postCard?: boolean } = {}): Promise<ConversationRecord> {
    const { conversation } = await this.ensureForUser(user, opts);
    return conversation;
  }

  async touchActivity(conversationId: string): Promise<void> {
    await this.db.conversations.touchActivity(conversationId, this.runtime.now());
  }

  async setAssignedOperatorId(conversationId: string, operatorId: string | null): Promise<void> {
    await this.db.conversations.setAssignedOperatorId(conversationId, operatorId);
  }

  async setHideAfterHours(conversationId: string, hideAfterHours: number | null): Promise<void> {
    await this.db.conversations.setHideAfterHours(conversationId, hideAfterHours);
  }

  /**
   * Cascade-delete the conversation's messages and notes in one transaction,
   * remove the conversation row, reset the user's access (so the next contact
   * requires verification again), then remove the topic best-effort. Finally
   * delete the bot-delivered copies from the user's private chat — best-effort,
   * since the Bot API only allows deleting bot-owned messages younger than 48 h.
   */
  async deleteConversation(conversation: ConversationRecord): Promise<void> {
    // Read the delivered user-chat copies before the cascade removes the rows.
    const deliveredCopyIds = await this.db.messages.listUserChatCopyIds(conversation.id);
    await this.db.transaction(async (tx) => {
      await tx.messages.deleteByConversationId(conversation.id);
      await tx.notes.deleteByConversationId(conversation.id);
      await tx.conversations.delete(conversation.id);
      // Deleting a conversation re-locks the door: the user must verify again
      // (and, for a first-timer, still state a purpose) before a new topic opens.
      await tx.users.resetAccess(conversation.telegramUserId);
      // The topic is gone, so its stored first-pin protection goes with it — a
      // recreated conversation pins and protects a fresh card.
      await tx.settings.set(TOPIC_PIN_KEY(conversation.id), "");
    });
    this.logger.info("conversation_deleted", {
      conversationId: conversation.id,
      telegramUserId: conversation.telegramUserId,
    });
    this.logger.info("user_access_reset", { telegramUserId: conversation.telegramUserId });
    if (conversation.telegramTopicId != null) {
      await this.topics.deleteTopic(conversation.telegramTopicId);
    }
    // Mirror the deletion onto the user's side: every OPERATOR_TO_USER copy the
    // bot delivered into the user's private chat is removed when the topic
    // goes. Deletions older than 48 h (or already gone) are logged and dropped.
    const userChatDeletes: number[] = [...deliveredCopyIds];
    for (const messageId of userChatDeletes) {
      try {
        await this.telegram.deleteMessage({ chatId: conversation.telegramUserId, messageId });
      } catch (err) {
        this.logger.warn("copy_delete_failed", {
          conversationId: conversation.id,
          telegramUserId: conversation.telegramUserId,
          status: "best_effort",
          errorKind: err instanceof TelegramError ? err.kind : "unknown",
        });
      }
    }
  }
}
