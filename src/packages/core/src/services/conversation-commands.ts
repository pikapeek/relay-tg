// ---------------------------------------------------------------------------
// ConversationCommands: the topic-scoped conversation commands — /info,
// /assign, /note, /rename, /hide, /ban, /unban and /restore. Split out of
// CommandService so command dispatch stays a thin facade; group-level /ban
// /unban by target lives here too since it shares the ban handlers.
// ---------------------------------------------------------------------------

import { TelegramError, type ConversationRecord, type OperatorMessageEvent } from "@relaytg/shared";
import type { ServiceContext } from "./service-context.ts";
import { OPERATOR_TEXTS } from "./texts.ts";
import { CommandBase, type CommandsDeps } from "./command-base.ts";

export class ConversationCommands extends CommandBase {
  constructor(ctx: ServiceContext, deps: CommandsDeps) {
    super(ctx, deps);
  }

  async info(conversation: ConversationRecord, event: OperatorMessageEvent): Promise<void> {
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

  async assign(senderId: number, args: string[], conversation: ConversationRecord, event: OperatorMessageEvent): Promise<void> {
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

  async note(senderId: number, args: string[], conversation: ConversationRecord, event: OperatorMessageEvent): Promise<void> {
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

  async rename(senderId: number, args: string[], conversation: ConversationRecord, event: OperatorMessageEvent): Promise<void> {
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

  async hide(args: string[], conversation: ConversationRecord, event: OperatorMessageEvent): Promise<void> {
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

  async ban(adminId: number, conversation: ConversationRecord, event: OperatorMessageEvent): Promise<void> {
    const t = OPERATOR_TEXTS(await this.deps.users.effectiveLanguageOf(event.sender));
    await this.db.blocks.create(
      { telegramUserId: conversation.telegramUserId, createdByTelegramUserId: adminId },
      this.runtime.now(),
    );
    await this.send(event, t.userBlocked);
    this.logger.info("block_added", { telegramUserId: conversation.telegramUserId });
    this.logger.info("command_executed", { conversationId: conversation.id, telegramUserId: adminId, status: "/ban" });
  }

  async unban(adminId: number, conversation: ConversationRecord, event: OperatorMessageEvent): Promise<void> {
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
  async banUnbanByTarget(adminId: number, cmd: string, args: string[], event: OperatorMessageEvent): Promise<void> {
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
  async resolveBanTarget(target: string): Promise<number | null> {
    if (/^\d+$/.test(target)) return Number(target);
    if (target.startsWith("@")) {
      const user = await this.db.users.getByUsername(target.slice(1));
      return user?.telegramUserId ?? null;
    }
    return null;
  }

  /** /restore at group level: restore by @username, telegram_user_id, or conversation id. */
  async restore(senderId: number, args: string[], event: OperatorMessageEvent): Promise<void> {
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
}