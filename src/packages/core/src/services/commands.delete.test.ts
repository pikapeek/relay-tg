// ---------------------------------------------------------------------------
// /delete (8.4): conversation cascade + user-chat copy cleanup + staff/bot
// protection. /delete reply-retract (8.4d), the /list + tap-to-delete picker
// (8.4b), and the staff private-chat surface (8.4c).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { type ConversationDeleteEvent } from "@relaytg/shared";
import { makeHarness, profile, text, userMessage, operatorMessage, verificationAnswer, GROUP_ID } from "./harness.ts";
import { OPERATOR_TEXTS, TEXTS } from "./texts.ts";
import { seeded, verifiedUser, replyText, groupReplies } from "./commands.test-helpers.ts";

// ---------------------------------------------------------------------------
// 8.4 /delete
// ---------------------------------------------------------------------------

describe("/delete (8.4)", () => {
  it("cascades conversation rows and removes the topic best-effort", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const conv = await verifiedUser(h, 42);
    // Seed some conversation state: a relayed message and a note.
    await services.processor.process(1, userMessage(42, 100, profile(42), text("first")));
    await h.db.notes.create({ conversationId: conv.id, operatorId: "op-2", text: "secret note" }, h.runtime.now());
    expect(h.db.messages.rows.size).toBe(1);
    expect(h.db.notes.rows.size).toBe(1);

    const result = await services.processor.process(2, operatorMessage(GROUP_ID, 2, profile(111), text("/delete"), conv.telegramTopicId!));
    expect(result.status).toBe("command_handled");
    // The topic is deleted, so the confirmation echoes into the general chat,
    // naming the conversation that was removed.
    expect(replyText(h)).toEqual([OPERATOR_TEXTS("en").conversationDeleted("User42", null, 42, conv.id)]);

    expect(h.db.conversations.rows.size).toBe(0);
    expect(h.db.messages.rows.size).toBe(0);
    expect(h.db.notes.rows.size).toBe(0);
    expect(h.telegram.callsOf("deleteForumTopic")).toHaveLength(1);

    // Deleting a conversation re-locks the door: verified_at / approved_at are
    // cleared so the next contact re-verifies, and the purpose is cleared too so
    // the next conversation opens with a freshly stated, pinned purpose.
    const after = await h.db.users.getByTelegramUserId(42);
    expect(await h.db.users.getVerifiedAt("main", 42)).toBeNull();
    expect(after?.approvedAt).toBeNull();
    expect(after?.purpose).toBeNull();
  });

  it("/delete removes the delivered user-chat copies and the user must re-verify on next contact", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const conv = await verifiedUser(h, 42);
    // The operator's earlier reply produced a user-chat copy.
    await services.processor.process(
      1,
      operatorMessage(GROUP_ID, 9001, profile(222), text("We're on it!"), conv.telegramTopicId!),
    );
    const record = [...h.db.messages.rows.values()][0];
    expect(record.direction).toBe("OPERATOR_TO_USER");
    const copyId = record.relayedMessageId;
    expect(copyId).not.toBeNull();

    await services.processor.process(2, operatorMessage(GROUP_ID, 2, profile(111), text("/delete"), conv.telegramTopicId!));
    // The delivered relayed copy is removed from the user's side, so the
    // user's chat is left empty (there is no welcome message to clean up).
    expect(h.telegram.deletedMessages).toEqual([{ chatId: 42, messageId: copyId }]);

    // Next contact re-challenges: the user is unverified again, so /start issues
    // a fresh arithmetic question instead of silently reopening the topic.
    const restart = await services.processor.process(3, userMessage(42, 100, profile(42), text("/start")));
    expect(restart.status).toBe("verification_issued");
    expect(await h.db.conversations.getByTelegramUserId(42)).toBeNull();
  });

  it("refuses to /delete the requester's own conversation in a topic", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    // An admin can hold a user conversation of their own (e.g. they contacted
    // support before being promoted); /delete in that topic must be refused.
    const own = await verifiedUser(h, 111);

    const result = await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(111), text("/delete"), own.telegramTopicId!));
    expect(result.status).toBe("command_handled");
    expect(replyText(h, own.telegramTopicId!)).toEqual([OPERATOR_TEXTS("en").deleteStaffRefused]);

    expect(await h.db.conversations.getByTelegramUserId(111)).not.toBeNull();
    expect(h.telegram.callsOf("deleteForumTopic")).toHaveLength(0);
  });

  it("refuses to /delete a staff member's conversation in a topic", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const opConv = await verifiedUser(h, 222); // 222 is a seeded OPERATOR

    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(111), text("/delete"), opConv.telegramTopicId!));
    expect(replyText(h, opConv.telegramTopicId!)).toEqual([OPERATOR_TEXTS("en").deleteStaffRefused]);
    expect(await h.db.conversations.getByTelegramUserId(222)).not.toBeNull();
    expect(h.telegram.callsOf("deleteForumTopic")).toHaveLength(0);
  });

  it("refuses a direct /delete of the requester's own or a staff conversation", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const own = await verifiedUser(h, 111);
    await verifiedUser(h, 222);

    // Own conversation, addressed by conversation id.
    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(111), text(`/delete ${own.id}`), null));
    // Staff conversation, addressed by telegram_user_id.
    await services.processor.process(2, operatorMessage(GROUP_ID, 2, profile(111), text("/delete 222"), null));
    expect(replyText(h)).toEqual([
      OPERATOR_TEXTS("en").deleteStaffRefused,
      OPERATOR_TEXTS("en").deleteStaffRefused,
    ]);

    expect(await h.db.conversations.getByTelegramUserId(111)).not.toBeNull();
    expect(await h.db.conversations.getByTelegramUserId(222)).not.toBeNull();
    expect(h.telegram.callsOf("deleteForumTopic")).toHaveLength(0);
  });

  it("refuses a tap-to-delete on the requester's own conversation", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const own = await verifiedUser(h, 111);
    await verifiedUser(h, 42); // a second, deletable conversation keeps the picker meaningful

    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(111), text("/delete"), null));
    const picker = h.telegram.callsOf("sendMessage").find((c) => c.payload.text === OPERATOR_TEXTS("en").deletePickerHeader(2))!;
    expect(picker).toBeDefined();

    const tap: ConversationDeleteEvent = {
      kind: "conversation_delete",
      callbackQueryId: "cb-1",
      chatId: GROUP_ID,
      messageId: picker.id!,
      sender: profile(111),
      conversationId: own.id,
    };
    const result = await services.processor.process(2, tap);
    expect(result.status).toBe("command_handled");

    // The tap is answered with an alert, and nothing was deleted.
    expect(h.telegram.answers.at(-1)).toEqual({
      callbackQueryId: "cb-1",
      text: OPERATOR_TEXTS("en").deleteStaffRefused,
      showAlert: true,
    });
    expect(await h.db.conversations.getByTelegramUserId(111)).not.toBeNull();
    expect(h.telegram.callsOf("deleteForumTopic")).toHaveLength(0);
  });

  it("refuses to /delete the bot's own conversation", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    // The PRIMARY bot's own telegram user id (the fake's default getMe id) — a
    // conversation whose user IS the bot is as untouchable as the requester's
    // or a staff member's.
    const botUserId = h.bots.primary().botTelegramUserId;
    const botConv = await verifiedUser(h, botUserId);

    // In its topic and by direct group-level target, the bot's own thread is
    // as untouchable as the requester's or a staff member's.
    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(111), text("/delete"), botConv.telegramTopicId!));
    await services.processor.process(2, operatorMessage(GROUP_ID, 2, profile(111), text(`/delete ${botUserId}`), null));
    expect(replyText(h)).toEqual([
      OPERATOR_TEXTS("en").deleteStaffRefused,
      OPERATOR_TEXTS("en").deleteStaffRefused,
    ]);

    expect(await h.db.conversations.getByTelegramUserId(botUserId)).not.toBeNull();
    expect(h.telegram.callsOf("deleteForumTopic")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 8.4d reply-to /delete retract
// ---------------------------------------------------------------------------

describe("/delete reply-retract (8.4d)", () => {
  it("retracts an operator message from the user's chat and leaves the topic message in place", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const conv = await verifiedUser(h, 42);
    await services.processor.process(
      1,
      operatorMessage(GROUP_ID, 9001, profile(222), text("We're on it!"), conv.telegramTopicId!),
    );
    const record = [...h.db.messages.rows.values()][0];
    expect(record.direction).toBe("OPERATOR_TO_USER");
    const copyId = record.relayedMessageId;
    expect(copyId).not.toBeNull();

    await services.processor.process(2, operatorMessage(GROUP_ID, 2, profile(222), text("/delete"), conv.telegramTopicId!, 9001));
    // Only the delivered user-chat copy is removed — the topic message stays.
    expect(h.telegram.deletedMessages).toEqual([{ chatId: 42, messageId: copyId }]);
    const replies = groupReplies(h, conv.telegramTopicId!);
    expect(replies).toHaveLength(1);
    expect(replies[0].payload.text).toBe(OPERATOR_TEXTS("en").delDone);
    // The confirmation quotes the message the operator replied to.
    expect(replies[0].target.replyToMessageId).toBe(9001);
  });

  it("silently ignores a /delete replying to a user message — nothing to retract", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const conv = await verifiedUser(h, 42);
    await services.processor.process(1, userMessage(42, 100, profile(42), text("hello")));
    const fwd = h.telegram.callsOf("forwardMessage")[0];
    expect(fwd).toBeDefined();
    const topicCopyId = fwd.id!;

    await services.processor.process(2, operatorMessage(GROUP_ID, 2, profile(222), text("/delete"), conv.telegramTopicId!, topicCopyId));
    // USER_TO_OPERATOR relay — the user typed it, so there is no user-side copy
    // the bot can withdraw; stay silent (no reply, no deletion).
    expect(h.telegram.deletedMessages).toEqual([]);
    expect(groupReplies(h, conv.telegramTopicId!)).toHaveLength(0);
  });

  it("tells an operator there is nothing to retract when /delete replies to a message with no relay record (the info card)", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const conv = await verifiedUser(h, 42);
    const card = h.telegram.callsOf("sendMessage").find(
      (c) => c.target.chatId === GROUP_ID && c.replyMarkup?.buttons.some((b) => b.url?.startsWith("tg://user?id=")),
    )!;
    expect(card).toBeDefined();

    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(222), text("/delete"), conv.telegramTopicId!, card.id!));
    expect(h.telegram.deletedMessages).toEqual([]);
    const replies = groupReplies(h, conv.telegramTopicId!);
    expect(replies[0].payload.text).toBe(OPERATOR_TEXTS("en").nothingToRetract);
    expect(replies[0].target.replyToMessageId).toBe(card.id!);
    // Nothing was deleted — the operator has no power to remove a conversation.
    expect(await h.db.conversations.getByTelegramUserId(42)).not.toBeNull();
  });

  it("lets an admin delete the conversation when /delete replies to the info card (no relay record)", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const conv = await verifiedUser(h, 42);
    const card = h.telegram.callsOf("sendMessage").find(
      (c) => c.target.chatId === GROUP_ID && c.replyMarkup?.buttons.some((b) => b.url?.startsWith("tg://user?id=")),
    )!;
    expect(card).toBeDefined();

    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(111), text("/delete"), conv.telegramTopicId!, card.id!));
    expect(await h.db.conversations.getByTelegramUserId(42)).toBeNull();
    expect(h.telegram.callsOf("deleteForumTopic")).toHaveLength(1);
    // The topic is gone, so the confirmation lands in the group's general chat.
    expect(replyText(h)).toEqual([OPERATOR_TEXTS("en").conversationDeleted("User42", null, 42, conv.id)]);
  });

  it("refuses /delete on the first pinned purpose card for both operator and admin (conversation survives)", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    // Drive the purpose gate so the topic opens with a SINGLE PINNED purpose+info
    // card (unlike `verifiedUser`, whose info card is unpinned).
    await services.processor.process(1, userMessage(42, 100, profile(42), text("/start")));
    const state = (await h.store.get("main", 42))!;
    await services.processor.process(2, verificationAnswer(42, state.questionMessageId!, state.answer, "cq", profile(42)));
    await services.processor.process(3, userMessage(42, 101, profile(42), text("asking about refunds")));

    const conv = await h.db.conversations.getByTelegramUserId(42);
    expect(conv).not.toBeNull();
    expect(h.telegram.pinnedMessageIds.size).toBe(1);
    const cardId = [...h.telegram.pinnedMessageIds][0];
    // The pin is persisted so `/delete` can protect it.
    expect(await h.db.settings.get(`topic_pin:${conv!.id}`)).toBe(String(cardId));

    // Operator: refused, conversation untouched.
    await services.processor.process(4, operatorMessage(GROUP_ID, 4, profile(222), text("/delete"), conv!.telegramTopicId!, cardId));
    expect(await h.db.conversations.getByTelegramUserId(42)).not.toBeNull();
    expect(h.telegram.callsOf("deleteForumTopic")).toHaveLength(0);
    expect(replyText(h, conv!.telegramTopicId!)).toContain(OPERATOR_TEXTS("en").pinCardProtected);

    // Admin: also refused — no escalation to a conversation delete.
    await services.processor.process(5, operatorMessage(GROUP_ID, 5, profile(111), text("/delete"), conv!.telegramTopicId!, cardId));
    expect(await h.db.conversations.getByTelegramUserId(42)).not.toBeNull();
    expect(h.telegram.callsOf("deleteForumTopic")).toHaveLength(0);
    expect(replyText(h, conv!.telegramTopicId!)).toContain(OPERATOR_TEXTS("en").pinCardProtected);
  });

  it("reports when the user-side copy could not be deleted", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const conv = await verifiedUser(h, 42);
    await services.processor.process(
      1,
      operatorMessage(GROUP_ID, 9001, profile(222), text("We're on it!"), conv.telegramTopicId!),
    );
    const record = [...h.db.messages.rows.values()][0];
    const copyId = record.relayedMessageId;
    expect(copyId).not.toBeNull();

    // The only deleteMessage is the user-side retract — make it fail.
    h.telegram.failOnceWith("bad_request", "deleteMessage");
    await services.processor.process(2, operatorMessage(GROUP_ID, 2, profile(222), text("/delete"), conv.telegramTopicId!, 9001));
    expect(h.telegram.deletedMessages).toEqual([]);
    const replies = groupReplies(h, conv.telegramTopicId!);
    expect(replies[0].payload.text).toBe(OPERATOR_TEXTS("en").delFailed);
    expect(replies[0].target.replyToMessageId).toBe(9001);
  });

  it("refuses an unprivileged operator's replyless /delete (conversation deletion is ADMIN only)", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const conv = await verifiedUser(h, 42);

    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(222), text("/delete"), conv.telegramTopicId!));
    expect(replyText(h, conv.telegramTopicId!)).toEqual([OPERATOR_TEXTS("en").adminOnly]);
    expect(await h.db.conversations.getByTelegramUserId(42)).not.toBeNull();
    expect(h.telegram.callsOf("deleteForumTopic")).toHaveLength(0);
  });

  it("lets an admin delete the conversation with a replyless /delete", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const conv = await verifiedUser(h, 42);

    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(111), text("/delete"), conv.telegramTopicId!));
    expect(replyText(h)).toEqual([OPERATOR_TEXTS("en").conversationDeleted("User42", null, 42, conv.id)]);
    expect(await h.db.conversations.getByTelegramUserId(42)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 8.4b /list and the tap-to-delete picker
// ---------------------------------------------------------------------------

describe("/list and the tap-to-delete picker (8.4b)", () => {
  it("/list renders every conversation numbered with its id", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const convA = await verifiedUser(h, 42);
    await services.users.getOrCreate(profile(42, { username: "alice" }));
    const convB = await verifiedUser(h, 43);

    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(111), text("/list"), null));

    const list = replyText(h)[0];
    expect(list).toContain("Conversations (2):");
    expect(list).toContain(`1. 👤 User42 (@alice) — ${convA.id}`);
    expect(list).toContain(`2. 👤 User43 — ${convB.id}`);
  });

  it("group-level /delete posts the tap-to-delete picker with one button per conversation", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const convA = await verifiedUser(h, 42);
    const convB = await verifiedUser(h, 43);

    const result = await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(111), text("/delete"), null));
    expect(result.status).toBe("command_handled");

    const picker = h.telegram.callsOf("sendMessage").find((c) => c.payload.text === OPERATOR_TEXTS("en").deletePickerHeader(2))!;
    expect(picker).toBeDefined();
    expect(picker.replyMarkup?.buttons.map((b) => b.callbackData)).toEqual([`del:${convA.id}`, `del:${convB.id}`]);
  });

  it("refuses a non-admin operator at group level with no picker and no state change", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    await verifiedUser(h, 42);

    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(222), text("/delete"), null));

    expect(replyText(h)).toEqual([OPERATOR_TEXTS("en").adminOnly]);
    expect(h.telegram.callsOf("sendMessage").some((c) => c.payload.text === OPERATOR_TEXTS("en").deletePickerHeader(1))).toBe(false);
    expect(h.db.conversations.rows.size).toBe(1);
  });

  it("tapping a picker button deletes the conversation and re-renders the picker", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const convA = await verifiedUser(h, 42);
    await services.users.getOrCreate(profile(42, { username: "alice" }));
    const convB = await verifiedUser(h, 43);

    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(111), text("/delete"), null));
    const picker = h.telegram.callsOf("sendMessage").find((c) => c.payload.text === OPERATOR_TEXTS("en").deletePickerHeader(2))!;

    const tap: ConversationDeleteEvent = {
      kind: "conversation_delete",
      callbackQueryId: "cq-del-a",
      chatId: GROUP_ID,
      messageId: picker.id!,
      sender: profile(111),
      conversationId: convA.id,
    };
    const result = await services.processor.process(2, tap);
    expect(result.status).toBe("command_handled");
    expect(await h.db.conversations.getByTelegramUserId(42)).toBeNull();
    expect(await h.db.conversations.getByTelegramUserId(43)).not.toBeNull();
    expect(h.telegram.callsOf("deleteForumTopic")).toHaveLength(1);
    const toast = h.telegram.answers.find((a) => a.callbackQueryId === "cq-del-a");
    expect(toast?.text).toBe(OPERATOR_TEXTS("en").deletedToast("User42", "alice", 42));

    // The picker is re-rendered with the remaining conversation only.
    const rerender = h.telegram.callsOf("editMessageText").pop()!;
    expect(rerender.payload.text).toBe(OPERATOR_TEXTS("en").deletePickerHeader(1));
    expect(rerender.replyMarkup?.buttons.map((b) => b.callbackData)).toEqual([`del:${convB.id}`]);
  });

  it("tapping the last conversation swaps the picker for the empty list", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const conv = await verifiedUser(h, 42);

    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(111), text("/delete"), null));
    const picker = h.telegram.callsOf("sendMessage").find((c) => c.payload.text === OPERATOR_TEXTS("en").deletePickerHeader(1))!;

    const tap: ConversationDeleteEvent = {
      kind: "conversation_delete",
      callbackQueryId: "cq-del-last",
      chatId: GROUP_ID,
      messageId: picker.id!,
      sender: profile(111),
      conversationId: conv.id,
    };
    await services.processor.process(2, tap);

    const rerender = h.telegram.callsOf("editMessageText").pop()!;
    expect(rerender.payload.text).toBe(OPERATOR_TEXTS("en").listEmpty);
    expect(rerender.replyMarkup).toBeUndefined();
  });

  it("an admin can /delete <target> at group level directly", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const conv = await verifiedUser(h, 42);

    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(111), text(`/delete ${conv.id}`), null));

    expect(await h.db.conversations.getByTelegramUserId(42)).toBeNull();
    expect(replyText(h)).toContain(OPERATOR_TEXTS("en").conversationDeleted("User42", null, 42, conv.id));
  });
});

// ---------------------------------------------------------------------------
// 8.4c staff private-chat /list and /delete
// ---------------------------------------------------------------------------

describe("staff private-chat /list and /delete (8.4c)", () => {
  it("an admin's /list in the bot chat lists every conversation", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const conv = await verifiedUser(h, 42);

    const result = await services.processor.process(1, userMessage(111, 1, profile(111), text("/list")));
    expect(result.status).toBe("command_handled");

    const list = h.telegram.callsOf("sendMessage").find((c) => c.target.chatId === 111 && (c.payload.text as string).startsWith("Conversations (1):"));
    expect(list).toBeDefined();
    expect(list!.payload.text).toContain(conv.id);
  });

  it("a regular user's /list in the bot chat gets the user help, not the list", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    await verifiedUser(h, 42);

    await services.processor.process(1, userMessage(99, 1, profile(99), text("/list")));

    const userHelp = h.telegram.callsOf("sendMessage").find((c) => c.target.chatId === 99 && c.payload.text === TEXTS("en").userHelp);
    expect(userHelp).toBeDefined();
  });

  it("an admin's /delete in the bot chat posts the tap-to-delete picker", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const conv = await verifiedUser(h, 42);

    const result = await services.processor.process(1, userMessage(111, 1, profile(111), text("/delete")));
    expect(result.status).toBe("command_handled");

    const picker = h.telegram.callsOf("sendMessage").find((c) => c.target.chatId === 111 && c.payload.text === OPERATOR_TEXTS("en").deletePickerHeader(1));
    expect(picker?.replyMarkup?.buttons[0]?.callbackData).toBe(`del:${conv.id}`);
  });
});
