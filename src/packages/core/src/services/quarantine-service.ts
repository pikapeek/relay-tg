// ---------------------------------------------------------------------------
// QuarantineService (垃圾隔离): ad-text hits are no longer dropped into the void
// — the message is silently forwarded into a dedicated "spam quarantine" topic
// so an admin can review it and restore a false positive. The notification
// lives inside that topic too, keeping the group's general chat clean.
//
// An admin replies to a quarantined copy with `/ad restore`: the message is
// forwarded into the sender's conversation topic and recorded as a
// USER_TO_OPERATOR relay row. Restoring never unblocks — unblocking stays a
// separate `/unban`, done after the false positive is inspected.
//
// Hardening: any failure while building the quarantine topic, forwarding, or
// notifying falls back to the old behavior (a notification in the group's
// general chat) and never throws out of the ad hot path.
// ---------------------------------------------------------------------------

import { ConversationError, type Logger, type MessageContent, type UserProfile } from "@relaytg/shared";
import type { Config, ConversationRecord } from "@relaytg/shared";
import type { Database, Runtime, TelegramClient } from "../ports.ts";
import { OPERATOR_TEXTS } from "./texts.ts";
import type { ServiceContext } from "./service-context.ts";

/** The quarantined copy's id plus enough to restore/record it. `fwdId` is the
 *  copy's message id inside the quarantine topic — the mapping key and the
 *  restore source. */
export interface QuarantinedMessage {
  fwdId: number;
  userId: number;
  chatId: number;
  messageId: number;
  contentType: MessageContent["type"];
}

export interface QuarantineEntry {
  sender: UserProfile;
  chatId: number;
  messageId: number;
  content: MessageContent;
  /** The keyword/pattern/link-rule that triggered the hit. */
  reason: string;
  /** An excerpt of the offending text for the operator notification. */
  excerpt: string;
}

const SPAM_TOPIC_KEY = "spam_topic_id";
const SPAM_TOPIC_NAME = "🚮 Spam quarantine (垃圾隔离)";
const SPAM_Q_KEY = (fwdId: number): string => `spam_q:${fwdId}`;

export class QuarantineService {
  private readonly db: Database;
  private readonly telegram: TelegramClient;
  private readonly runtime: Runtime;
  private readonly config: Config;
  private readonly logger: Logger;
  /** In-memory memo of the quarantine topic id; the settings row is the source
   *  of truth across restarts. */
  private topicId: number | null = null;

  constructor(ctx: ServiceContext) {
    this.db = ctx.db;
    this.telegram = ctx.telegram;
    this.runtime = ctx.runtime;
    this.config = ctx.config;
    this.logger = ctx.logger;
  }

  /** The quarantine topic, created lazily on first hit and persisted. */
  async ensureTopic(): Promise<number> {
    if (this.topicId != null) return this.topicId;
    const stored = await this.db.settings.get(SPAM_TOPIC_KEY);
    if (stored != null) {
      const parsed = Number(stored);
      if (Number.isInteger(parsed) && parsed > 0) {
        this.topicId = parsed;
        return parsed;
      }
    }
    const topicId = await this.telegram.createForumTopic({ chatId: this.config.supportGroupId, name: SPAM_TOPIC_NAME });
    await this.db.settings.set(SPAM_TOPIC_KEY, String(topicId));
    this.topicId = topicId;
    this.logger.info("topic_created", { topicId, status: "quarantine" });
    return topicId;
  }

  /** Quarantine an ad hit: forward the message into the quarantine topic, map
   *  the copy, notify inside the topic. On any failure, fall back to the old
   *  group-general-chat notification — an admin must never be left blind. This
   *  method never throws. */
  async quarantine(entry: QuarantineEntry): Promise<void> {
    const name = entry.sender.firstName ?? entry.sender.username ?? String(entry.sender.telegramUserId);
    const text = OPERATOR_TEXTS("en").adAutoBlocked(name, entry.sender.username, entry.sender.telegramUserId, entry.reason, entry.excerpt);
    try {
      const topicId = await this.ensureTopic();
      const fwdId = await this.telegram.forwardMessage({
        chatId: this.config.supportGroupId,
        messageThreadId: topicId,
        fromChatId: entry.chatId,
        messageId: entry.messageId,
      });
      const record: QuarantinedMessage = {
        fwdId,
        userId: entry.sender.telegramUserId,
        chatId: entry.chatId,
        messageId: entry.messageId,
        contentType: entry.content.type,
      };
      await this.db.settings.set(SPAM_Q_KEY(fwdId), JSON.stringify(record));
      // The notice lives inside the quarantine topic; on a failure below it is
      // resent in the group's general chat so an admin is never left blind.
      await this.telegram.sendMessage({ chatId: this.config.supportGroupId, messageThreadId: topicId, text });
      this.logger.info("ad_quarantined", { telegramUserId: entry.sender.telegramUserId, topicId, reason: entry.reason });
      return;
    } catch (err) {
      this.logger.warn("ad_quarantined", {
        telegramUserId: entry.sender.telegramUserId,
        status: "fallback_group_notify",
        reason: entry.reason,
      });
    }
    try {
      await this.telegram.sendMessage({ chatId: this.config.supportGroupId, text });
    } catch {
      this.logger.warn("ad_quarantined", { telegramUserId: entry.sender.telegramUserId, status: "notify_failed", reason: entry.reason });
    }
  }

  /** Look up a quarantined copy's mapping by its message id, or null when it
   *  was never quarantined (or already restored). */
  async lookup(fwdId: number): Promise<QuarantinedMessage | null> {
    const raw = await this.db.settings.get(SPAM_Q_KEY(fwdId));
    if (raw == null || raw.length === 0) return null;
    try {
      const parsed = JSON.parse(raw) as QuarantinedMessage;
      if (
        typeof parsed?.fwdId !== "number" ||
        typeof parsed?.userId !== "number" ||
        typeof parsed?.chatId !== "number" ||
        typeof parsed?.messageId !== "number" ||
        parsed.fwdId !== fwdId
      ) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  /** Restore a quarantined message into the user's conversation topic: forward
   *  the quarantine-topic copy into the topic, record it as a USER_TO_OPERATOR
   *  relay row, and clear the mapping so a second restore is refused. Returns
   *  the new topic-copy message id. Does NOT unblock — the notification still
   *  carries the `/unban` hint. */
  async restore(entry: QuarantinedMessage, conversation: ConversationRecord): Promise<number> {
    const topicId = conversation.telegramTopicId;
    if (topicId == null) throw new ConversationError("conversation has no topic", "no_topic");
    // The quarantine copy lives in the support group; forwarding it into the
    // user's topic keeps the sender's name/avatar attribution like any other
    // user→operator relay.
    const relayedId = await this.telegram.forwardMessage({
      chatId: this.config.supportGroupId,
      messageThreadId: topicId,
      fromChatId: this.config.supportGroupId,
      messageId: entry.fwdId,
    });
    await this.db.messages.create(
      {
        conversationId: conversation.id,
        telegramChatId: entry.chatId,
        telegramMessageId: entry.messageId,
        telegramTopicId: topicId,
        relayedMessageId: relayedId,
        direction: "USER_TO_OPERATOR",
        senderType: "USER",
        contentType: entry.contentType,
        replyToMessageId: null,
      },
      this.runtime.now(),
    );
    await this.db.conversations.touchActivity(conversation.id, this.runtime.now());
    await this.db.settings.set(SPAM_Q_KEY(entry.fwdId), "");
    this.logger.info("quarantine_restored", { conversationId: conversation.id, telegramUserId: entry.userId, topicId });
    return relayedId;
  }
}