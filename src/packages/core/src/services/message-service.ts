// ---------------------------------------------------------------------------
// MessageService (task 6.1-6.2): records every relayed message with its source
// (chat_id, message_id) and relayed-copy id, and resolves records for
// idempotency, edits, and reply preservation.
// ---------------------------------------------------------------------------

import type { Direction, MessageCreateInput, MessageRecord } from "@relaytg/shared";
import type { Database, Runtime } from "../ports.ts";
import type { Logger } from "@relaytg/shared";
import type { ServiceContext } from "./service-context.ts";

export class MessageService {
  private readonly db: Database;
  private readonly runtime: Runtime;
  private readonly logger: Logger;

  constructor(ctx: ServiceContext) {
    this.db = ctx.db;
    this.runtime = ctx.runtime;
    this.logger = ctx.logger;
  }

  async create(input: MessageCreateInput): Promise<MessageRecord> {
    const record = await this.db.messages.create(input, this.runtime.now());
    this.logger.info("message_recorded", {
      conversationId: record.conversationId,
      direction: record.direction,
      contentType: record.contentType,
    });
    return record;
  }

  async resolveBySource(telegramChatId: number, telegramMessageId: number): Promise<MessageRecord | null> {
    return this.db.messages.getBySource(telegramChatId, telegramMessageId);
  }

  async resolveByConversationAndRelayedId(conversationId: string, relayedMessageId: number, direction: Direction): Promise<MessageRecord | null> {
    return this.db.messages.getByConversationAndRelayedId(conversationId, relayedMessageId, direction);
  }

  /**
   * Reply preservation walk: the referenced id in the sending chat is the
   * relayed copy of the original; return that original's message id as the
   * reply target for the other side. `direction` is the direction of the
   * record being looked up — a user's reply resolves only OPERATOR_TO_USER
   * copies and an operator's reply only USER_TO_OPERATOR copies, so id
   * collisions between the private chat and the topic can never anchor a reply
   * to the wrong message. Unresolvable replies degrade to null (plain send) —
   * never a failure.
   */
  async resolveReplyTarget(conversationId: string, replyToMessageId: number | null, direction: Direction): Promise<number | null> {
    if (replyToMessageId == null) return null;
    const record = await this.db.messages.getByConversationAndRelayedId(conversationId, replyToMessageId, direction);
    return record?.telegramMessageId ?? null;
  }
}
