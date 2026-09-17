// ---------------------------------------------------------------------------
// CommandService (task 8.2-8.11): the operator-facing command dispatcher. This
// module is now a thin facade — the actual handlers live in the per-domain
// command classes (AdCommands / DeleteCommands / ConversationCommands) over the
// shared CommandBase. All of them are exported here so the services barrel
// keeps exposing just CommandService + CommandsDeps.
//
// Commands posted inside a mapped topic resolve the conversation by topic and
// run scoped to it. /restore and /help also work at the group's general chat.
// /ban /unban /delete are ADMIN-only; everything else is OPERATOR+.
// Usernames only resolve targets for assignment/restore — they grant nothing.
// ---------------------------------------------------------------------------

import { parseCommand, type ConversationDeleteEvent, type OperatorMessageEvent, type UserProfile } from "@relaytg/shared";
import { OPERATOR_TEXTS } from "./texts.ts";
import type { ServiceContext } from "./service-context.ts";
import { CommandBase, type CommandsDeps } from "./command-base.ts";
import { AdCommands } from "./ad-commands.ts";
import { DeleteCommands } from "./delete-commands.ts";
import { ConversationCommands } from "./conversation-commands.ts";

export type { CommandsDeps } from "./command-base.ts";

export class CommandService extends CommandBase {
  private readonly adCommands: AdCommands;
  private readonly deleteCommands: DeleteCommands;
  private readonly conversationCommands: ConversationCommands;

  constructor(ctx: ServiceContext, deps: CommandsDeps) {
    super(ctx, deps);
    this.adCommands = new AdCommands(ctx, deps);
    this.deleteCommands = new DeleteCommands(ctx, deps);
    this.conversationCommands = new ConversationCommands(ctx, deps);
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
      await this.conversationCommands.restore(sender.telegramUserId, args, event);
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
      await this.adCommands.ad(sender.telegramUserId, args, event);
      return;
    }

    if (event.messageThreadId == null) {
      // Group-level /ban · /unban by target: a blocked user may have no
      // conversation at all (a first-contact ad was auto-blocked before any
      // row existed), so a bare telegram_user_id or @username reaches them
      // without a topic context.
      if ((cmd === "/ban" || cmd === "/unban") && args.length > 0) {
        await this.conversationCommands.banUnbanByTarget(sender.telegramUserId, cmd, args, event);
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
        await this.conversationCommands.info(conversation, event);
        return;
      case "/assign":
        await this.conversationCommands.assign(sender.telegramUserId, args, conversation, event);
        return;
      case "/note":
        await this.conversationCommands.note(sender.telegramUserId, args, conversation, event);
        return;
      case "/rename":
        await this.conversationCommands.rename(sender.telegramUserId, args, conversation, event);
        return;
      case "/delete":
        // Reply to a topic message → retract its delivered copy from the user's
        // chat (OPERATOR+); without a reply it deletes the whole conversation
        // (ADMIN only).
        if (event.replyToMessageId != null) {
          await this.deleteCommands.delMessage(event, conversation);
        } else {
          await this.adminOnly(() => this.deleteCommands.deleteConversation(sender.telegramUserId, conversation, event), sender.telegramUserId, event, "/delete");
        }
        return;
      case "/hide":
        await this.conversationCommands.hide(args, conversation, event);
        return;
      case "/ban":
        await this.adminOnly(() => this.conversationCommands.ban(sender.telegramUserId, conversation, event), sender.telegramUserId, event, "/ban");
        return;
      case "/unban":
        await this.adminOnly(() => this.conversationCommands.unban(sender.telegramUserId, conversation, event), sender.telegramUserId, event, "/unban");
        return;
      default:
        await this.send(event, t.unknownCommand);
        this.logger.info("command_invalid", { telegramUserId: sender.telegramUserId, status: cmd });
    }
  }

  /** /list — delegating to DeleteCommands (shared with the staff private chat). */
  async listAll(sender: UserProfile, chatId: number): Promise<void> {
    await this.deleteCommands.listAll(sender, chatId);
  }

  /** /delete at group level / private chat — delegating to DeleteCommands. */
  async deleteFromList(sender: UserProfile, chatId: number, args: string[]): Promise<void> {
    await this.deleteCommands.deleteFromList(sender, chatId, args);
  }

  /** Callback tap on a delete-picker button — delegating to DeleteCommands. */
  async handleDeleteTap(event: ConversationDeleteEvent): Promise<void> {
    await this.deleteCommands.handleDeleteTap(event);
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
}