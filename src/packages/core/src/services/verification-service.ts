// ---------------------------------------------------------------------------
// VerificationService (task 5.4): the four-choice arithmetic gate.
// A fresh challenge is issued on first contact; taps consume attempts and
// re-ask in place with re-ordered options; non-button content re-asks without
// consuming an attempt; expiry is lazy (checked on tap, no background timer).
// A correct answer marks the (bot, user) pair verified — conversation creation
// is the relay pipeline's job.
// ---------------------------------------------------------------------------

import type { UserProfile } from "@relaytg/shared";
import type { Database, Runtime, VerificationStore, VerificationState } from "../ports.ts";
import type { InlineKeyboard } from "../telegram-types.ts";
import type { Config, Logger } from "@relaytg/shared";
import type { BotInfo } from "./bot-registry.ts";
import type { ServiceContext } from "./service-context.ts";
import { generateArithmeticQuestion, shuffle } from "./arithmetic.ts";
import { TEXTS } from "./texts.ts";
import { effectiveLanguageOf } from "./effective-language.ts";

export type AnswerOutcome =
  | { outcome: "correct" }
  | { outcome: "wrong"; state: VerificationState }
  | { outcome: "exhausted" }
  | { outcome: "expired" }
  | { outcome: "no_challenge" };

export class VerificationService {
  private readonly db: Database;
  private readonly runtime: Runtime;
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly store: VerificationStore;

  constructor(ctx: ServiceContext) {
    this.db = ctx.db;
    this.runtime = ctx.runtime;
    this.config = ctx.config;
    this.logger = ctx.logger;
    this.store = ctx.verificationStore;
  }

  /** Unverified (on THIS bot) and unapproved users still need the arithmetic
   *  gate. Verification is per (bot, user): passing it on one bot never marks
   *  the human verified on another, so every bot runs the gate independently.
   *  Approval stays global — an approved/operator human skips the gate everywhere. */
  async isEligible(bot: BotInfo, user: { telegramUserId: number; approvedAt: string | null }): Promise<boolean> {
    if (user.approvedAt != null) return false;
    return (await this.db.users.getVerifiedAt(bot.botId, user.telegramUserId)) == null;
  }

  /** Issue a fresh challenge through `bot` (the bot whose chat the user is in).
   *  Challenges are stored per (bot, user) so two bots never overwrite each
   *  other's gate. */
  async startChallenge(profile: UserProfile, bot: BotInfo): Promise<void> {
    const challenge = generateArithmeticQuestion();
    const now = this.runtime.now();
    const state: VerificationState = {
      challengeId: this.runtime.randomId(),
      expression: challenge.expression,
      answer: challenge.answer,
      choices: challenge.choices,
      attemptsLeft: this.config.verification.attempts,
      expiresAt: new Date(now.getTime() + this.config.verification.ttlSeconds * 1000).toISOString(),
      questionMessageId: null,
    };
    const messageId = await bot.client.sendMessage({
      chatId: profile.telegramUserId,
      text: TEXTS(await effectiveLanguageOf(this.db, profile)).verifyQuestion(challenge.expression),
      replyMarkup: this.choicesKeyboard(challenge.choices),
    });
    state.questionMessageId = messageId;
    await this.store.set(bot.botId, profile.telegramUserId, state);
    this.logger.info("verification_issued", { telegramUserId: profile.telegramUserId, botId: bot.botId });
  }

  /**
   * Re-ask in place with re-ordered options. `consumeAttempt` is true only for
   * wrong button taps — non-button content never burns an attempt.
   */
  async reAsk(profile: UserProfile, state: VerificationState, consumeAttempt: boolean, bot: BotInfo): Promise<VerificationState> {
    const next: VerificationState = {
      ...state,
      choices: shuffle(state.choices),
      attemptsLeft: consumeAttempt ? state.attemptsLeft - 1 : state.attemptsLeft,
    };
    const text = TEXTS(await effectiveLanguageOf(this.db, profile)).verifyQuestion(next.expression);
    if (next.questionMessageId != null) {
      await bot.client.editMessageText({
        chatId: profile.telegramUserId,
        messageId: next.questionMessageId,
        text,
        replyMarkup: this.choicesKeyboard(next.choices),
      });
    } else {
      const messageId = await bot.client.sendMessage({
        chatId: profile.telegramUserId,
        text,
        replyMarkup: this.choicesKeyboard(next.choices),
      });
      next.questionMessageId = messageId;
    }
    await this.store.set(bot.botId, profile.telegramUserId, next);
    return next;
  }

  /** Handle a `verify:<answer>` callback tap from `bot`'s chat. */
  async answer(profile: UserProfile, answer: number, bot: BotInfo): Promise<AnswerOutcome> {
    const state = await this.store.get(bot.botId, profile.telegramUserId);
    if (!state) return { outcome: "no_challenge" };

    const now = this.runtime.now();
    if (new Date(state.expiresAt).getTime() < now.getTime()) {
      await this.store.delete(bot.botId, profile.telegramUserId);
      this.logger.info("verification_expired", { telegramUserId: profile.telegramUserId, botId: bot.botId });
      return { outcome: "expired" };
    }

    if (state.answer === answer) {
      await this.store.delete(bot.botId, profile.telegramUserId);
      // Verified on THIS bot only — the user must pass the gate separately on
      // every other bot they contact.
      await this.db.users.setVerifiedAt(bot.botId, profile.telegramUserId, now);
      this.logger.info("verification_correct", { telegramUserId: profile.telegramUserId, botId: bot.botId });
      return { outcome: "correct" };
    }

    this.logger.info("verification_wrong", {
      telegramUserId: profile.telegramUserId,
      botId: bot.botId,
      attempt: state.attemptsLeft,
    });
    if (state.attemptsLeft <= 1) {
      await this.store.delete(bot.botId, profile.telegramUserId);
      return { outcome: "exhausted" };
    }
    const nextState = await this.reAsk(profile, state, true, bot);
    return { outcome: "wrong", state: nextState };
  }

  /**
   * Non-button content from an eligible user in `bot`'s chat: re-ask without
   * consuming an attempt if a challenge is pending, otherwise issue a fresh
   * challenge (restart-after-expiry on the next contact).
   */
  async nonButtonContent(profile: UserProfile, bot: BotInfo): Promise<void> {
    const state = await this.store.get(bot.botId, profile.telegramUserId);
    if (state && new Date(state.expiresAt).getTime() >= this.runtime.now().getTime()) {
      await this.reAsk(profile, state, false, bot);
    } else {
      await this.startChallenge(profile, bot);
    }
  }

  async clear(telegramUserId: number, bot: BotInfo): Promise<void> {
    await this.store.delete(bot.botId, telegramUserId);
  }

  private choicesKeyboard(choices: number[]): InlineKeyboard {
    return {
      buttons: choices.map((c) => ({ text: String(c), callbackData: `verify:${c}` })),
    };
  }
}
