// ---------------------------------------------------------------------------
// ApprovalService (task 5.5): the `/apply` human-approval path.
// One pending application per unapproved user; the notification with
// Approve/Reject buttons is posted to the support group. Approve sets
// users.approved_at, promotes the applicant to the OPERATOR role, opens the
// conversation (topic + welcome) and re-registers the command menu so the new
// operator's support-group menu appears; reject notifies the user and creates
// nothing. Decisions are ADMIN-only, and a double-tap on an already-handled
// button is a no-op.
// ---------------------------------------------------------------------------

import { displayName, type UserProfile } from "@relaytg/shared";
import type { Database, Runtime, TelegramClient } from "../ports.ts";
import type { InlineKeyboard } from "../telegram-types.ts";
import type { Config, Logger } from "@relaytg/shared";
import type { ServiceContext } from "./service-context.ts";
import type { ConversationService } from "./conversation-service.ts";
import type { BotInfo, BotRegistry } from "./bot-registry.ts";
import { OPERATOR_TEXTS, TEXTS, languageOf, resolveLanguage } from "./texts.ts";
import { effectiveLanguageOf } from "./effective-language.ts";

export type ApplyOutcome = "submitted" | "pending" | "already_approved" | "already_connected";
export type DecideOutcome = "handled" | "unauthorized" | "not_found" | "already_decided";

/** Settings key under which the applicant's bot is remembered at decide time.
 *  Applications are global per human, but the approved user must be contacted
 *  through the bot they actually messaged (and, on approval, the conversation
 *  must open with that bot), so `/apply` records the source bot here. */
const APP_BOT_KEY = (applicationId: string): string => `app_bot:${applicationId}`;

export class ApprovalService {
  private readonly db: Database;
  private readonly telegram: TelegramClient;
  private readonly bots: BotRegistry;
  private readonly runtime: Runtime;
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly conversations: ConversationService;
  private readonly isAdmin: (telegramUserId: number) => Promise<boolean>;
  /** Re-register the command menu after a role change (approval → OPERATOR). */
  private readonly refreshMenus: () => Promise<void>;

  constructor(
    ctx: ServiceContext,
    conversations: ConversationService,
    isAdmin: (telegramUserId: number) => Promise<boolean>,
    refreshMenus: () => Promise<void>,
  ) {
    this.db = ctx.db;
    this.telegram = ctx.telegram;
    this.bots = ctx.bots;
    this.runtime = ctx.runtime;
    this.config = ctx.config;
    this.logger = ctx.logger;
    this.conversations = conversations;
    this.isAdmin = isAdmin;
    this.refreshMenus = refreshMenus;
  }

  /** Applicant feedback goes through the bot they messaged (only that bot has
   *  the private chat with them); the group notice stays on the PRIMARY bot. */
  async apply(profile: UserProfile, bot: BotInfo): Promise<ApplyOutcome> {
    const { user } = await this.db.users.upsertProfile(profile, this.runtime.now());
    // The applicant's language drives their feedback and the group notice (the
    // notice is created on the applicant's behalf; admins read it in their own
    // language). A stored /lang preference wins over the detected code.
    const userTexts = TEXTS(languageOf(user));
    const staffTexts = OPERATOR_TEXTS(languageOf(user));

    if (user.approvedAt != null) {
      await bot.client.sendMessage({ chatId: user.telegramUserId, text: userTexts.applyAlreadyApproved });
      return "already_approved";
    }
    // Verification is per (bot, user): "already connected" applies only when the
    // user already passed the gate on the SAME bot they're applying through —
    // on any other bot they are still an unverified stranger who may apply.
    if (await this.db.users.getVerifiedAt(bot.botId, user.telegramUserId)) {
      await bot.client.sendMessage({ chatId: user.telegramUserId, text: userTexts.applyAlreadyConnected });
      return "already_connected";
    }

    const latest = await this.db.applications.getLatestByTelegramUserId(user.telegramUserId);
    if (latest && latest.status === "pending") {
      await bot.client.sendMessage({ chatId: user.telegramUserId, text: userTexts.applyPending });
      return "pending";
    }

    const app = await this.db.applications.create({ telegramUserId: user.telegramUserId }, this.runtime.now());
    // Remember which bot the applicant contacted — decide() uses it to reach
    // them and to open their conversation with the right bot.
    await this.db.settings.set(APP_BOT_KEY(app.id), bot.botId);
    const name = displayName(user);
    const notice = staffTexts.applyNotice(name, user.telegramUserId, user.username);
    await this.telegram.sendMessage({
      chatId: this.config.supportGroupId,
      text: notice,
      replyMarkup: decisionKeyboard(app.id, staffTexts.approveButton, staffTexts.rejectButton),
    });
    await bot.client.sendMessage({ chatId: user.telegramUserId, text: userTexts.applySubmitted });
    this.logger.info("application_created", { telegramUserId: user.telegramUserId });
    return "submitted";
  }

  async decide(
    sender: UserProfile,
    decision: "approve" | "reject",
    applicationId: string,
    callbackQueryId: string,
    bot: BotInfo,
  ): Promise<DecideOutcome> {
    // Decision callbacks answer the person tapping the button, so they follow
    // the acting admin's language; the applicant's feedback uses their profile.
    // `bot` is the acting bot — for the support-group notice buttons that is the
    // PRIMARY bot alone (the group gate ignores the other bots' copies).
    const staffTexts = OPERATOR_TEXTS(await effectiveLanguageOf(this.db, sender));

    if (!(await this.isAdmin(sender.telegramUserId))) {
      await bot.client.answerCallbackQuery({
        callbackQueryId,
        text: staffTexts.onlyAdmins,
        showAlert: true,
      });
      return "unauthorized";
    }

    const app = await this.db.applications.getById(applicationId);
    if (!app) {
      await bot.client.answerCallbackQuery({ callbackQueryId, text: staffTexts.applicationNotFound, showAlert: true });
      return "not_found";
    }
    if (app.status !== "pending") {
      await bot.client.answerCallbackQuery({
        callbackQueryId,
        text: TEXTS(await effectiveLanguageOf(this.db, sender)).alreadyHandled,
        showAlert: true,
      });
      return "already_decided";
    }

    // The applicant's feedback and their conversation must land on the bot they
    // messaged (recorded by apply()); a decision on an application that never
    // recorded a bot falls back to PRIMARY.
    const applicantBot = await this.applicantBotFor(app.id);

    const now = this.runtime.now();
    await this.db.transaction(async (tx) => {
      await tx.applications.update({
        id: app.id,
        status: decision === "approve" ? "approved" : "rejected",
        decidedAt: now,
        decidedByTelegramUserId: sender.telegramUserId,
      });
      if (decision === "approve") {
        await tx.users.setApprovedAt(app.telegramUserId, now);
        // Approval is the operator-application path: promote to OPERATOR (never
        // demote an existing ADMIN — the repository's upsert already guarantees it).
        const existing = await tx.operators.getByTelegramUserId(app.telegramUserId);
        if (!existing) {
          await tx.operators.upsert({ telegramUserId: app.telegramUserId, role: "OPERATOR" }, now);
        }
      }
    });
    this.logger.info("application_decided", { telegramUserId: app.telegramUserId, status: decision });

    if (decision === "approve") {
      // The new operator's support-group menu should appear immediately. The
      // registration is fully guarded internally, so a Telegram hiccup here
      // cannot fail the decision that already committed.
      await this.refreshMenus().catch(() => this.logger.warn("command_menu_failed", { scope: "after_approval" }));

      const user = await this.db.users.getByTelegramUserId(app.telegramUserId);
      if (user) {
        // Approval is already persisted; failures here only log, and the user's
        // next contact self-heals the conversation.
        if (user.purpose == null) {
          // First-contact purpose gate: approved but never stated a purpose —
          // ask before any conversation or topic is created.
          try {
            await applicantBot.client.sendMessage({
              chatId: user.telegramUserId,
              text: TEXTS(languageOf(user)).purposePrompt,
            });
            this.logger.info("purpose_prompted", { telegramUserId: user.telegramUserId });
          } catch {
            this.logger.warn("purpose_prompted", { telegramUserId: user.telegramUserId, status: "send_failed" });
          }
        } else {
          try {
            await this.conversations.grantAccess(user, applicantBot);
          } catch {
            this.logger.warn("conversation_created", {
              telegramUserId: user.telegramUserId,
              status: "grant_failed",
            });
          }
        }
      }
      await bot.client.answerCallbackQuery({ callbackQueryId, text: staffTexts.approvedAsOperator, showAlert: false });
    } else {
      const applicant = await this.db.users.getByTelegramUserId(app.telegramUserId);
      await applicantBot.client.sendMessage({
        chatId: app.telegramUserId,
        text: TEXTS(applicant ? languageOf(applicant) : resolveLanguage(null)).applyRejected,
      });
      await bot.client.answerCallbackQuery({ callbackQueryId, text: staffTexts.rejected, showAlert: false });
    }
    return "handled";
  }

  /** The bot an application was filed through (recorded by apply()); unknown or
   *  legacy applications fall back to PRIMARY. */
  private async applicantBotFor(applicationId: string): Promise<BotInfo> {
    const stored = await this.db.settings.get(APP_BOT_KEY(applicationId));
    if (stored != null && stored.length > 0) {
      try {
        return this.bots.get(stored);
      } catch {
        // A bot that was removed from BOTS after the application: fall through.
      }
    }
    return this.bots.primary();
  }
}

function decisionKeyboard(applicationId: string, approveLabel: string, rejectLabel: string): InlineKeyboard {
  return {
    buttons: [
      { text: approveLabel, callbackData: `apply:approve:${applicationId}` },
      { text: rejectLabel, callbackData: `apply:reject:${applicationId}` },
    ],
  };
}
