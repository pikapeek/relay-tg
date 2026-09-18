// ---------------------------------------------------------------------------
// Relayer (task 6.3-6.6): the outbound half of the pipeline. Relays each
// inbound message across with a per-message record (source + relayed-copy id),
// preserves replies when resolvable (degrading gracefully), recovers deleted
// topics (recreate + retry once) and closed topics (restore + retry once), and
// relays message edits to the delivered copy.
//
// User → operator messages are *forwarded* verbatim into the user's topic, so
// the copy shows the sender's real name and avatar through Telegram's own
// forward attribution. Identity lives in the personal info card that
// TopicService posts at the top of every new topic (photo card when the sender
// has a profile photo, else a text card, both with a tap-through profile
// button); for a first-time contact that single card carries the user's stated
// purpose (来意) as its first line and is pinned — the purpose is NOT forwarded
// into the topic separately. A forwarded copy can't be edited, so user message
// edits are dropped; operator → user copies are re-sent into the user's private
// chat and stay editable.
// ---------------------------------------------------------------------------

import {
  isTopicClosed,
  isTopicNotFound,
  ConversationError,
  TelegramError,
  type ConversationRecord,
  type Config,
  type EditedOperatorMessageEvent,
  type EditedUserMessageEvent,
  type Logger,
  type MessageContent,
  type OperatorMessageEvent,
  type UserMessageEvent,
} from "@relaytg/shared";
import type { Database, Runtime, SendTarget, TelegramClient } from "../ports.ts";
import type { BotInfo, BotRegistry } from "./bot-registry.ts";
import type { ServiceContext } from "./service-context.ts";
import type { ConversationService } from "./conversation-service.ts";
import type { MessageService } from "./message-service.ts";
import type { PendingEntry } from "./pending-service.ts";
import type { TopicService } from "./topic-service.ts";
import type { UserService } from "./user-service.ts";

export interface RelayerDeps {
  users: UserService;
  topics: TopicService;
  conversations: ConversationService;
}

interface SendWithRecoveryResult<T> {
  relayedId: T;
  topicId: number;
}

export class Relayer {
  private readonly db: Database;
  private readonly telegram: TelegramClient;
  private readonly bots: BotRegistry;
  private readonly runtime: Runtime;
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly messages: MessageService;
  private readonly deps: RelayerDeps;

  constructor(ctx: ServiceContext, deps: RelayerDeps, messages: MessageService) {
    this.db = ctx.db;
    this.telegram = ctx.telegram;
    this.bots = ctx.bots;
    this.runtime = ctx.runtime;
    this.config = ctx.config;
    this.logger = ctx.logger;
    this.deps = deps;
    this.messages = messages;
  }

  /** The client of the bot a conversation is bound to — every user-side send
   *  (forward from their private chat, deliver to it, edit/delete the copy,
   *  avatar fetch) goes through this bot, never the primary. */
  private botFor(conversation: ConversationRecord): BotInfo {
    return this.bots.get(conversation.botId);
  }

  /** User → operator: forward the user's message into their topic and record
   *  only on success. Returns the topic-copy message id. (The first-contact
   *  purpose statement is NOT forwarded here — it lives on the single pinned
   *  purpose+info card UpdateProcessor.recordPurposeAndOpen posts.) */
  async relayUserToOperator(conversation: ConversationRecord, event: UserMessageEvent): Promise<number> {
    const topicId = conversation.telegramTopicId;
    if (topicId == null) throw new ConversationError("conversation has no topic", "no_topic");
    return this.relayForward(conversation, {
      fromChatId: event.chatId,
      messageId: event.messageId,
      contentType: event.content.type,
      replyToMessageId: event.replyToMessageId,
    });
  }

  /** User → operator album: merge buffered media-group items into one album in
   *  the user's topic via sendMediaGroup. Degrades to the individual-forward
   *  path when the album holds a single item (Bot API needs 2–10) or any item
   *  isn't album-able (voice/sticker/text). Chunks above the Bot API cap; the
   *  conversation is re-read after each chunk so a topic recovery mid-album
   *  makes the next chunk target the fresh topic, not the stale deleted one. */
  async relayUserMediaGroup(conversation: ConversationRecord, events: UserMessageEvent[]): Promise<void> {
    if (conversation.telegramTopicId == null) throw new ConversationError("conversation has no topic", "no_topic");
    if (events.length === 1) {
      await this.relayUserToOperator(conversation, events[0]);
      return;
    }
    if (!events.every((e) => isAlbumable(e.content))) {
      for (const event of events) await this.relayUserToOperator(conversation, event);
      return;
    }

    let current = conversation;
    for (const chunk of chunkItems(events, MEDIA_GROUP_MAX_ITEMS)) {
      // A trailing chunk below the 2-item Bot API minimum is forwarded alone —
      // sendMediaGroup would reject it.
      if (chunk.length === 1) {
        await this.relayUserToOperator(current, chunk[0]);
        continue;
      }
      const { relayedId, topicId: actualTopicId } = await this.withTopicRecovery(current, (t) =>
        this.botFor(current).client.sendMediaGroup({
          chatId: this.config.supportGroupId,
          messageThreadId: t,
          items: toMediaItems(chunk),
        }),
      );
      for (let i = 0; i < chunk.length; i++) {
        await this.messages.create({
          conversationId: current.id,
          botId: current.botId,
          telegramChatId: chunk[i].chatId,
          telegramMessageId: chunk[i].messageId,
          telegramTopicId: actualTopicId,
          relayedMessageId: relayedId[i],
          direction: "USER_TO_OPERATOR",
          senderType: "USER",
          contentType: chunk[i].content.type,
          replyToMessageId: chunk[i].replyToMessageId,
        });
      }
      await this.db.conversations.touchActivity(current.id, this.runtime.now());
      this.logger.info("message_relayed", {
        conversationId: current.id,
        direction: "USER_TO_OPERATOR",
        contentType: "media_group",
        topicId: actualTopicId,
      });
      // A recovery re-created the topic and updated the mapping; refresh so the
      // next chunk sends into the current topic instead of the stale one.
      const refreshed = await this.db.conversations.getById(current.id);
      if (refreshed) current = refreshed;
    }
  }

  /** User → operator relay of messages queued while the user was still behind
   *  the verification/purpose gate. Entries are forwarded in order into the
   *  user's topic and recorded like a normal relay; the conversation is
   *  re-read after each entry so a topic recovery mid-flush targets the fresh
   *  topic. A single entry's failure is logged and skipped — one bad message
   *  must not abort the rest of the flush. */
  async relayPending(conversation: ConversationRecord, userId: number, entries: PendingEntry[]): Promise<void> {
    let current = conversation;
    for (const entry of entries) {
      if (current.telegramTopicId == null) throw new ConversationError("conversation has no topic", "no_topic");
      try {
        await this.relayForward(current, {
          fromChatId: userId,
          messageId: entry.messageId,
          contentType: entry.contentType,
          replyToMessageId: entry.replyToMessageId,
          kind: "pending",
        });
        // A recovery re-created the topic and updated the mapping; refresh so
        // the next entry targets the fresh topic, not the stale deleted one.
        const refreshed = await this.db.conversations.getById(current.id);
        if (refreshed) current = refreshed;
      } catch (err) {
        this.logger.warn("pending_forward_failed", {
          conversationId: current.id,
          telegramUserId: userId,
          contentType: entry.contentType,
          errorKind: err instanceof TelegramError ? err.kind : "unknown",
        });
      }
    }
  }

  /** Forward one user message into the conversation topic and record it as a
   *  USER_TO_OPERATOR relay row — the shared core of the ordinary and
   *  pending-flush paths, which differ only in the source ids and the log
   *  `kind`. The copy carries the sender's real name/avatar via Telegram's
   *  forward attribution; forwardMessage can't attach a reply-to, so the
   *  user-side reply reference is preserved for the database only. */
  private async relayForward(
    conversation: ConversationRecord,
    params: { fromChatId: number; messageId: number; contentType: MessageContent["type"]; replyToMessageId: number | null; kind?: string },
  ): Promise<number> {
    // Only the bot the user wrote to can forward their message (the source
    // chat lives in that bot's private chat), so the forward uses the
    // conversation's own client — never the primary.
    const { relayedId, topicId: actualTopicId } = await this.withTopicRecovery(conversation, (t) =>
      this.botFor(conversation).client.forwardMessage({
        chatId: this.config.supportGroupId,
        fromChatId: params.fromChatId,
        messageId: params.messageId,
        messageThreadId: t,
      }),
    );
    await this.messages.create({
      conversationId: conversation.id,
      botId: conversation.botId,
      telegramChatId: params.fromChatId,
      telegramMessageId: params.messageId,
      telegramTopicId: actualTopicId,
      relayedMessageId: relayedId,
      direction: "USER_TO_OPERATOR",
      senderType: "USER",
      contentType: params.contentType,
      replyToMessageId: params.replyToMessageId,
    });
    await this.db.conversations.touchActivity(conversation.id, this.runtime.now());
    this.logger.info("message_relayed", {
      conversationId: conversation.id,
      direction: "USER_TO_OPERATOR",
      contentType: params.contentType,
      topicId: actualTopicId,
      ...(params.kind != null ? { kind: params.kind } : {}),
    });
    return relayedId;
  }

  /** Operator → user: deliver to the owning user's chat only, then record. */
  async relayOperatorToUser(conversation: ConversationRecord, event: OperatorMessageEvent): Promise<void> {
    const replyTo = await this.messages.resolveReplyTarget(conversation.id, event.replyToMessageId, "USER_TO_OPERATOR");
    const target: SendTarget = { chatId: conversation.telegramUserId };
    if (replyTo != null) target.replyToMessageId = replyTo;

    // A user who blocked the bot makes the send fail permanently (403). That
    // must not crash the pipeline into a webhook 400 (Telegram then retries the
    // already-claimed update and the reply is silently lost) — log it and move
    // on instead. Retryable failures (429 / 5xx / network) still propagate.
    const relayedId = await this.deliverToUser(conversation, target, event.content);
    if (relayedId == null) return;
    await this.messages.create({
      conversationId: conversation.id,
      botId: conversation.botId,
      telegramChatId: event.chatId,
      telegramMessageId: event.messageId,
      telegramTopicId: event.messageThreadId,
      relayedMessageId: relayedId,
      direction: "OPERATOR_TO_USER",
      senderType: "OPERATOR",
      contentType: event.content.type,
      replyToMessageId: event.replyToMessageId,
    });
    await this.db.conversations.touchActivity(conversation.id, this.runtime.now());
    this.logger.info("message_relayed", {
      conversationId: conversation.id,
      direction: "OPERATOR_TO_USER",
      contentType: event.content.type,
    });
  }

  /** Edited user message → the topic copy is a forwarded message, which the Bot
   *  API cannot edit, so the edit is dropped. The source record stays intact so
   *  subsequent operator replies still anchor correctly. */
  async editUserMessage(event: EditedUserMessageEvent): Promise<"relayed" | "dropped"> {
    this.logger.info("message_edit_dropped", {
      telegramUserId: event.sender.telegramUserId,
      contentType: event.content.type,
      status: "not_editable",
    });
    return "dropped";
  }

  /** Edited operator message → edit the user-chat copy. */
  async editOperatorMessage(event: EditedOperatorMessageEvent): Promise<"relayed" | "dropped"> {
    const record = await this.messages.resolveBySource(event.chatId, event.messageId);
    if (!record || record.relayedMessageId == null) {
      this.logger.info("message_edit_dropped", { telegramUserId: event.sender.telegramUserId, contentType: event.content.type, status: "unmappable" });
      return "dropped";
    }
    const conversation = await this.db.conversations.getById(record.conversationId);
    if (!conversation) {
      this.logger.info("message_edit_dropped", { conversationId: record.conversationId, contentType: event.content.type, status: "unmappable" });
      return "dropped";
    }
    // The user-chat copy was delivered by the conversation's bot — only that bot
    // can edit it, so the edit goes through its client.
    const ok = await this.applyEditSafe(this.botFor(conversation).client, conversation.telegramUserId, record.relayedMessageId, event.content);
    if (!ok) {
      this.logger.info("message_edit_dropped", { conversationId: record.conversationId, contentType: event.content.type, status: "not_editable" });
      return "dropped";
    }
    this.logger.info("message_edit_relayed", { conversationId: record.conversationId, direction: record.direction });
    return "relayed";
  }

  // -------------------------------------------------------------------------

  /** Deliver to the user's chat via the conversation's own bot. Null =
   *  permanent failure (e.g. user blocked the bot) handled as an undeliverable
   *  drop; retryable errors propagate. */
  private async deliverToUser(
    conversation: ConversationRecord,
    target: SendTarget,
    content: MessageContent,
  ): Promise<number | null> {
    try {
      return await this.botFor(conversation).client.sendContent(target, content);
    } catch (err) {
      if (err instanceof TelegramError && err.isRetryable()) throw err;
      this.logger.warn("relay_undeliverable", {
        conversationId: conversation.id,
        telegramUserId: conversation.telegramUserId,
        kind: err instanceof TelegramError ? err.kind : "unknown",
      });
      return null;
    }
  }

  /**
   * Deliver into the user's topic, recovering transient topic states once:
   * deleted topic → create a fresh topic, post its identity card, update
   * conversation.topic_id, retry; closed topic → reopen in place and retry.
   * `deliver` receives the topic id to send into. Everything else propagates.
   * (A topic is only re-created when the conversation still exists — /delete
   * removes the conversation row, so a deleted conversation's topic is never
   * resurrected.)
   */
  private async withTopicRecovery<T>(
    conversation: ConversationRecord,
    deliver: (topicId: number) => Promise<T>,
  ): Promise<SendWithRecoveryResult<T>> {
    try {
      const relayedId = await deliver(conversation.telegramTopicId!);
      return { relayedId, topicId: conversation.telegramTopicId! };
    } catch (err) {
      if (isTopicNotFound(err)) {
        const user = await this.db.users.getByTelegramUserId(conversation.telegramUserId);
        if (!user) throw err;
        const freshTopicId = await this.deps.topics.createTopic(user, {
          conversationId: conversation.id,
          botId: conversation.botId,
        });
        await this.db.conversations.updateTopicId(conversation.id, freshTopicId);
        // Best-effort: a recovered topic still opens with the user-info card so
        // operators can tell who they are replying to. The card is built from
        // the conversation's bot (the user's contact with it).
        await this.deps.topics.postIdentityCard(freshTopicId, user, { bot: this.botFor(conversation) });
        this.logger.info("topic_created", {
          conversationId: conversation.id,
          telegramUserId: conversation.telegramUserId,
          topicId: freshTopicId,
          status: "recovered",
        });
        const relayedId = await deliver(freshTopicId);
        return { relayedId, topicId: freshTopicId };
      }
      if (isTopicClosed(err)) {
        await this.telegram.restoreForumTopic({
          chatId: this.config.supportGroupId,
          messageThreadId: conversation.telegramTopicId!,
        });
        this.logger.info("topic_restored", {
          conversationId: conversation.id,
          topicId: conversation.telegramTopicId!,
          status: "auto_restored",
        });
        const relayedId = await deliver(conversation.telegramTopicId!);
        return { relayedId, topicId: conversation.telegramTopicId! };
      }
      throw err;
    }
  }

  /** Edit the copy through the bot that delivered it; stickers can't be
   *  edited. Failures degrade to "dropped". */
  private async applyEditSafe(client: TelegramClient, chatId: number, messageId: number, content: MessageContent): Promise<boolean> {
    if (content.type === "text") {
      try {
        await client.editMessageText({ chatId, messageId, text: content.text });
        return true;
      } catch {
        return false;
      }
    }
    if (content.type === "sticker") return false;
    try {
      await client.editMessageCaption({ chatId, messageId, caption: content.caption ?? "" });
      return true;
    } catch {
      return false;
    }
  }
}

/** Bot API cap on items per sendMediaGroup call. */
const MEDIA_GROUP_MAX_ITEMS = 10;

type AlbumableContent = Extract<MessageContent, { type: "photo" | "video" | "document" | "audio" }>;

function isAlbumable(content: MessageContent): content is AlbumableContent {
  return content.type === "photo" || content.type === "video" || content.type === "document" || content.type === "audio";
}

/** Build the Bot API `media` array. Only the FIRST item may carry a caption
 *  (Bot API restriction), so later captions are dropped here — the HTTP client
 *  also guards defensively, but the recorded request shape stays truthful. */
function toMediaItems(events: UserMessageEvent[]): Array<{ type: AlbumableContent["type"]; fileId: string; caption?: string }> {
  return events.map((e, i) => {
    const c = e.content as AlbumableContent; // guarded by isAlbumable at the call site
    return { type: c.type, fileId: c.fileId, ...(i === 0 && c.caption != null ? { caption: c.caption } : {}) };
  });
}

function chunkItems<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}