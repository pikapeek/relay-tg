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
  protected readonly runtime: Runtime;
  protected readonly config: Config;
  protected readonly logger: Logger;
  protected readonly deps: CommandsDeps;
  /** The bot's own telegram_user_id, resolved at boot (getMe) — see the
   *  ServiceContext doc comment. Guards /delete against the bot's own thread. */
  protected readonly botTelegramUserId: number | undefined;

  constructor(ctx: ServiceContext, deps: CommandsDeps) {
    this.db = ctx.db;
    this.telegram = ctx.telegram;
    this.runtime = ctx.runtime;
    this.config = ctx.config;
    this.logger = ctx.logger;
    this.deps = deps;
    this.botTelegramUserId = ctx.botTelegramUserId;
  }

  protected async send(event: OperatorMessageEvent, text: string): Promise<void> {
    await this.sendTo(event.chatId, event.messageThreadId ?? undefined, text);
  }

  /** Send into an arbitrary chat (group general chat, a topic, or a private
   *  chat) — shared by the event-shaped helpers and the picker/list methods. */
  protected async sendTo(chatId: number, messageThreadId: number | undefined, text: string): Promise<void> {
    await this.telegram.sendMessage({ chatId, messageThreadId, text });
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

  /** `/delete` must never remove the requester's own conversation, the bot's,
   *  or a staff member's — deleting the support team's own threads (and
   *  resetting the owner's access) is always a mistake, whichever delete path
   *  is used. */
  protected async isProtectedDeleteTarget(senderTelegramUserId: number, conversation: ConversationRecord): Promise<boolean> {
    if (conversation.telegramUserId === senderTelegramUserId) return true;
    if (conversation.telegramUserId === this.botTelegramUserId) return true;
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
