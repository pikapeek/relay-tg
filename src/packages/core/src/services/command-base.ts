// ---------------------------------------------------------------------------
// CommandBase: the shared surface of the operator-command classes. CommandService
// (the dispatcher) and the per-domain command classes (ad/delete/conversation)
// all extend it, so the Telegram/sender plumbing — replies, admin gating, the
// /delete protection rules and conversation-target resolution — lives exactly
// once. See service-context.ts for the deps bundle shape.
// ---------------------------------------------------------------------------

import { type ConversationRecord, type Config, type Logger, type OperatorMessageEvent } from "@relaytg/shared";
import type { Database, Runtime, TelegramClient } from "../ports.ts";
import type { ServiceContext } from "./service-context.ts";
import type { BotInfo, BotRegistry } from "./bot-registry.ts";
import type { ConversationService } from "./conversation-service.ts";
import type { HideService } from "./hide-service.ts";
import type { OperatorService } from "./operator-service.ts";
import type { UserService } from "./user-service.ts";
import type { UserMenuChoice } from "./command-menu.ts";
import type { SelfCheckService } from "./selfcheck-service.ts";
import type { AdDetectionService } from "./ad-service.ts";
import type { QuarantineService } from "./quarantine-service.ts";
import type { TopicService } from "./topic-service.ts";
import { OPERATOR_TEXTS } from "./texts.ts";

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

export abstract class CommandBase {
  protected readonly db: Database;
  protected readonly telegram: TelegramClient;
  protected readonly bots: BotRegistry;
  protected readonly runtime: Runtime;
  protected readonly config: Config;
  protected readonly logger: Logger;
  protected readonly deps: CommandsDeps;

  constructor(ctx: ServiceContext, deps: CommandsDeps) {
    this.db = ctx.db;
    this.telegram = ctx.telegram;
    this.bots = ctx.bots;
    this.runtime = ctx.runtime;
    this.config = ctx.config;
    this.logger = ctx.logger;
    this.deps = deps;
  }

  /** The client that owns a reply: the event's bot for private-chat call sites,
   *  the PRIMARY bot (the group control surface) when none is given. */
  protected clientFor(bot?: BotInfo): TelegramClient {
    return bot?.client ?? this.telegram;
  }

  protected async send(event: OperatorMessageEvent, text: string, bot?: BotInfo): Promise<void> {
    await this.sendTo(event.chatId, event.messageThreadId ?? undefined, text, bot);
  }

  /** Send into an arbitrary chat (group general chat, a topic, or a private
   *  chat) — shared by the event-shaped helpers and the picker/list methods.
   *  Group replies default to the PRIMARY bot; private-chat call sites pass the
   *  event's bot so the reply lands in the chat the operator is actually in. */
  protected async sendTo(chatId: number, messageThreadId: number | undefined, text: string, bot?: BotInfo): Promise<void> {
    await this.clientFor(bot).sendMessage({ chatId, messageThreadId, text });
  }

  protected async adminOnly(
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

  /** `/delete` must never remove the requester's own conversation, one with any
   *  configured bot as its owner (a user who only ever talked to the bot is the
   *  bot's own thread, and only removing the row would reset that bot's access),
   *  or a staff member's — deleting the support team's own threads is always a
   *  mistake, whichever delete path is used. */
  protected async isProtectedDeleteTarget(senderTelegramUserId: number, conversation: ConversationRecord): Promise<boolean> {
    if (conversation.telegramUserId === senderTelegramUserId) return true;
    if (this.bots.list().some((b) => b.botTelegramUserId === conversation.telegramUserId)) return true;
    return this.deps.operators.isOperator(conversation.telegramUserId);
  }

  protected async resolveConversationTarget(target: string): Promise<ConversationRecord | null> {
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
}
