// ---------------------------------------------------------------------------
// DeleteCommands: /delete (reply-retract and whole-conversation), /list and the
// tap-to-delete picker. Split out of CommandService so command dispatch stays a
// thin facade. All delete paths share the /delete protection rules and the
// conversation-target resolution from CommandBase.
// ---------------------------------------------------------------------------

import {
  TelegramError,
  type ConversationDeleteEvent,
  type ConversationRecord,
  type OperatorMessageEvent,
  type UserProfile,
} from "@relaytg/shared";
import { TOPIC_PIN_KEY } from "../ports.ts";
import type { ServiceContext } from "./service-context.ts";
import type { InlineKeyboard, InlineKeyboardButton } from "../telegram-types.ts";
import { OPERATOR_TEXTS, type OperatorTexts } from "./texts.ts";
import { CommandBase, type CommandsDeps } from "./command-base.ts";

export class DeleteCommands extends CommandBase {
  constructor(ctx: ServiceContext, deps: CommandsDeps) {
    super(ctx, deps);
  }

  /** Reply-to `/delete` — retract a sent message from the user's chat. The Bot
   *  API never notifies a bot that a message was deleted, so retracting the
   *  delivered user-side copy has to be explicit: reply to the topic message and
   *  send /delete. The topic message stays (operators keep the archive); only
   *  the delivered copy in the user's private chat is removed best-effort
   *  (Bot API 48 h limit). A user message's forwarded topic copy has no
   *  user-side copy to retract (silently ignored). A target with no relay record
   *  at all — the info card or any other unrecorded topic message — has nothing
   *  to retract either: for an admin that is a request to delete the
   *  conversation itself, for an operator it is answered honestly instead of a
   *  hollow success. */
  async delMessage(event: OperatorMessageEvent, conversation: ConversationRecord): Promise<void> {
    const t = OPERATOR_TEXTS(await this.deps.users.effectiveLanguageOf(event.sender));
    // `delMessage` is only entered with a reply (a reply-less /delete in a topic
    // goes straight to deleteConversation), so the anchor always exists.
    const targetId = event.replyToMessageId!;
    // The first pinned purpose+info card is permanent — `/delete` refuses to
    // remove it for operators AND admins (no escalation to a conversation
    // delete); only deleting the conversation itself clears it.
    const pinnedCardId = await this.db.settings.get(TOPIC_PIN_KEY(conversation.id));
    if (pinnedCardId != null && Number(pinnedCardId) === targetId) {
      await this.telegram.sendMessage({
        chatId: event.chatId,
        messageThreadId: event.messageThreadId ?? undefined,
        text: t.pinCardProtected,
        replyToMessageId: targetId,
      });
      this.logger.info("command_rejected", {
        telegramUserId: event.sender.telegramUserId,
        status: "/delete",
        conversationId: conversation.id,
        kind: "pinned_card",
      });
      return;
    }
    // Resolve the record: an operator message is found by its source
    // (chat_id, message_id); a user message's forwarded topic copy is found by
    // its relayed id within the conversation. Only an OPERATOR_TO_USER message
    // has a bot-delivered copy in the user's private chat worth retracting.
    const record =
      (await this.db.messages.getBySource(event.chatId, targetId)) ??
      (await this.db.messages.getByConversationAndRelayedId(conversation.id, targetId, "USER_TO_OPERATOR"));
    const mirrorsUserChat = record != null && record.direction === "OPERATOR_TO_USER" && record.relayedMessageId != null;
    const userOwn = record != null && record.direction === "USER_TO_OPERATOR";

    // The user's own message can't be retracted — the bot may only delete the
    // messages it sent itself, never ones the user typed. Stay silent: there is
    // nothing to withdraw and nothing to confirm.
    if (userOwn) {
      this.logger.info("command_rejected", {
        telegramUserId: event.sender.telegramUserId,
        status: "/delete",
        conversationId: conversation.id,
        kind: "user_message_not_retractable",
      });
      return;
    }

    // Nothing to retract — the target has no relay record at all (the info card
    // or any other unrecorded topic message) or no user-side copy. For an admin
    // replying to it with /delete this is the conversation they are pointing at,
    // so escalate to the full conversation delete (same semantics as a
    // reply-less /delete). For an operator say so instead of echoing a success
    // that changed nothing.
    if (!mirrorsUserChat) {
      if (await this.deps.operators.isAdmin(event.sender.telegramUserId)) {
        await this.deleteConversation(event.sender.telegramUserId, conversation, event);
        return;
      }
      await this.telegram.sendMessage({
        chatId: event.chatId,
        messageThreadId: event.messageThreadId ?? undefined,
        text: t.nothingToRetract,
        replyToMessageId: targetId,
      });
      this.logger.info("command_executed", {
        telegramUserId: event.sender.telegramUserId,
        status: "/delete",
        conversationId: conversation.id,
        kind: "no_copy",
      });
      return;
    }

    // The topic message stays — retracting only removes the delivered copy from
    // the user's private chat (best-effort: a copy older than 48 h or already
    // gone just logs). The confirmation quotes the topic message (reply) so the
    // operator sees exactly which message was retracted.
    let ok = true;
    try {
      await this.telegram.deleteMessage({ chatId: conversation.telegramUserId, messageId: record.relayedMessageId! });
    } catch (err) {
      ok = false;
      this.logger.warn("del_user_chat_failed", {
        conversationId: conversation.id,
        telegramUserId: conversation.telegramUserId,
        status: "best_effort",
        errorKind: err instanceof TelegramError ? err.kind : "unknown",
      });
    }
    await this.telegram.sendMessage({
      chatId: event.chatId,
      messageThreadId: event.messageThreadId ?? undefined,
      text: ok ? t.delDone : t.delFailed,
      replyToMessageId: targetId,
    });
    this.logger.info("command_executed", {
      telegramUserId: event.sender.telegramUserId,
      status: "/delete",
      conversationId: conversation.id,
      direction: record?.direction ?? undefined,
      kind: ok ? "retracted" : "retract_failed",
    });
  }

  async deleteConversation(adminId: number, conversation: ConversationRecord, event: OperatorMessageEvent): Promise<void> {
    const t = OPERATOR_TEXTS(await this.deps.users.effectiveLanguageOf(event.sender));
    if (await this.isProtectedDeleteTarget(adminId, conversation)) {
      await this.send(event, t.deleteStaffRefused);
      this.logger.info("command_rejected", {
        telegramUserId: adminId,
        status: "staff_target:/delete",
        conversationId: conversation.id,
      });
      return;
    }
    await this.deps.conversations.deleteConversation(conversation);
    // The topic is gone by now; echoing into it would fail with
    // topic_not_found, so confirm in the group's general chat instead. Name the
    // conversation so the admin knows exactly which one was removed.
    const user = await this.deps.users.getByTelegramUserId(conversation.telegramUserId);
    const name = user?.firstName ?? String(conversation.telegramUserId);
    await this.telegram.sendMessage({
      chatId: this.config.supportGroupId,
      text: t.conversationDeleted(name, user?.username ?? null, conversation.telegramUserId, conversation.id),
    });
    this.logger.info("command_executed", { telegramUserId: adminId, status: "/delete", conversationId: conversation.id });
  }

  // -- /list and the tap-to-delete picker -----------------------------------

  /** /list — plain-text list of every conversation, numbered, each ending with
   *  its conversation id so `/delete <id>` (or @user / telegram_user_id) targets
   *  it directly. Works at group level and in a staff member's private chat. */
  async listAll(sender: UserProfile, chatId: number): Promise<void> {
    const t = OPERATOR_TEXTS(await this.deps.users.effectiveLanguageOf(sender));
    const conversations = await this.db.conversations.list();
    if (conversations.length === 0) {
      await this.sendTo(chatId, undefined, t.listEmpty);
      this.logger.info("command_executed", { telegramUserId: sender.telegramUserId, status: "/list" });
      return;
    }
    const lines: string[] = [];
    for (let i = 0; i < conversations.length; i++) {
      const c = conversations[i]!;
      const user = await this.deps.users.getByTelegramUserId(c.telegramUserId);
      const name = user?.firstName ?? String(c.telegramUserId);
      lines.push(t.listItem(i + 1, t.conversationLabel(name, user?.username ?? null, c.id)));
    }
    const text = [t.listHeader(conversations.length), "", ...lines].join("\n");
    await this.sendTo(chatId, undefined, text);
    this.logger.info("command_executed", { telegramUserId: sender.telegramUserId, status: "/list" });
  }

  /** /delete at group level / private chat (admin only): with a target argument
   *  delete that conversation directly; otherwise post the tap-to-delete list. */
  async deleteFromList(sender: UserProfile, chatId: number, args: string[]): Promise<void> {
    const t = OPERATOR_TEXTS(await this.deps.users.effectiveLanguageOf(sender));
    if (!(await this.deps.operators.isAdmin(sender.telegramUserId))) {
      await this.sendTo(chatId, undefined, t.adminOnly);
      this.logger.info("command_rejected", { telegramUserId: sender.telegramUserId, status: "admin_only:/delete" });
      return;
    }
    const target = args.join(" ").trim();
    if (target) {
      const conversation = await this.resolveConversationTarget(target);
      if (!conversation) {
        await this.sendTo(chatId, undefined, t.unknownRestoreTarget);
        return;
      }
      if (await this.isProtectedDeleteTarget(sender.telegramUserId, conversation)) {
        await this.sendTo(chatId, undefined, t.deleteStaffRefused);
        this.logger.info("command_rejected", {
          telegramUserId: sender.telegramUserId,
          status: "staff_target:/delete",
          mode: "direct",
          conversationId: conversation.id,
        });
        return;
      }
      await this.deps.conversations.deleteConversation(conversation);
      const user = await this.deps.users.getByTelegramUserId(conversation.telegramUserId);
      const name = user?.firstName ?? String(conversation.telegramUserId);
      await this.sendTo(
        chatId,
        undefined,
        t.conversationDeleted(name, user?.username ?? null, conversation.telegramUserId, conversation.id),
      );
      this.logger.info("command_executed", { telegramUserId: sender.telegramUserId, status: "/delete", mode: "direct", conversationId: conversation.id });
      return;
    }
    await this.deletePicker(sender, chatId);
  }

  /** The tap-to-delete picker: one single-column button per conversation, each
   *  carrying `del:<conversation_id>`. Posting it into a private chat or the
   *  group's general chat gives admins a one-tap delete surface. */
  async deletePicker(sender: UserProfile, chatId: number): Promise<void> {
    const t = OPERATOR_TEXTS(await this.deps.users.effectiveLanguageOf(sender));
    const conversations = await this.db.conversations.list();
    if (conversations.length === 0) {
      await this.sendTo(chatId, undefined, t.listEmpty);
      return;
    }
    const markup = await this.pickerMarkup(conversations, t);
    await this.telegram.sendMessage({ chatId, text: t.deletePickerHeader(conversations.length), replyMarkup: markup });
    this.logger.info("command_executed", { telegramUserId: sender.telegramUserId, status: "/delete", mode: "picker" });
  }

  /** Callback tap on a `del:<conversation_id>` button (admin only): delete the
   *  conversation (and its topic), toast the result, then re-render the picker
   *  so the removed row disappears. */
  async handleDeleteTap(event: ConversationDeleteEvent): Promise<void> {
    const t = OPERATOR_TEXTS(await this.deps.users.effectiveLanguageOf(event.sender));
    if (!(await this.deps.operators.isAdmin(event.sender.telegramUserId))) {
      await this.telegram.answerCallbackQuery({ callbackQueryId: event.callbackQueryId, text: t.adminOnly, showAlert: true });
      this.logger.info("command_rejected", { telegramUserId: event.sender.telegramUserId, status: "admin_only:delete_tap" });
      return;
    }
    const conversation = await this.deps.conversations.getById(event.conversationId);
    if (!conversation) {
      // Already gone — e.g. deleted from another picker or via a direct /delete.
      // Toast and refresh the picker so the stale row disappears.
      await this.telegram.answerCallbackQuery({ callbackQueryId: event.callbackQueryId, text: t.deleteGone, showAlert: false });
      await this.rerenderPicker(event.chatId, event.messageId, t);
      return;
    }
    if (await this.isProtectedDeleteTarget(event.sender.telegramUserId, conversation)) {
      // A tap can't remove the requester's own conversation or a staff member's
      // — alert instead of deleting; the picker (unchanged) stays on screen.
      await this.telegram.answerCallbackQuery({
        callbackQueryId: event.callbackQueryId,
        text: t.deleteStaffRefused,
        showAlert: true,
      });
      this.logger.info("command_rejected", {
        telegramUserId: event.sender.telegramUserId,
        status: "staff_target:delete_tap",
        conversationId: conversation.id,
      });
      return;
    }
    const user = await this.deps.users.getByTelegramUserId(conversation.telegramUserId);
    const name = user?.firstName ?? String(conversation.telegramUserId);
    await this.deps.conversations.deleteConversation(conversation);
    await this.telegram.answerCallbackQuery({
      callbackQueryId: event.callbackQueryId,
      text: t.deletedToast(name, user?.username ?? null, conversation.telegramUserId),
      showAlert: false,
    });
    await this.rerenderPicker(event.chatId, event.messageId, t);
    this.logger.info("command_executed", {
      telegramUserId: event.sender.telegramUserId,
      status: "/delete",
      mode: "tap",
      conversationId: conversation.id,
    });
  }

  /** Re-render a picker message after a delete: with conversations left, the
   *  header count and button set are rebuilt; with none, the buttons are dropped
   *  and the empty text replaces the picker. */
  async rerenderPicker(chatId: number, messageId: number, t: OperatorTexts): Promise<void> {
    const conversations = await this.db.conversations.list();
    if (conversations.length === 0) {
      await this.telegram.editMessageText({ chatId, messageId, text: t.listEmpty }).catch(() => {});
      return;
    }
    const markup = await this.pickerMarkup(conversations, t);
    await this.telegram
      .editMessageText({ chatId, messageId, text: t.deletePickerHeader(conversations.length), replyMarkup: markup })
      .catch(() => {});
  }

  /** Single-column button list for the picker. Each button is labelled with the
   *  user and carries `del:<conversation_id>`; the mapper renders one row per
   *  button so long user lists stay tappable. */
  async pickerMarkup(conversations: ConversationRecord[], t: OperatorTexts): Promise<InlineKeyboard> {
    const buttons: InlineKeyboardButton[] = [];
    for (const c of conversations) {
      const user = await this.deps.users.getByTelegramUserId(c.telegramUserId);
      const name = user?.firstName ?? String(c.telegramUserId);
      buttons.push({ text: t.deleteButtonLabel(name, user?.username ?? null), callbackData: `del:${c.id}` });
    }
    return { buttons };
  }
}