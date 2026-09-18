// ---------------------------------------------------------------------------
// ConversationService (task 5.2, 5.3): one conversation per user with no
// status lifecycle. last_activity_at feeds the inactivity hide; assignment is
// informational and never gates who may operate. Deletion cascades messages
// and notes in one transaction, then removes the topic best-effort.
// ---------------------------------------------------------------------------

import { TelegramError, type ConversationRecord, type Logger, type UserRecord } from "@relaytg/shared";
import type { Database, Runtime } from "../ports.ts";
import { TOPIC_PIN_KEY } from "../ports.ts";
import type { BotInfo, BotRegistry } from "./bot-registry.ts";
import type { ServiceContext } from "./service-context.ts";
import type { TopicService } from "./topic-service.ts";

export class ConversationService {
  private readonly db: Database;
  private readonly bots: BotRegistry;
  private readonly runtime: Runtime;
  private readonly logger: Logger;
  private readonly topics: TopicService;

  constructor(ctx: ServiceContext, topics: TopicService) {
    this.db = ctx.db;
    this.bots = ctx.bots;
    this.runtime = ctx.runtime;
    this.logger = ctx.logger;
    this.topics = topics;
  }

  getByTelegramUserId(telegramUserId: number): Promise<ConversationRecord | null> {
    return this.db.conversations.getByTelegramUserId(telegramUserId);
  }

  /** The single conversation for a (bot × user) pair. */
  getByBotAndUser(botId: string, telegramUserId: number): Promise<ConversationRecord | null> {
    return this.db.conversations.getByBotAndUser(botId, telegramUserId);
  }

  getByTopicId(telegramTopicId: number): Promise<ConversationRecord | null> {
    return this.db.conversations.getByTopicId(telegramTopicId);
  }

  getById(id: string): Promise<ConversationRecord | null> {
    return this.db.conversations.getById(id);
  }

  /**
   * Reuse the user's conversation with this bot; otherwise create the forum
   * topic and the conversation row bound to `bot`. Two concurrent callers for a
   * brand-new (bot, user) pair are serialized by the per-conversation lock
   * (Docker mutex / DO queue). After the topic is created the row insert is
   * re-checked: a conversation may have appeared since our first read, so the
   * topic is only linked to the winner — the loser's fresh topic is deleted
   * again to avoid a permanently orphaned forum topic.
   *
   * The user-info card is posted for the winner only (never for a topic that is
   * about to be dropped), and can be deferred with `postCard: false` so the
   * caller controls where the card lands — e.g. the first-contact purpose path
   * posts its own single pinned purpose+info card instead.
   */
  async ensureForUser(
    user: UserRecord,
    bot: BotInfo,
    opts: { postCard?: boolean } = {},
  ): Promise<{ conversation: ConversationRecord; created: boolean }> {
    const existing = await this.db.conversations.getByBotAndUser(bot.botId, user.telegramUserId);
    if (existing) return { conversation: existing, created: false };

    const topicId = await this.topics.createTopic(user, { botId: bot.botId });
    const res = await this.db.transaction(async (tx) => {
      const winner = await tx.conversations.getByBotAndUser(bot.botId, user.telegramUserId);
      if (winner) return { conversation: winner, created: false, droppedTopicId: topicId };
      const conversation = await tx.conversations.create(
        {
          botId: bot.botId,
          telegramUserId: user.telegramUserId,
          telegramTopicId: topicId,
          assignedOperatorId: null,
        },
        this.runtime.now(),
      );
      return { conversation, created: true, droppedTopicId: null };
    });

    if (res.droppedTopicId != null) {
      // Lost the create race: another conversation owns the (bot, user) now.
      // Remove the topic we built for nothing; failures here are best-effort.
      await this.topics.deleteTopic(res.droppedTopicId);
      this.logger.info("conversation_lost_race", {
        telegramUserId: user.telegramUserId,
        botId: bot.botId,
        droppedTopicId: res.droppedTopicId,
      });
      return { conversation: res.conversation, created: false };
    }
    // The winner's topic gets its user-info card — unless the caller deferred it
    // (the purpose-gate path posts its own single pinned purpose+info card).
    if (opts.postCard !== false) {
      await this.topics.postIdentityCard(topicId, user, { bot });
    }
    this.logger.info("conversation_created", {
      conversationId: res.conversation.id,
      telegramUserId: user.telegramUserId,
      botId: bot.botId,
      topicId,
    });
    return { conversation: res.conversation, created: true };
  }

  /** Create-or-reuse the conversation bound to `bot`. No welcome message is
   *  sent to the user's private chat — the topic's pinned purpose+info card is
   *  the only opening message the user relates to. */
  async grantAccess(user: UserRecord, bot: BotInfo, opts: { postCard?: boolean } = {}): Promise<ConversationRecord> {
    const { conversation } = await this.ensureForUser(user, bot, opts);
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
      // Deleting a conversation re-locks THAT bot's door: the user must verify
      // again on this bot (and, for a first-timer, still state a purpose)
      // before a new topic opens. Verification is per (bot, user) — the user's
      // OTHER bots' conversations (and verification) are untouched.
      await tx.users.clearVerified(conversation.botId, conversation.telegramUserId);
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
    // Mirror the deletion onto the user's side: every OPERATOR_TO_USER copy
    // this bot delivered into the user's private chat is removed when the topic
    // goes. Deletions older than 48 h (or already gone) are logged and dropped.
    // The retract must go through the conversation's own bot — the copy was
    // delivered by it, and only a bot the user has chatted with can touch it.
    const userSideClient = this.bots.get(conversation.botId).client;
    const userChatDeletes: number[] = [...deliveredCopyIds];
    for (const messageId of userChatDeletes) {
      try {
        await userSideClient.deleteMessage({ chatId: conversation.telegramUserId, messageId });
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
