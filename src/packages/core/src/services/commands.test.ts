// ---------------------------------------------------------------------------
// Operator command + application-decision tests (task 8): the operator
// registry (8.1), the command dispatcher (8.2), /ban /unban (8.3),
// /delete (8.4), /info (8.5), /assign (8.6), /note (8.7), the callback
// handler's application-decision consumer (8.8), /restore (8.9), /hide (8.10),
// and /help (8.11).
//
// Verification-answer callbacks are covered by the pipeline suite (pipeline
// 7.2); this file covers the application-decision half of 8.8.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { type ApplicationDecisionEvent, type ConversationDeleteEvent, type ConversationRecord } from "@relaytg/shared";
import { buildServices } from "./index.ts";
import {
  makeHarness,
  profile,
  text,
  userMessage,
  operatorMessage,
  verificationAnswer,
  GROUP_ID,
  type Harness,
} from "./harness.ts";
import { OPERATOR_TEXTS, TEXTS } from "./texts.ts";
import { OPERATOR_COMMANDS_ZH, USER_COMMANDS_ZH } from "./command-menu.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seeded(h: Harness) {
  const services = buildServices(h.ctx);
  await services.operators.seed();
  return services;
}

async function verifiedUser(h: Harness, telegramUserId: number, purpose = "test purpose"): Promise<ConversationRecord> {
  const services = buildServices(h.ctx);
  const { user } = await services.users.getOrCreate(profile(telegramUserId));
  await services.users.markVerified(user.telegramUserId);
  // Verification is followed by the first-contact purpose gate: the user states
  // a purpose before any topic exists, so fixtures carry one on the record.
  await services.users.setPurpose(user.telegramUserId, purpose);
  return services.conversations.grantAccess(user);
}

/** Reply posted by the bot back into the support group (operator command echo).
 * Relayed content sends are excluded: only direct command replies carry a
 * plain `payload.text`. The pinned personal info card is also excluded — it is
 * a `sendMessage` into the topic whose tap-through profile button marks it. */
function groupReplies(h: Harness, messageThreadId?: number) {
  return h.telegram
    .callsOf("sendMessage")
    .filter((c) => c.payload.text != null)
    .filter((c) => c.target.chatId === GROUP_ID && (messageThreadId === undefined || c.target.messageThreadId === messageThreadId))
    .filter((c) => !c.replyMarkup?.buttons.some((b) => b.url?.startsWith("tg://user?id=")));
}

function replyText(h: Harness, messageThreadId?: number): string[] {
  return groupReplies(h, messageThreadId).map((c) => c.payload.text as string);
}

function applicationDecision(
  callbackQueryId: string,
  senderId: number,
  decision: "approve" | "reject",
  applicationId: string,
): ApplicationDecisionEvent {
  return { kind: "application_decision", callbackQueryId, chatId: GROUP_ID, messageId: 200, sender: profile(senderId), decision, applicationId };
}

async function hiddenConversation(h: Harness, telegramUserId: number): Promise<ConversationRecord> {
  const conv = await verifiedUser(h, telegramUserId);
  await h.telegram.hideForumTopic({ chatId: GROUP_ID, messageThreadId: conv.telegramTopicId! });
  await h.db.conversations.setHidden(conv.id, h.runtime.now().toISOString());
  return conv;
}

// ---------------------------------------------------------------------------
// 8.1 Role / permission service
// ---------------------------------------------------------------------------

describe("role registry (8.1)", () => {
  it("seeds ADMIN_IDS and OPERATOR_IDS with admins winning overlaps", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const ops = await h.db.operators.list();
    expect(ops.map((o) => `${o.telegramUserId}:${o.role}`).sort()).toEqual(["111:ADMIN", "222:OPERATOR", "333:OPERATOR"]);
    expect(await services.operators.isAdmin(111)).toBe(true);
    expect(await services.operators.isOperator(222)).toBe(true);
    expect(await services.operators.isAdmin(222)).toBe(false);
  });

  it("overlapping ids resolve to ADMIN", async () => {
    const config = makeHarness().ctx.config;
    config.operatorIds = [111, 222];
    const h = makeHarness(config);
    const services = await seeded(h);
    expect(await services.operators.getRole(111)).toBe("ADMIN");
  });

  it("a username grants nothing by itself", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    await services.users.getOrCreate(profile(999, { username: "impostor" }));
    expect(await services.operators.resolveByTarget("@impostor")).toBeNull();
    expect(await services.operators.isOperator(999)).toBe(false);
    // A registered operator resolves by numeric id even without a user row…
    expect((await services.operators.resolveByTarget("222"))?.telegramUserId).toBe(222);
    // …but by @username only once the username is attached to a user row.
    expect(await services.operators.resolveByTarget("@missing")).toBeNull();
    await services.users.getOrCreate(profile(222, { username: "bob" }));
    expect((await services.operators.resolveByTarget("@bob"))?.telegramUserId).toBe(222);
  });

  it("denies an admin-only command to an operator (no state change)", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const conv = await verifiedUser(h, 42);
    await services.processor.process(
      1,
      operatorMessage(GROUP_ID, 1, profile(222), text("/ban"), conv.telegramTopicId!),
    );
    expect(h.db.blocks.rows.size).toBe(0);
    expect(replyText(h, conv.telegramTopicId!)).toEqual([OPERATOR_TEXTS("en").adminOnly]);
  });
});

// ---------------------------------------------------------------------------
// 8.2 Command dispatcher
// ---------------------------------------------------------------------------

describe("command dispatcher (8.2)", () => {
  it("runs a valid in-topic command and replies inside the topic", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const conv = await verifiedUser(h, 42);
    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(222), text("/info"), conv.telegramTopicId!));
    const inTopic = replyText(h, conv.telegramTopicId!);
    expect(inTopic).toHaveLength(1);
    expect(inTopic[0]).toContain("ID: 42");
  });

  it("rejects in-topic-only commands posted outside any topic", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(222), text("/note hello"), null));
    expect(replyText(h)).toEqual([OPERATOR_TEXTS("en").outOfTopic]);
    expect(h.db.notes.rows.size).toBe(0);
  });

  it("handles group-level /help", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const result = await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(222), text("/help"), null));
    expect(result.status).toBe("command_handled");
    expect(replyText(h)).toEqual([OPERATOR_TEXTS("en").helpGeneral]);
  });

  it("refuses non-operators even for group-level commands", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const result = await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(999), text("/restore 42"), null));
    expect(result.status).toBe("command_handled"); // handled as a refused command
    expect(replyText(h)).toEqual([OPERATOR_TEXTS("en").notOperator]);
  });

  it("replies with an unknown-command message for unhandled literals", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const conv = await verifiedUser(h, 42);
    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(222), text("/nope"), conv.telegramTopicId!));
    expect(replyText(h, conv.telegramTopicId!)).toEqual([OPERATOR_TEXTS("en").unknownCommand]);
  });

  it("accepts the @bot-mentioned form the group menu suggests", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const conv = await verifiedUser(h, 42);
    // Telegram appends @botusername to menu commands in groups/topics, so the
    // topic receives `/info@relaytg_bot` — it must behave as `/info`.
    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(222), text("/info@relaytg_bot"), conv.telegramTopicId!));
    const inTopic = replyText(h, conv.telegramTopicId!);
    expect(inTopic).toHaveLength(1);
    expect(inTopic[0]).toContain("ID: 42");
  });

  it("accepts arguments after an @bot-mentioned command", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const conv = await verifiedUser(h, 42);
    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(222), text("/assign@relaytg_bot 333"), conv.telegramTopicId!));
    const updated = (await h.db.conversations.getByTelegramUserId(42))!;
    const op = [...h.db.operators.rows.values()].find((o) => o.telegramUserId === 333)!;
    expect(updated.assignedOperatorId).toBe(op.id);
    expect(replyText(h, conv.telegramTopicId!)).toEqual([OPERATOR_TEXTS("en").assigned("333")]);
  });
});

// ---------------------------------------------------------------------------
// 8.3 /ban /unban
// ---------------------------------------------------------------------------

describe("/ban and /unban (8.3)", () => {
  it("adds a block record; the blocked user is then rejected", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const conv = await verifiedUser(h, 42);
    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(111), text("/ban"), conv.telegramTopicId!));
    expect(h.db.blocks.rows.get(42)).toBeDefined();
    expect(replyText(h, conv.telegramTopicId!)).toEqual([OPERATOR_TEXTS("en").userBlocked]);

    const result = await services.processor.process(2, userMessage(42, 100, profile(42), text("hello?")));
    expect(result.status).toBe("blocked");
    expect(h.db.messages.rows.size).toBe(0);
  });

  it("removes the ban on /unban", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const conv = await verifiedUser(h, 42);
    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(111), text("/ban"), conv.telegramTopicId!));
    await services.processor.process(2, operatorMessage(GROUP_ID, 2, profile(111), text("/unban"), conv.telegramTopicId!));
    expect(h.db.blocks.rows.size).toBe(0);

    const result = await services.processor.process(3, userMessage(42, 100, profile(42), text("hello?")));
    expect(result.status).toBe("processed");
  });
});

// ---------------------------------------------------------------------------
// Group-level /ban · /unban by target (广告防护)
// ---------------------------------------------------------------------------

describe("group-level /ban and /unban by target", () => {
  it("blocks a user by bare telegram_user_id from the general chat", async () => {
    const h = makeHarness();
    const services = await seeded(h);

    const result = await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(111), text("/ban 42"), null));
    expect(result.status).toBe("command_handled");
    expect(h.db.blocks.rows.get(42)).toBeDefined();
    expect(replyText(h)).toEqual([OPERATOR_TEXTS("en").userBlocked]);
  });

  it("blocks by @username and does not need a conversation row", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    await services.users.getOrCreate(profile(42, { username: "spammer" }));

    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(111), text("/ban @spammer"), null));
    expect(h.db.blocks.rows.get(42)).toBeDefined();
  });

  it("unblocks a blocked user by bare id from the general chat", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(111), text("/ban 42"), null));
    expect(h.db.blocks.rows.size).toBe(1);

    await services.processor.process(2, operatorMessage(GROUP_ID, 2, profile(111), text("/unban 42"), null));
    expect(h.db.blocks.rows.size).toBe(0);
    expect(replyText(h)).toContain(OPERATOR_TEXTS("en").userUnblocked);
  });

  it("a repeat /ban does not create a duplicate row (blocks.telegram_user_id is unique)", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(111), text("/ban 42"), null));
    await services.processor.process(2, operatorMessage(GROUP_ID, 2, profile(111), text("/ban 42"), null));
    expect(h.db.blocks.rows.size).toBe(1);
  });

  it("refuses a non-admin and an unknown target", async () => {
    const h = makeHarness();
    const services = await seeded(h);

    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(222), text("/ban 42"), null));
    expect(replyText(h)).toEqual([OPERATOR_TEXTS("en").adminOnly]);
    expect(h.db.blocks.rows.size).toBe(0);

    await services.processor.process(2, operatorMessage(GROUP_ID, 2, profile(111), text("/unban @nobody"), null));
    expect(replyText(h)).toContain(OPERATOR_TEXTS("en").unknownRestoreTarget);
  });
});

// ---------------------------------------------------------------------------
// /ad — runtime ad-keyword management (广告防护)
// ---------------------------------------------------------------------------

describe("/ad (广告防护)", () => {
  it("lists, adds, and deletes runtime keywords (persisted in settings)", async () => {
    const h = makeHarness();
    const services = await seeded(h);

    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(111), text("/ad"), null));
    expect(replyText(h).join("\n")).toContain(OPERATOR_TEXTS("en").adEmpty);

    await services.processor.process(2, operatorMessage(GROUP_ID, 2, profile(111), text("/ad add 加微信"), null));
    expect(replyText(h)).toContain(OPERATOR_TEXTS("en").adAdded("加微信"));
    expect(await h.db.settings.get("ad_keywords")).toBe("加微信");

    await services.processor.process(3, operatorMessage(GROUP_ID, 3, profile(111), text("/ad list"), null));
    expect(replyText(h).some((t) => t.startsWith(OPERATOR_TEXTS("en").adListHeader(1)))).toBe(true);
    expect(replyText(h).some((t) => t.includes("加微信"))).toBe(true);

    await services.processor.process(4, operatorMessage(GROUP_ID, 4, profile(111), text("/ad del 加微信"), null));
    expect(replyText(h)).toContain(OPERATOR_TEXTS("en").adRemoved("加微信"));
    expect(await h.db.settings.get("ad_keywords")).toBe("");
  });

  it("a newly added keyword immediately flags messages in the pipeline", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(111), text("/ad add 代购"), null));

    const result = await services.processor.process(2, userMessage(42, 100, profile(42), text("海外代购直邮")));
    expect(result.status).toBe("message_rejected");
  });

  it("refuses a non-admin", async () => {
    const h = makeHarness();
    const services = await seeded(h);

    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(222), text("/ad add 加微信"), null));
    expect(replyText(h)).toEqual([OPERATOR_TEXTS("en").adminOnly]);
    expect(await h.db.settings.get("ad_keywords")).toBeNull();
  });

  it("manages the allowlist with /ad allow (list/add/del)", async () => {
    const h = makeHarness();
    const services = await seeded(h);

    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(111), text("/ad allow add 官网"), null));
    expect(replyText(h).join("\n")).toContain(OPERATOR_TEXTS("en").adAllowAdded("官网"));
    expect(await h.db.settings.get("ad_allow_keywords")).toBe("官网");

    await services.processor.process(2, operatorMessage(GROUP_ID, 2, profile(111), text("/ad allow list"), null));
    expect(replyText(h).some((t) => t.startsWith(OPERATOR_TEXTS("en").adAllowListHeader(1)))).toBe(true);

    await services.processor.process(3, operatorMessage(GROUP_ID, 3, profile(111), text("/ad allow del 官网"), null));
    expect(replyText(h).join("\n")).toContain(OPERATOR_TEXTS("en").adAllowRemoved("官网"));
    expect(await h.db.settings.get("ad_allow_keywords")).toBe("");
  });

  it("sets, views, and clears the link rule with /ad links", async () => {
    const h = makeHarness();
    const services = await seeded(h);

    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(111), text("/ad links"), null));
    expect(replyText(h).join("\n")).toContain(OPERATOR_TEXTS("en").adLinksOff);

    await services.processor.process(2, operatorMessage(GROUP_ID, 2, profile(111), text("/ad links 3"), null));
    expect(replyText(h).join("\n")).toContain(OPERATOR_TEXTS("en").adLinksSet("3"));
    expect(await h.db.settings.get("ad_max_links")).toBe("3");

    await services.processor.process(3, operatorMessage(GROUP_ID, 3, profile(111), text("/ad links"), null));
    expect(replyText(h).join("\n")).toContain(OPERATOR_TEXTS("en").adLinksCurrent(3));

    await services.processor.process(4, operatorMessage(GROUP_ID, 4, profile(111), text("/ad links off"), null));
    expect(replyText(h).join("\n")).toContain(OPERATOR_TEXTS("en").adLinksSet("off"));
    expect(await h.db.settings.get("ad_max_links")).toBe("0");
  });

  it("refuses a non-admin and a reply-less /ad restore", async () => {
    const h = makeHarness();
    const services = await seeded(h);

    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(222), text("/ad restore"), null, 9001));
    expect(replyText(h)).toEqual([OPERATOR_TEXTS("en").adminOnly]);

    await services.processor.process(2, operatorMessage(GROUP_ID, 2, profile(111), text("/ad restore"), null));
    expect(replyText(h).join("\n")).toContain(OPERATOR_TEXTS("en").adRestoreUsage);
  });
});

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
    expect(after?.verifiedAt).toBeNull();
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
    h.ctx.botTelegramUserId = 4242;
    const services = await seeded(h);
    const botConv = await verifiedUser(h, 4242);

    // In its topic and by direct group-level target, the bot's own thread is
    // as untouchable as the requester's or a staff member's.
    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(111), text("/delete"), botConv.telegramTopicId!));
    await services.processor.process(2, operatorMessage(GROUP_ID, 2, profile(111), text("/delete 4242"), null));
    expect(replyText(h)).toEqual([
      OPERATOR_TEXTS("en").deleteStaffRefused,
      OPERATOR_TEXTS("en").deleteStaffRefused,
    ]);

    expect(await h.db.conversations.getByTelegramUserId(4242)).not.toBeNull();
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
    const state = (await h.store.get(42))!;
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

// ---------------------------------------------------------------------------
// 8.5 /info
// ---------------------------------------------------------------------------

describe("/info (8.5)", () => {
  it("renders every summary field", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const conv = await verifiedUser(h, 42);
    await h.db.conversations.setAssignedOperatorId(conv.id, "op-2"); // operator 222
    // One message so "last message" is populated.
    await services.processor.process(1, userMessage(42, 100, profile(42), text("hello")));
    // Attach the username last — any later re-upsert with a bare profile would
    // clear it, and the relay above already re-upserted without one.
    await services.users.getOrCreate(profile(42, { username: "alice" }));
    // A saved /note is internal but must surface in /info — a note nobody can
    // see is useless. Create one directly (same port /note writes through).
    await h.db.notes.create({ conversationId: conv.id, operatorId: "op-1", text: "follow up on refund" }, new Date());

    await services.processor.process(2, operatorMessage(GROUP_ID, 1, profile(222), text("/info"), conv.telegramTopicId!));

    const info = replyText(h, conv.telegramTopicId!)[0];
    expect(info).toContain("alice");
    expect(info).toContain("ID: 42");
    // The purpose stated at first contact is part of the operator summary.
    expect(info).toContain("Purpose: test purpose");
    expect(info).toContain(`Conversation: ${conv.id}`);
    expect(info).toContain("Created: ");
    expect(info).toContain("Last message: ");
    // "op-2" is the registry id of the second seeded operator (333).
    expect(info).toContain("Assigned operator: 333");
    expect(info).toContain(OPERATOR_TEXTS("en").hidePolicyPermanent);
    // Internal notes render under their own header, newest not required.
    expect(info).toContain(OPERATOR_TEXTS("en").infoNotes);
    expect(info).toContain("- follow up on refund");
  });
});

// ---------------------------------------------------------------------------
// 8.6 /assign
// ---------------------------------------------------------------------------

describe("/assign (8.6)", () => {
  it("persists an assignment by numeric id", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const conv = await verifiedUser(h, 42);
    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(222), text("/assign 333"), conv.telegramTopicId!));
    const updated = (await h.db.conversations.getByTelegramUserId(42))!;
    const op = [...h.db.operators.rows.values()].find((o) => o.telegramUserId === 333)!;
    expect(updated.assignedOperatorId).toBe(op.id);
    expect(replyText(h, conv.telegramTopicId!)).toEqual([OPERATOR_TEXTS("en").assigned("333")]);
  });

  it("persists an assignment by @username of a registered operator", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    await services.users.getOrCreate(profile(333, { username: "charlie" }));
    const conv = await verifiedUser(h, 42);
    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(222), text("/assign @charlie"), conv.telegramTopicId!));
    const updated = (await h.db.conversations.getByTelegramUserId(42))!;
    const op = [...h.db.operators.rows.values()].find((o) => o.telegramUserId === 333)!;
    expect(updated.assignedOperatorId).toBe(op.id);
  });

  it("rejects an unknown target without changing the assignment", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const conv = await verifiedUser(h, 42);
    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(222), text("/assign @ghost"), conv.telegramTopicId!));
    expect(replyText(h, conv.telegramTopicId!)).toEqual([OPERATOR_TEXTS("en").unknownRestoreTarget]);
    const updated = (await h.db.conversations.getByTelegramUserId(42))!;
    expect(updated.assignedOperatorId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 8.7 /note
// ---------------------------------------------------------------------------

describe("/note (8.7)", () => {
  it("persists an internal note and never delivers it to the user", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const conv = await verifiedUser(h, 42);
    await services.processor.process(
      1,
      operatorMessage(GROUP_ID, 1, profile(222), text("/note VIP client, speaks Mandarin"), conv.telegramTopicId!),
    );
    expect(replyText(h, conv.telegramTopicId!)).toEqual([OPERATOR_TEXTS("en").noteSaved]);

    const notes = [...h.db.notes.rows.values()];
    expect(notes).toHaveLength(1);
    expect(notes[0].conversationId).toBe(conv.id);
    // Operator 222 is the first seeded operator, hence the "op-1" registry id.
    expect(notes[0].operatorId).toBe("op-1");
    expect(notes[0].text).toBe("VIP client, speaks Mandarin");

    expect(
      h.telegram.callsOf("sendMessage").some((c) => c.target.chatId === 42 && (c.payload.text as string | undefined)?.includes("VIP")),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8.7b /rename
// ---------------------------------------------------------------------------

describe("/rename (8.7b)", () => {
  it("renames the topic and persists the custom title", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const conv = await verifiedUser(h, 42);

    await services.processor.process(
      1,
      operatorMessage(GROUP_ID, 1, profile(222), text("/rename VIP case"), conv.telegramTopicId!),
    );
    expect(replyText(h, conv.telegramTopicId!)).toEqual([OPERATOR_TEXTS("en").topicRenamed("VIP case")]);

    const edit = h.telegram.callsOf("editForumTopic");
    expect(edit).toHaveLength(1);
    expect(edit[0].target).toEqual({ chatId: GROUP_ID, messageThreadId: conv.telegramTopicId, name: "VIP case" });
    // The title is persisted (not just applied live) so a recovered topic keeps it.
    expect(await h.db.settings.get(`topic_title:${conv.id}`)).toBe("VIP case");
  });

  it("reuses a persisted title when a deleted topic is recreated", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const conv = await verifiedUser(h, 42);
    const user = (await h.db.users.getByTelegramUserId(42))!;
    await h.db.settings.set(`topic_title:${conv.id}`, "VIP case");

    const freshTopicId = await services.topics.createTopic(user, { conversationId: conv.id });
    expect(freshTopicId).not.toBe(conv.telegramTopicId);
    const created = h.telegram.callsOf("createForumTopic").at(-1)!;
    expect(created.payload.name).toBe("VIP case");
  });

  it("rejects an empty name with usage", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const conv = await verifiedUser(h, 42);
    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(222), text("/rename"), conv.telegramTopicId!));
    expect(replyText(h, conv.telegramTopicId!)).toEqual([OPERATOR_TEXTS("en").usageRename]);
    expect(h.telegram.callsOf("editForumTopic")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 8.8 Application-decision callbacks (approve/reject path of the callback
// handler; verify taps are covered in the pipeline suite)
// ---------------------------------------------------------------------------

describe("application decisions (8.8)", () => {
  async function pendingApplication(h: Harness, services: ReturnType<typeof buildServices>, userId: number, updateId = 1) {
    await services.processor.process(updateId, userMessage(userId, 100, profile(userId), text("/apply")));
    return (await h.db.applications.getLatestByTelegramUserId(userId))!;
  }

  it("admin approve marks approved_at, asks a first-timer for a purpose, and only then opens the conversation", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const app = await pendingApplication(h, services, 42);
    const result = await services.processor.process(2, applicationDecision("cq-approve", 111, "approve", app.id));
    expect(result.status).toBe("command_handled");

    expect((await h.db.applications.getById(app.id))!.status).toBe("approved");
    expect((await h.db.users.getByTelegramUserId(42))!.approvedAt).not.toBeNull();
    // Approval is the operator-application path — the applicant gains OPERATOR.
    expect(await h.db.operators.getByTelegramUserId(42)).toMatchObject({ role: "OPERATOR" });
    // The first-contact purpose gate still applies to an approved first-timer:
    // no conversation or topic yet — the bot asks for the purpose first.
    expect(await h.db.conversations.getByTelegramUserId(42)).toBeNull();
    const prompt = h.telegram.callsOf("sendMessage").find((c) => c.target.chatId === 42 && c.payload.text === TEXTS("en").purposePrompt);
    expect(prompt).toBeDefined();
    expect(h.telegram.answers.find((a) => a.callbackQueryId === "cq-approve")?.text).toContain("Approved");

    // The purpose statement opens the conversation (even though approval made
    // the user an OPERATOR); no welcome message is sent to the user's chat.
    await services.processor.process(3, userMessage(42, 101, profile(42), text("applying for refund support")));
    const conv = await h.db.conversations.getByTelegramUserId(42);
    expect(conv).not.toBeNull();
    expect(h.telegram.topics.has(conv!.telegramTopicId!)).toBe(true);
    expect((await h.db.users.getByTelegramUserId(42))!.purpose).toBe("applying for refund support");
    const welcomeText = "Welcome! Send a message anytime and support will reply right here in the chat.";
    expect(h.telegram.callsOf("sendMessage").some((c) => c.target.chatId === 42 && c.payload.text === welcomeText)).toBe(false);
  });

  it("admin reject notifies the user and creates nothing", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const app = await pendingApplication(h, services, 42);
    const result = await services.processor.process(2, applicationDecision("cq-reject", 111, "reject", app.id));
    expect(result.status).toBe("command_handled");

    expect((await h.db.applications.getById(app.id))!.status).toBe("rejected");
    expect(await h.db.conversations.getByTelegramUserId(42)).toBeNull();
    expect(h.telegram.callsOf("sendMessage").some((c) => c.target.chatId === 42 && c.payload.text === TEXTS("en").applyRejected)).toBe(true);
  });

  it("a non-admin operator tap is refused and the application stays pending", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const app = await pendingApplication(h, services, 42);
    const result = await services.processor.process(2, applicationDecision("cq-forbidden", 222, "approve", app.id));
    expect(result.status).toBe("ignored");

    expect(h.telegram.answers.find((a) => a.callbackQueryId === "cq-forbidden")?.text).toContain("Only admins");
    expect((await h.db.applications.getById(app.id))!.status).toBe("pending");
    expect(await h.db.conversations.getByTelegramUserId(42)).toBeNull();
  });

  it("a double-tap on a decided application is a no-op", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const app = await pendingApplication(h, services, 42);
    await services.processor.process(2, applicationDecision("cq-1", 111, "approve", app.id));
    const before = h.db.conversations.rows.size;
    const result = await services.processor.process(3, applicationDecision("cq-2", 111, "approve", app.id));
    expect(result.status).toBe("ignored");
    expect(h.db.conversations.rows.size).toBe(before);
    expect(h.telegram.answers.find((a) => a.callbackQueryId === "cq-2")?.text).toContain("Already handled");
  });
});

// ---------------------------------------------------------------------------
// 8.9 /restore
// ---------------------------------------------------------------------------

describe("/restore (8.9)", () => {
  it("restores by telegram_user_id", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    await hiddenConversation(h, 42);
    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(222), text("/restore 42"), null));
    expect(h.telegram.callsOf("restoreForumTopic")).toHaveLength(1);
    expect((await h.db.conversations.getByTelegramUserId(42))!.hiddenAt).toBeNull();
    expect(replyText(h)).toEqual([OPERATOR_TEXTS("en").conversationRestored]);
  });

  it("restores by @username", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    // Keep the username attached to the user row (a later bare-profile upsert
    // would clear it, so set it once at creation).
    const { user } = await services.users.getOrCreate(profile(42, { username: "alice" }));
    await services.users.markVerified(user.telegramUserId);
    const conv = await services.conversations.grantAccess(user);
    await h.telegram.hideForumTopic({ chatId: GROUP_ID, messageThreadId: conv.telegramTopicId! });
    await h.db.conversations.setHidden(conv.id, h.runtime.now().toISOString());

    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(222), text("/restore @alice"), null));
    expect((await h.db.conversations.getByTelegramUserId(42))!.hiddenAt).toBeNull();
    expect(replyText(h)).toEqual([OPERATOR_TEXTS("en").conversationRestored]);
  });

  it("restores by conversation id", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const conv = await hiddenConversation(h, 42);
    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(222), text(`/restore ${conv.id}`), null));
    expect((await h.db.conversations.getByTelegramUserId(42))!.hiddenAt).toBeNull();
    expect(replyText(h)).toEqual([OPERATOR_TEXTS("en").conversationRestored]);
  });

  it("rejects an unknown target", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(222), text("/restore c-does-not-exist"), null));
    expect(replyText(h)).toEqual([OPERATOR_TEXTS("en").unknownRestoreTarget]);
  });
});

// ---------------------------------------------------------------------------
// 8.10 /hide
// ---------------------------------------------------------------------------

describe("/hide (8.10)", () => {
  it("sets custom hours, off, and default", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const conv = await verifiedUser(h, 42);
    const topicId = conv.telegramTopicId!;

    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(222), text("/hide 48"), topicId));
    expect((await h.db.conversations.getByTelegramUserId(42))!.hideAfterHours).toBe(48);

    await services.processor.process(2, operatorMessage(GROUP_ID, 2, profile(222), text("/hide off"), topicId));
    expect((await h.db.conversations.getByTelegramUserId(42))!.hideAfterHours).toBe(0);

    await services.processor.process(3, operatorMessage(GROUP_ID, 3, profile(222), text("/hide default"), topicId));
    expect((await h.db.conversations.getByTelegramUserId(42))!.hideAfterHours).toBeNull();
  });

  it("rejects invalid arguments", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const conv = await verifiedUser(h, 42);
    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(222), text("/hide soon"), conv.telegramTopicId!));
    expect(replyText(h, conv.telegramTopicId!)).toEqual([OPERATOR_TEXTS("en").usageHide]);
    expect((await h.db.conversations.getByTelegramUserId(42))!.hideAfterHours).toBeNull();
  });

  it("restores a hidden conversation when its policy changes", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const conv = await hiddenConversation(h, 42);
    const topicId = conv.telegramTopicId!;
    expect(h.telegram.callsOf("restoreForumTopic")).toHaveLength(0);

    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(222), text("/hide 96"), topicId));
    expect((await h.db.conversations.getByTelegramUserId(42))!.hideAfterHours).toBe(96);
    expect((await h.db.conversations.getByTelegramUserId(42))!.hiddenAt).toBeNull();
    expect(h.telegram.callsOf("restoreForumTopic")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 8.11 /help
// ---------------------------------------------------------------------------

describe("/help (8.11)", () => {
  it("advertises only /start to users and leaves a pending verification untouched", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    // Start a challenge so there is a pending verification to preserve.
    await services.processor.process(1, userMessage(42, 100, profile(42), text("/start")));
    const before = (await h.store.get(42))!;

    const result = await services.processor.process(2, userMessage(42, 101, profile(42), text("/help")));
    expect(result.status).toBe("command_handled");
    expect(h.telegram.callsOf("sendMessage").find((c) => c.target.chatId === 42 && c.payload.text === TEXTS("en").userHelp)).toBeDefined();

    const after = (await h.store.get(42))!;
    expect(after.challengeId).toBe(before.challengeId);
    expect(after.attemptsLeft).toBe(before.attemptsLeft);
    expect(await h.db.conversations.getByTelegramUserId(42)).toBeNull();
  });

  it("prints operator help inside a topic and in the general chat", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const conv = await verifiedUser(h, 42);

    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(222), text("/help"), conv.telegramTopicId!));
    expect(replyText(h, conv.telegramTopicId!)).toEqual([OPERATOR_TEXTS("en").helpTopic]);

    h.telegram.calls = [];
    await services.processor.process(2, operatorMessage(GROUP_ID, 2, profile(222), text("/help"), null));
    expect(replyText(h)).toEqual([OPERATOR_TEXTS("en").helpGeneral]);
  });

  it("refuses an unregistered sender asking for help", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(999), text("/help"), null));
    expect(replyText(h)).toEqual([OPERATOR_TEXTS("en").notOperator]);
  });

  it("an admin's /help in private chat lists the operator commands, not the user copy", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    await services.processor.process(1, userMessage(111, 100, profile(111), text("/help")));
    const sent = h.telegram.callsOf("sendMessage").filter((c) => c.target.chatId === 111);
    expect(sent.some((c) => c.payload.text === OPERATOR_TEXTS("en").helpGeneral)).toBe(true);
    expect(sent.some((c) => c.payload.text === TEXTS("en").userHelp)).toBe(false);
  });

  it("an admin's unknown command in private chat is not answered with the user copy", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    await services.processor.process(1, userMessage(111, 100, profile(111), text("/bogus")));
    const sent = h.telegram.callsOf("sendMessage").filter((c) => c.target.chatId === 111);
    expect(sent.some((c) => c.payload.text === OPERATOR_TEXTS("en").unknownCommand)).toBe(true);
    expect(sent.some((c) => c.payload.text === TEXTS("en").userHelp)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 9 /lang — per-user language preference (zh|en|auto) overriding detection
// ---------------------------------------------------------------------------

describe("/lang (9)", () => {
  function sentTo(h: Harness, chatId: number): string[] {
    return h.telegram
      .callsOf("sendMessage")
      .filter((c) => c.target.chatId === chatId && c.payload.text != null)
      .map((c) => c.payload.text as string);
  }

  it("a new user can switch the bot to 简体中文 before verifying", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    const result = await services.processor.process(1, userMessage(42, 100, profile(42, { languageCode: "en" }), text("/lang zh")));
    expect(result.status).toBe("command_handled");
    expect((await h.db.users.getByTelegramUserId(42))?.preferredLanguage).toBe("zh");
    expect(sentTo(h, 42)).toContain(TEXTS("zh").langSet);
    // The suggestion menu is re-applied in 简体中文 immediately (not just the
    // bot's own copy) — Telegram caches it per chat scope.
    const zhDefault = h.telegram.commandMenus.find(
      (m) => m.scope?.type === "chat" && m.scope.chat_id === 42 && m.languageCode === undefined,
    );
    expect(zhDefault?.commands).toEqual(USER_COMMANDS_ZH);
    // /lang is not a gate pass — no conversation was created.
    expect(await h.db.conversations.getByTelegramUserId(42)).toBeNull();
  });

  it("post-verification purpose prompt follows the chosen language", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await services.processor.process(1, userMessage(42, 100, profile(42, { languageCode: "en" }), text("/lang zh")));
    await services.processor.process(2, userMessage(42, 101, profile(42, { languageCode: "en" }), text("/start")));
    const state = (await h.store.get(42))!;
    const ok = await services.processor.process(
      3,
      verificationAnswer(42, state.questionMessageId!, state.answer, "cq-ok", profile(42, { languageCode: "en" })),
    );
    // Verified, but the first-contact purpose gate asks in the chosen language.
    expect(ok.status).toBe("purpose_pending");
    expect(sentTo(h, 42)).toContain(TEXTS("zh").purposePrompt);
    expect(sentTo(h, 42)).not.toContain(TEXTS("en").purposePrompt);

    // The purpose statement still opens the conversation (no welcome to follow).
    await services.processor.process(4, userMessage(42, 102, profile(42, { languageCode: "en" }), text("咨询退款")));
    expect(await h.db.conversations.getByTelegramUserId(42)).not.toBeNull();
  });

  it("/lang with no argument reports the current language", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await services.processor.process(1, userMessage(42, 100, profile(42), text("/lang zh")));
    h.telegram.calls = [];
    await services.processor.process(2, userMessage(42, 101, profile(42), text("/lang")));
    expect(sentTo(h, 42)).toContain(TEXTS("zh").langCurrent("zh"));
  });

  it("/lang auto clears the preference and falls back to the detected language", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await services.processor.process(1, userMessage(42, 100, profile(42, { languageCode: "zh" }), text("/lang zh")));
    await services.processor.process(2, userMessage(42, 101, profile(42, { languageCode: "zh" }), text("/lang auto")));
    expect((await h.db.users.getByTelegramUserId(42))?.preferredLanguage).toBeNull();
    expect(sentTo(h, 42)).toContain(TEXTS("zh").langAuto);
  });

  it("an invalid argument shows usage in the current language and stores nothing", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await services.processor.process(1, userMessage(42, 100, profile(42, { languageCode: "en" }), text("/lang fr")));
    expect(sentTo(h, 42)).toContain(TEXTS("en").langUsage);
    expect((await h.db.users.getByTelegramUserId(42))?.preferredLanguage).toBeNull();
  });

  it("user-facing help follows the stored preference", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await services.processor.process(1, userMessage(42, 100, profile(42), text("/lang zh")));
    h.telegram.calls = [];
    await services.processor.process(2, userMessage(42, 101, profile(42), text("/help")));
    expect(sentTo(h, 42)).toContain(TEXTS("zh").userHelp);
  });

  it("an operator can switch and the group echo uses the new language", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const result = await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(222), text("/lang zh"), null));
    expect(result.status).toBe("command_handled");
    expect(replyText(h)).toEqual([OPERATOR_TEXTS("zh").langSet]);
    expect((await h.db.users.getByTelegramUserId(222))?.preferredLanguage).toBe("zh");
    // The operator's per-user menus (private chat + group member) flip to zh.
    const zhDefault = h.telegram.commandMenus.find(
      (m) => m.scope?.type === "chat" && m.scope.chat_id === 222 && m.languageCode === undefined,
    );
    expect(zhDefault?.commands).toEqual(OPERATOR_COMMANDS_ZH);
  });

  it("an operator /lang with no argument reports the stored choice", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(222), text("/lang zh"), null));
    h.telegram.calls = [];
    await services.processor.process(2, operatorMessage(GROUP_ID, 2, profile(222), text("/lang"), null));
    expect(replyText(h)).toEqual([OPERATOR_TEXTS("zh").langCurrent("zh")]);
  });
});

// ---------------------------------------------------------------------------
// 10 /selfcheck — admin-only config self-check, group-level and in a topic
// ---------------------------------------------------------------------------

describe("/selfcheck (10)", () => {
  it("an admin runs the check at the group's general chat and gets the report", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const result = await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(111), text("/selfcheck"), null));
    expect(result.status).toBe("command_handled");
    expect(replyText(h).some((t) => t.includes("Self-check"))).toBe(true);
  });

  it("an operator is refused", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const result = await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(222), text("/selfcheck"), null));
    expect(result.status).toBe("command_handled");
    expect(replyText(h)).toEqual([OPERATOR_TEXTS("en").adminOnly]);
  });
});