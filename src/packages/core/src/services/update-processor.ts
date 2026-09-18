// ---------------------------------------------------------------------------
// UpdateProcessor (task 7): idempotent ingestion for every internal event.
//
// Order of rejection guarantees (task 7.4): bot-ignore, block, rate-limit /
// spam, and the verification gate all produce zero user/conversation/topic/
// message rows and are never relayed. Idempotency (7.1) claims the update_id
// before any work, with the UNIQUE messages(chat_id, message_id) index as the
// storage backstop. Each event runs inside the per-conversation serializer
// (7.5).
// ---------------------------------------------------------------------------

import type {
  Config,
  Logger,
  ConversationRecord,
  MessageContent,
  UserProfile,
  UserRecord,
} from "@relaytg/shared";
import type {
  ApplicationDecisionEvent,
  ConversationDeleteEvent,
  EditedOperatorMessageEvent,
  EditedUserMessageEvent,
  InboundEvent,
  OperatorMessageEvent,
  ProcessResult,
  UserMessageEvent,
  VerificationAnswerEvent,
} from "@relaytg/shared";
import type { Database, Runtime, Serializer } from "../ports.ts";
import { TOPIC_PIN_KEY } from "../ports.ts";
import type { ServiceContext } from "./service-context.ts";
import type { BotInfo, BotRegistry } from "./bot-registry.ts";
import type { ApprovalService } from "./approval-service.ts";
import type { CommandService } from "./command-service.ts";
import type { ConversationService } from "./conversation-service.ts";
import type { HideService } from "./hide-service.ts";
import type { MediaGroupService } from "./media-group-service.ts";
import type { OperatorService } from "./operator-service.ts";
import type { Relayer } from "./relayer.ts";
import type { SelfCheckService } from "./selfcheck-service.ts";
import type { SpamService } from "./spam-service.ts";
import type { AdCheckResult, AdDetectionService } from "./ad-service.ts";
import type { TopicService } from "./topic-service.ts";
import type { UserService } from "./user-service.ts";
import type { VerificationService } from "./verification-service.ts";
import type { PendingService } from "./pending-service.ts";
import type { QuarantineService } from "./quarantine-service.ts";
import { OPERATOR_TEXTS, TEXTS } from "./texts.ts";
import { effectiveLanguageOf } from "./effective-language.ts";
import type { UserMenuChoice } from "./command-menu.ts";
import { messageText, parseCommand } from "@relaytg/shared";

export interface ProcessDeps {
  users: UserService;
  conversations: ConversationService;
  operators: OperatorService;
  verification: VerificationService;
  approvals: ApprovalService;
  hides: HideService;
  spam: SpamService;
  /** Ad-text detection (广告防护); enforcement is auto-block + quarantine. */
  ad: AdDetectionService;
  /** Quarantine topic: ad hits are forwarded there for admin review + `/ad restore`. */
  quarantine: QuarantineService;
  /** Pre-gate message queue: pre-verification messages are flushed after the
   *  user passes the verification + purpose gates. */
  pending: PendingService;
  commands: CommandService;
  /** Create/delete support-group forum topics and post the user-info card. */
  topics: TopicService;
  /** Re-apply a user's command menus after their /lang change. */
  syncUserMenu: (telegramUserId: number, lang: UserMenuChoice) => Promise<void>;
  /** Album aggregation: buffers media-group items and flushes them as one album. */
  mediaGroups: MediaGroupService;
  /** Boot config self-check; admin /selfcheck re-runs it and replies with a report. */
  selfCheck: SelfCheckService;
}

export class UpdateProcessor {
  private readonly db: Database;
  private readonly bots: BotRegistry;
  private readonly runtime: Runtime;
  private readonly config: Config;
  private readonly logger: Logger;
  private readonly serializer: Serializer;
  private readonly deps: ProcessDeps;
  private readonly relayer: Relayer;

  constructor(ctx: ServiceContext, deps: ProcessDeps, relayer: Relayer) {
    this.db = ctx.db;
    this.bots = ctx.bots;
    this.runtime = ctx.runtime;
    this.config = ctx.config;
    this.logger = ctx.logger;
    this.serializer = ctx.serializer;
    this.deps = deps;
    this.relayer = relayer;
  }

  /** Entry point: resolve the event's bot, dedupe, then serialize by
   *  conversation, then handle. `botId` names the bot the update arrived
   *  through (webhook path) and falls back to the PRIMARY bot — so single-bot
   *  callers (and every existing test) can omit it. */
  async process(updateId: number, event: InboundEvent, botId?: string): Promise<ProcessResult> {
    if (event.kind === "ignored") {
      this.logger.info("update_ignored", { updateId });
      return { status: "ignored" };
    }

    const bot = this.bots.get(botId ?? this.bots.primaryBotId);
    const claimed = await this.db.processedUpdates.claim(bot.botId, updateId, this.runtime.now());
    if (!claimed) {
      this.logger.info("update_duplicate", { updateId, botId: bot.botId });
      if (event.kind === "verification_answer" || event.kind === "application_decision" || event.kind === "conversation_delete") {
        await bot.client
          .answerCallbackQuery({
            callbackQueryId: event.callbackQueryId,
            text: TEXTS(await effectiveLanguageOf(this.db, event.sender)).alreadyHandled,
            showAlert: false,
          })
          .catch(() => {});
      }
      return { status: "duplicate" };
    }

    this.logger.info("update_received", { updateId, botId: bot.botId });
    // A processing error must not escape to the webhook: the update is already
    // claimed, so a 4xx/5xx to Telegram would only trigger a retry that the
    // claim then drops as a duplicate — a silent at-most-once delivery plus a
    // retry storm. Report the failure honestly instead and let Telegram keep
    // the rest of the queue flowing.
    let result: ProcessResult;
    try {
      result = await this.serializer.runExclusive(this.keyFor(event, bot.botId), () => this.processEvent(updateId, event, bot));
    } catch (err) {
      this.logger.error("system_error", { errorKind: "process" });
      return { status: "error" };
    }
    this.logger.info("update_processed", { updateId, status: result.status, conversationId: result.conversationId });
    return result;
  }

  private async processEvent(updateId: number, event: InboundEvent, bot: BotInfo): Promise<ProcessResult> {
    switch (event.kind) {
      case "user_message":
        return this.handleUserMessage(updateId, event, bot);
      case "operator_message":
        return this.handleOperatorMessage(event, bot);
      case "edited_user_message":
        return this.handleEditedUserMessage(event, bot);
      case "edited_operator_message":
        return this.handleEditedOperatorMessage(event, bot);
      case "verification_answer":
        return this.handleVerificationAnswer(event, bot);
      case "application_decision":
        return this.handleApplicationDecision(event, bot);
      case "conversation_delete":
        return this.handleConversationDelete(event, bot);
      default:
        return { status: "ignored" };
    }
  }

  // -------------------------------------------------------------------------

  private async handleUserMessage(updateId: number, event: UserMessageEvent, bot: BotInfo): Promise<ProcessResult> {
    // 1. bot-ignore (defense in depth; the parser already filters bots)
    if (this.deps.users.rejectionReason(event.sender) === "bot") {
      this.logger.info("update_ignored", { updateId });
      return { status: "ignored" };
    }
    // 2. block check
    if (await this.db.blocks.getByTelegramUserId(event.sender.telegramUserId)) {
      this.logger.info("message_rejected", { telegramUserId: event.sender.telegramUserId, status: "blocked" });
      return { status: "blocked" };
    }
    // 2b. ad-text detection (before the gates: a first-contact spammer is
    // caught with zero user/conversation rows created). Only users who have not
    // passed human verification (on THIS bot) are subject to the blacklist — a
    // human verified on the bot they are messaging is trusted and may say e.g.
    // "加微信" without being auto-blocked. A hit drops the message, auto-blocks
    // the user (per config) and notifies the support group.
    const existing = await this.deps.users.getByTelegramUserId(event.sender.telegramUserId);
    // "Behind the gates" — an unknown user or one who hasn't passed verification
    // (on THIS bot) or approval. Verification is per (bot, user), so the gate is
    // evaluated against the bot the message arrived through. Shared by the
    // ad-text check (2b) and the verification gate (5).
    const gated = existing == null || (await this.deps.verification.isEligible(bot, existing));
    if (gated) {
      const adCheck = await this.deps.ad.detect(event.content);
      if (adCheck.detected) {
        await this.enforceAd(event, adCheck, bot);
        return { status: "message_rejected" };
      }
    }
    // 3. rate limit / content checks
    if (!(await this.spamAllowed(event.sender.telegramUserId))) {
      return { status: "rate_limited" };
    }
    const contentCheck = this.deps.spam.checkContent(event.content);
    if (contentCheck !== "ok") {
      this.logger.info("message_rejected", { telegramUserId: event.sender.telegramUserId, contentType: event.content.type, status: contentCheck });
      return { status: "message_rejected" };
    }
    // 4. commands (read-only user lookup — the gate must not create rows)
    if (event.content.type === "text" && event.content.text.startsWith("/")) {
      return this.handleUserCommand(event, bot);
    }
    // 5. verification gate — operators/admins are trusted and skip it entirely;
    //    everyone else gets a challenge only while not yet verified/approved.
    //    (`existing` was fetched at the ad-text check above.)
    const isStaff = await this.deps.operators.isOperator(event.sender.telegramUserId);
    if (!isStaff && gated) {
      // What the user wrote is not lost: queue it for the post-gate flush that
      // forwards later messages once they pass verification + purpose. (Ad and
      // rate/flood-limited messages were already rejected above and never
      // enqueued, so the flush needs no re-checks.)
      await this.deps.pending.enqueue(bot.botId, event.sender.telegramUserId, event.messageId, event.content.type, event.replyToMessageId);
      await this.deps.verification.nonButtonContent(event.sender, bot);
      return { status: "verification_issued" };
    }
    // 6. verified/approved (or staff) → ensure user/conversation, restore hidden, relay
    const { user } = await this.deps.users.getOrCreate(event.sender);
    if (isStaff && (await this.deps.verification.isEligible(bot, user))) {
      // Staff never see the challenge; record it (on this bot) so a later
      // registry removal (no longer staff) doesn't re-gate a known trusted
      // human on this bot.
      await this.deps.users.markVerified(user.telegramUserId, bot);
    }
    // 7. First-contact purpose gate: a verified/approved first-timer states
    //    their purpose before any conversation or topic is created. This very
    //    message IS the purpose statement — commands were routed above and can
    //    never land here, so text/photo captions both qualify. The statement is
    //    relayed into the topic and pinned as its first message (the card is
    //    just the user-info display).
    if (await this.purposeGatePending(user, isStaff)) {
      const conversation = await this.recordPurposeAndOpen(user, event, bot);
      await this.flushPending(user, conversation, bot);
      return { status: "processed", conversationId: conversation.id };
    }
    const conversation = await this.deps.conversations.grantAccess(user, bot);
    if (conversation.hiddenAt != null) {
      await this.deps.hides.restore(conversation);
    }
    // Album items are acknowledged immediately and delivered as one gallery by
    // MediaGroupService once the aggregation window closes.
    if (event.mediaGroupId != null) {
      this.deps.mediaGroups.push(conversation, event);
      return { status: "processed", conversationId: conversation.id };
    }
    await this.relayer.relayUserToOperator(conversation, event);
    return { status: "processed", conversationId: conversation.id };
  }

  private async handleUserCommand(event: UserMessageEvent, bot: BotInfo): Promise<ProcessResult> {
    const text = event.content.type === "text" ? event.content.text.trim() : "";
    // Strip a trailing @botusername (Telegram appends it in groups/topics), so
    // `/start@relaytg_bot` behaves exactly like `/start`.
    const { cmd, args } = parseCommand(text);
    const sender = event.sender;
    const existing = await this.deps.users.getByTelegramUserId(sender.telegramUserId);

    if (cmd === "/start") {
      const isStaff = await this.deps.operators.isOperator(sender.telegramUserId);
      if (!isStaff && (!existing || (await this.deps.verification.isEligible(bot, existing)))) {
        // Non-button path: re-ask in place while a challenge is still live
        // instead of minting a fresh one — /start is not an attempt-remint
        // exploit. A user who burned all attempts still cannot reset them by
        // restarting. Only an expired (or absent) challenge starts fresh.
        await this.deps.verification.nonButtonContent(sender, bot);
        return { status: "verification_issued" };
      }
      // Staff (or already verified/approved) go straight in. A staff first
      // contact may have no user row yet — upsert, then open the conversation.
      const { user } = await this.deps.users.getOrCreate(sender);
      if (isStaff && (await this.deps.verification.isEligible(bot, user))) {
        await this.deps.users.markVerified(user.telegramUserId, bot);
      }
      // Purpose gate on /start: a granted user who never stated a purpose is
      // re-asked — /start alone must not silently open a topic for them.
      if (await this.purposeGatePending(user, isStaff)) {
        await bot.client.sendMessage({
          chatId: sender.telegramUserId,
          text: TEXTS(await effectiveLanguageOf(this.db, sender)).purposePrompt,
        });
        this.logger.info("purpose_prompted", { telegramUserId: user.telegramUserId });
        return { status: "purpose_pending" };
      }
      const conversation = await this.deps.conversations.grantAccess(user, bot);
      await this.flushPending(user, conversation, bot);
      return { status: "processed", conversationId: conversation.id };
    }

    // Non-/start commands: handled per their own rules; a user who is still
    // waiting to state a purpose is re-asked afterwards — a command never
    // counts as a purpose and never opens a conversation.
    switch (cmd) {
      case "/apply": {
        const outcome = await this.deps.approvals.apply(sender, bot);
        if (outcome !== "submitted") void outcome;
        break;
      }
      case "/help": {
        // Staff get the full operator command list even in private chat; only
        // non-staff get the user-facing pointer to /start.
        const { operator, user, staff } = await this.commandTextsOf(sender);
        await bot.client.sendMessage({ chatId: sender.telegramUserId, text: operator ? staff.helpGeneral : user.userHelp });
        break;
      }
      case "/lang": {
        // Reachable pre-gate on purpose: switch the bot's language before
        // proving you're human. The shared implementation guarantees a row so
        // the preference persists even on first contact.
        await this.deps.commands.lang(sender, args, { chatId: sender.telegramUserId }, bot);
        break;
      }
      case "/selfcheck": {
        // Admin-only re-run of the boot config self-check, delivered in the
        // private chat (the group-level route lives in CommandService).
        const { operator, user, staff } = await this.commandTextsOf(sender);
        if (!operator) {
          await bot.client.sendMessage({ chatId: sender.telegramUserId, text: user.userHelp });
          break;
        }
        if (!(await this.deps.operators.isAdmin(sender.telegramUserId))) {
          await bot.client.sendMessage({ chatId: sender.telegramUserId, text: staff.adminOnly });
          break;
        }
        const report = await this.deps.selfCheck.run();
        await bot.client.sendMessage({ chatId: sender.telegramUserId, text: staff.selfcheckReport(report) });
        this.logger.info("command_executed", { telegramUserId: sender.telegramUserId, status: "/selfcheck" });
        break;
      }
      case "/list":
      case "/delete": {
        // Staff-only, private-chat copies of the group-level conversation tools:
        // a regular user just gets the /start pointer. /delete's admin check
        // lives inside CommandService.
        const { operator, user } = await this.commandTextsOf(sender);
        if (!operator) {
          await bot.client.sendMessage({ chatId: sender.telegramUserId, text: user.userHelp });
          break;
        }
        if (cmd === "/list") {
          await this.deps.commands.listAll(sender, event.chatId, bot);
        } else {
          await this.deps.commands.deleteFromList(sender, event.chatId, args, bot);
        }
        break;
      }
      default: {
        // Unknown command: an operator is pointed at /help (their commands need
        // a topic context, which private chat lacks); a regular user just gets
        // the /start pointer.
        const { operator, user, staff } = await this.commandTextsOf(sender);
        await bot.client.sendMessage({
          chatId: sender.telegramUserId,
          text: operator ? staff.unknownCommand : user.userHelp,
        });
        this.logger.info("command_invalid", { telegramUserId: sender.telegramUserId, status: cmd });
        break;
      }
    }

    await this.repeatPurposePromptIfPending(sender, bot);
    return { status: "command_handled" };
  }

  private async handleOperatorMessage(event: OperatorMessageEvent, bot: BotInfo): Promise<ProcessResult> {
    // Only the configured support group is a control surface: a bot that is
    // also present in any other group must not accept operator commands there,
    // and a coincidental foreign topic id must not relay into a user's chat.
    if (event.chatId !== this.config.supportGroupId) return { status: "ignored" };
    // Every bot receives a copy of each group message via its webhook, but the
    // group control surface belongs to the PRIMARY bot alone — the others'
    // copies are ignored (they were claimed above, so they still dedupe).
    if (bot.botId !== this.bots.primaryBotId) return { status: "ignored" };
    // Command-shaped messages always reach the dispatcher: it holds the role
    // check itself, so an unregistered sender gets the notOperator refusal
    // instead of a silent drop. Non-command content from non-operators is
    // ignored outright.
    if (event.content.type === "text" && event.content.text.trim().startsWith("/")) {
      await this.deps.commands.handleOperatorCommand(event);
      return { status: "command_handled" };
    }
    if (!(await this.deps.operators.isOperator(event.sender.telegramUserId))) {
      this.logger.info("message_rejected", { telegramUserId: event.sender.telegramUserId, status: "not_operator" });
      return { status: "ignored" };
    }
    if (event.messageThreadId == null) return { status: "ignored" };
    const conversation = await this.deps.conversations.getByTopicId(event.messageThreadId);
    if (!conversation) return { status: "ignored" };
    await this.relayer.relayOperatorToUser(conversation, event);
    this.logger.info("message_relayed", { conversationId: conversation.id, direction: "OPERATOR_TO_USER", telegramUserId: conversation.telegramUserId });
    return { status: "processed", conversationId: conversation.id };
  }

  private async handleEditedUserMessage(event: EditedUserMessageEvent, bot: BotInfo): Promise<ProcessResult> {
    // Edits must pass the same rejection chain as fresh messages: a blocked user
    // must not be able to keep re-writing text into the support group by
    // editing a previously-relayed message.
    if (this.deps.users.rejectionReason(event.sender) === "bot") {
      return { status: "ignored" };
    }
    if (await this.db.blocks.getByTelegramUserId(event.sender.telegramUserId)) {
      this.logger.info("message_rejected", { telegramUserId: event.sender.telegramUserId, status: "blocked", kind: "edit" });
      return { status: "blocked" };
    }
    // Editing a message into an ad must be caught the same way as a fresh one —
    // and, like a fresh one, only for users who have not passed verification
    // on THIS bot.
    const existing = await this.deps.users.getByTelegramUserId(event.sender.telegramUserId);
    if (existing == null || (await this.deps.verification.isEligible(bot, existing))) {
      const adCheck = await this.deps.ad.detect(event.content);
      if (adCheck.detected) {
        await this.enforceAd(event, adCheck, bot);
        return { status: "message_rejected" };
      }
    }
    if (!(await this.spamAllowed(event.sender.telegramUserId))) {
      return { status: "rate_limited" };
    }
    const contentCheck = this.deps.spam.checkContent(event.content);
    if (contentCheck !== "ok") {
      this.logger.info("message_rejected", {
        telegramUserId: event.sender.telegramUserId,
        contentType: event.content.type,
        status: contentCheck,
        kind: "edit",
      });
      return { status: "message_rejected" };
    }
    await this.relayer.editUserMessage(event);
    return { status: "processed" };
  }

  private async handleEditedOperatorMessage(event: EditedOperatorMessageEvent, bot: BotInfo): Promise<ProcessResult> {
    // Same surface rule as operator messages: the support group only, and only
    // registered operators may edit-deliver into a user's chat. The group
    // control surface belongs to the PRIMARY bot alone — other bots' copies of
    // the edit are ignored.
    if (event.chatId !== this.config.supportGroupId) return { status: "ignored" };
    if (bot.botId !== this.bots.primaryBotId) return { status: "ignored" };
    if (!(await this.deps.operators.isOperator(event.sender.telegramUserId))) {
      this.logger.info("message_rejected", { telegramUserId: event.sender.telegramUserId, status: "not_operator", kind: "edit" });
      return { status: "ignored" };
    }
    await this.relayer.editOperatorMessage(event);
    return { status: "processed" };
  }

  private async handleVerificationAnswer(event: VerificationAnswerEvent, bot: BotInfo): Promise<ProcessResult> {
    const t = TEXTS(await effectiveLanguageOf(this.db, event.sender));
    if (await this.db.blocks.getByTelegramUserId(event.sender.telegramUserId)) {
      await this.answerCallback(event.callbackQueryId, t.verifyBlocked, true, bot);
      return { status: "blocked" };
    }
    if (!(await this.spamAllowed(event.sender.telegramUserId))) {
      await this.answerCallback(event.callbackQueryId, t.tooManyRequests, true, bot);
      return { status: "rate_limited" };
    }

    const outcome = await this.deps.verification.answer(event.sender, event.answer, bot);
    switch (outcome.outcome) {
      case "correct": {
        const { user } = await this.deps.users.getOrCreate(event.sender);
        // verification.answer() already persisted the per-(bot, user) verified
        // mark (and logged verification_correct) — the relay only consumes it.
        // The challenge message, its callback answer and the purpose prompt all
        // live in the bot's private chat with the user — they go through the
        // bot the user answered.
        await bot.client
          .editMessageText({ chatId: event.chatId, messageId: event.messageId, text: t.verifyCorrect })
          .catch(() => {});
        await this.answerCallback(event.callbackQueryId, t.verifyCorrect, false, bot);
        // First-contact purpose gate: a verified user who has never stated a
        // purpose must state one before any conversation or topic is created.
        if (user.purpose == null) {
          await bot.client.sendMessage({ chatId: event.chatId, text: t.purposePrompt });
          this.logger.info("purpose_prompted", { telegramUserId: user.telegramUserId });
          return { status: "purpose_pending" };
        }
        const conversation = await this.deps.conversations.grantAccess(user, bot);
        await this.flushPending(user, conversation, bot);
        return { status: "processed", conversationId: conversation.id };
      }
      case "wrong":
        await this.answerCallback(event.callbackQueryId, t.verifyWrong, false, bot);
        return { status: "verification_issued" };
      case "exhausted":
        await bot.client.sendMessage({ chatId: event.chatId, text: t.verifyExpired });
        await this.answerCallback(event.callbackQueryId, t.outOfAttempts, true, bot);
        return { status: "message_rejected" };
      case "expired":
        await bot.client.sendMessage({ chatId: event.chatId, text: t.verifyExpired });
        await this.answerCallback(event.callbackQueryId, t.challengeExpired, true, bot);
        return { status: "message_rejected" };
      case "no_challenge":
        await this.answerCallback(event.callbackQueryId, t.noActiveChallenge, true, bot);
        return { status: "ignored" };
    }
  }

  private async handleApplicationDecision(event: ApplicationDecisionEvent, bot: BotInfo): Promise<ProcessResult> {
    // The notice with the Approve/Reject buttons lives in the support group, so
    // every bot receives a copy of the tap — but the decision is a group
    // control-surface action and only the PRIMARY bot processes it.
    if (event.chatId === this.config.supportGroupId && bot.botId !== this.bots.primaryBotId) {
      return { status: "ignored" };
    }
    const outcome = await this.deps.approvals.decide(
      event.sender,
      event.decision,
      event.applicationId,
      event.callbackQueryId,
      bot,
    );
    return { status: outcome === "handled" ? "command_handled" : "ignored" };
  }

  /** Tap on a `del:<conversation_id>` picker button. The tap handler owns the
   *  admin check, the deletion, the callback toast and the picker re-render.
   *  A group picker (support group) is a control-surface action handled by the
   *  PRIMARY bot alone; a private-chat picker goes through the bot that owns
   *  that chat. */
  private async handleConversationDelete(event: ConversationDeleteEvent, bot: BotInfo): Promise<ProcessResult> {
    if (event.chatId === this.config.supportGroupId && bot.botId !== this.bots.primaryBotId) {
      return { status: "ignored" };
    }
    await this.deps.commands.handleDeleteTap(event, bot);
    return { status: "command_handled" };
  }

  // -------------------------------------------------------------------------

  /** Purpose-gate step: consume the incoming message as the user's purpose
   *  statement (text, or a media caption, or a placeholder), persist it, and
   *  open the conversation with a SINGLE pinned opening message that carries the
   *  purpose plus the user's info — the purpose statement itself is not
   *  forwarded into the topic. The topic is created with `postCard: false` so
   *  that combined card is the only card posted. */
  private async recordPurposeAndOpen(user: UserRecord, event: UserMessageEvent, bot: BotInfo): Promise<ConversationRecord> {
    const fresh = await this.deps.users.setPurpose(user.telegramUserId, purposeTextOf(event.content));

    const conversation = await this.deps.conversations.grantAccess(fresh, bot, { postCard: false });
    const cardId = await this.deps.topics.postIdentityCard(conversation.telegramTopicId!, fresh, {
      purpose: fresh.purpose ?? undefined,
      pin: true,
      bot,
    });
    // Persist the first pinned card's id so `/delete` can refuse to retract it —
    // the pin is only ever removed by deleting the conversation itself.
    if (cardId != null) {
      await this.db.settings.set(TOPIC_PIN_KEY(conversation.id), String(cardId));
    }
    return conversation;
  }

  /** Resolve the operator-vs-user reply texts for a command sender with a single
   *  language lookup and a single role check, shared by the private-chat
   *  command branches that pick between the staff and user lexicons. */
  private async commandTextsOf(sender: UserProfile): Promise<{
    operator: boolean;
    user: ReturnType<typeof TEXTS>;
    staff: ReturnType<typeof OPERATOR_TEXTS>;
  }> {
    const lang = await effectiveLanguageOf(this.db, sender);
    return {
      operator: await this.deps.operators.isOperator(sender.telegramUserId),
      user: TEXTS(lang),
      staff: OPERATOR_TEXTS(lang),
    };
  }

  /** Re-ask the purpose prompt after a non-/start command: a granted user who
   *  still hasn't stated a purpose is handled per the command's rules but a
   *  command never counts as the purpose and never opens a conversation. */
  private async repeatPurposePromptIfPending(sender: UserProfile, bot: BotInfo): Promise<void> {
    const user = await this.deps.users.getByTelegramUserId(sender.telegramUserId);
    if (!user || !(await this.purposeGatePending(user))) return;
    await bot.client.sendMessage({
      chatId: sender.telegramUserId,
      text: TEXTS(await effectiveLanguageOf(this.db, sender)).purposePrompt,
    });
    this.logger.info("purpose_prompted", { telegramUserId: sender.telegramUserId });
  }

  /** First-contact purpose gate: a user with no stated purpose must state one
   *  before any conversation or topic is created. The gate applies to both
   *  entry paths — /start verification and /apply approval — and an approval
   *  even promotes the applicant to OPERATOR, so a user with a persisted
   *  `approvedAt` is gated regardless of role. Registry-seeded staff (ADMIN /
   *  OPERATOR who were never approved) are trusted and skip it. `isStaff` —
   *  when the caller already resolved the role — skips the extra registry
   *  lookup on the every-message hot path. */
  private async purposeGatePending(user: UserRecord, isStaff?: boolean): Promise<boolean> {
    if (user.purpose != null) return false;
    if (user.approvedAt != null) return true;
    if (isStaff !== undefined) return !isStaff;
    return !(await this.deps.operators.isOperator(user.telegramUserId));
  }

  // -------------------------------------------------------------------------

  private keyFor(event: InboundEvent, botId: string): string {
    // Serializer keys carry the botId so the same user's (or thread's) events
    // on two bots serialize independently — a bot1 message must never stall
    // behind a bot2 message of the same user.
    switch (event.kind) {
      case "user_message":
        return `u:${botId}:${event.sender.telegramUserId}`;
      case "edited_user_message":
        return `u:${botId}:${event.sender.telegramUserId}`;
      case "verification_answer":
        return `u:${botId}:${event.sender.telegramUserId}`;
      case "operator_message":
        return `t:${botId}:${event.messageThreadId ?? "general"}`;
      case "edited_operator_message":
        return `t:${botId}:${event.messageThreadId ?? "general"}`;
      case "application_decision":
        return `app:${botId}:${event.applicationId}`;
      case "conversation_delete":
        return `del:${botId}:${event.conversationId}`;
      case "ignored":
        return "ignored";
    }
  }

  private async spamAllowed(telegramUserId: number): Promise<boolean> {
    const result = this.deps.spam.checkAllowed(telegramUserId, this.runtime.now());
    if (result !== "ok") {
      this.logger.info(this.isFlood(result) ? "flood_restricted" : "rate_limited", { telegramUserId });
      return false;
    }
    return true;
  }

  private isFlood(result: string): result is "flood_restricted" {
    return result === "flood_restricted";
  }

  private async answerCallback(callbackQueryId: string, text: string, showAlert: boolean, bot: BotInfo): Promise<void> {
    // The callback belongs to the bot the user is talking to — answering it via
    // any other bot fails with "query is too old / invalid".
    await bot.client.answerCallbackQuery({ callbackQueryId, text, showAlert });
  }

  /** Ad-text hit: drop the message, auto-block the sender (per config) and
   *  quarantine the message — forwarded into the spam-quarantine topic so a
   *  false positive can be reviewed and restored with `/ad restore`. Shared by
   *  the fresh-message and edit paths (both events carry sender + content +
   *  chatId + messageId). */
  private async enforceAd(event: { sender: UserProfile; content: MessageContent; chatId: number; messageId: number }, check: AdCheckResult, bot: BotInfo): Promise<void> {
    if (this.config.ad.autoBlock) {
      // blocks.telegram_user_id is UNIQUE — a repeat offender must not re-create.
      const existing = await this.db.blocks.getByTelegramUserId(event.sender.telegramUserId);
      if (!existing) {
        await this.db.blocks.create(
          { telegramUserId: event.sender.telegramUserId, createdByTelegramUserId: AUTO_BLOCK_MARKER },
          this.runtime.now(),
        );
      }
    }
    this.logger.info("ad_blocked", { telegramUserId: event.sender.telegramUserId, reason: check.reason ?? undefined });
    // QuarantineService owns the fallback — if the quarantine topic or forward
    // fails it falls back to the old group-general-chat notification, so an
    // admin is never left blind by an ad hit. The quarantine forward reads the
    // original from the sender's chat with `bot`, so the bot is carried along.
    await this.deps.quarantine.quarantine(
      {
        sender: event.sender,
        chatId: event.chatId,
        messageId: event.messageId,
        content: event.content,
        reason: check.reason ?? "?",
        excerpt: truncate(messageText(event.content) ?? "", 200),
      },
      bot,
    );
  }

  /** Forward any messages the user wrote before passing the gate, now that
   *  their conversation is open. See PendingService for what gets queued. The
   *  queue is keyed per (bot, user) — only the bot that received the message
   *  can forward it. */
  private async flushPending(user: UserRecord, conversation: ConversationRecord, bot: BotInfo): Promise<void> {
    const entries = await this.deps.pending.drain(bot.botId, user.telegramUserId);
    if (entries.length === 0) return;
    await this.relayer.relayPending(conversation, user.telegramUserId, entries);
  }
}

/** Sentinel `created_by_telegram_user_id` for auto-detected ad blocks: the
 *  block was created by the system, not by an admin. The blocks table has no FK,
 *  so 0 is a safe marker. */
const AUTO_BLOCK_MARKER = 0;

/** Purpose recorded when a purpose statement carries no text or caption
 *  (e.g. a bare sticker) — per spec, media-only purpose records a placeholder. */
const PLACEHOLDER_PURPOSE = "(no text)";

function purposeTextOf(content: MessageContent): string {
  const text = messageText(content);
  return text != null && text.trim().length > 0 ? text.trim() : PLACEHOLDER_PURPOSE;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}