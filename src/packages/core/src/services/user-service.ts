// ---------------------------------------------------------------------------
// UserService (task 5.1): get-or-create by telegram_user_id, refresh profile
// fields on every contact, reject bot senders, manage per-(bot, user) human
// verification (markVerified) and the global purpose/language fields.
// Username is display-only and never an identity key.
// ---------------------------------------------------------------------------

import type { UserProfile, UserRecord } from "@relaytg/shared";
import type { Database, Runtime } from "../ports.ts";
import type { Logger } from "@relaytg/shared";
import type { BotInfo } from "./bot-registry.ts";
import type { ServiceContext } from "./service-context.ts";
import type { Language } from "./texts.ts";
import { effectiveLanguageOf } from "./effective-language.ts";

export class UserService {
  private readonly db: Database;
  private readonly runtime: Runtime;
  private readonly logger: Logger;

  constructor(ctx: ServiceContext) {
    this.db = ctx.db;
    this.runtime = ctx.runtime;
    this.logger = ctx.logger;
  }

  /**
   * Identity-level rejection for senders core must not process at all.
   * Telegram bots are ignored before any database write happens.
   */
  rejectionReason(profile: UserProfile): "bot" | null {
    return profile.isBot ? "bot" : null;
  }

  async getOrCreate(profile: UserProfile): Promise<{ user: UserRecord; created: boolean }> {
    const result = await this.db.users.upsertProfile(profile, this.runtime.now());
    if (result.created) {
      this.logger.info("user_created", { telegramUserId: profile.telegramUserId });
    } else {
      this.logger.info("user_profile_refreshed", { telegramUserId: profile.telegramUserId });
    }
    return result;
  }

  async getByTelegramUserId(telegramUserId: number): Promise<UserRecord | null> {
    return this.db.users.getByTelegramUserId(telegramUserId);
  }

  /** Set (or clear with null) the user's manual `/lang` override. */
  async setPreferredLanguage(telegramUserId: number, language: string | null): Promise<void> {
    await this.db.users.setPreferredLanguage(telegramUserId, language, this.runtime.now());
    this.logger.info("user_language_changed", { telegramUserId, language: language ?? "auto" });
  }

  /** Effective language for outbound messages to a sender: a stored `/lang`
   *  preference wins over the Telegram-detected code. */
  effectiveLanguageOf(profile: UserProfile): Promise<Language> {
    return effectiveLanguageOf(this.db, profile);
  }

  /** Set the verification flag on the given bot; idempotent once set.
   *  Verification is per (bot, user) — the flag for one bot never grants
   *  access on another. */
  async markVerified(telegramUserId: number, bot: BotInfo): Promise<void> {
    await this.db.users.setVerifiedAt(bot.botId, telegramUserId, this.runtime.now());
    this.logger.info("user_verified", { telegramUserId, botId: bot.botId });
  }

  /** Record the purpose stated at first contact (来意) and return the updated
   *  record, so the caller opens the conversation with the purpose already on
   *  the record the topic card reads. */
  async setPurpose(telegramUserId: number, purpose: string): Promise<UserRecord> {
    await this.db.users.setPurpose(telegramUserId, purpose, this.runtime.now());
    const user = await this.db.users.getByTelegramUserId(telegramUserId);
    if (!user) throw new Error("user row vanished while recording purpose");
    this.logger.info("purpose_recorded", { telegramUserId });
    return user;
  }
}
