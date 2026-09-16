// ---------------------------------------------------------------------------
// CommandService (task 8.2-8.11): the operator-facing command dispatcher.
//
// Commands posted inside a mapped topic resolve the conversation by topic and
// run scoped to it. /restore and /help also work at the group's general chat.
// /ban /unban /delete are ADMIN-only; everything else is OPERATOR+.
// Usernames only resolve targets for assignment/restore — they grant nothing.
// ---------------------------------------------------------------------------

import {
  parseCommand,
  TelegramError,
  type ConversationDeleteEvent,
  type ConversationRecord,
  type Config,
  type Logger,
  type OperatorMessageEvent,
  type UserProfile,
} from "@relaytg/shared";
import type { Database, Runtime, TelegramClient } from "../ports.ts";
import { TOPIC_PIN_KEY } from "../ports.ts";
import type { ServiceContext } from "./service-context.ts";
import type { ConversationService } from "./conversation-service.ts";
import type { HideService } from "./hide-service.ts";
import type { OperatorService } from "./operator-service.ts";
import type { UserService } from "./user-service.ts";
import type { InlineKeyboard, InlineKeyboardButton } from "../telegram-types.ts";
import { OPERATOR_TEXTS, type OperatorTexts } from "./texts.ts";
import type { UserMenuChoice } from "./command-menu.ts";
import type { SelfCheckService } from "./selfcheck-service.ts";
import type { AdDetectionService } from "./ad-service.ts";
import type { QuarantineService } from "./quarantine-service.ts";
import type { TopicService } from "./topic-service.ts";

export interface CommandsDeps {
  users: UserService;
  conversations: ConversationService;
  operators: OperatorService;
  hides: HideService;
  /** Re-apply the sender's command menus after a /lang change. */
  syncUserMenu: (telegramUserId: number, lang: UserMenuChoice) => Promise<void>;
  /** Admin-only /selfcheck: re-run the boot config self-check on demand. */
  selfCheck: SelfCheckService;
  /** Admin /ad: runtime ad-keyword/allowlist/link-rule management. */
  ad: AdDetectionService;
  /** Admin /ad restore: forward a quarantined copy back into the user's topic. */
  quarantine: QuarantineService;
  /** Topic lifecycle: /rename renames a topic and persists the custom title. */
  topics: TopicService;
}

export class CommandService {
  private readonly db: Database;
  private readonly telegram: TelegramClient;
  private readonly runtime: Runtime;
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly deps: CommandsDeps;
  /** The bot's own telegram_user_id, resolved at boot (getMe) — see the
   *  ServiceContext doc comment. Guards /delete against the bot's own thread. */
  private readonly botTelegramUserId: number | undefined;

  constructor(ctx: ServiceContext, deps: CommandsDeps) {
    this.db = ctx.db;
    this.telegram = ctx.telegram;
    this.runtime = ctx.runtime;
    this.config = ctx.config;
    this.logger = ctx.logger;
    this.deps = deps;
    this.botTelegramUserId = ctx.botTelegramUserId;
  }

  async handleOperatorCommand(event: OperatorMessageEvent): Promise<void> {
    if (event.content.type !== "text") return;
    const text = event.content.text.trim();
    if (!text.startsWith("/")) return;
    // Strip a trailing @botusername (Telegram appends it in groups/topics), so
    // `/info@relaytg_bot args` behaves exactly like `/info args`.
    const { cmd, args } = parseCommand(text);
    const sender = event.sender;
    const t = OPERATOR_TEXTS(await this.deps.users.effectiveLanguageOf(sender));

    const role = await this.deps.operators.getRole(sender.telegramUserId);
    if (!role) {
      await this.send(event, t.notOperator);
      this.logger.info("command_rejected", { telegramUserId: sender.telegramUserId, status: "not_operator" });
      return;
    }

    if (cmd === "/help") {
      await this.send(
        event,
        event.messageThreadId != null ? t.helpTopic : t.helpGeneral,
      );
      this.logger.info("command_executed", { telegramUserId: sender.telegramUserId, status: "/help" });
      return;
    }

    if (cmd === "/restore") {
      await this.restore(sender.telegramUserId, args, event);
      return;
    }

    if (cmd === "/lang") {
      await this.lang(sender, args, { chatId: event.chatId, messageThreadId: event.messageThreadId ?? undefined });
      return;
    }

    if (cmd === "/selfcheck") {
      await this.selfcheck(sender.telegramUserId, event);
      return;
    }

    // /list works anywhere in the group (general chat or a topic).
    if (cmd === "/list") {
      await this.listAll(event.sender, event.chatId);
      return;
    }

    // Group-level /delete (general chat): delete a specific conversation via its
    // target, or show the tap-to-delete list. Inside a topic /delete keeps the
    // direct delete of that conversation (handled in the topic switch below).
    if (cmd === "/delete" && event.messageThreadId == null) {
      await this.deleteFromList(event.sender, event.chatId, args);
      return;
    }

    // /ad — runtime ad-keyword management (admin only); works anywhere in the
    // group so it is reachable from both the general chat and any topic.
    if (cmd === "/ad") {
      await this.ad(sender.telegramUserId, args, event);
      return;
    }

    if (event.messageThreadId == null) {
      // Group-level /ban · /unban by target: a blocked user may have no
      // conversation at all (a first-contact ad was auto-blocked before any
      // row existed), so a bare telegram_user_id or @username reaches them
      // without a topic context.
      if ((cmd === "/ban" || cmd === "/unban") && args.length > 0) {
        await this.banUnbanByTarget(sender.telegramUserId, cmd, args, event);
        return;
      }
      await this.send(event, t.outOfTopic);
      this.logger.info("command_rejected", { telegramUserId: sender.telegramUserId, status: "out_of_topic" });
      return;
    }

    const conversation = await this.deps.conversations.getByTopicId(event.messageThreadId);
    if (!conversation) {
      await this.send(event, t.unknownTopic);
      this.logger.info("command_rejected", { telegramUserId: sender.telegramUserId, status: "unmapped_topic" });
      return;
    }

    switch (cmd) {
      case "/info":
        await this.info(conversation, event);
        return;
      case "/assign":
        await this.assign(sender.telegramUserId, args, conversation, event);
        return;
      case "/note":
        await this.note(sender.telegramUserId, args, conversation, event);
        return;
      case "/rename":
        await this.rename(sender.telegramUserId, args, conversation, event);
        return;
      case "/delete":
        // Reply to a topic message → retract its delivered copy from the user's
        // chat (OPERATOR+); without a reply it deletes the whole conversation
        // (ADMIN only).
        if (event.replyToMessageId != null) {
          await this.delMessage(event, conversation);
        } else {
          await this.adminOnly(() => this.deleteConversation(sender.telegramUserId, conversation, event), sender.telegramUserId, event, "/delete");
        }
        return;
      case "/hide":
        await this.hide(args, conversation, event);
        return;
      case "/ban":
        await this.adminOnly(() => this.ban(sender.telegramUserId, conversation, event), sender.telegramUserId, event, "/ban");
        return;
      case "/unban":
        await this.adminOnly(() => this.unban(sender.telegramUserId, conversation, event), sender.telegramUserId, event, "/unban");
        return;
      default:
        await this.send(event, t.unknownCommand);
        this.logger.info("command_invalid", { telegramUserId: sender.telegramUserId, status: cmd });
    }
  }

  // -------------------------------------------------------------------------

  private async info(conversation: ConversationRecord, event: OperatorMessageEvent): Promise<void> {
    const t = OPERATOR_TEXTS(await this.deps.users.effectiveLanguageOf(event.sender));
    const user = await this.deps.users.getByTelegramUserId(conversation.telegramUserId);
    const last = await this.db.messages.getLastByConversation(conversation.id);
    const op = conversation.assignedOperatorId ? await this.db.operators.list().then((ops) => ops.find((o) => o.id === conversation.assignedOperatorId)) : null;

    const policy =
      conversation.hideAfterHours != null && conversation.hideAfterHours > 0
        ? t.hidePolicyHours(conversation.hideAfterHours)
        : t.hidePolicyPermanent;

    const lastLine = last ? `${last.createdAt} (${last.contentType}, ${last.direction})` : t.none;
    const assigned = conversation.assignedOperatorId
      ? (op?.telegramUserId ?? conversation.assignedOperatorId)
      : t.none;

    // Internal /note lines (private, never sent to the user) render under a
    // header when the conversation has any — a saved note is only useful if
    // whoever runs /info actually sees it.
    const notes = await this.db.notes.listByConversation(conversation.id);
    const lines = [
      t.infoUser(user?.firstName ?? String(conversation.telegramUserId), user?.username ?? null),
      t.infoId(conversation.telegramUserId),
      // The purpose of contact stated at first contact, when one exists.
      user?.purpose != null && user.purpose.length > 0 ? t.infoPurpose(user.purpose) : "",
      t.infoConversation(conversation.id),
      t.infoCreated(conversation.createdAt),
      t.infoLastMessage(lastLine),
      ...(notes.length > 0 ? [t.infoNotes, ...notes.map((n) => `- ${n.text}`)] : []),
      t.infoAssigned(String(assigned)),
      t.infoHidePolicy(policy, conversation.hiddenAt != null),
    ].filter((line) => line !== "");
    await this.send(event, lines.join("\n"));
    this.logger.info("command_executed", { conversationId: conversation.id, status: "/info" });
  }

  private async assign(senderId: number, args: string[], conversation: ConversationRecord, event: OperatorMessageEvent): Promise<void> {
    const t = OPERATOR_TEXTS(await this.deps.users.effectiveLanguageOf(event.sender));
    const target = args.join(" ").trim();
    if (!target) {
      await this.send(event, t.usageAssign);
      return;
    }
    const op = await this.deps.operators.resolveByTarget(target);
    if (!op) {
      await this.send(event, t.unknownRestoreTarget);
      return;
    }
    await this.deps.conversations.setAssignedOperatorId(conversation.id, op.id);
    await this.send(event, t.assigned(target));
    this.logger.info("command_executed", { conversationId: conversation.id, telegramUserId: senderId, status: "/assign" });
  }

  private async note(senderId: number, args: string[], conversation: ConversationRecord, event: OperatorMessageEvent): Promise<void> {
    const t = OPERATOR_TEXTS(await this.deps.users.effectiveLanguageOf(event.sender));
    const noteText = args.join(" ").trim();
    if (!noteText) {
      await this.send(event, t.usageNote);
      return;
    }
    const operator = await this.db.operators.getByTelegramUserId(senderId);
    await this.db.notes.create(
      { conversationId: conversation.id, operatorId: operator?.id ?? "unknown", text: noteText },
      this.runtime.now(),
    );
    await this.send(event, t.noteSaved);
    this.logger.info("command_executed", { conversationId: conversation.id, status: "/note" });
  }

  private async rename(senderId: number, args: string[], conversation: ConversationRecord, event: OperatorMessageEvent): Promise<void> {
    const t = OPERATOR_TEXTS(await this.deps.users.effectiveLanguageOf(event.sender));
    const name = args.join(" ").trim();
    if (!name) {
      await this.send(event, t.usageRename);
      return;
    }
    try {
      // TopicService persists the title too, so an auto-recovered topic (manual
      // delete → user messages → recreate) keeps the operator's name.
      await this.deps.topics.renameTopic(conversation, name);
      await this.send(event, t.topicRenamed(name));
      this.logger.info("command_executed", { conversationId: conversation.id, telegramUserId: senderId, status: "/rename" });
    } catch (err) {
      await this.send(event, t.renameFailed);
      this.logger.info("command_failed", {
        conversationId: conversation.id,
        telegramUserId: senderId,
        status: "/rename",
        errorKind: err instanceof TelegramError ? err.kind : "unknown",
      });
    }
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
  private async delMessage(event: OperatorMessageEvent, conversation: ConversationRecord): Promise<void> {
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

  private async hide(args: string[], conversation: ConversationRecord, event: OperatorMessageEvent): Promise<void> {
    const t = OPERATOR_TEXTS(await this.deps.users.effectiveLanguageOf(event.sender));
    const arg = args.join(" ").trim().toLowerCase();
    let hours: number | null;
    if (arg === "" || arg === "default") hours = null;
    else if (arg === "off" || arg === "0") hours = 0;
    else if (/^\d+$/.test(arg) && Number(arg) > 0) hours = Number(arg);
    else {
      await this.send(event, t.usageHide);
      return;
    }
    await this.deps.conversations.setHideAfterHours(conversation.id, hours);
    if (conversation.hiddenAt != null) {
      await this.deps.hides.restore(conversation);
    }
    const label = hours != null && hours > 0 ? t.hidePolicyHours(hours) : t.hidePolicyPermanent;
    await this.send(event, t.hideUpdated(label));
    this.logger.info("command_executed", { conversationId: conversation.id, status: "/hide" });
  }

  private async ban(adminId: number, conversation: ConversationRecord, event: OperatorMessageEvent): Promise<void> {
    const t = OPERATOR_TEXTS(await this.deps.users.effectiveLanguageOf(event.sender));
    await this.db.blocks.create(
      { telegramUserId: conversation.telegramUserId, createdByTelegramUserId: adminId },
      this.runtime.now(),
    );
    await this.send(event, t.userBlocked);
    this.logger.info("block_added", { telegramUserId: conversation.telegramUserId });
    this.logger.info("command_executed", { conversationId: conversation.id, telegramUserId: adminId, status: "/ban" });
  }

  private async unban(adminId: number, conversation: ConversationRecord, event: OperatorMessageEvent): Promise<void> {
    const t = OPERATOR_TEXTS(await this.deps.users.effectiveLanguageOf(event.sender));
    await this.db.blocks.deleteByTelegramUserId(conversation.telegramUserId);
    await this.send(event, t.userUnblocked);
    this.logger.info("block_removed", { telegramUserId: conversation.telegramUserId });
    this.logger.info("command_executed", { conversationId: conversation.id, telegramUserId: adminId, status: "/unban" });
  }

  /** Group-level /ban · /unban by target (admin only): operates on the blocks
   *  table directly, keyed by telegram_user_id — the same resolution the
   *  message hot path uses — so a user with no conversation/topic (e.g. a
   *  first-contact ad auto-block) is still reachable. */
  private async banUnbanByTarget(adminId: number, cmd: string, args: string[], event: OperatorMessageEvent): Promise<void> {
    const t = OPERATOR_TEXTS(await this.deps.users.effectiveLanguageOf(event.sender));
    if (!(await this.deps.operators.isAdmin(adminId))) {
      await this.send(event, t.adminOnly);
      this.logger.info("command_rejected", { telegramUserId: adminId, status: `admin_only:${cmd}` });
      return;
    }
    const telegramUserId = await this.resolveBanTarget(args.join(" ").trim());
    if (telegramUserId == null) {
      await this.send(event, t.unknownRestoreTarget);
      return;
    }
    if (cmd === "/ban") {
      // blocks.telegram_user_id is UNIQUE — a repeat /ban must not re-create.
      const existing = await this.db.blocks.getByTelegramUserId(telegramUserId);
      if (!existing) {
        await this.db.blocks.create({ telegramUserId, createdByTelegramUserId: adminId }, this.runtime.now());
      }
      await this.send(event, t.userBlocked);
      this.logger.info("block_added", { telegramUserId });
    } else {
      await this.db.blocks.deleteByTelegramUserId(telegramUserId);
      await this.send(event, t.userUnblocked);
      this.logger.info("block_removed", { telegramUserId });
    }
    this.logger.info("command_executed", { telegramUserId: adminId, status: cmd, mode: "target" });
  }

  /** Resolve a ban target: a bare telegram_user_id (resolves even with no
   *  user row — blocks are keyed by id alone), or @username via the users table. */
  private async resolveBanTarget(target: string): Promise<number | null> {
    if (/^\d+$/.test(target)) return Number(target);
    if (target.startsWith("@")) {
      const user = await this.db.users.getByUsername(target.slice(1));
      return user?.telegramUserId ?? null;
    }
    return null;
  }

  /** /ad — admin-only runtime ad management: blocklist add/del/list, allowlist
   *  management (`/ad allow`), the link-count rule (`/ad links`), and
   *  quarantine recovery (`/ad restore` — reply to a quarantined copy). The
   *  blocklist is also seeded from AD_KEYWORDS at boot. */
  private async ad(senderId: number, args: string[], event: OperatorMessageEvent): Promise<void> {
    const t = OPERATOR_TEXTS(await this.deps.users.effectiveLanguageOf(event.sender));
    if (!(await this.deps.operators.isAdmin(senderId))) {
      await this.send(event, t.adminOnly);
      this.logger.info("command_rejected", { telegramUserId: senderId, status: "admin_only:/ad" });
      return;
    }
    const [action, ...rest] = args;
    const word = rest.join(" ").trim();
    switch (action) {
      case undefined:
      case "list": {
        const keywords = await this.deps.ad.listKeywords();
        const links = await this.deps.ad.getMaxLinks();
        const lines = keywords.length > 0 ? [t.adListHeader(keywords.length), ...keywords] : [t.adEmpty];
        lines.push(links > 0 ? t.adLinksCurrent(links) : t.adLinksOff);
        await this.send(event, lines.join("\n"));
        break;
      }
      case "allow": {
        await this.adAllow(rest, event, t);
        break;
      }
      case "links": {
        await this.adLinks(rest, event, t);
        break;
      }
      case "restore": {
        await this.adRestore(event, t);
        break;
      }
      case "add": {
        if (word.length === 0) {
          await this.send(event, t.adUsage);
          return;
        }
        await this.deps.ad.addKeyword(word);
        await this.send(event, t.adAdded(word));
        break;
      }
      case "del": {
        if (word.length === 0) {
          await this.send(event, t.adUsage);
          return;
        }
        const removed = await this.deps.ad.removeKeyword(word);
        await this.send(event, removed ? t.adRemoved(word) : t.adEmpty);
        break;
      }
      default:
        await this.send(event, t.adUsage);
    }
    this.logger.info("command_executed", { telegramUserId: senderId, status: "/ad", kind: action ?? "list" });
  }

  /** /ad allow — runtime allowlist (an allow match overrides the blocklist:
   *  a keyword on both lists clears the message). */
  private async adAllow(rest: string[], event: OperatorMessageEvent, t: OperatorTexts): Promise<void> {
    const [sub, ...subArgs] = rest;
    const word = subArgs.join(" ").trim();
    switch (sub) {
      case undefined:
      case "list": {
        const allow = await this.deps.ad.listAllowKeywords();
        await this.send(event, allow.length === 0 ? t.adAllowEmpty : [t.adAllowListHeader(allow.length), ...allow].join("\n"));
        return;
      }
      case "add": {
        if (word.length === 0) {
          await this.send(event, t.adAllowUsage);
          return;
        }
        await this.deps.ad.addAllowKeyword(word);
        await this.send(event, t.adAllowAdded(word));
        return;
      }
      case "del": {
        if (word.length === 0) {
          await this.send(event, t.adAllowUsage);
          return;
        }
        const removed = await this.deps.ad.removeAllowKeyword(word);
        await this.send(event, removed ? t.adAllowRemoved(word) : t.adAllowEmpty);
        return;
      }
      default:
        await this.send(event, t.adAllowUsage);
    }
  }

  /** /ad links — set/clear the link-count rule (`/ad links 3`, `/ad links
   *  off`), or show the current value with no argument. */
  private async adLinks(rest: string[], event: OperatorMessageEvent, t: OperatorTexts): Promise<void> {
    if (rest.length === 0) {
      const current = await this.deps.ad.getMaxLinks();
      await this.send(event, current > 0 ? t.adLinksCurrent(current) : t.adLinksOff);
      return;
    }
    const raw = rest.join(" ").trim().toLowerCase();
    if (raw === "off" || raw === "0") {
      await this.deps.ad.setMaxLinks(0);
      await this.send(event, t.adLinksSet("off"));
      return;
    }
    if (/^\d+$/.test(raw) && Number(raw) > 0) {
      const n = Number(raw);
      await this.deps.ad.setMaxLinks(n);
      await this.send(event, t.adLinksSet(String(n)));
      return;
    }
    await this.send(event, t.adLinksUsage);
  }

  /** /ad restore — reply to a quarantined copy in the quarantine topic to
   *  forward it back into the sender's conversation. Only the message is
   *  recovered; unblocking stays a separate /unban. */
  private async adRestore(event: OperatorMessageEvent, t: OperatorTexts): Promise<void> {
    if (event.replyToMessageId == null) {
      await this.send(event, t.adRestoreUsage);
      return;
    }
    const entry = await this.deps.quarantine.lookup(event.replyToMessageId);
    if (!entry) {
      await this.send(event, t.adRestoreNotFound);
      return;
    }
    // A first-contact ad auto-block may have zero user rows — ensure the user
    // (minimal profile) and open their conversation before the restore.
    let user = await this.deps.users.getByTelegramUserId(entry.userId);
    if (!user) {
      const result = await this.deps.users.getOrCreate({
        telegramUserId: entry.userId,
        username: null,
        firstName: String(entry.userId),
        lastName: null,
        languageCode: null,
        isBot: false,
      });
      user = result.user;
    }
    const conversation = await this.deps.conversations.grantAccess(user);
    await this.deps.quarantine.restore(entry, conversation);
    await this.send(event, t.adRestoreDone);
  }

  private async deleteConversation(adminId: number, conversation: ConversationRecord, event: OperatorMessageEvent): Promise<void> {
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
  private async deletePicker(sender: UserProfile, chatId: number): Promise<void> {
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
  private async rerenderPicker(chatId: number, messageId: number, t: OperatorTexts): Promise<void> {
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
  private async pickerMarkup(conversations: ConversationRecord[], t: OperatorTexts): Promise<InlineKeyboard> {
    const buttons: InlineKeyboardButton[] = [];
    for (const c of conversations) {
      const user = await this.deps.users.getByTelegramUserId(c.telegramUserId);
      const name = user?.firstName ?? String(c.telegramUserId);
      buttons.push({ text: t.deleteButtonLabel(name, user?.username ?? null), callbackData: `del:${c.id}` });
    }
    return { buttons };
  }

  /** /restore at group level: restore by @username, telegram_user_id, or conversation id. */
  private async restore(senderId: number, args: string[], event: OperatorMessageEvent): Promise<void> {
    const t = OPERATOR_TEXTS(await this.deps.users.effectiveLanguageOf(event.sender));
    const target = args.join(" ").trim();
    if (!target) {
      await this.send(event, t.usageRestore);
      return;
    }
    const conversation = await this.resolveConversationTarget(target);
    if (!conversation) {
      await this.send(event, t.unknownRestoreTarget);
      return;
    }
    await this.deps.hides.restore(conversation);
    await this.send(event, t.conversationRestored);
    this.logger.info("command_executed", { conversationId: conversation.id, telegramUserId: senderId, status: "/restore" });
  }

  /** /lang — switch the sender's language, wherever the command was posted
   *  (a topic, the group's general chat, or the bot's private chat). Shared by
   *  the operator dispatcher here and the user private-chat route, which
   *  delegates through `this.deps.commands.lang`. The reply copy is identical
   *  across the user and operator lexicons. */
  async lang(sender: UserProfile, args: string[], target: { chatId: number; messageThreadId?: number }): Promise<void> {
    // The sender may set /lang before ever messaging as a user — guarantee a
    // row so the preference persists on first contact (same as the user path).
    await this.deps.users.getOrCreate(sender);
    const current = await this.deps.users.effectiveLanguageOf(sender);
    const arg = args[0]?.toLowerCase();
    const reply = (text: string): Promise<void> => this.sendTo(target.chatId, target.messageThreadId, text);
    if (arg == null) {
      await reply(OPERATOR_TEXTS(current).langCurrent(current));
      return;
    }
    if (arg === "en" || arg === "zh") {
      await this.deps.users.setPreferredLanguage(sender.telegramUserId, arg);
      await this.deps.syncUserMenu(sender.telegramUserId, arg);
      await reply(OPERATOR_TEXTS(arg).langSet);
      this.logger.info("command_executed", { telegramUserId: sender.telegramUserId, status: "/lang" });
      return;
    }
    if (arg === "auto") {
      await this.deps.users.setPreferredLanguage(sender.telegramUserId, null);
      await this.deps.syncUserMenu(sender.telegramUserId, "auto");
      await reply(OPERATOR_TEXTS(await this.deps.users.effectiveLanguageOf(sender)).langAuto);
      this.logger.info("command_executed", { telegramUserId: sender.telegramUserId, status: "/lang" });
      return;
    }
    await reply(OPERATOR_TEXTS(current).langUsage);
    this.logger.info("command_invalid", { telegramUserId: sender.telegramUserId, status: "/lang" });
  }

  /** /selfcheck — admin-only re-run of the boot config self-check, with the
   *  report delivered where the command was posted (anywhere in the group). */
  private async selfcheck(senderId: number, event: OperatorMessageEvent): Promise<void> {
    const t = OPERATOR_TEXTS(await this.deps.users.effectiveLanguageOf(event.sender));
    if (!(await this.deps.operators.isAdmin(senderId))) {
      await this.send(event, t.adminOnly);
      this.logger.info("command_rejected", { telegramUserId: senderId, status: "admin_only:/selfcheck" });
      return;
    }
    const report = await this.deps.selfCheck.run();
    await this.send(event, t.selfcheckReport(report));
    this.logger.info("command_executed", { telegramUserId: senderId, status: "/selfcheck" });
  }

  private async adminOnly(
    fn: () => Promise<void>,
    senderId: number,
    event: OperatorMessageEvent,
    cmd: string,
  ): Promise<void> {
    if (!(await this.deps.operators.isAdmin(senderId))) {
      await this.send(event, OPERATOR_TEXTS(await this.deps.users.effectiveLanguageOf(event.sender)).adminOnly);
      this.logger.info("command_rejected", { telegramUserId: senderId, status: `admin_only:${cmd}` });
      return;
    }
    await fn();
  }

  /** `/delete` must never remove the requester's own conversation, the bot's,
   *  or a staff member's — deleting the support team's own threads (and
   *  resetting the owner's access) is always a mistake, whichever delete path
   *  is used. */
  private async isProtectedDeleteTarget(senderTelegramUserId: number, conversation: ConversationRecord): Promise<boolean> {
    if (conversation.telegramUserId === senderTelegramUserId) return true;
    if (conversation.telegramUserId === this.botTelegramUserId) return true;
    return this.deps.operators.isOperator(conversation.telegramUserId);
  }

  private async resolveConversationTarget(target: string): Promise<ConversationRecord | null> {
    if (/^\d+$/.test(target)) {
      const byUser = await this.deps.conversations.getByTelegramUserId(Number(target));
      if (byUser) return byUser;
    }
    if (target.startsWith("@")) {
      const user = await this.db.users.getByUsername(target.slice(1));
      if (!user) return null;
      return this.deps.conversations.getByTelegramUserId(user.telegramUserId);
    }
    return this.deps.conversations.getById(target);
  }

  private async send(event: OperatorMessageEvent, text: string): Promise<void> {
    await this.sendTo(event.chatId, event.messageThreadId ?? undefined, text);
  }

  /** Send into an arbitrary chat (group general chat, a topic, or a private
   *  chat) — shared by the event-shaped helpers and the picker/list methods. */
  private async sendTo(chatId: number, messageThreadId: number | undefined, text: string): Promise<void> {
    await this.telegram.sendMessage({ chatId, messageThreadId, text });
  }
}