// ---------------------------------------------------------------------------
// Unit tests for task 5 core services: UserService, ConversationService,
// TopicService, VerificationService (+ arithmetic generator), ApprovalService,
// HideService, and the OperatorService wiring they depend on.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { loadConfig, type Config, type UserProfile } from "@relaytg/shared";
import {
  botRegistryFrom,
  buildServices,
  generateArithmeticQuestion,
  OPERATOR_COMMANDS,
  type BotRegistry,
  type ServiceContext,
} from "./index.ts";
import {
  CaptureLogger,
  FakeRuntime,
  FakeTelegramClient,
  immediateSerializer,
  MemoryDatabase,
  MemoryVerificationStore,
} from "../testing.ts";
import { TEXTS } from "./texts.ts";

function baseConfig(): Config {
  return loadConfig({
    BOTS: "main:test-token",
    GROUP_ID: "-100123456789",
    ADMIN_IDS: "111",
    OPERATOR_IDS: "222,333",
  });
}

interface Harness {
  ctx: ServiceContext;
  db: MemoryDatabase;
  telegram: FakeTelegramClient;
  bots: BotRegistry;
  runtime: FakeRuntime;
  logger: CaptureLogger;
  store: MemoryVerificationStore;
}

function makeHarness(config: Config = baseConfig()): Harness {
  const db = new MemoryDatabase();
  const telegram = new FakeTelegramClient();
  const runtime = new FakeRuntime();
  const logger = new CaptureLogger();
  const store = new MemoryVerificationStore();
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
  return { ctx, db, telegram, bots, runtime, logger, store };
}

function profile(telegramUserId: number, overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    telegramUserId,
    username: null,
    firstName: `User${telegramUserId}`,
    lastName: null,
    languageCode: null,
    isBot: false,
    ...overrides,
  };
}

const HOUR = 3_600_000;

// ---------------------------------------------------------------------------
// 5.1 UserService
// ---------------------------------------------------------------------------

describe("UserService", () => {
  it("creates a new user with no verified flag", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    const { user, created } = await services.users.getOrCreate(profile(42));
    expect(created).toBe(true);
    expect(user.telegramUserId).toBe(42);
    expect(user.approvedAt).toBeNull();
    expect(await h.db.users.getVerifiedAt("main", 42)).toBeNull();
    expect(h.logger.has("user_created")).toBe(true);
  });

  it("refreshes profile fields on repeat contact without duplicating", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await services.users.getOrCreate(profile(42, { username: "old" }));
    const { user, created } = await services.users.getOrCreate(profile(42, { username: "new", firstName: "Renamed" }));
    expect(created).toBe(false);
    expect(user.username).toBe("new");
    expect(user.firstName).toBe("Renamed");
    expect(h.logger.has("user_profile_refreshed")).toBe(true);
  });

  it("rejects bot senders at the identity gate", () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    expect(services.users.rejectionReason(profile(7, { isBot: true }))).toBe("bot");
    expect(services.users.rejectionReason(profile(7))).toBeNull();
  });

  it("marks the verified flag idempotently, per bot", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await services.users.getOrCreate(profile(42));
    await services.users.markVerified(42, h.bots.primary());
    const first = await h.db.users.getVerifiedAt("main", 42);
    expect(first).not.toBeNull();
    await services.users.markVerified(42, h.bots.primary());
    const second = await h.db.users.getVerifiedAt("main", 42);
    expect(second).toBe(first);
    // The flag is bot-scoped: nothing is recorded for a bot the user never
    // verified on.
    expect(await h.db.users.getVerifiedAt("other", 42)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5.2 ConversationService
// ---------------------------------------------------------------------------

describe("ConversationService", () => {
  it("reuses the single conversation per user", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    const user = (await services.users.getOrCreate(profile(42))).user;
    const first = await services.conversations.ensureForUser(user, h.bots.primary());
    const second = await services.conversations.ensureForUser(user, h.bots.primary());
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.conversation.id).toBe(first.conversation.id);
  });

  it("works unassigned", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    const user = (await services.users.getOrCreate(profile(42))).user;
    const { conversation } = await services.conversations.ensureForUser(user, h.bots.primary());
    expect(conversation.assignedOperatorId).toBeNull();
    const messageId = await h.telegram.sendContent(
      { chatId: conversation.telegramTopicId!, messageThreadId: conversation.telegramTopicId! },
      { type: "text", text: "hello" },
    );
    expect(messageId).toBeGreaterThan(0);
  });

  it("persists an informational assignment", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    const user = (await services.users.getOrCreate(profile(42))).user;
    const { conversation } = await services.conversations.ensureForUser(user, h.bots.primary());
    await services.conversations.setAssignedOperatorId(conversation.id, "op-1");
    const after = await services.conversations.getById(conversation.id);
    expect(after?.assignedOperatorId).toBe("op-1");
  });

  it("refreshes the activity timestamp", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    const user = (await services.users.getOrCreate(profile(42))).user;
    const { conversation } = await services.conversations.ensureForUser(user, h.bots.primary());
    h.runtime.advance(HOUR);
    await services.conversations.touchActivity(conversation.id);
    const after = await services.conversations.getById(conversation.id);
    expect(new Date(after!.lastActivityAt).getTime()).toBe(h.runtime.now().getTime());
  });

  it("deletion cascades messages and notes in one transaction", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    const user = (await services.users.getOrCreate(profile(42))).user;
    const { conversation } = await services.conversations.ensureForUser(user, h.bots.primary());
    const topicId = conversation.telegramTopicId!;
    await h.db.messages.create(
      { conversationId: conversation.id, botId: "main", telegramChatId: 42, telegramMessageId: 1, telegramTopicId: topicId, relayedMessageId: 201, direction: "USER_TO_OPERATOR", senderType: "USER", contentType: "text", replyToMessageId: null },
      h.runtime.now(),
    );
    await h.db.messages.create(
      { conversationId: conversation.id, botId: "main", telegramChatId: 42, telegramMessageId: 2, telegramTopicId: topicId, relayedMessageId: 202, direction: "USER_TO_OPERATOR", senderType: "USER", contentType: "text", replyToMessageId: null },
      h.runtime.now(),
    );
    await h.db.notes.create({ conversationId: conversation.id, operatorId: "op-1", text: "internal note" }, h.runtime.now());

    await services.conversations.deleteConversation(conversation);

    expect(await services.conversations.getById(conversation.id)).toBeNull();
    expect(await h.db.messages.getBySource(42, 1)).toBeNull();
    expect(await h.db.messages.getBySource(42, 2)).toBeNull();
    expect(h.db.notes.rows.size).toBe(0);
    expect(h.telegram.callsOf("deleteForumTopic").length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5.3 TopicService
// ---------------------------------------------------------------------------

describe("TopicService", () => {
  it("names topics `botId | DisplayName | telegram_user_id`", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    const user = (await services.users.getOrCreate(profile(42, { firstName: "Jason" }))).user;
    const topicId = await services.topics.createTopic(user);
    expect(topicId).toBeGreaterThan(0);
    const call = h.telegram.callsOf("createForumTopic")[0];
    expect(call.payload.name).toBe("main | Jason | 42");
  });

  it("stores the created topic id on the conversation and routes by it", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    const user = (await services.users.getOrCreate(profile(42))).user;
    const { conversation } = await services.conversations.ensureForUser(user, h.bots.primary());
    expect(conversation.telegramTopicId).not.toBeNull();
    const routed = await services.conversations.getByTopicId(conversation.telegramTopicId!);
    expect(routed?.id).toBe(conversation.id);
  });

  it("topic removal is best-effort when the topic is already gone", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    const user = (await services.users.getOrCreate(profile(42))).user;
    const { conversation } = await services.conversations.ensureForUser(user, h.bots.primary());
    // Simulate a manually-deleted topic (as if an operator removed it).
    h.telegram.topics.delete(conversation.telegramTopicId!);
    await expect(services.conversations.deleteConversation(conversation)).resolves.not.toThrow();
    expect(await services.conversations.getById(conversation.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5.4 VerificationService + arithmetic generator
// ---------------------------------------------------------------------------

/** Evaluate the generated expression with standard ×/÷ precedence. */
function evaluate(expr: string): number {
  const stack: number[] = [];
  let op = "+";
  for (const t of expr.split(" ")) {
    if (t === "+" || t === "−" || t === "×" || t === "÷") {
      op = t;
      continue;
    }
    const n = Number(t);
    if (op === "×") stack.push(stack.pop()! * n);
    else if (op === "÷") stack.push(stack.pop()! / n);
    else stack.push(op === "−" ? -n : n);
  }
  return stack.reduce((a, b) => a + b, 0);
}

describe("arithmetic generator", () => {
  it("produces four distinct integer choices with exactly one correct", () => {
    for (let i = 0; i < 200; i++) {
      const q = generateArithmeticQuestion();
      expect(q.choices).toHaveLength(4);
      expect(new Set(q.choices).size).toBe(4);
      expect(q.choices.filter((c) => c === q.answer)).toHaveLength(1);
    }
  });

  it("generated expressions evaluate to integers within ±1000", () => {
    for (let i = 0; i < 200; i++) {
      const q = generateArithmeticQuestion();
      expect(Number.isInteger(q.answer)).toBe(true);
      expect(Math.abs(q.answer)).toBeLessThanOrEqual(1000);
      expect(evaluate(q.expression)).toBe(q.answer);
    }
  });

  it("expressions never contain division or a negative operand", () => {
    for (let i = 0; i < 200; i++) {
      const expr = generateArithmeticQuestion().expression;
      expect(expr).not.toContain("÷");
      // Terms are strictly positive `a × b` — the only signs are the `+`/`−`
      // joiners, so no ASCII minus (a negative number) can appear.
      expect(expr).not.toContain("-");
    }
  });
});

describe("VerificationService", () => {
  it("issues a challenge with four choice buttons", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await services.verification.startChallenge(profile(42), h.bots.primary());
    const call = h.telegram.lastCall()!;
    expect(call.method).toBe("sendMessage");
    expect(call.target.chatId).toBe(42);
    expect(call.replyMarkup?.buttons).toHaveLength(4);
    const state = await h.store.get("main", 42);
    expect(state).not.toBeNull();
    expect(state!.attemptsLeft).toBe(3);
  });

  it("tapping the correct choice marks the user verified", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await services.users.getOrCreate(profile(42));
    await services.verification.startChallenge(profile(42), h.bots.primary());
    const state = (await h.store.get("main", 42))!;
    const outcome = await services.verification.answer(profile(42), state.answer, h.bots.primary());
    expect(outcome.outcome).toBe("correct");
    expect(await h.store.get("main", 42)).toBeNull();
    expect(await h.db.users.getVerifiedAt("main", 42)).not.toBeNull();
    expect(h.logger.has("verification_correct")).toBe(true);
  });

  it("a wrong choice re-asks in place, consuming an attempt", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await services.verification.startChallenge(profile(42), h.bots.primary());
    const state = (await h.store.get("main", 42))!;
    const wrong = state.choices.find((c) => c !== state.answer)!;
    const outcome = await services.verification.answer(profile(42), wrong, h.bots.primary());
    expect(outcome.outcome).toBe("wrong");
    const after = (await h.store.get("main", 42))!;
    expect(after.attemptsLeft).toBe(state.attemptsLeft - 1);
    const edits = h.telegram.callsOf("editMessageText");
    expect(edits.length).toBe(1);
    expect(edits[0].target.messageId).toBe(state.questionMessageId);
    expect(edits[0].replyMarkup?.buttons).toHaveLength(4);
  });

  it("non-button content re-asks without consuming an attempt", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await services.verification.startChallenge(profile(42), h.bots.primary());
    const before = (await h.store.get("main", 42))!.attemptsLeft;
    await services.verification.nonButtonContent(profile(42), h.bots.primary());
    const after = (await h.store.get("main", 42))!;
    expect(after.attemptsLeft).toBe(before);
    expect(h.telegram.callsOf("editMessageText").length).toBe(1);
  });

  it("exhausts attempts and clears the challenge", async () => {
    const h = makeHarness(loadConfig({ ...envWithToken(), VERIFY_ATTEMPTS: "1" }));
    const services = buildServices(h.ctx);
    await services.verification.startChallenge(profile(42), h.bots.primary());
    const state = (await h.store.get("main", 42))!;
    const wrong = state.choices.find((c) => c !== state.answer)!;
    const outcome = await services.verification.answer(profile(42), wrong, h.bots.primary());
    expect(outcome.outcome).toBe("exhausted");
    expect(await h.store.get("main", 42)).toBeNull();
  });

  it("expires lazily when the TTL passes", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await services.verification.startChallenge(profile(42), h.bots.primary());
    h.runtime.advance(301_000);
    const state = (await h.store.get("main", 42))!;
    const outcome = await services.verification.answer(profile(42), state.answer, h.bots.primary());
    expect(outcome.outcome).toBe("expired");
    expect(await h.store.get("main", 42)).toBeNull();
    expect(h.logger.has("verification_expired")).toBe(true);
  });

  it("restarts with a fresh challenge on the next contact after expiry", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await services.verification.startChallenge(profile(42), h.bots.primary());
    h.runtime.advance(301_000);
    await services.verification.nonButtonContent(profile(42), h.bots.primary());
    const state = (await h.store.get("main", 42))!;
    expect(state.attemptsLeft).toBe(h.ctx.config.verification.attempts);
    const sends = h.telegram.callsOf("sendMessage");
    expect(sends.filter((c) => c.replyMarkup != null)).toHaveLength(2);
  });

  it("skips the per-bot gate once verified on this bot or approved anywhere", async () => {
    const h = makeHarness(
      loadConfig({ BOTS: "main:test-token,second:test-token-2", GROUP_ID: "-100123456789" }),
    );
    const services = buildServices(h.ctx);
    await services.users.getOrCreate(profile(42));
    const userOf = async (id: number) => (await h.db.users.getByTelegramUserId(id))!;

    // A fresh user is eligible on the primary bot.
    expect(await services.verification.isEligible(h.bots.primary(), await userOf(42))).toBe(true);
    // Verified on this bot → no longer eligible here …
    await services.users.markVerified(42, h.bots.primary());
    expect(await services.verification.isEligible(h.bots.primary(), await userOf(42))).toBe(false);
    // … but verified on ANOTHER bot never grants anything on this one: the
    // per-bot records are independent, so the second-bot mark leaves the
    // primary-bot gate closed.
    await h.db.users.clearVerified("main", 42);
    await services.users.markVerified(42, h.bots.get("second"));
    expect(await services.verification.isEligible(h.bots.primary(), await userOf(42))).toBe(true);
    // Approval is global — an approved human is trusted on every bot.
    await h.db.users.setApprovedAt(42, h.runtime.now());
    expect(await services.verification.isEligible(h.bots.primary(), await userOf(42))).toBe(false);
  });
});

function envWithToken(): Record<string, string> {
  return { BOTS: "main:test-token", GROUP_ID: "-100123456789" };
}

// ---------------------------------------------------------------------------
// 5.5 ApprovalService
// ---------------------------------------------------------------------------

describe("ApprovalService", () => {
  it("creates one pending application and posts the notification", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    const outcome = await services.approvals.apply(profile(42, { username: "jason" }), h.bots.primary());
    expect(outcome).toBe("submitted");
    const app = await h.db.applications.getLatestByTelegramUserId(42);
    expect(app?.status).toBe("pending");
    const notification = h.telegram.callsOf("sendMessage").find((c) => c.target.chatId === h.ctx.config.supportGroupId);
    expect(notification).toBeDefined();
    expect(notification!.replyMarkup?.buttons).toEqual([
      { text: "Approve", callbackData: `apply:approve:${app!.id}` },
      { text: "Reject", callbackData: `apply:reject:${app!.id}` },
    ]);
    const reply = h.telegram.callsOf("sendMessage").find((c) => c.target.chatId === 42);
    expect(reply?.payload.text).toBe(TEXTS("en").applySubmitted);
  });

  it("is a no-op while an application is pending", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await services.approvals.apply(profile(42), h.bots.primary());
    const outcome = await services.approvals.apply(profile(42), h.bots.primary());
    expect(outcome).toBe("pending");
    const repliesTo42 = h.telegram.callsOf("sendMessage").filter((c) => c.target.chatId === 42);
    const reply = repliesTo42[repliesTo42.length - 1];
    expect(reply?.payload.text).toBe(TEXTS("en").applyPending);
    const apps = [...h.db.applications.rows.values()].filter((a) => a.telegramUserId === 42);
    expect(apps).toHaveLength(1);
  });

  it("approve promotes to OPERATOR, sets approved_at, and gates a first-timer on their purpose before opening the conversation", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await services.operators.seed();
    await services.approvals.apply(profile(42), h.bots.primary());
    const app = (await h.db.applications.getLatestByTelegramUserId(42))!;
    const outcome = await services.approvals.decide(profile(111), "approve", app.id, "q1", h.bots.primary());
    expect(outcome).toBe("handled");
    const user = await services.users.getByTelegramUserId(42);
    expect(user?.approvedAt).not.toBeNull();
    // Approval is the operator-application path: the applicant is now OPERATOR,
    // and the menu re-registration reflects it in the support group.
    expect(await h.db.operators.getByTelegramUserId(42)).toMatchObject({ role: "OPERATOR" });
    expect(
      h.telegram.commandMenus.some(
        (m) => m.scope?.type === "chat_member" && m.scope.user_id === 42 && m.commands === OPERATOR_COMMANDS,
      ),
    ).toBe(true);
    // First-contact purpose gate: no conversation yet — the approved applicant
    // is asked to state their purpose first.
    expect(await services.conversations.getByTelegramUserId(42)).toBeNull();
    const prompt = h.telegram.callsOf("sendMessage").find((c) => c.target.chatId === 42 && c.payload.text === TEXTS("en").purposePrompt);
    expect(prompt).toBeDefined();
    expect(h.telegram.answers.find((a) => a.callbackQueryId === "q1")?.text).toBe("Approved as operator.");

    // Stating the purpose opens the conversation (despite the OPERATOR role).
    // No welcome message is sent to the user's private chat.
    await services.users.setPurpose(42, "refund help");
    await services.conversations.grantAccess(user!, h.bots.primary());
    const conversation = await services.conversations.getByTelegramUserId(42);
    expect(conversation).not.toBeNull();
    expect(conversation!.telegramTopicId).not.toBeNull();
    const welcomeText = "Welcome! Send a message anytime and support will reply right here in the chat.";
    expect(h.telegram.callsOf("sendMessage").some((c) => c.target.chatId === 42 && c.payload.text === welcomeText)).toBe(false);
  });

  it("reject notifies the user and creates nothing", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await services.operators.seed();
    await services.approvals.apply(profile(42), h.bots.primary());
    const app = (await h.db.applications.getLatestByTelegramUserId(42))!;
    const outcome = await services.approvals.decide(profile(111), "reject", app.id, "q1", h.bots.primary());
    expect(outcome).toBe("handled");
    const user = await services.users.getByTelegramUserId(42);
    expect(user?.approvedAt).toBeNull();
    expect(await services.conversations.getByTelegramUserId(42)).toBeNull();
    expect(await h.db.applications.getById(app.id)).toMatchObject({ status: "rejected" });
    const rejectedReply = h.telegram.callsOf("sendMessage").find((c) => c.target.chatId === 42 && c.payload.text === TEXTS("en").applyRejected);
    expect(rejectedReply).toBeDefined();
  });

  it("allows a re-apply after rejection", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await services.operators.seed();
    await services.approvals.apply(profile(42), h.bots.primary());
    const first = (await h.db.applications.getLatestByTelegramUserId(42))!;
    await services.approvals.decide(profile(111), "reject", first.id, "q1", h.bots.primary());
    const outcome = await services.approvals.apply(profile(42), h.bots.primary());
    expect(outcome).toBe("submitted");
    const second = (await h.db.applications.getLatestByTelegramUserId(42))!;
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe("pending");
    const apps = [...h.db.applications.rows.values()].filter((a) => a.telegramUserId === 42);
    expect(apps).toHaveLength(2);
  });

  it("is a no-op for an already-approved user", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await services.users.getOrCreate(profile(42));
    await services.users.getOrCreate(profile(42));
    await h.db.users.setApprovedAt(42, h.runtime.now());
    const outcome = await services.approvals.apply(profile(42), h.bots.primary());
    expect(outcome).toBe("already_approved");
    expect([...h.db.applications.rows.values()].filter((a) => a.telegramUserId === 42)).toHaveLength(0);
  });

  it("refuses non-admin deciders", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await services.operators.seed();
    await services.approvals.apply(profile(42), h.bots.primary());
    const app = (await h.db.applications.getLatestByTelegramUserId(42))!;
    const outcome = await services.approvals.decide(profile(222), "approve", app.id, "q1", h.bots.primary());
    expect(outcome).toBe("unauthorized");
    expect(await h.db.applications.getById(app.id)).toMatchObject({ status: "pending" });
    expect(h.telegram.answers.find((a) => a.callbackQueryId === "q1")?.showAlert).toBe(true);
  });

  it("is a no-op on a double-tap of an already-decided application", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await services.operators.seed();
    await services.approvals.apply(profile(42), h.bots.primary());
    const app = (await h.db.applications.getLatestByTelegramUserId(42))!;
    await services.approvals.decide(profile(111), "approve", app.id, "q1", h.bots.primary());
    const outcome = await services.approvals.decide(profile(111), "reject", app.id, "q2", h.bots.primary());
    expect(outcome).toBe("already_decided");
    expect(await h.db.applications.getById(app.id)).toMatchObject({ status: "approved" });
    expect(h.telegram.answers.find((a) => a.callbackQueryId === "q2")?.showAlert).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5.6 HideService
// ---------------------------------------------------------------------------

async function seededConversation(h: Harness, telegramUserId: number): Promise<{ id: string; topicId: number }> {
  const topicId = h.telegram.seedTopic();
  const conversation = await h.db.conversations.create(
    { botId: "main", telegramUserId, telegramTopicId: topicId, assignedOperatorId: null },
    h.runtime.now(),
  );
  return { id: conversation.id, topicId };
}

describe("HideService", () => {
  it("hides only stale conversations", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    const stale = await seededConversation(h, 42);
    h.runtime.advance(200 * HOUR);
    const fresh = await seededConversation(h, 43);
    const count = await services.hides.sweep(h.runtime.now());
    expect(count).toBe(1);
    expect((await services.conversations.getById(stale.id))?.hiddenAt).not.toBeNull();
    expect((await services.conversations.getById(fresh.id))?.hiddenAt).toBeNull();
    expect(h.telegram.topics.get(stale.topicId)?.closed).toBe(true);
  });

  it("skips never-hide conversations", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    const neverHide = await seededConversation(h, 42);
    await h.db.conversations.setHideAfterHours(neverHide.id, 0);
    h.runtime.advance(100 * HOUR);
    const count = await services.hides.sweep(h.runtime.now());
    expect(count).toBe(0);
    expect((await services.conversations.getById(neverHide.id))?.hiddenAt).toBeNull();
    expect(h.telegram.topics.get(neverHide.topicId)?.closed).toBe(false);
  });

  it("honors a custom per-conversation threshold", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    const custom = await seededConversation(h, 42);
    await h.db.conversations.setHideAfterHours(custom.id, 1);
    h.runtime.advance(2 * HOUR);
    let count = await services.hides.sweep(h.runtime.now());
    expect(count).toBe(1);
    expect((await services.conversations.getById(custom.id))?.hiddenAt).not.toBeNull();

    const recent = await seededConversation(h, 43);
    await h.db.conversations.setHideAfterHours(recent.id, 1);
    count = await services.hides.sweep(h.runtime.now());
    expect(count).toBe(0);
    expect((await services.conversations.getById(recent.id))?.hiddenAt).toBeNull();
  });

  it("skips re-hiding an already-hidden conversation", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await seededConversation(h, 42);
    h.runtime.advance(200 * HOUR);
    await services.hides.sweep(h.runtime.now());
    const hideCalls = h.telegram.callsOf("hideForumTopic").length;
    await services.hides.sweep(h.runtime.now());
    expect(h.telegram.callsOf("hideForumTopic").length).toBe(hideCalls);
  });

  it("restore reopens the topic, clears the hidden flag, and refreshes activity", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    const conv = await seededConversation(h, 42);
    h.runtime.advance(200 * HOUR);
    await services.hides.sweep(h.runtime.now());
    h.runtime.advance(60_000);
    const hidden = (await services.conversations.getById(conv.id))!;
    await services.hides.restore(hidden);
    const after = (await services.conversations.getById(conv.id))!;
    expect(after.hiddenAt).toBeNull();
    expect(h.telegram.topics.get(conv.topicId)?.closed).toBe(false);
    expect(new Date(after.lastActivityAt).getTime()).toBe(h.runtime.now().getTime());
  });

  it("restore leaves a never-hidden conversation active and refreshed", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    const conv = await seededConversation(h, 42);
    h.runtime.advance(60_000);
    await services.hides.restore((await services.conversations.getById(conv.id))!);
    expect((await services.conversations.getById(conv.id))?.hiddenAt).toBeNull();
  });
});
