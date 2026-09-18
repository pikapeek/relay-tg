// ---------------------------------------------------------------------------
// SqliteMessages: the core MessageRepository over SqlDb.
// ---------------------------------------------------------------------------

import type { Direction, MessageCreateInput, MessageRecord } from "@relaytg/shared";
import type { MessageRepository } from "@relaytg/core";
import type { SqlDb } from "../sql-db.ts";
import { iso, mapRow, newId } from "./mapping.ts";

export class SqliteMessages implements MessageRepository {
  constructor(private readonly sql: SqlDb) {}

  async create(input: MessageCreateInput, now: Date): Promise<MessageRecord> {
    const createdAt = iso(now);
    const row: MessageRecord = {
      id: newId(),
      conversationId: input.conversationId,
      botId: input.botId,
      telegramChatId: input.telegramChatId,
      telegramMessageId: input.telegramMessageId,
      telegramTopicId: input.telegramTopicId,
      relayedMessageId: input.relayedMessageId,
      direction: input.direction,
      senderType: input.senderType,
      contentType: input.contentType,
      replyToMessageId: input.replyToMessageId,
      createdAt,
    };
    this.sql
      .prepare(
        `INSERT INTO messages
           (id, conversation_id, bot_id, telegram_chat_id, telegram_message_id, telegram_topic_id, relayed_message_id,
            direction, sender_type, content_type, reply_to_message_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.conversationId,
        row.botId,
        row.telegramChatId,
        row.telegramMessageId,
        row.telegramTopicId,
        row.relayedMessageId,
        row.direction,
        row.senderType,
        row.contentType,
        row.replyToMessageId,
        row.createdAt,
      );
    return row;
  }

  async getBySource(telegramChatId: number, telegramMessageId: number): Promise<MessageRecord | null> {
    return mapRow<MessageRecord>(
      this.sql
        .prepare("SELECT * FROM messages WHERE telegram_chat_id = ? AND telegram_message_id = ?")
        .get(telegramChatId, telegramMessageId),
    );
  }

  async getByConversationAndRelayedId(
    conversationId: string,
    relayedMessageId: number,
    direction: Direction,
  ): Promise<MessageRecord | null> {
    return mapRow<MessageRecord>(
      this.sql
        .prepare("SELECT * FROM messages WHERE conversation_id = ? AND direction = ? AND relayed_message_id = ?")
        .get(conversationId, direction, relayedMessageId),
    );
  }

  async getLastByConversation(conversationId: string): Promise<MessageRecord | null> {
    return mapRow<MessageRecord>(
      this.sql
        .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
        .get(conversationId),
    );
  }

  async deleteByConversationId(conversationId: string): Promise<void> {
    this.sql.prepare("DELETE FROM messages WHERE conversation_id = ?").run(conversationId);
  }

  async listUserChatCopyIds(conversationId: string): Promise<number[]> {
    const rows = this.sql
      .prepare(
        `SELECT relayed_message_id FROM messages
          WHERE conversation_id = ? AND direction = 'OPERATOR_TO_USER' AND relayed_message_id IS NOT NULL`,
      )
      .all(conversationId);
    return rows.map((row) => Number(row.relayed_message_id));
  }
}
