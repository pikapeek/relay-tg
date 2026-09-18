// ---------------------------------------------------------------------------
// Shared relay integration scenario suite (task 13.1).
//
// Runs the same end-to-end relay scenarios against ANY SqlDb binding: the
// Docker path (node:sqlite, in sqlite/src/relay-scenarios.test.ts) and the
// Cloudflare DO path (a fake sql handle, in cloudflare-do/src/*.test.ts).
// Each scenario builds a fresh migrated Database, wires the real core services
// over it with the shared fakes (FakeTelegramClient / FakeRuntime /
// CaptureLogger / MemoryVerificationStore), and drives the UpdateProcessor the
// way the runtimes do.
//
// Assertions use repository methods plus SQL row counts (via the raw SqlDb),
// so the same suite proves behavioral parity on both stacks.
// ---------------------------------------------------------------------------

import { beforeEach, describe, expect, it } from "vitest";
import type { BotRegistry, Database, ServiceContext, CoreServices } from "@relaytg/core";
import { botRegistryFrom, buildServices, OPERATOR_TEXTS, TEXTS } from "@relaytg/core";
import {
  CaptureLogger,
  FakeRuntime,
  FakeTelegramClient,
  MemoryVerificationStore,
  immediateSerializer,
  type RecordedCall,
} from "@relaytg/core/testing";
import {
  loadConfig,
  type ApplicationDecisionEvent,
  type Config,
  type MessageContent,
  type OperatorMessageEvent,
  type UserMessageEvent,
  type UserProfile,
  type VerificationAnswerEvent,
} from "@relaytg/shared";
import type { SqlDb } from "./sql-db.ts";
import type { Migration } from "./migrate.ts";
import { applyMigrations } from "./migrate.ts";
import { SqliteDatabase } from "./repository.ts";

export const GROUP_ID = -100123456789;

// ---------------------------------------------------------------------------
// Event / content builders (same shapes the Telegram parser emits).
// ---------------------------------------------------------------------------

export function profile(telegramUserId: number, overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    telegramUserId,
    username: `user${telegramUserId}`,
    firstName: `User ${telegramUserId}`,
    lastName: null,
    languageCode: "en",
    isBot: false,
    ...overrides,
  };
}

export function text(t: string): MessageContent {
  return { type: "text", text: t };
}

export function userMessage(
  chatId: number,
  messageId: number,
  sender: UserProfile,
  content: MessageContent,
  opts: { replyToMessageId?: number | null } = {},
): UserMessageEvent {
  return {
    kind: "user_message",
    chatId,
    messageId,
    sender,
    content,
    replyToMessageId: opts.replyToMessageId ?? null,
    mediaGroupId: null,
  };
}

export function operatorMessage(
  chatId: number,
  messageId: number,
  sender: UserProfile,
  content: MessageContent,
  messageThreadId: number | null,
): OperatorMessageEvent {
  return { kind: "operator_message", chatId, messageId, messageThreadId, sender, content, replyToMessageId: null };
}

export function verificationAnswer(
  chatId: number,
  messageId: number,
  answer: number,
  callbackQueryId: string,
  sender: UserProfile,
): VerificationAnswerEvent {
  return { kind: "verification_answer", callbackQueryId, chatId, messageId, sender, answer };
}

export function applicationDecision(
  callbackQueryId: string,
  sender: UserProfile,
  decision: "approve" | "reject",
  applicationId: string,
): ApplicationDecisionEvent {
  return { kind: "application_decision", callbackQueryId, chatId: GROUP_ID, messageId: 0, sender, decision, applicationId };
}

// ---------------------------------------------------------------------------
// Harness: real Database + shared fakes wired into core.
// ---------------------------------------------------------------------------

export interface RelayHarness {
  ctx: ServiceContext;
  db: Database;
  /** Raw SqlDb handle — lets scenarios assert exact row counts on both stacks. */
  sql: SqlDb;
  telegram: FakeTelegramClient;
  bots: BotRegistry;
  runtime: FakeRuntime;
  logger: CaptureLogger;
  store: MemoryVerificationStore;
  services: CoreServices;
}

export function baseConfig(): Config {
  return loadConfig({
    BOTS: "main:test-token",
    GROUP_ID: "-100123456789",
    ADMIN_IDS: "111",
    OPERATOR_IDS: "222,333",
  });
}

export async function makeRelayHarness(db: Database, sql: SqlDb): Promise<RelayHarness> {
  const telegram = new FakeTelegramClient();
  const runtime = new FakeRuntime();
  const logger = new CaptureLogger();
  const store = new MemoryVerificationStore();
  const config = baseConfig();
  const clients = config.bots.map((_bot, i) => (i === 0 ? telegram : new FakeTelegramClient()));
  const bots = botRegistryFrom(
    config.bots.map((bot, i) => ({
      botId: bot.id,
      client: clients[i]!,
      botTelegramUserId: clients[i]!.meResult.id,
      botUsername: clients[i]!.meResult.username,
    })),
  );
  const ctx: ServiceContext = { db, telegram, bots, runtime, config, logger, verificationStore: store, serializer: immediateSerializer };
  const services = buildServices(ctx);
  await services.operators.seed();
  return { ctx, db, sql, telegram, bots, runtime, logger, store, services };
}

// ---------------------------------------------------------------------------
// Scenario helpers
// ---------------------------------------------------------------------------

export async function markVerified(h: RelayHarness, telegramUserId: number, purpose = "test purpose"): Promise<void> {
  const { user } = await h.services.users.getOrCreate(profile(telegramUserId));
  await h.services.users.markVerified(user.telegramUserId, h.bots.primary());
  // Verification is followed by the first-contact purpose gate: the user states
  // a purpose before any topic exists, so fixtures carry one on the record.
  await h.services.users.setPurpose(user.telegramUserId, purpose);
}

/** Open the user's conversation (topic + welcome) without any relayed messages. */
export async function openConversation(h: RelayHarness, telegramUserId: number) {
  const user = (await h.services.users.getByTelegramUserId(telegramUserId))!;
  return h.services.conversations.grantAccess(user, h.bots.primary());
}

export function topicSends(h: RelayHarness, topicId: number, method = "sendMessage"): RecordedCall[] {
  return h.telegram.callsOf(method).filter((c) => c.target.messageThreadId === topicId);
}

/** Reads the text the relayed copy carries, whatever its carrier shape:
 *  `sendContent` records the content object, `sendMessage` records `text`, and
 *  the pinned photo info card keeps it as the `caption`. */
export function textOf(call: RecordedCall): string | undefined {
  const payload = call.payload as { content?: MessageContent; text?: string; caption?: string };
  if (payload.content) {
    if (payload.content.type === "text") return payload.content.text;
    if ("caption" in payload.content) return payload.content.caption ?? undefined;
  }
  if (typeof payload.text === "string") return payload.text;
  if (typeof payload.caption === "string") return payload.caption;
  return undefined;
}

export function countRows(h: RelayHarness, table: string): number {
  const row = h.sql.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get();
  return Number((row as { c: number | bigint }).c);
}

// ---------------------------------------------------------------------------
// The scenario suite (task 13.1).
// ---------------------------------------------------------------------------

export function relaySuite(label: string, makeDb: () => Promise<SqlDb>, migrations: Migration[]): void {
  describe(`relay scenario suite: ${label}`, () => {
    let h: RelayHarness;

    beforeEach(async () => {
      const sql = await makeDb();
      await applyMigrations(sql, migrations);
      h = await makeRelayHarness(new SqliteDatabase(sql), sql);
    });

    // -- user → topic -------------------------------------------------------

    it("relays a verified user's message into their topic and records it (user→topic)", async () => {
      await markVerified(h, 42);
      const conv = await openConversation(h, 42);

      const result = await h.services.processor.process(1, userMessage(42, 1001, profile(42), text("hello support")));
      expect(result.status).toBe("processed");

      // The message is forwarded verbatim, so the copy shows the sender.
      const forwards = topicSends(h, conv.telegramTopicId!, "forwardMessage");
      expect(forwards).toHaveLength(1);
      expect(forwards[0]!.payload.fromChatId).toBe(42);
      expect(forwards[0]!.payload.messageId).toBe(1001);

      // The topic's first message is the user-info card (text card for a user
      // without a profile photo) with a tap-through profile button — a pure
      // info display, never pinned.
      const card = topicSends(h, conv.telegramTopicId!, "sendMessage").pop()!;
      expect(textOf(card)).toBe("👤 User 42\n@user42\n🆔 42");
      expect(card.replyMarkup?.buttons[0]?.url).toBe("tg://user?id=42");
      expect(h.telegram.pinnedMessageIds.has(card.id!)).toBe(false);

      const record = await h.db.messages.getBySource(42, 1001);
      expect(record).not.toBeNull();
      expect(record!.conversationId).toBe(conv.id);
      expect(record!.direction).toBe("USER_TO_OPERATOR");
      expect(record!.senderType).toBe("USER");
      expect(record!.telegramTopicId).toBe(conv.telegramTopicId);
      expect(record!.relayedMessageId).toBe(forwards[0]!.id);
    });

    // -- topic → user -------------------------------------------------------

    it("relays an authorized operator's topic reply to the owning user's private chat (topic→user)", async () => {
      await markVerified(h, 42);
      const conv = await openConversation(h, 42);

      const result = await h.services.processor.process(
        1,
        operatorMessage(GROUP_ID, 9001, profile(222), text("We're on it!"), conv.telegramTopicId!),
      );
      expect(result.status).toBe("processed");
      expect(result.conversationId).toBe(conv.id);

      const userSend = h.telegram.callsOf("sendMessage").find((c) => c.target.chatId === 42 && textOf(c) === "We're on it!");
      expect(userSend).toBeDefined();
      expect(userSend!.target.messageThreadId).toBeUndefined();

      const record = await h.db.messages.getBySource(GROUP_ID, 9001);
      expect(record).not.toBeNull();
      expect(record!.direction).toBe("OPERATOR_TO_USER");
      expect(record!.senderType).toBe("OPERATOR");
      expect(record!.telegramTopicId).toBe(conv.telegramTopicId);
    });

    // -- four-choice arithmetic verification --------------------------------

    it("verifies an unverified user via a four-choice arithmetic challenge", async () => {
      // /start → challenge with exactly four choice buttons; nothing persisted.
      const first = await h.services.processor.process(1, userMessage(42, 100, profile(42), text("/start")));
      expect(first.status).toBe("verification_issued");
      expect(countRows(h, "users")).toBe(0);
      expect(countRows(h, "conversations")).toBe(0);

      const question = h.telegram.callsOf("sendMessage").find((c) => c.target.chatId === 42 && c.replyMarkup != null);
      expect(question).toBeDefined();
      expect(question!.replyMarkup!.buttons).toHaveLength(4);

      // A wrong tap consumes an attempt and re-asks in place (still 4 choices).
      const state = (await h.store.get("main", 42))!;
      const wrong = state.choices.find((c) => c !== state.answer)!;
      const wrongResult = await h.services.processor.process(
        2,
        verificationAnswer(42, state.questionMessageId!, wrong, "cq-wrong", profile(42)),
      );
      expect(wrongResult.status).toBe("verification_issued");
      const after = (await h.store.get("main", 42))!;
      expect(after.attemptsLeft).toBe(state.attemptsLeft - 1);
      const reAsk = h.telegram.callsOf("editMessageText").find((c) => c.target.messageId === state.questionMessageId);
      expect(reAsk).toBeDefined();
      expect(reAsk!.replyMarkup!.buttons).toHaveLength(4);
      expect(countRows(h, "conversations")).toBe(0);

      // The correct tap verifies the user; the first-contact purpose gate then
      // asks for a purpose before any conversation or topic exists.
      const okResult = await h.services.processor.process(
        3,
        verificationAnswer(42, after.questionMessageId!, after.answer, "cq-ok", profile(42)),
      );
      expect(okResult.status).toBe("purpose_pending");
      expect(countRows(h, "conversations")).toBe(0);
      const prompt = h.telegram.callsOf("sendMessage").find((c) => c.target.chatId === 42 && c.payload.text === TEXTS("en").purposePrompt);
      expect(prompt).toBeDefined();

      // The purpose statement opens the conversation + topic.
      const stated = await h.services.processor.process(4, userMessage(42, 1002, profile(42), text("asking about a refund")));
      expect(stated.status).toBe("processed");

      const user = await h.db.users.getByTelegramUserId(42);
      expect(await h.db.users.getVerifiedAt("main", 42)).not.toBeNull();
      expect(user?.purpose).toBe("asking about a refund");
      const conv = await h.db.conversations.getByTelegramUserId(42);
      expect(conv).not.toBeNull();
      expect(h.telegram.topics.has(conv!.telegramTopicId!)).toBe(true);
      // The topic opens with ONE combined card carrying the purpose + the user's
      // info, and that single card is pinned. The purpose statement itself is
      // consumed, NOT forwarded into the topic.
      expect(topicSends(h, conv!.telegramTopicId!, "forwardMessage")).toHaveLength(0);
      const card = topicSends(h, conv!.telegramTopicId!, "sendMessage").pop()!;
      expect(textOf(card)).toBe("📝 asking about a refund\n👤 User 42\n@user42\n🆔 42");
      expect(h.telegram.pinnedMessageIds.has(card.id!)).toBe(true);
    });

    // -- /apply approval ----------------------------------------------------

    it("/apply posts an admin-only approve/reject notice and an admin approval opens the conversation", async () => {
      const applied = await h.services.processor.process(1, userMessage(42, 100, profile(42), text("/apply")));
      expect(applied.status).toBe("command_handled");

      const app = await h.db.applications.getLatestByTelegramUserId(42);
      expect(app).not.toBeNull();
      expect(app!.status).toBe("pending");
      expect(await h.db.conversations.getByTelegramUserId(42)).toBeNull();

      const notice = h.telegram.callsOf("sendMessage").find((c) => c.target.chatId === GROUP_ID && c.replyMarkup != null);
      expect(notice).toBeDefined();
      expect(notice!.replyMarkup!.buttons.map((b) => b.callbackData)).toEqual([
        `apply:approve:${app!.id}`,
        `apply:reject:${app!.id}`,
      ]);

      // Only an ADMIN may decide: an operator tap is refused.
      const refused = await h.services.processor.process(2, applicationDecision("cq-op", profile(222), "approve", app!.id));
      expect(refused.status).toBe("ignored");
      expect(await h.db.conversations.getByTelegramUserId(42)).toBeNull();
      const refuseAlert = h.telegram.answers.find((a) => a.callbackQueryId === "cq-op");
      expect(refuseAlert?.showAlert).toBe(true);

      // Admin approves → user approved; a first-timer is then asked for their
      // purpose before any conversation or topic exists.
      const approved = await h.services.processor.process(3, applicationDecision("cq-ok", profile(111), "approve", app!.id));
      expect(approved.status).toBe("command_handled");
      expect((await h.db.users.getByTelegramUserId(42))?.approvedAt).not.toBeNull();
      expect(await h.db.conversations.getByTelegramUserId(42)).toBeNull();
      const prompt = h.telegram.callsOf("sendMessage").find((c) => c.target.chatId === 42 && c.payload.text === TEXTS("en").purposePrompt);
      expect(prompt).toBeDefined();

      // The purpose statement opens the conversation/topic.
      await h.services.processor.process(4, userMessage(42, 101, profile(42), text("applying for support")));
      const conv = await h.db.conversations.getByTelegramUserId(42);
      expect(conv).not.toBeNull();
      expect((await h.db.users.getByTelegramUserId(42))?.purpose).toBe("applying for support");
    });

    // -- reply --------------------------------------------------------------

    it("preserves a user reply to the delivered copy as a reply to the operator's original topic message", async () => {
      await markVerified(h, 42);
      const conv = await openConversation(h, 42);

      // Operator's earlier message: group 9001 → user-chat copy 3000.
      await h.services.messages.create({
        conversationId: conv.id,
        botId: "main",
        telegramChatId: GROUP_ID,
        telegramMessageId: 9001,
        telegramTopicId: conv.telegramTopicId,
        relayedMessageId: 3000,
        direction: "OPERATOR_TO_USER",
        senderType: "OPERATOR",
        contentType: "text",
        replyToMessageId: null,
      });

      await h.services.processor.process(
        1,
        userMessage(42, 1001, profile(42), text("thanks"), { replyToMessageId: 3000 }),
      );

const forward = topicSends(h, conv.telegramTopicId!, "forwardMessage").pop()!;
      expect(forward.payload.fromChatId).toBe(42);
      expect(forward.payload.messageId).toBe(1001);
      // forwardMessage can't carry a reply-to (Bot API limitation), so the
      // user-side reply reference lives in the database record.
      expect(forward.target.replyToMessageId).toBeUndefined();
      const record = await h.db.messages.getBySource(42, 1001);
      expect(record?.replyToMessageId).toBe(3000);
    });

    // -- duplicate update ---------------------------------------------------

    it("deduplicates a repeated update_id while keeping one record and one relayed copy", async () => {
      await markVerified(h, 42);
      const event = userMessage(42, 1001, profile(42), text("hello"));

      const first = await h.services.processor.process(10, event);
      expect(first.status).toBe("processed");

      const conv = await h.db.conversations.getByTelegramUserId(42);
      expect(conv).not.toBeNull();
      expect(topicSends(h, conv!.telegramTopicId!, "forwardMessage")).toHaveLength(1);

      const second = await h.services.processor.process(10, event);
      expect(second.status).toBe("duplicate");

      expect(topicSends(h, conv!.telegramTopicId!, "forwardMessage")).toHaveLength(1);
      expect(await h.db.messages.getBySource(42, 1001)).not.toBeNull();
      expect(countRows(h, "messages")).toBe(1);
      expect(countRows(h, "processed_updates")).toBe(1);
    });

    // -- block --------------------------------------------------------------

    it("rejects a blocked user with zero database rows and no relay", async () => {
      await h.db.blocks.create({ telegramUserId: 42, createdByTelegramUserId: 111 }, h.runtime.now());

      const result = await h.services.processor.process(1, userMessage(42, 100, profile(42), text("hi")));
      expect(result.status).toBe("blocked");
      expect(countRows(h, "users")).toBe(0);
      expect(countRows(h, "conversations")).toBe(0);
      expect(countRows(h, "messages")).toBe(0);
      expect(h.telegram.callsOf("sendMessage")).toHaveLength(0);
    });

    // -- rate limit ---------------------------------------------------------

    it("rate-limits an over-window user without relaying or recording the exceeding message", async () => {
      await markVerified(h, 42);
      for (let i = 1; i <= 10; i++) {
        await h.services.processor.process(i, userMessage(42, 1000 + i, profile(42), text(`m${i}`)));
      }
      expect(countRows(h, "messages")).toBe(10);

      const result = await h.services.processor.process(11, userMessage(42, 9999, profile(42), text("spam")));
      expect(result.status).toBe("rate_limited");
      expect(countRows(h, "messages")).toBe(10);
      expect(await h.db.messages.getBySource(42, 9999)).toBeNull();
    });

    // -- topic hide/restore -------------------------------------------------

    it("hides a stale conversation on sweep and restores it via /restore", async () => {
      await markVerified(h, 42);
      const conv = await openConversation(h, 42);
      const topicId = conv.telegramTopicId!;
      const now = h.runtime.now();
      await h.db.conversations.touchActivity(conv.id, new Date(now.getTime() - 200 * 3600 * 1000));

      const hidden = await h.services.hides.sweep(now);
      expect(hidden).toBe(1);
      expect((await h.db.conversations.getById(conv.id))?.hiddenAt).toBe(now.toISOString());
      expect(h.telegram.topics.get(topicId)?.closed).toBe(true);
      expect(h.telegram.callsOf("hideForumTopic").some((c) => c.target.messageThreadId === topicId)).toBe(true);

      // /restore at group level reopens the topic and clears the flag.
      const result = await h.services.processor.process(2, operatorMessage(GROUP_ID, 9002, profile(222), text("/restore 42"), null));
      expect(result.status).toBe("command_handled");
      expect((await h.db.conversations.getById(conv.id))?.hiddenAt).toBeNull();
      expect(h.telegram.topics.get(topicId)?.closed).toBe(false);
      expect(h.telegram.callsOf("restoreForumTopic").some((c) => c.target.messageThreadId === topicId)).toBe(true);
    });

    // -- /hide policy -------------------------------------------------------

    it("/hide sets the per-conversation hide policy: off skips the sweep, default resets, custom hours are honored", async () => {
      await markVerified(h, 42);
      const conv = await openConversation(h, 42);
      const topicId = conv.telegramTopicId!;
      const now = h.runtime.now();
      const stale = new Date(now.getTime() - 3 * 3600 * 1000); // 3h ago

      // An invalid argument is refused while the topic is still open, leaving the policy untouched.
      await h.services.processor.process(1, operatorMessage(GROUP_ID, 9001, profile(222), text("/hide banana"), topicId));
      expect(h.telegram.callsOf("sendMessage").some((c) => c.payload.text === OPERATOR_TEXTS("en").usageHide)).toBe(true);
      expect((await h.db.conversations.getById(conv.id))?.hideAfterHours).toBeNull();

      // /hide off → never hide, even far past the default threshold.
      await h.services.processor.process(2, operatorMessage(GROUP_ID, 9002, profile(222), text("/hide off"), topicId));
      expect((await h.db.conversations.getById(conv.id))?.hideAfterHours).toBe(0);
      await h.db.conversations.touchActivity(conv.id, stale);
      expect(await h.services.hides.sweep(now)).toBe(0);
      expect((await h.db.conversations.getById(conv.id))?.hiddenAt).toBeNull();

      // /hide default → policy cleared; with the 24h default a 3h-old conversation stays visible.
      await h.services.processor.process(3, operatorMessage(GROUP_ID, 9003, profile(222), text("/hide default"), topicId));
      expect((await h.db.conversations.getById(conv.id))?.hideAfterHours).toBeNull();
      expect(await h.services.hides.sweep(now)).toBe(0);

      // /hide 2 → a 3h-old conversation is past the 2h threshold and gets hidden.
      await h.services.processor.process(4, operatorMessage(GROUP_ID, 9004, profile(222), text("/hide 2"), topicId));
      expect((await h.db.conversations.getById(conv.id))?.hideAfterHours).toBe(2);
      expect(await h.services.hides.sweep(now)).toBe(1);
      expect((await h.db.conversations.getById(conv.id))?.hiddenAt).not.toBeNull();
    });
  });
}
