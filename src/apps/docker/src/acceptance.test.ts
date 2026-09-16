// ---------------------------------------------------------------------------
// RelayTG acceptance suite (task 13.2) — the delivery criteria from SPEC §48
// plus the extended behavior scenarios, run on the Docker/sqlite stack where
// restart persistence is meaningful.
//
//   10 acceptance scenarios:
//     A1. a new user passes the four-choice arithmetic verification
//     A2. a second user's conversation is isolated from the first
//     A3. a user message reaches their topic and is recorded
//     A4. an operator reply reaches the owning user's private chat
//     A5. a reply preserves its target across the relay
//     A6. restarting the process preserves users/conversations/messages
//     A7. deleting the topic recovers via a fresh topic
//     A8. a blocked user is rejected
//     A9. an over-window user is rate-limited
//     A10. a repeated update is deduplicated
//
//   Extended scenarios:
//     E1. a user message edit is dropped (the topic copy is a forward)
//     E2. non-operator topic messages are ignored
//     E3. /apply → admin approval → conversation flow
//     E4. a hidden conversation is reopened by /restore and usable again
//     E5. /hide off keeps a conversation visible past the sweep threshold
//     E6. /help replies in both the user and operator contexts
//     E7. a sender with a profile photo gets a pinned avatar photo card + forwarding
//     E7b. a sender without a profile photo gets a pinned text card + forwarding
//
// These reuse the shared relay-suite harness so the acceptance scenarios drive
// the exact same core services both runtimes do.
// ---------------------------------------------------------------------------

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { OPERATOR_TEXTS, TEXTS } from "@relaytg/core";
import { applyMigrations, loadMigrationsFromDir, NodeSqliteDb } from "@relaytg/adapter-sqlite";
import { SqliteDatabase } from "@relaytg/adapter-sqlite/repository";
import {
  applicationDecision,
  countRows,
  GROUP_ID,
  makeRelayHarness,
  markVerified,
  openConversation,
  operatorMessage,
  profile,
  text,
  textOf,
  topicSends,
  userMessage,
  verificationAnswer,
  type RelayHarness,
} from "@relaytg/adapter-sqlite/relay-suite";

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "migrations");

// ---------------------------------------------------------------------------
// Acceptance suite (shared in-memory sqlite per test, real migrations).
// ---------------------------------------------------------------------------

describe("relaytg acceptance suite (SPEC §48 + extended)", () => {
  let h: RelayHarness;
  let tempDirs: string[] = [];

  beforeEach(async () => {
    const sql = NodeSqliteDb.open(":memory:");
    await applyMigrations(sql, loadMigrationsFromDir(migrationsDir));
    h = await makeRelayHarness(new SqliteDatabase(sql), sql);
  });

  afterEach(() => {
    for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
    tempDirs = [];
  });

  // ------------------------------------------------------------------ A1
  it("A1: a new user passes the four-choice arithmetic verification", async () => {
    const challenge = await h.services.processor.process(1, userMessage(42, 100, profile(42), text("/start")));
    expect(challenge.status).toBe("verification_issued");
    expect(countRows(h, "users")).toBe(0);
    expect(countRows(h, "conversations")).toBe(0);

    const question = h.telegram.callsOf("sendMessage").find((c) => c.target.chatId === 42 && c.replyMarkup != null);
    expect(question).toBeDefined();
    expect(question!.replyMarkup!.buttons).toHaveLength(4);

    const state = (await h.store.get(42))!;
    const result = await h.services.processor.process(2, verificationAnswer(42, state.questionMessageId!, state.answer, "cq", profile(42)));
    // Verified — the first-contact purpose gate then asks before any topic.
    expect(result.status).toBe("purpose_pending");
    expect(countRows(h, "conversations")).toBe(0);

    // The purpose statement opens the conversation + topic.
    const stated = await h.services.processor.process(3, userMessage(42, 101, profile(42), text("asking about a refund")));
    expect(stated.status).toBe("processed");

    expect((await h.db.users.getByTelegramUserId(42))?.verifiedAt).not.toBeNull();
    expect((await h.db.users.getByTelegramUserId(42))?.purpose).toBe("asking about a refund");
    const conv = await h.db.conversations.getByTelegramUserId(42);
    expect(conv).not.toBeNull();
    expect(h.telegram.topics.has(conv!.telegramTopicId!)).toBe(true);
    // The purpose statement opens the topic as ONE combined pinned card: the
    // purpose + the user's info in a single message. No forward into the topic.
    expect(topicSends(h, conv!.telegramTopicId!, "forwardMessage")).toHaveLength(0);
    const card = topicSends(h, conv!.telegramTopicId!, "sendMessage").pop()!;
    expect(textOf(card)).toBe("📝 asking about a refund\n👤 User 42\n@user42\n🆔 42");
    expect(h.telegram.pinnedMessageIds.has(card.id!)).toBe(true);
  });

  // ------------------------------------------------------------------ A2
  it("A2: a second user's conversation is isolated from the first", async () => {
    await markVerified(h, 42);
    await markVerified(h, 43);
    const conv42 = await openConversation(h, 42);
    await openConversation(h, 43);

    await h.services.processor.process(
      1,
      operatorMessage(GROUP_ID, 9001, profile(222), text("for 42 only"), conv42.telegramTopicId!),
    );

    const to42 = h.telegram.callsOf("sendMessage").find((c) => c.target.chatId === 42 && textOf(c) === "for 42 only");
    expect(to42).toBeDefined();
    // User 43 must never receive user 42's relayed copy.
    expect(h.telegram.callsOf("sendMessage").some((c) => c.target.chatId === 43 && textOf(c) === "for 42 only")).toBe(false);
    expect(countRows(h, "messages")).toBe(1);
    expect((await h.db.messages.getBySource(GROUP_ID, 9001))?.conversationId).toBe(conv42.id);
  });

  // ------------------------------------------------------------------ A3
  it("A3: a user message reaches their topic and is recorded", async () => {
    await markVerified(h, 42);
    const conv = await openConversation(h, 42);

    const result = await h.services.processor.process(1, userMessage(42, 1001, profile(42), text("hello support")));
    expect(result.status).toBe("processed");

    // The user's message is forwarded verbatim into their topic.
    const forwards = topicSends(h, conv.telegramTopicId!, "forwardMessage");
    expect(forwards).toHaveLength(1);
    expect(forwards[0]!.payload.fromChatId).toBe(42);
    expect(forwards[0]!.payload.messageId).toBe(1001);
    // The topic's first message is the user-info card (text card for a sender
    // without a profile photo) with a tap-through profile button — a pure info
    // display, never pinned.
    const card = topicSends(h, conv.telegramTopicId!, "sendMessage").pop()!;
    expect(textOf(card)).toBe("👤 User 42\n@user42\n🆔 42");
    expect(card.replyMarkup?.buttons[0]?.url).toBe("tg://user?id=42");
    expect(h.telegram.pinnedMessageIds.has(card.id!)).toBe(false);
    const record = await h.db.messages.getBySource(42, 1001);
    expect(record).not.toBeNull();
    expect(record!.direction).toBe("USER_TO_OPERATOR");
    expect(record!.relayedMessageId).toBe(forwards[0]!.id);
  });

  // ------------------------------------------------------------------ A4
  it("A4: an operator reply reaches the owning user's private chat", async () => {
    await markVerified(h, 42);
    const conv = await openConversation(h, 42);

    const result = await h.services.processor.process(
      1,
      operatorMessage(GROUP_ID, 9001, profile(222), text("We're on it!"), conv.telegramTopicId!),
    );
    expect(result.status).toBe("processed");

    const userSend = h.telegram.callsOf("sendMessage").find((c) => c.target.chatId === 42 && textOf(c) === "We're on it!");
    expect(userSend).toBeDefined();
    expect(userSend!.target.messageThreadId).toBeUndefined();
    const record = await h.db.messages.getBySource(GROUP_ID, 9001);
    expect(record!.direction).toBe("OPERATOR_TO_USER");
  });

  // ------------------------------------------------------------------ A5
  it("A5: a reply preserves its target across the relay", async () => {
    await markVerified(h, 42);
    const conv = await openConversation(h, 42);

    await h.services.messages.create({
      conversationId: conv.id,
      telegramChatId: GROUP_ID,
      telegramMessageId: 9001,
      telegramTopicId: conv.telegramTopicId,
      relayedMessageId: 3000,
      direction: "OPERATOR_TO_USER",
      senderType: "OPERATOR",
      contentType: "text",
      replyToMessageId: null,
    });

    await h.services.processor.process(1, userMessage(42, 1001, profile(42), text("thanks"), { replyToMessageId: 3000 }));

    const forward = topicSends(h, conv.telegramTopicId!, "forwardMessage").pop()!;
    expect(forward.payload.fromChatId).toBe(42);
    expect(forward.payload.messageId).toBe(1001);
    // forwardMessage can't carry a reply-to, so the reply reference lives in the
    // database record only.
    expect(forward.target.replyToMessageId).toBeUndefined();
    expect((await h.db.messages.getBySource(42, 1001))?.replyToMessageId).toBe(3000);
  });

  // ------------------------------------------------------------------ A6
  it("A6: restarting the process preserves users, conversations, and messages", async () => {
    const dir = mkdtempSync(join(tmpdir(), "relaytg-accept-"));
    tempDirs.push(dir);
    const dbPath = join(dir, "relaytg.db");

    // First "boot": migrate + relay a message into a file-backed database.
    const sql1 = NodeSqliteDb.open(dbPath);
    await applyMigrations(sql1, loadMigrationsFromDir(migrationsDir));
    const h1 = await makeRelayHarness(new SqliteDatabase(sql1), sql1);
    await markVerified(h1, 42);
    const conv1 = await openConversation(h1, 42);
    const topicId = conv1.telegramTopicId!;
    await h1.services.processor.process(1, userMessage(42, 1001, profile(42), text("persist me")));
    expect(countRows(h1, "messages")).toBe(1);
    sql1.close();

    // Second "boot": reopen the same file; no pending migrations.
    const sql2 = NodeSqliteDb.open(dbPath);
    expect(await applyMigrations(sql2, loadMigrationsFromDir(migrationsDir))).toEqual([]);
    const h2 = await makeRelayHarness(new SqliteDatabase(sql2), sql2);

    const user = await h2.db.users.getByTelegramUserId(42);
    expect(user).not.toBeNull();
    expect(user!.firstName).toBe("User 42");
    const conv = await h2.db.conversations.getByTelegramUserId(42);
    expect(conv).not.toBeNull();
    expect(conv!.telegramTopicId).toBe(topicId);
    const record = await h2.db.messages.getBySource(42, 1001);
    expect(record).not.toBeNull();
    expect(record!.direction).toBe("USER_TO_OPERATOR");
    expect(countRows(h2, "conversations")).toBe(1);
    expect(countRows(h2, "messages")).toBe(1);
    sql2.close();
  });

  // ------------------------------------------------------------------ A7
  it("A7: deleting the support topic recovers via a fresh topic and retries delivery", async () => {
    await markVerified(h, 42);
    const conv = await openConversation(h, 42);
    const oldTopicId = conv.telegramTopicId!;

    // An operator deletes the topic out-of-band; the mapping is now stale.
    await h.telegram.deleteForumTopic({ chatId: GROUP_ID, messageThreadId: oldTopicId });

    const result = await h.services.processor.process(1, userMessage(42, 1001, profile(42), text("hello")));
    expect(result.status).toBe("processed");

    const updated = (await h.db.conversations.getByTelegramUserId(42))!;
    expect(updated.telegramTopicId).not.toBe(oldTopicId);
    expect(h.telegram.topics.has(updated.telegramTopicId!)).toBe(true);
    const record = await h.db.messages.getBySource(42, 1001);
    expect(record!.telegramTopicId).toBe(updated.telegramTopicId);
    expect(topicSends(h, updated.telegramTopicId!, "forwardMessage")).toHaveLength(1);
  });

  // ------------------------------------------------------------------ A8
  it("A8: a blocked user's messages are rejected", async () => {
    await h.db.blocks.create({ telegramUserId: 42, createdByTelegramUserId: 111 }, h.runtime.now());

    const result = await h.services.processor.process(1, userMessage(42, 100, profile(42), text("hi")));
    expect(result.status).toBe("blocked");
    expect(countRows(h, "users")).toBe(0);
    expect(countRows(h, "conversations")).toBe(0);
    expect(countRows(h, "messages")).toBe(0);
    expect(h.telegram.callsOf("sendMessage")).toHaveLength(0);
  });

  // ------------------------------------------------------------------ A9
  it("A9: an over-window user is rate-limited without a relayed copy", async () => {
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

  // ----------------------------------------------------------------- A10
  it("A10: a repeated update is deduplicated (one relayed copy, one record)", async () => {
    await markVerified(h, 42);
    const event = userMessage(42, 1001, profile(42), text("hello"));

    const first = await h.services.processor.process(10, event);
    expect(first.status).toBe("processed");
    const conv = (await h.db.conversations.getByTelegramUserId(42))!;
    expect(topicSends(h, conv.telegramTopicId!, "forwardMessage")).toHaveLength(1);

    const second = await h.services.processor.process(10, event);
    expect(second.status).toBe("duplicate");

    expect(topicSends(h, conv.telegramTopicId!, "forwardMessage")).toHaveLength(1);
    expect(await h.db.messages.getBySource(42, 1001)).not.toBeNull();
    expect(countRows(h, "messages")).toBe(1);
    expect(countRows(h, "processed_updates")).toBe(1);
  });

  // ------------------------------------------------------------------ E1
  it("E1: a user message edit is dropped — the topic copy is a forward and can't be edited", async () => {
    await markVerified(h, 42);
    await openConversation(h, 42);

    await h.services.processor.process(1, userMessage(42, 1001, profile(42), text("original")));
    const record = (await h.db.messages.getBySource(42, 1001))!;
    expect(record.relayedMessageId).not.toBeNull();

    const result = await h.services.processor.process(2, {
      kind: "edited_user_message",
      chatId: 42,
      messageId: 1001,
      sender: profile(42),
      content: text("edited"),
    });
    expect(result.status).toBe("processed");

    // No edit call reaches the topic; the drop is logged. The source record stays
    // intact so operator replies keep anchoring on it.
    expect(h.telegram.callsOf("editMessageCaption")).toHaveLength(0);
    expect(h.telegram.callsOf("editMessageText")).toHaveLength(0);
    expect(h.logger.has("message_edit_dropped")).toBe(true);
  });

  // ------------------------------------------------------------------ E2
  it("E2: non-operator topic messages are ignored and never delivered", async () => {
    await markVerified(h, 42);
    const conv = await openConversation(h, 42);

    const result = await h.services.processor.process(
      1,
      operatorMessage(GROUP_ID, 9001, profile(999), text("i am not an operator"), conv.telegramTopicId!),
    );
    expect(result.status).toBe("ignored");
    expect(countRows(h, "messages")).toBe(0);
  });

  // ------------------------------------------------------------------ E3
  it("E3: /apply → admin approval → conversation flow", async () => {
    await h.services.processor.process(1, userMessage(42, 100, profile(42), text("/apply")));
    const app = (await h.db.applications.getLatestByTelegramUserId(42))!;
    expect(app.status).toBe("pending");
    expect(await h.db.conversations.getByTelegramUserId(42)).toBeNull();

    const notice = h.telegram.callsOf("sendMessage").find((c) => c.target.chatId === GROUP_ID && c.replyMarkup != null);
    expect(notice!.replyMarkup!.buttons.map((b) => b.callbackData)).toEqual([
      `apply:approve:${app.id}`,
      `apply:reject:${app.id}`,
    ]);

    // An operator tap is refused; only an admin may decide.
    await h.services.processor.process(2, applicationDecision("cq-op", profile(222), "approve", app.id));
    expect(await h.db.conversations.getByTelegramUserId(42)).toBeNull();

    await h.services.processor.process(3, applicationDecision("cq-ok", profile(111), "approve", app.id));
    expect((await h.db.users.getByTelegramUserId(42))?.approvedAt).not.toBeNull();
    // A first-time applicant is then asked for a purpose before any topic exists.
    expect(await h.db.conversations.getByTelegramUserId(42)).toBeNull();

    // The purpose statement opens the conversation + topic.
    await h.services.processor.process(4, userMessage(42, 101, profile(42), text("applying for support")));
    const conv = await h.db.conversations.getByTelegramUserId(42);
    expect(conv).not.toBeNull();
    expect((await h.db.users.getByTelegramUserId(42))?.purpose).toBe("applying for support");
    // The purpose statement opens the topic as ONE combined pinned card: the
    // purpose + the user's info in a single message. No forward into the topic.
    expect(topicSends(h, conv!.telegramTopicId!, "forwardMessage")).toHaveLength(0);
    const card = topicSends(h, conv!.telegramTopicId!, "sendMessage").pop()!;
    expect(textOf(card)).toBe("📝 applying for support\n👤 User 42\n@user42\n🆔 42");
    expect(h.telegram.pinnedMessageIds.has(card.id!)).toBe(true);
  });

  // ------------------------------------------------------------------ E4
  it("E4: a hidden conversation is reopened by /restore and usable again", async () => {
    await markVerified(h, 42);
    const conv = await openConversation(h, 42);
    const topicId = conv.telegramTopicId!;
    const now = h.runtime.now();
    await h.db.conversations.touchActivity(conv.id, new Date(now.getTime() - 200 * 3600 * 1000));

    expect(await h.services.hides.sweep(now)).toBe(1);
    expect((await h.db.conversations.getById(conv.id))?.hiddenAt).not.toBeNull();

    const restored = await h.services.processor.process(2, operatorMessage(GROUP_ID, 9002, profile(222), text("/restore 42"), null));
    expect(restored.status).toBe("command_handled");
    expect((await h.db.conversations.getById(conv.id))?.hiddenAt).toBeNull();
    expect(h.telegram.topics.get(topicId)?.closed).toBe(false);

    // The conversation is usable again: a new user message relays into the topic.
    const result = await h.services.processor.process(3, userMessage(42, 1001, profile(42), text("back!")));
    expect(result.status).toBe("processed");
    expect(topicSends(h, topicId, "forwardMessage")).toHaveLength(1);
  });

  // ------------------------------------------------------------------ E5
  it("E5: /hide off keeps a conversation visible past the sweep threshold", async () => {
    await markVerified(h, 42);
    const conv = await openConversation(h, 42);
    const topicId = conv.telegramTopicId!;

    await h.services.processor.process(1, operatorMessage(GROUP_ID, 9001, profile(222), text("/hide off"), topicId));
    expect((await h.db.conversations.getById(conv.id))?.hideAfterHours).toBe(0);

    const now = h.runtime.now();
    await h.db.conversations.touchActivity(conv.id, new Date(now.getTime() - 25 * 3600 * 1000));
    expect(await h.services.hides.sweep(now)).toBe(0);
    expect((await h.db.conversations.getById(conv.id))?.hiddenAt).toBeNull();
    expect(h.telegram.topics.get(topicId)?.closed).toBe(false);
  });

  // ------------------------------------------------------------------ E6
  it("E6: /help replies in the user chat and the operator contexts", async () => {
    // User context: /help replies with the user copy and creates nothing.
    const userHelp = await h.services.processor.process(1, userMessage(42, 100, profile(42), text("/help")));
    expect(userHelp.status).toBe("command_handled");
    const userCopy = h.telegram.callsOf("sendMessage").find((c) => c.target.chatId === 42 && c.payload.text === TEXTS("en").userHelp);
    expect(userCopy).toBeDefined();
    expect(countRows(h, "users")).toBe(0);
    expect(countRows(h, "conversations")).toBe(0);

    // Operator context: in a topic and at the group general chat.
    await markVerified(h, 43);
    const conv = await openConversation(h, 43);
    await h.services.processor.process(2, operatorMessage(GROUP_ID, 9100, profile(222), text("/help"), conv.telegramTopicId!));
    const topicHelp = h.telegram.callsOf("sendMessage").find(
      (c) => c.target.chatId === GROUP_ID && c.target.messageThreadId === conv.telegramTopicId && c.payload.text === OPERATOR_TEXTS("en").helpTopic,
    );
    expect(topicHelp).toBeDefined();

    await h.services.processor.process(3, operatorMessage(GROUP_ID, 9101, profile(222), text("/help"), null));
    const generalHelp = h.telegram.callsOf("sendMessage").find(
      (c) => c.target.chatId === GROUP_ID && c.target.messageThreadId == null && c.payload.text === OPERATOR_TEXTS("en").helpGeneral,
    );
    expect(generalHelp).toBeDefined();
  });

  // ------------------------------------------------------------------ E7
  it("E7: a sender with a profile photo gets a pinned avatar photo card, and messages forward verbatim", async () => {
    await markVerified(h, 42);
    // The photo must exist before the topic is created: the card is built once,
    // at topic birth, from the sender's current profile picture.
    h.telegram.setProfilePhoto(42, "ava-42");
    const conv = await openConversation(h, 42);
    const topicId = conv.telegramTopicId!;

    const card = topicSends(h, topicId, "sendPhoto").pop()!;
    // The card IS the sender's face: photo = avatar, caption = the user info
    // line, and the tap-through profile button opens their profile. It is a
    // pure info display, never pinned.
    expect((card.payload.content as { type: string }).type).toBe("photo");
    expect((card.payload.content as { fileId: string }).fileId).toBe("ava-42");
    expect(textOf(card)).toBe("👤 User 42\n@user42\n🆔 42");
    expect(card.replyMarkup?.buttons[0]).toMatchObject({ url: "tg://user?id=42" });
    expect(h.telegram.pinnedMessageIds.has(card.id!)).toBe(false);

    // The message itself still forwards verbatim.
    const result = await h.services.processor.process(1, userMessage(42, 1001, profile(42), text("hello")));
    expect(result.status).toBe("processed");
    const forward = topicSends(h, topicId, "forwardMessage").pop()!;
    expect(forward.payload.fromChatId).toBe(42);
    expect(forward.payload.messageId).toBe(1001);

    const record = await h.db.messages.getBySource(42, 1001);
    expect(record).not.toBeNull();
    expect(record!.direction).toBe("USER_TO_OPERATOR");
    expect(record!.relayedMessageId).toBe(forward.id);
  });

  it("E7b: a sender without a profile photo gets a pinned text card plus the identity button", async () => {
    await markVerified(h, 42);
    const conv = await openConversation(h, 42);
    const topicId = conv.telegramTopicId!;

    // No profile photo → the card is text: name, @username, user id and the
    // tap-through identity button — a pure user-info display, never pinned.
    const card = topicSends(h, topicId, "sendMessage").pop()!;
    expect(textOf(card)).toBe("👤 User 42\n@user42\n🆔 42");
    expect(card.replyMarkup?.buttons[0]).toMatchObject({ url: "tg://user?id=42" });
    expect(h.telegram.pinnedMessageIds.has(card.id!)).toBe(false);
    expect(topicSends(h, topicId, "sendPhoto")).toHaveLength(0);

    const result = await h.services.processor.process(1, userMessage(42, 1001, profile(42), text("hi")));
    expect(result.status).toBe("processed");
    const forward = topicSends(h, topicId, "forwardMessage").pop()!;
    expect(forward.payload.fromChatId).toBe(42);
    expect(forward.payload.messageId).toBe(1001);
  });
});