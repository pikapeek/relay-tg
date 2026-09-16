// ---------------------------------------------------------------------------
// TopicService (task 5.3): creates and removes support-group forum topics.
// Topic name is `DisplayName | telegram_user_id` — unless an operator set a
// custom name with `/rename`, which is persisted in the settings table and
// reused when a manually-deleted topic is auto-recreated. The topic id is
// stored on the conversation and used to route operator replies back to the
// right user. Topic removal is best-effort — a missing topic is already gone.
// ---------------------------------------------------------------------------

import type { UserRecord } from "@relaytg/shared";
import { displayName, TelegramError } from "@relaytg/shared";
import type { Database, SendTarget, TelegramClient } from "../ports.ts";
import type { ConversationRecord } from "@relaytg/shared";
import type { Logger, Config } from "@relaytg/shared";
import type { InlineKeyboard } from "../telegram-types.ts";
import type { ServiceContext } from "./service-context.ts";

/** Settings key under which a `/rename` custom topic title is persisted. */
const TOPIC_TITLE_KEY = (conversationId: string): string => `topic_title:${conversationId}`;

export class TopicService {
  private readonly telegram: TelegramClient;
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly db: Database;

  constructor(ctx: ServiceContext) {
    this.telegram = ctx.telegram;
    this.config = ctx.config;
    this.logger = ctx.logger;
    this.db = ctx.db;
  }

  /** The topic's display name: a stored `/rename` title wins, otherwise the
   *  default `DisplayName | telegram_user_id`. */
  private async topicName(conversationId: string | undefined, user: UserRecord): Promise<string> {
    const stored = conversationId != null ? await this.db.settings.get(TOPIC_TITLE_KEY(conversationId)) : null;
    return stored != null && stored.length > 0 ? stored : `${displayName(user)} | ${user.telegramUserId}`;
  }

  /** Create the forum topic and return its id. Pass the conversation id so an
   *  auto-recovered topic picks up a stored `/rename` title. The opening
   *  message is a separate step (`postIdentityCard`) so callers can choose
   *  between the first-contact single pinned purpose+info card and the plain
   *  card that re-opens a recovered topic. */
  async createTopic(user: UserRecord, opts: { conversationId?: string } = {}): Promise<number> {
    const name = await this.topicName(opts.conversationId, user);
    const topicId = await this.telegram.createForumTopic({
      chatId: this.config.supportGroupId,
      name,
    });
    this.logger.info("topic_created", { telegramUserId: user.telegramUserId, topicId });
    return topicId;
  }

  /** Rename a topic and persist the custom title, so a topic that is manually
   *  deleted and later auto-recreated keeps the operator's name. */
  async renameTopic(conversation: ConversationRecord, name: string): Promise<void> {
    await this.telegram.editForumTopic({
      chatId: this.config.supportGroupId,
      messageThreadId: conversation.telegramTopicId!,
      name,
    });
    await this.db.settings.set(TOPIC_TITLE_KEY(conversation.id), name);
  }

  /** Post the topic-opening personal info card. Photo card (avatar as the
   *  photo) when the user has a profile photo, otherwise a text card; both show
   *  name / @username / user id and a tap-through profile button. The first
   *  contact case (`opts.purpose` set) prepends the user's stated purpose of
   *  contact (来意) and — with `opts.pin` — pins the single combined card as the
   *  topic's opening message, so the purpose is NOT forwarded into the topic
   *  separately. A recovered topic (no fresh purpose) re-opens with the plain,
   *  unpinned card. Best-effort — a card or pin failure (e.g. avatar lookup)
   *  never fails topic creation; the posted card's group message id is
   *  returned (null when the card could not be posted). */
  async postIdentityCard(
    topicId: number,
    user: UserRecord,
    opts: { purpose?: string; pin?: boolean } = {},
  ): Promise<number | null> {
    const target: SendTarget = { chatId: this.config.supportGroupId, messageThreadId: topicId };
    const name = displayName(user);
    const username = user.username != null && user.username.length > 0 ? `\n@${user.username}` : "";
    const purposeLine = opts.purpose != null && opts.purpose.length > 0 ? `📝 ${opts.purpose}\n` : "";
    const info = `${purposeLine}👤 ${name}${username}\n🆔 ${user.telegramUserId}`;
    const markup: InlineKeyboard = {
      buttons: [{ text: `👤 ${name}`, url: `tg://user?id=${user.telegramUserId}` }],
    };
    try {
      const avatar = await this.telegram.getUserProfilePhoto({ userId: user.telegramUserId });
      const messageId =
        avatar != null
          ? await this.telegram.sendContent(target, { type: "photo", fileId: avatar, caption: info, fileSize: null }, markup)
          : await this.telegram.sendMessage({ ...target, text: info, replyMarkup: markup });
      if (opts.pin && messageId != null) {
        try {
          await this.telegram.pinChatMessage({ chatId: this.config.supportGroupId, messageId, messageThreadId: topicId });
        } catch (err) {
          this.logger.warn("topic_card_pin_failed", {
            telegramUserId: user.telegramUserId,
            topicId,
            errorKind: err instanceof TelegramError ? err.kind : "unknown",
          });
        }
      }
      this.logger.info("topic_card_posted", { telegramUserId: user.telegramUserId, topicId, pinned: opts.pin === true });
      return messageId;
    } catch (err) {
      this.logger.warn("topic_card_failed", {
        telegramUserId: user.telegramUserId,
        topicId,
        errorKind: err instanceof TelegramError ? err.kind : "unknown",
      });
      return null;
    }
  }

  /** Best-effort: deletion failures (including already-deleted topics) are logged, not thrown. */
  async deleteTopic(telegramTopicId: number): Promise<void> {
    try {
      await this.telegram.deleteForumTopic({
        chatId: this.config.supportGroupId,
        messageThreadId: telegramTopicId,
      });
      this.logger.info("topic_deleted", { topicId: telegramTopicId });
    } catch {
      this.logger.warn("topic_deleted", { topicId: telegramTopicId, status: "best_effort_failed" });
    }
  }
}
