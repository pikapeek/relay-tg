// ---------------------------------------------------------------------------
// Relay-flow tests (task 7): the user → operator pipeline (7.2), operator →
// user (7.3), boot-seeded staff skipping the verification gate (2026-09), and
// no-state-on-rejection (7.4).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { buildServices } from "./index.ts";
import { makeHarness, profile, text, photo, userMessage, operatorMessage, verificationAnswer, GROUP_ID } from "./harness.ts";
import { TEXTS } from "./texts.ts";
import {
  verifiedUser,
  openConversation,
  topicSends,
  recordsForConversation,
  textOf,
  cardInfoOf,
  identityUrlOf,
  fileIdOf,
} from "./pipeline.test-helpers.ts";

// ---------------------------------------------------------------------------
// 7.2 User → operator flow
// ---------------------------------------------------------------------------

describe("user → operator pipeline (7.2)", () => {
  it("/start issues a four-choice challenge and stores no user or conversation rows", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);

    const result = await services.processor.process(1, userMessage(42, 100, profile(42), text("/start")));
    expect(result.status).toBe("verification_issued");

    const question = h.telegram.callsOf("sendMessage").find((c) => c.target.chatId === 42 && c.replyMarkup != null);
    expect(question).toBeDefined();
    expect(question!.replyMarkup!.buttons).toHaveLength(4);

    const state = (await h.store.get(42))!;
    expect(state).not.toBeNull();
    const answers = question!.replyMarkup!.buttons.map((b) => Number(b.callbackData!.replace("verify:", "")));
    expect(new Set(answers).size).toBe(4);
    expect(answers.filter((a) => a === state.answer)).toHaveLength(1);

    expect(await h.db.users.getByTelegramUserId(42)).toBeNull();
    expect(await h.db.conversations.getByTelegramUserId(42)).toBeNull();
  });

  it("a correct tap verifies the user, prompts for a purpose, and only then opens the conversation", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await services.processor.process(1, userMessage(42, 100, profile(42), text("/start")));
    const state = (await h.store.get(42))!;

    // Correct tap: verified, but the first-contact purpose gate holds the
    // conversation back — no topic yet, just the purpose prompt.
    const result = await services.processor.process(
      2,
      verificationAnswer(42, state.questionMessageId!, state.answer, "cq-ok", profile(42)),
    );
    expect(result.status).toBe("purpose_pending");

    const user = await h.db.users.getByTelegramUserId(42);
    expect(user?.verifiedAt).not.toBeNull();
    expect(await h.db.conversations.getByTelegramUserId(42)).toBeNull();
    expect(h.telegram.topics.size).toBe(0);

    const prompt = h.telegram.callsOf("sendMessage").find((c) => c.target.chatId === 42 && c.payload.text === TEXTS("en").purposePrompt);
    expect(prompt).toBeDefined();
    const answer = h.telegram.answers.find((a) => a.callbackQueryId === "cq-ok");
    expect(answer?.text).toContain("Verified");

    // The user's purpose statement opens the topic: the topic carries ONE
    // combined card with the purpose + the user's info, and that single card is
    // the pinned opening message. The purpose statement itself is consumed, NOT
    // forwarded into the topic.
    const opened = await services.processor.process(3, userMessage(42, 200, profile(42), text("asking about refunds")));
    expect(opened.status).toBe("processed");
    const conv = await h.db.conversations.getByTelegramUserId(42);
    expect(conv).not.toBeNull();
    expect(h.telegram.topics.has(conv!.telegramTopicId!)).toBe(true);

    const card = topicSends(h, conv!.telegramTopicId!, "sendMessage").pop()!;
    expect(cardInfoOf(card)).toBe("📝 asking about refunds\n👤 User42\n🆔 42");
    // No forward into the topic: the purpose lives on the pinned card only.
    expect(topicSends(h, conv!.telegramTopicId!, "forwardMessage")).toHaveLength(0);
    expect(h.telegram.pinnedMessageIds.has(card.id!)).toBe(true);
    // The pinned card id is persisted so `/delete` can refuse to retract it.
    expect(await h.db.settings.get(`topic_pin:${conv!.id}`)).toBe(String(card.id!));

    // No welcome message is sent to the user's private chat — the topic card is
    // the only opening message the user relates to.
    const welcomeText = "Welcome! Send a message anytime and support will reply right here in the chat.";
    expect(h.telegram.callsOf("sendMessage").some((c) => c.target.chatId === 42 && c.payload.text === welcomeText)).toBe(false);
    // The purpose statement is consumed, not relayed: no message record exists.
    const record = recordsForConversation(h, conv!.id).find((m) => m.telegramMessageId === 200);
    expect(record).toBeUndefined();
  });

  it("a media-only purpose statement records a placeholder and still opens the conversation", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await services.processor.process(1, userMessage(42, 100, profile(42), text("/start")));
    const state = (await h.store.get(42))!;
    await services.processor.process(
      2,
      verificationAnswer(42, state.questionMessageId!, state.answer, "cq", profile(42)),
    );

    // A bare sticker carries no caption → the placeholder purpose opens the topic.
    const result = await services.processor.process(3, userMessage(42, 101, profile(42), { type: "sticker", fileId: "st1", fileSize: 10 }));
    expect(result.status).toBe("processed");
    expect((await h.db.users.getByTelegramUserId(42))?.purpose).toBe("(no text)");
    const conv = await h.db.conversations.getByTelegramUserId(42);
    expect(conv).not.toBeNull();
    // The single pinned card carries the placeholder purpose; the caption-less
    // sticker is NOT forwarded into the topic.
    const card = topicSends(h, conv!.telegramTopicId!, "sendMessage").pop()!;
    expect(cardInfoOf(card)).toBe("📝 (no text)\n👤 User42\n🆔 42");
    expect(topicSends(h, conv!.telegramTopicId!, "forwardMessage")).toHaveLength(0);
    expect(h.telegram.pinnedMessageIds.has(card.id!)).toBe(true);
  });

  it("a non-/start command while the purpose gate is pending re-asks and never counts as the purpose", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await services.processor.process(1, userMessage(42, 100, profile(42), text("/start")));
    const state = (await h.store.get(42))!;
    await services.processor.process(
      2,
      verificationAnswer(42, state.questionMessageId!, state.answer, "cq", profile(42)),
    );

    // /help is handled, then the purpose prompt is re-asked — the command itself
    // is not a purpose and does not open anything.
    const result = await services.processor.process(3, userMessage(42, 101, profile(42), text("/help")));
    expect(result.status).toBe("command_handled");
    expect((await h.db.users.getByTelegramUserId(42))?.purpose).toBeNull();
    expect(await h.db.conversations.getByTelegramUserId(42)).toBeNull();
    const promptAgain = h.telegram
      .callsOf("sendMessage")
      .filter((c) => c.target.chatId === 42 && c.payload.text === TEXTS("en").purposePrompt);
    expect(promptAgain).toHaveLength(2);

    // Only a real purpose statement opens the conversation.
    await services.processor.process(4, userMessage(42, 102, profile(42), text("checking my order")));
    expect((await h.db.users.getByTelegramUserId(42))?.purpose).toBe("checking my order");
    expect(await h.db.conversations.getByTelegramUserId(42)).not.toBeNull();
  });

  it("a returning user whose conversation was deleted is asked for a purpose again", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await verifiedUser(h, 42, "still my purpose");
    const conv = await openConversation(h, 42);
    await services.conversations.deleteConversation(conv);
    // Access AND the stored purpose were reset — /start re-issues the challenge…
    const restart = await services.processor.process(1, userMessage(42, 100, profile(42), text("/start")));
    expect(restart.status).toBe("verification_issued");
    expect((await h.db.users.getByTelegramUserId(42))?.purpose).toBeNull();

    // …and a correct tap re-asks for a purpose instead of opening the topic.
    const state = (await h.store.get(42))!;
    const result = await services.processor.process(
      2,
      verificationAnswer(42, state.questionMessageId!, state.answer, "cq", profile(42)),
    );
    expect(result.status).toBe("purpose_pending");
    expect(await h.db.conversations.getByTelegramUserId(42)).toBeNull();
    const prompts = h.telegram.callsOf("sendMessage").filter((c) => c.target.chatId === 42 && c.payload.text === TEXTS("en").purposePrompt);
    expect(prompts).toHaveLength(1);
  });

  it("a wrong tap consumes an attempt, re-asks in place, and does not open a conversation", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await services.processor.process(1, userMessage(42, 100, profile(42), text("/start")));
    const state = (await h.store.get(42))!;
    const wrong = state.choices.find((c) => c !== state.answer)!;

    const result = await services.processor.process(
      2,
      verificationAnswer(42, state.questionMessageId!, wrong, "cq-wrong", profile(42)),
    );
    expect(result.status).toBe("verification_issued");

    const after = (await h.store.get(42))!;
    expect(after.attemptsLeft).toBe(state.attemptsLeft - 1);
    const reAsk = h.telegram.callsOf("editMessageText").find((c) => c.target.messageId === state.questionMessageId);
    expect(reAsk).toBeDefined();
    expect(reAsk!.replyMarkup!.buttons).toHaveLength(4);
    expect(await h.db.conversations.getByTelegramUserId(42)).toBeNull();
    expect(await h.db.users.getByTelegramUserId(42)).toBeNull();
  });

  it("exhausting attempts expires the challenge and creates nothing", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await services.processor.process(1, userMessage(42, 100, profile(42), text("/start")));
    const state = (await h.store.get(42))!;
    // config.verification.attempts = 3 → tap wrong twice, then a third wrong exhausts.
    for (let i = 2; i <= 3; i++) {
      const before = (await h.store.get(42))!;
      const wrong = before.choices.find((c) => c !== before.answer)!;
      await services.processor.process(i, verificationAnswer(42, before.questionMessageId!, wrong, `cq-${i}`, profile(42)));
    }
    await services.processor.process(4, verificationAnswer(42, state.questionMessageId!, 0, "cq-final", profile(42)));
    expect(await h.store.get(42)).toBeNull();
    const expired = h.telegram.callsOf("sendMessage").find((c) => c.target.chatId === 42 && c.payload.text === TEXTS("en").verifyExpired);
    expect(expired).toBeDefined();
    expect(await h.db.conversations.getByTelegramUserId(42)).toBeNull();
  });

  it("non-button content from an eligible user re-asks without consuming an attempt", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await services.processor.process(1, userMessage(42, 100, profile(42), text("/start")));
    const state = (await h.store.get(42))!;

    const result = await services.processor.process(2, userMessage(42, 101, profile(42), text("hello?")));
    expect(result.status).toBe("verification_issued");
    const after = (await h.store.get(42))!;
    expect(after.attemptsLeft).toBe(state.attemptsLeft);
    expect(await h.db.conversations.getByTelegramUserId(42)).toBeNull();
  });

  it("/apply creates a pending application, posts the group notice, and opens no conversation", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);

    const result = await services.processor.process(1, userMessage(42, 100, profile(42), text("/apply")));
    expect(result.status).toBe("command_handled");

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

    const submitted = h.telegram.callsOf("sendMessage").find((c) => c.target.chatId === 42 && c.payload.text === TEXTS("en").applySubmitted);
    expect(submitted).toBeDefined();
  });

  it("/apply while a prior application is pending does not duplicate it", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await services.processor.process(1, userMessage(42, 100, profile(42), text("/apply")));
    await services.processor.process(2, userMessage(42, 101, profile(42), text("/apply")));

    const apps = [...h.db.applications.rows.values()].filter((a) => a.telegramUserId === 42);
    expect(apps).toHaveLength(1);
    expect(h.telegram.callsOf("sendMessage").filter((c) => c.payload.text === TEXTS("en").applyPending)).toHaveLength(1);
  });

  it("/help replies with the user help copy and creates nothing", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);

    const result = await services.processor.process(1, userMessage(42, 100, profile(42), text("/help")));
    expect(result.status).toBe("command_handled");
    const help = h.telegram.callsOf("sendMessage").find((c) => c.target.chatId === 42 && c.payload.text === TEXTS("en").userHelp);
    expect(help).toBeDefined();
    expect(await h.db.users.getByTelegramUserId(42)).toBeNull();
    expect(await h.db.conversations.getByTelegramUserId(42)).toBeNull();
  });

  it("an unknown user command also points to /start only", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await services.processor.process(1, userMessage(42, 100, profile(42), text("/mystery")));
    expect(h.telegram.callsOf("sendMessage").filter((c) => c.payload.text === TEXTS("en").userHelp)).toHaveLength(1);
    expect(await h.db.conversations.getByTelegramUserId(42)).toBeNull();
  });

  it("a verified user's message auto-restores a hidden conversation before relaying", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await verifiedUser(h, 42);
    const conv = await openConversation(h, 42);
    const topicId = conv.telegramTopicId!;
    // Hide: topic closed + hidden flag set.
    await h.telegram.hideForumTopic({ chatId: GROUP_ID, messageThreadId: topicId });
    await h.db.conversations.setHidden(conv.id, h.runtime.now().toISOString());

    const result = await services.processor.process(1, userMessage(42, 1001, profile(42), text("hello")));
    expect(result.status).toBe("processed");

    expect(h.telegram.callsOf("restoreForumTopic")).toHaveLength(1);
    const updated = (await h.db.conversations.getByTelegramUserId(42))!;
    expect(updated.hiddenAt).toBeNull();
    expect(topicSends(h, topicId, "forwardMessage")).toHaveLength(1);
    const record = recordsForConversation(h, conv.id).find((m) => m.telegramMessageId === 1001);
    expect(record).toBeDefined();
  });

  it("a verified user's first message opens the conversation, posts a user-info card, and forwards the message", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await verifiedUser(h, 42);

    const result = await services.processor.process(1, userMessage(42, 1001, profile(42), text("hello support")));
    expect(result.status).toBe("processed");

    const conv = await h.db.conversations.getByTelegramUserId(42);
    expect(conv).not.toBeNull();
    const topicId = conv!.telegramTopicId!;

    // First message in the topic: the user-info card (text card for a user
    // without a profile photo) with a tap-through profile button. It is a pure
    // info display — the purpose heads no card, and nothing is pinned for a
    // returning user (the pinned purpose message only happens on first contact).
    const card = topicSends(h, topicId, "sendMessage").pop()!;
    expect(cardInfoOf(card)).toBe("👤 User42\n🆔 42");
    expect(identityUrlOf(card)).toBe("tg://user?id=42");
    expect(h.telegram.pinnedMessageIds.has(card.id!)).toBe(false);

    // The user's actual message is forwarded verbatim, so the copy shows the
    // sender's real name and avatar through Telegram's forward attribution.
    const forward = topicSends(h, topicId, "forwardMessage").pop()!;
    expect(forward.payload.fromChatId).toBe(42);
    expect(forward.payload.messageId).toBe(1001);

    const record = recordsForConversation(h, conv!.id).find((m) => m.telegramMessageId === 1001)!;
    expect(record.direction).toBe("USER_TO_OPERATOR");
    expect(record.senderType).toBe("USER");
    expect(record.relayedMessageId).toBe(forward.id);
    expect(record.telegramTopicId).toBe(topicId);
  });

  it("a sender with a profile photo gets their avatar as a photo card at topic creation", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await verifiedUser(h, 42);
    // The photo must exist before the topic is created: the card is built once,
    // at topic birth, from the current profile picture.
    h.telegram.setProfilePhoto(42, "ava-42");
    const conv = await openConversation(h, 42);
    const topicId = conv.telegramTopicId!;

    // The card is the sender's face: photo = avatar, caption = the user info
    // line (no purpose — the card is a pure user-info display).
    const card = topicSends(h, topicId, "sendPhoto").pop()!;
    expect(fileIdOf(card)).toBe("ava-42");
    expect(cardInfoOf(card)).toBe("👤 User42\n🆔 42");
    expect(identityUrlOf(card)).toBe("tg://user?id=42");
    expect(h.telegram.pinnedMessageIds.has(card.id!)).toBe(false);

    // The avatar is only looked up for the card, at topic creation.
    expect(h.telegram.profilePhotoLookups).toEqual([42]);

    // The message itself still forwards verbatim.
    const result = await services.processor.process(1, userMessage(42, 1001, profile(42), text("hello")));
    expect(result.status).toBe("processed");
    const forward = topicSends(h, topicId, "forwardMessage").pop()!;
    expect(forward.payload.fromChatId).toBe(42);
    expect(forward.payload.messageId).toBe(1001);
  });

  it("text and media messages both forward verbatim into the topic", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await verifiedUser(h, 42);
    const conv = await openConversation(h, 42);
    const topicId = conv.telegramTopicId!;

    const textResult = await services.processor.process(1, userMessage(42, 1001, profile(42), text("hello")));
    const mediaResult = await services.processor.process(2, userMessage(42, 1002, profile(42), photo("f1", "look")));
    const longResult = await services.processor.process(3, userMessage(42, 1003, profile(42), text("x".repeat(1025))));
    expect(textResult.status).toBe("processed");
    expect(mediaResult.status).toBe("processed");
    expect(longResult.status).toBe("processed");

    const forwards = topicSends(h, topicId, "forwardMessage");
    expect(forwards.map((f) => f.payload.messageId)).toEqual([1001, 1002, 1003]);
    expect(forwards.every((f) => f.payload.fromChatId === 42)).toBe(true);
    // No re-send as the bot — the copies are Telegram's own forwarded messages.
    expect(topicSends(h, topicId, "sendPhoto")).toHaveLength(0);
  });

  it("an avatar lookup failure skips the card entirely but never fails topic creation or the relay", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await verifiedUser(h, 42);
    h.telegram.setProfilePhoto(42, "ava-42");
    h.telegram.failOnceWith("network", "getUserProfilePhoto");
    const conv = await openConversation(h, 42);
    const topicId = conv.telegramTopicId!;

    // Best-effort: no card was posted, and the failure is logged.
    expect(topicSends(h, topicId, "sendMessage")).toHaveLength(0);
    expect(topicSends(h, topicId, "sendPhoto")).toHaveLength(0);
    expect(h.logger.has("topic_card_failed")).toBe(true);
    expect(h.logger.has("topic_card_posted")).toBe(false);

    // The failure never breaks the relay that follows.
    const result = await services.processor.process(1, userMessage(42, 1001, profile(42), text("hi")));
    expect(result.status).toBe("processed");
    expect(topicSends(h, topicId, "forwardMessage")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 7.3 Operator → user flow
// ---------------------------------------------------------------------------

describe("operator → user pipeline (7.3)", () => {
  it("relays an operator's topic message to the owning user and records it", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await services.operators.seed();
    await verifiedUser(h, 42);
    const conv = await openConversation(h, 42);

    const result = await services.processor.process(1, operatorMessage(GROUP_ID, 9001, profile(222), text("We're on it!"), conv.telegramTopicId!));
    expect(result.status).toBe("processed");
    expect(result.conversationId).toBe(conv.id);

    const userSend = h.telegram.callsOf("sendMessage").find((c) => c.target.chatId === 42 && textOf(c) === "We're on it!");
    expect(userSend).toBeDefined();
    const record = recordsForConversation(h, conv.id).find((m) => m.telegramMessageId === 9001)!;
    expect(record.direction).toBe("OPERATOR_TO_USER");
    expect(record.senderType).toBe("OPERATOR");
    expect(record.telegramTopicId).toBe(conv.telegramTopicId);
  });

  it("delivers the reply only to the owning user's chat, never into other chats", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await services.operators.seed();
    await verifiedUser(h, 42);
    await verifiedUser(h, 43);
    const conv42 = await openConversation(h, 42);
    await openConversation(h, 43);

    await services.processor.process(1, operatorMessage(GROUP_ID, 9001, profile(222), text("for 42 only"), conv42.telegramTopicId!));
    // user 43 must never see it (no welcome message either — the topic card is
    // the only opening message, and it never reaches the user's chat)
    expect(h.telegram.callsOf("sendMessage").filter((c) => c.target.chatId === 43)).toHaveLength(0);
  });

  it("ignores messages from non-operators", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await services.operators.seed();
    await verifiedUser(h, 42);
    const conv = await openConversation(h, 42);

    const result = await services.processor.process(
      1,
      operatorMessage(GROUP_ID, 9002, profile(999), text("i am not an operator"), conv.telegramTopicId!),
    );
    expect(result.status).toBe("ignored");
    expect(h.db.messages.rows.size).toBe(0);
  });

  it("ignores operator posts in the group's general chat (no topic)", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await services.operators.seed();
    await verifiedUser(h, 42);
    await openConversation(h, 42);

    const result = await services.processor.process(1, operatorMessage(GROUP_ID, 9003, profile(222), text("general chat chatter"), null));
    expect(result.status).toBe("ignored");
    expect(h.db.messages.rows.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Operators/admins skip the verification gate (product decision 2026-09):
// boot-seeded staff ids are trusted humans — no arithmetic challenge.
// ---------------------------------------------------------------------------

describe("staff skip the verification gate (2026-09)", () => {
  it("an operator's first /start opens the conversation without issuing a challenge", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await services.operators.seed();

    const result = await services.processor.process(1, userMessage(222, 100, profile(222), text("/start")));
    expect(result.status).toBe("processed");

    expect(await h.db.users.getByTelegramUserId(222)).not.toBeNull();
    expect(await h.db.conversations.getByTelegramUserId(222)).not.toBeNull();
    // No challenge state and no challenge message was created for the operator.
    expect(await h.store.get(222)).toBeNull();
    const challenge = h.telegram.callsOf("sendMessage").find((c) => c.target.chatId === 222 && c.replyMarkup != null);
    expect(challenge).toBeUndefined();
  });

  it("an admin's first plain-text message relays without a challenge and marks them verified", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await services.operators.seed();

    const result = await services.processor.process(1, userMessage(111, 100, profile(111), text("hi from the boss")));
    expect(result.status).toBe("processed");

    expect((await h.db.users.getByTelegramUserId(111))?.verifiedAt).not.toBeNull();
    expect(await h.store.get(111)).toBeNull();
    // The message was forwarded into the admin's own topic, which got a
    // user-info text card at creation (no profile photo on the admin). The card
    // is an unpinned info display.
    const conv = await h.db.conversations.getByTelegramUserId(111);
    expect(conv).not.toBeNull();
    const card = topicSends(h, conv!.telegramTopicId!, "sendMessage").pop()!;
    expect(cardInfoOf(card)).toBe("👤 User111\n🆔 111");
    expect(identityUrlOf(card)).toBe("tg://user?id=111");
    expect(h.telegram.pinnedMessageIds.has(card.id!)).toBe(false);
    const adminForwards = topicSends(h, conv!.telegramTopicId!, "forwardMessage");
    expect(adminForwards.map((f) => f.payload.messageId)).toEqual([100]);
    expect(adminForwards[0]!.payload.fromChatId).toBe(111);
  });

  it("non-staff users stay gated even when the operator registry is seeded", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await services.operators.seed();

    const result = await services.processor.process(1, userMessage(42, 100, profile(42), text("/start")));
    expect(result.status).toBe("verification_issued");
    const challenge = h.telegram.callsOf("sendMessage").find((c) => c.target.chatId === 42 && c.replyMarkup != null);
    expect(challenge).toBeDefined();
    expect(await h.db.conversations.getByTelegramUserId(42)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7.4 Zero rows on rejection
// ---------------------------------------------------------------------------

describe("no-state-on-rejection (7.4)", () => {
  it("bot senders are ignored with no user/conversation/message rows", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    const result = await services.processor.process(1, userMessage(42, 100, profile(42, { isBot: true }), text("hi")));
    expect(result.status).toBe("ignored");
    expect(h.db.users.rows.size).toBe(0);
    expect(h.db.conversations.rows.size).toBe(0);
    expect(h.db.messages.rows.size).toBe(0);
  });

  it("blocked users are rejected with no new rows", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await h.db.blocks.create({ telegramUserId: 42, createdByTelegramUserId: 111 }, h.runtime.now());

    const result = await services.processor.process(1, userMessage(42, 100, profile(42), text("hi")));
    expect(result.status).toBe("blocked");
    expect(h.db.users.rows.size).toBe(0);
    expect(h.db.conversations.rows.size).toBe(0);
    expect(h.db.messages.rows.size).toBe(0);
  });

  it("an unverified user's plain text is gated with no rows", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    const result = await services.processor.process(1, userMessage(42, 100, profile(42), text("hi")));
    expect(result.status).toBe("verification_issued");
    expect(h.db.users.rows.size).toBe(0);
    expect(h.db.conversations.rows.size).toBe(0);
    expect(h.db.messages.rows.size).toBe(0);
  });

  it("a rate-limited message is not relayed and creates no message record", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await verifiedUser(h, 42);

    for (let i = 1; i <= 10; i++) {
      await services.processor.process(i, userMessage(42, 1000 + i, profile(42), text(`m${i}`)));
    }
    expect(h.db.messages.rows.size).toBe(10);

    const result = await services.processor.process(11, userMessage(42, 9999, profile(42), text("spam")));
    expect(result.status).toBe("rate_limited");
    expect(h.db.messages.rows.size).toBe(10);
  });
});
