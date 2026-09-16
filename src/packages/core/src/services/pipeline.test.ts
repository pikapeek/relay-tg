// ---------------------------------------------------------------------------
// Integration tests for the relay pipeline (tasks 6 and 7):
//   - 6.1-6.2  MessageService records + resolution (source, relayed id,
//              no cross-conversation reply leaks)
//   - 6.3      reply preservation both directions + graceful degradation
//   - 6.4      media group: album merged into one sendMediaGroup; single-item,
//              oversized and mixed albums degrade to individual forwards
//   - 6.5      topic recovery: recreate deleted topic, reopen closed topic
//   - 6.6      edit relay for both directions + dropped unmappable edits
//   - 7.1      update idempotency (same update delivered twice)
//   - 7.2      user → operator flow via UpdateProcessor (/start, verify, /apply,
//              /help, unknown commands, verified first contact)
//   - 7.3      operator → user flow + non-operator / general-chat rejection
//   - 7.4      zero rows on rejection (bot, block, gate, rate limit)
//   - 7.5      per-conversation serialization with the keyed mutex
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { loadConfig, type ConversationRecord, type MessageContent } from "@relaytg/shared";
import { buildServices, MEDIA_GROUP_WINDOW_MS } from "./index.ts";
import {
  baseConfig,
  makeHarness,
  profile,
  text,
  photo,
  userMessage,
  operatorMessage,
  verificationAnswer,
  editedUserMessage,
  editedOperatorMessage,
  GROUP_ID,
  type Harness,
} from "./harness.ts";
import { KeyedMutexSerializer } from "../testing.ts";
import { OPERATOR_TEXTS, TEXTS } from "./texts.ts";

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

async function verifiedUser(h: Harness, telegramUserId: number, purpose = "test purpose"): Promise<void> {
  const services = buildServices(h.ctx);
  const { user } = await services.users.getOrCreate(profile(telegramUserId));
  await services.users.markVerified(user.telegramUserId);
  // Verification is followed by the first-contact purpose gate: the user states
  // a purpose before any topic exists, so fixtures carry one on the record.
  await services.users.setPurpose(user.telegramUserId, purpose);
}

/** Open the user's conversation (topic + welcome) without any relayed messages. */
async function openConversation(h: Harness, telegramUserId: number): Promise<ConversationRecord> {
  const services = buildServices(h.ctx);
  const user = (await services.users.getByTelegramUserId(telegramUserId))!;
  return services.conversations.grantAccess(user);
}

function topicSends(h: Harness, topicId: number, method = "sendMessage") {
  return h.telegram.callsOf(method).filter((c) => c.target.messageThreadId === topicId);
}

function recordsForConversation(h: Harness, conversationId: string) {
  return [...h.db.messages.rows.values()].filter((m) => m.conversationId === conversationId);
}

/** Relay sends go through sendContent, whose recorded payload wraps the content. */
function contentOf(call: { payload: Record<string, unknown> }): MessageContent | null {
  return (call.payload.content as MessageContent | undefined) ?? null;
}

function textOf(call: { payload: Record<string, unknown> }): string | undefined {
  const content = contentOf(call);
  return content && content.type === "text" ? content.text : undefined;
}

function fileIdOf(call: { payload: Record<string, unknown> }): string | undefined {
  const content = contentOf(call);
  return content && content.type !== "text" ? content.fileId : undefined;
}

/** The pinned personal-info card carries the user's info text as its payload
 *  (`sendMessage`) or caption (`sendContent` photo card). */
function cardInfoOf(
  call: { payload: Record<string, unknown> },
): string | undefined {
  const text = call.payload.text;
  if (typeof text === "string") return text;
  const caption = call.payload.caption;
  if (typeof caption === "string") return caption;
  const content = contentOf(call);
  if (content && content.type !== "text" && "caption" in content) return content.caption ?? undefined;
  return undefined;
}

/** The identity button's tg:// URL, when the call carries a reply markup. */
function identityUrlOf(call: { replyMarkup?: { buttons: Array<{ url?: string }> } }): string | undefined {
  return call.replyMarkup?.buttons[0]?.url;
}

/** Drain the microtask queue so a fire-and-forget async flush (MediaGroupService)
 *  has finished its fake-only promise chain before the test asserts. One
 *  macrotask is enough: every await in the chain resolves immediately. */
async function drainMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

// ---------------------------------------------------------------------------
// 6.1-6.2 MessageService: records and resolution
// ---------------------------------------------------------------------------

describe("MessageService — records & resolution (6.1-6.2)", () => {
  it("records a message with source and relayed-copy ids and resolves by both", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await verifiedUser(h, 42);
    const conversation = await openConversation(h, 42);

    await services.messages.create({
      conversationId: conversation.id,
      telegramChatId: 42,
      telegramMessageId: 1001,
      telegramTopicId: conversation.telegramTopicId,
      relayedMessageId: 2000,
      direction: "USER_TO_OPERATOR",
      senderType: "USER",
      contentType: "photo",
      replyToMessageId: null,
    });

    const bySource = await services.messages.resolveBySource(42, 1001);
    expect(bySource).not.toBeNull();
    expect(bySource!.conversationId).toBe(conversation.id);
    expect(bySource!.relayedMessageId).toBe(2000);
    expect(bySource!.contentType).toBe("photo");
    expect(bySource!.direction).toBe("USER_TO_OPERATOR");

    const byRelayed = await services.messages.resolveByConversationAndRelayedId(conversation.id, 2000, "USER_TO_OPERATOR");
    expect(byRelayed?.id).toBe(bySource!.id);

    const missing = await services.messages.resolveBySource(42, 999);
    expect(missing).toBeNull();
  });

  it("resolves reply targets only within the same conversation", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await verifiedUser(h, 42);
    await verifiedUser(h, 43);
    const a = await openConversation(h, 42);
    const b = await openConversation(h, 43);

    // An operator reply delivered into conv A's user chat at copy id 3000,
    // originating from group message 9001.
    await services.messages.create({
      conversationId: a.id,
      telegramChatId: GROUP_ID,
      telegramMessageId: 9001,
      telegramTopicId: a.telegramTopicId,
      relayedMessageId: 3000,
      direction: "OPERATOR_TO_USER",
      senderType: "OPERATOR",
      contentType: "text",
      replyToMessageId: null,
    });

    // Same relayed copy id 3000 exists in conv A → resolves to 9001. Resolving
    // an operator→user copy anchors the reply to the group's original message.
    expect(await services.messages.resolveReplyTarget(a.id, 3000, "OPERATOR_TO_USER")).toBe(9001);
    // …but the id never resolves inside conv B (no cross-conversation leak).
    expect(await services.messages.resolveReplyTarget(b.id, 3000, "OPERATOR_TO_USER")).toBeNull();
    // The same id stored as a different-direction record never resolves across
    // the direction boundary (a genuine user copy in conv A is ignored).
    expect(await services.messages.resolveReplyTarget(a.id, 3000, "USER_TO_OPERATOR")).toBeNull();
    // Unresolvable / no reply → null (plain send), never a failure.
    expect(await services.messages.resolveReplyTarget(a.id, 424242, "OPERATOR_TO_USER")).toBeNull();
    expect(await services.messages.resolveReplyTarget(a.id, null, "OPERATOR_TO_USER")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 6.3 Reply preservation
// ---------------------------------------------------------------------------

describe("reply preservation (6.3)", () => {
  it("a user reply to the delivered copy replies to the original operator message in the topic", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await verifiedUser(h, 42);
    const conv = await openConversation(h, 42);

    // Operator's earlier message: group 9001 → user-chat copy 3000.
    await services.messages.create({
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

    await services.processor.process(1, userMessage(42, 1001, profile(42), text("thanks"), { replyToMessageId: 3000 }));

    // The message is forwarded verbatim; forwardMessage can't attach a reply-to
    // (Bot API limitation), so the user-side reply reference lives in the record.
    const forward = topicSends(h, conv.telegramTopicId!, "forwardMessage").pop()!;
    expect(forward.payload.fromChatId).toBe(42);
    expect(forward.payload.messageId).toBe(1001);
    expect(forward.target.replyToMessageId).toBeUndefined();
    const record = recordsForConversation(h, conv.id).find((m) => m.telegramMessageId === 1001)!;
    expect(record.replyToMessageId).toBe(3000);
  });

  it("an operator reply to a topic copy replies to the original user message in the user chat", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await services.operators.seed();
    await verifiedUser(h, 42);
    const conv = await openConversation(h, 42);

    // User's earlier message: user chat 1001 → topic copy 2000.
    await services.messages.create({
      conversationId: conv.id,
      telegramChatId: 42,
      telegramMessageId: 1001,
      telegramTopicId: conv.telegramTopicId,
      relayedMessageId: 2000,
      direction: "USER_TO_OPERATOR",
      senderType: "USER",
      contentType: "text",
      replyToMessageId: null,
    });

    await services.processor.process(
      1,
      operatorMessage(GROUP_ID, 9002, profile(222), text("got it"), conv.telegramTopicId!, 2000),
    );

    const userSend = h.telegram.callsOf("sendMessage").find((c) => c.target.chatId === 42 && textOf(c) === "got it")!;
    expect(userSend.target.replyToMessageId).toBe(1001);
  });

  it("unresolvable replies degrade to a plain send", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await verifiedUser(h, 42);
    const conv = await openConversation(h, 42);

    await services.processor.process(
      1,
      userMessage(42, 1001, profile(42), text("hi"), { replyToMessageId: 424242 }),
    );

    const forward = topicSends(h, conv.telegramTopicId!, "forwardMessage").pop()!;
    expect(forward.payload.fromChatId).toBe(42);
    expect(forward.payload.messageId).toBe(1001);
    expect(forward.target.replyToMessageId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6.4 Media groups
// ---------------------------------------------------------------------------

describe("media groups (6.4)", () => {
  it("merges an album into one sendMediaGroup and records each item", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await verifiedUser(h, 42);
    const conv = await openConversation(h, 42);

    await services.processor.process(1, userMessage(42, 101, profile(42), photo("f1", "one"), { mediaGroupId: "album-1" }));
    await services.processor.process(2, userMessage(42, 102, profile(42), photo("f2", "two"), { mediaGroupId: "album-1" }));
    await services.processor.process(3, userMessage(42, 103, profile(42), photo("f3", null), { mediaGroupId: "album-1" }));

    // Each item is acknowledged immediately; nothing reaches the topic while
    // the aggregation window is open.
    expect(topicSends(h, conv.telegramTopicId!, "forwardMessage")).toHaveLength(0);
    expect(topicSends(h, conv.telegramTopicId!, "sendMediaGroup")).toHaveLength(0);

    // The window closes → one album with all three items lands in the topic.
    h.runtime.advance(MEDIA_GROUP_WINDOW_MS);
    await drainMicrotasks();

    const album = topicSends(h, conv.telegramTopicId!, "sendMediaGroup").pop()!;
    const items = album.payload.items as Array<{ type: string; fileId: string; caption?: string }>;
    expect(items.map((i) => i.fileId)).toEqual(["f1", "f2", "f3"]);
    // Bot API: only the first album item may carry a caption.
    expect(items[0]!.caption).toBe("one");
    expect(items[1]!.caption).toBeUndefined();
    expect(items[2]!.caption).toBeUndefined();

    const records = recordsForConversation(h, conv.id);
    expect(records).toHaveLength(3);
    expect(records.map((r) => r.telegramMessageId)).toEqual([101, 102, 103]);
    expect(records.map((r) => r.contentType)).toEqual(["photo", "photo", "photo"]);
    expect(records.every((r) => r.relayedMessageId != null)).toBe(true);
  });

  it("forwards a lone album item individually", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await verifiedUser(h, 42);
    const conv = await openConversation(h, 42);

    await services.processor.process(1, userMessage(42, 101, profile(42), photo("f1", "solo"), { mediaGroupId: "album-1" }));
    h.runtime.advance(MEDIA_GROUP_WINDOW_MS);
    await drainMicrotasks();

    // A 1-item album can't be sent via sendMediaGroup (needs 2–10) — the item
    // falls back to the individual forward path.
    expect(topicSends(h, conv.telegramTopicId!, "sendMediaGroup")).toHaveLength(0);
    const forward = topicSends(h, conv.telegramTopicId!, "forwardMessage").pop()!;
    expect(forward.payload.messageId).toBe(101);
    expect(recordsForConversation(h, conv.id)).toHaveLength(1);
  });

  it("chunks an album above the Bot API cap", async () => {
    // 11 rapid items would trip the default spam rate limit (10/60s) before the
    // aggregation window closes, so lift the cap for this burst.
    const h = makeHarness(
      loadConfig({
        BOT_TOKEN: "test-token",
        GROUP_ID: "-100123456789",
        ADMIN_IDS: "111",
        OPERATOR_IDS: "222,333",
        SPAM_RATE_LIMIT_MAX: "30",
      }),
    );
    const services = buildServices(h.ctx);
    await verifiedUser(h, 42);
    const conv = await openConversation(h, 42);

    for (let i = 0; i < 11; i++) {
      await services.processor.process(i + 1, userMessage(42, 200 + i, profile(42), photo(`f${i}`, `cap${i}`), { mediaGroupId: "big-album" }));
    }
    h.runtime.advance(MEDIA_GROUP_WINDOW_MS);
    await drainMicrotasks();

    // 11 items → one full 10-item album plus a trailing lone item, which the
    // Bot API can't include in a media group, so it is forwarded individually.
    const albums = topicSends(h, conv.telegramTopicId!, "sendMediaGroup");
    expect(albums).toHaveLength(1);
    expect(albums[0]!.payload.items as Array<{ fileId: string }>).toHaveLength(10);
    const trailing = topicSends(h, conv.telegramTopicId!, "forwardMessage").pop()!;
    expect(trailing.payload.messageId).toBe(210);
    expect(recordsForConversation(h, conv.id)).toHaveLength(11);
  });

  it("falls back to individual forwards when an album contains a non-album-able item", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await verifiedUser(h, 42);
    const conv = await openConversation(h, 42);

    await services.processor.process(1, userMessage(42, 101, profile(42), photo("f1", "pic"), { mediaGroupId: "mixed" }));
    await services.processor.process(2, userMessage(42, 102, profile(42), { type: "voice", fileId: "v1", caption: null, fileSize: 10 }, { mediaGroupId: "mixed" }));
    await services.processor.process(3, userMessage(42, 103, profile(42), photo("f3", "pic3"), { mediaGroupId: "mixed" }));

    h.runtime.advance(MEDIA_GROUP_WINDOW_MS);
    await drainMicrotasks();

    // A voice message can't join an album — the whole group degrades to
    // per-item forwards, in order, nothing lost.
    expect(topicSends(h, conv.telegramTopicId!, "sendMediaGroup")).toHaveLength(0);
    const forwards = topicSends(h, conv.telegramTopicId!, "forwardMessage");
    expect(forwards.map((f) => f.payload.messageId)).toEqual([101, 102, 103]);
    expect(recordsForConversation(h, conv.id)).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 6.5 Topic recovery
// ---------------------------------------------------------------------------

describe("topic recovery (6.5)", () => {
  it("recreates a deleted topic, updates the mapping, and retries the relay", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await verifiedUser(h, 42);
    const conv = await openConversation(h, 42);
    const oldTopicId = conv.telegramTopicId!;

    await h.telegram.deleteForumTopic({ chatId: GROUP_ID, messageThreadId: oldTopicId });

    await services.processor.process(1, userMessage(42, 1001, profile(42), text("hello")));

    const updated = (await services.conversations.getByTelegramUserId(42))!;
    expect(updated.telegramTopicId).not.toBe(oldTopicId);
    // The topic map in the fake knows the new topic.
    expect(h.telegram.topics.has(updated.telegramTopicId!)).toBe(true);
    // The message is recorded against the new topic and landed in it.
    const record = recordsForConversation(h, conv.id).find((m) => m.telegramMessageId === 1001)!;
    expect(record.telegramTopicId).toBe(updated.telegramTopicId);
    expect(topicSends(h, updated.telegramTopicId!, "forwardMessage")).toHaveLength(1);
  });

  it("reopens a closed topic in place and retries the relay", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await verifiedUser(h, 42);
    const conv = await openConversation(h, 42);
    const topicId = conv.telegramTopicId!;

    await h.telegram.hideForumTopic({ chatId: GROUP_ID, messageThreadId: topicId });

    await services.processor.process(1, userMessage(42, 1001, profile(42), text("hello")));

    expect(h.telegram.callsOf("restoreForumTopic")).toHaveLength(1);
    const record = recordsForConversation(h, conv.id).find((m) => m.telegramMessageId === 1001)!;
    expect(record.telegramTopicId).toBe(topicId);
    expect(topicSends(h, topicId, "forwardMessage")).toHaveLength(1);
  });

  it("a conversation with no topic throws before any state change", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await verifiedUser(h, 42);
    await services.users.getOrCreate(profile(42));
    // Force the conversation row without a topic.
    const bare = await h.db.conversations.create(
      { telegramUserId: 42, telegramTopicId: null, assignedOperatorId: null },
      h.runtime.now(),
    );
    await expect(
      services.relayer.relayUserToOperator(bare, userMessage(42, 1001, profile(42), text("hi"))),
    ).rejects.toThrow();
    expect(h.db.messages.rows.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6.6 Edit relay
// ---------------------------------------------------------------------------

describe("edit relay (6.6)", () => {
  it("drops a user message edit (the topic copy is a forward and can't be edited)", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await verifiedUser(h, 42);
    const conv = await openConversation(h, 42);

    await services.processor.process(1, userMessage(42, 1001, profile(42), text("original")));
    const record = recordsForConversation(h, conv.id).find((m) => m.telegramMessageId === 1001)!;
    expect(record.relayedMessageId).not.toBeNull();

    const result = await services.processor.process(2, editedUserMessage(42, 1001, profile(42), text("edited")));
    expect(result.status).toBe("processed");

    // Forwarded copies can't be edited — no edit call reaches the topic, and the
    // drop is logged. The source record stays intact for later reply anchoring.
    expect(h.telegram.callsOf("editMessageText")).toHaveLength(0);
    expect(h.telegram.callsOf("editMessageCaption")).toHaveLength(0);
    expect(h.logger.has("message_edit_dropped")).toBe(true);
  });

  it("relays an operator edit to the user-chat copy", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await services.operators.seed();
    await verifiedUser(h, 42);
    const conv = await openConversation(h, 42);

    // Operator's original message relayed to user-chat copy 3000.
    await services.processor.process(1, operatorMessage(GROUP_ID, 9001, profile(222), text("first answer"), conv.telegramTopicId!));
    const record = recordsForConversation(h, conv.id).find((m) => m.telegramMessageId === 9001)!;

    await services.processor.process(
      2,
      editedOperatorMessage(GROUP_ID, 9001, profile(222), text("updated answer"), conv.telegramTopicId!),
    );

    const edit = h.telegram.callsOf("editMessageText").find((c) => c.target.chatId === 42 && c.target.messageId === record.relayedMessageId);
    expect(edit).toBeDefined();
    expect(edit!.payload.text).toBe("updated answer");
  });

  it("drops edits with no matching source record", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await verifiedUser(h, 42);
    await openConversation(h, 42);

    await services.processor.process(1, editedUserMessage(42, 9999, profile(42), text("ghost edit")));
    expect(h.telegram.callsOf("editMessageText")).toHaveLength(0);
    expect(h.telegram.callsOf("editMessageCaption")).toHaveLength(0);
  });

  it("drops edits of stickers", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await verifiedUser(h, 42);
    await openConversation(h, 42);

    const sticker: MessageContent = { type: "sticker", fileId: "st1", fileSize: null };
    await services.processor.process(1, userMessage(42, 1001, profile(42), sticker));
    const result = await services.processor.process(2, editedUserMessage(42, 1001, profile(42), sticker));
    expect(result.status).toBe("processed");
    expect(h.telegram.callsOf("editMessageText")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 7.1 Idempotency
// ---------------------------------------------------------------------------

describe("idempotency (7.1)", () => {
  it("delivering the same update twice produces one conversation, one record, one send", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await verifiedUser(h, 42);

    const event = userMessage(42, 1001, profile(42), text("hello"));
    const first = await services.processor.process(10, event);
    expect(first.status).toBe("processed");

    const second = await services.processor.process(10, event);
    expect(second.status).toBe("duplicate");

    expect(h.db.conversations.rows.size).toBe(1);
    expect(h.db.messages.rows.size).toBe(1);
    const conv = [...h.db.conversations.rows.values()][0];
    expect(topicSends(h, conv.telegramTopicId!, "forwardMessage")).toHaveLength(1);
  });
});

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

// ---------------------------------------------------------------------------
// 7.5 Serialization
// ---------------------------------------------------------------------------

describe("per-conversation serialization (7.5)", () => {
  it("concurrent updates for the same user relay in submission order", async () => {
    const h = makeHarness(baseConfig(), new KeyedMutexSerializer());
    const services = buildServices(h.ctx);
    await verifiedUser(h, 42);
    // Pre-create the conversation so both concurrent runs resolve the same row.
    await services.processor.process(1, userMessage(42, 100, profile(42), text("setup")));
    const conv = (await services.conversations.getByTelegramUserId(42))!;
    const topicId = conv.telegramTopicId!;
    h.telegram.calls = [];

    await Promise.all([
      services.processor.process(10, userMessage(42, 200, profile(42), text("first"))),
      services.processor.process(11, userMessage(42, 201, profile(42), text("second"))),
    ]);

    const topicForwards = topicSends(h, topicId, "forwardMessage");
    expect(topicForwards.map((f) => f.payload.messageId)).toEqual([200, 201]);
    expect(topicForwards.every((f) => f.payload.fromChatId === 42)).toBe(true);

    // Both records were created, in the same order.
    const records = recordsForConversation(h, conv.id).filter((m) => m.telegramMessageId >= 200);
    expect(records.map((r) => r.telegramMessageId)).toEqual([200, 201]);
  });

  it("a failed run never poisons the chain for later runs on the same key", async () => {
    const serializer = new KeyedMutexSerializer();
    let runs = 0;

    // The first run throws; the caller receives the error (this is what the
    // processor catches into a logged { status: "error" }).
    await expect(
      serializer.runExclusive("k", async () => {
        runs += 1;
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(runs).toBe(1);

    // The next run on the same key must still execute fn — a rejected previous
    // run used to propagate through the chain and silently drop later updates.
    const value = await serializer.runExclusive("k", async () => {
      runs += 1;
      return "ok";
    });
    expect(value).toBe("ok");
    expect(runs).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Full-review regression fixes (2026-09)
// ---------------------------------------------------------------------------

describe("review-fix regressions (2026-09)", () => {
  it("a blocked user cannot bypass the block via /start or /apply", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await h.db.blocks.create({ telegramUserId: 42, createdByTelegramUserId: 111 }, h.runtime.now());

    const startResult = await services.processor.process(1, userMessage(42, 100, profile(42), text("/start")));
    expect(startResult.status).toBe("blocked");
    const applyResult = await services.processor.process(2, userMessage(42, 101, profile(42), text("/apply")));
    expect(applyResult.status).toBe("blocked");

    expect(h.db.users.rows.size).toBe(0);
    expect(h.db.conversations.rows.size).toBe(0);
    expect(h.db.applications.rows.size).toBe(0);
    expect(h.db.messages.rows.size).toBe(0);
  });

  it("a blocked user's edits are rejected before they reach the update path", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await verifiedUser(h, 42);
    const conv = await openConversation(h, 42);
    await services.processor.process(1, userMessage(42, 100, profile(42), text("original")));
    expect(topicSends(h, conv.telegramTopicId!, "forwardMessage")).toHaveLength(1);

    await h.db.blocks.create({ telegramUserId: 42, createdByTelegramUserId: 111 }, h.runtime.now());
    h.telegram.calls = [];

    const result = await services.processor.process(2, editedUserMessage(42, 100, profile(42), text("edited while blocked")));
    expect(result.status).toBe("blocked");
    expect(h.telegram.callsOf("editMessageText").length).toBe(0);
  });

  it("operator messages in a group other than the support group are ignored", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await services.operators.seed();
    await verifiedUser(h, 42);
    const conv = await openConversation(h, 42);

    const result = await services.processor.process(
      1,
      operatorMessage(-100999999999, 9100, profile(222), text("some other group"), conv.telegramTopicId!),
    );
    expect(result.status).toBe("ignored");
    expect(h.db.messages.rows.size).toBe(0);
    // No send into any user chat from a foreign group (no welcome message either).
    expect(h.telegram.callsOf("sendMessage").filter((c) => c.target.chatId === 42)).toHaveLength(0);
  });

  it("/start re-asks in place and never remints the attempts budget while a challenge is live", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await services.processor.process(1, userMessage(42, 100, profile(42), text("/start")));
    let state = (await h.store.get(42))!;
    expect(state.attemptsLeft).toBe(3);
    const wrong = state.choices.find((c) => c !== state.answer)!;
    await services.processor.process(2, verificationAnswer(42, state.questionMessageId!, wrong, "cq-1", profile(42)));
    state = (await h.store.get(42))!;
    expect(state.attemptsLeft).toBe(2);

    const result = await services.processor.process(3, userMessage(42, 102, profile(42), text("/start")));
    expect(result.status).toBe("verification_issued");
    expect((await h.store.get(42))!.attemptsLeft).toBe(2);

    // The re-ask edited the existing question in place — no second question message.
    const questions = h.telegram.callsOf("sendMessage").filter((c) => c.target.chatId === 42 && c.replyMarkup != null);
    expect(questions).toHaveLength(1);
    expect(h.telegram.callsOf("editMessageText").length).toBeGreaterThan(0);
  });

  it("an operator reply to a user who blocked the bot drops quietly instead of crashing the webhook", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await services.operators.seed();
    await verifiedUser(h, 42);
    const conv = await openConversation(h, 42);
    // User 42 "blocked the bot": every outbound text send fails with a permanent 403.
    h.telegram.failAlwaysWith("forbidden", "sendMessage");

    const result = await services.processor.process(1, operatorMessage(GROUP_ID, 9001, profile(222), text("are you there?"), conv.telegramTopicId!));
    expect(result.status).toBe("processed");
    // No record: the send never completed, so there is nothing to anchor a reply on.
    expect(h.db.messages.rows.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Self-check (boot config + admin /selfcheck report)
// ---------------------------------------------------------------------------

describe("self-check (feature 2)", () => {
  it("reports all green on a healthy deployment", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);

    const report = await services.selfCheck.run();
    expect(report.allOk).toBe(true);
    expect(report.bot).toMatchObject({ ok: true, detail: "@relaytg_test_bot" });
    expect(report.group).toMatchObject({ ok: true, detail: "forum" });
    expect(report.admin).toMatchObject({ ok: true, detail: "administrator" });
  });

  it("short-circuits group and admin when the token is bad", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    h.telegram.failOnceWith("unauthorized", "getMe");

    const report = await services.selfCheck.run();
    expect(report.allOk).toBe(false);
    expect(report.bot.ok).toBe(false);
    expect(report.group).toMatchObject({ ok: false, skipped: true });
    expect(report.admin).toMatchObject({ ok: false, skipped: true });
    // A failed getMe must not fire the probes that would only 401 again.
    expect(h.telegram.callsOf("getChat")).toHaveLength(0);
    expect(h.telegram.callsOf("getChatMember")).toHaveLength(0);
  });

  it("fails the group check when the support group is not a forum", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    h.telegram.chatResult = { id: GROUP_ID, type: "supergroup", is_forum: false, title: "Not a forum" };

    const report = await services.selfCheck.run();
    expect(report.allOk).toBe(false);
    expect(report.group).toMatchObject({ ok: false, detail: "not a forum" });
    // No point asking for admin rights in a group that isn't even a forum.
    expect(report.admin).toMatchObject({ ok: false, skipped: true });
    expect(h.telegram.callsOf("getChatMember")).toHaveLength(0);
  });

  it("fails the admin check when the bot is not an administrator", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    h.telegram.chatMemberResult = { status: "member" };

    const report = await services.selfCheck.run();
    expect(report.allOk).toBe(false);
    expect(report.group.ok).toBe(true);
    expect(report.admin).toMatchObject({ ok: false, detail: "member" });
  });

  it("delivers a report to an admin who sends /selfcheck in the private chat", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await services.operators.seed(); // ADMIN_IDS=111 in baseConfig

    const result = await services.processor.process(1, userMessage(111, 501, profile(111), text("/selfcheck")));
    expect(result.status).toBe("command_handled");

    const reportSends = h.telegram.callsOf("sendMessage").filter((c) => c.target.chatId === 111);
    expect(reportSends.some((c) => typeof c.payload.text === "string" && c.payload.text.includes("Self-check"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Ad-text detection (广告防护)
// ---------------------------------------------------------------------------

function adConfig(env: Record<string, string> = {}) {
  return loadConfig({
    BOT_TOKEN: "test-token",
    GROUP_ID: "-100123456789",
    ADMIN_IDS: "111",
    OPERATOR_IDS: "222,333",
    ...env,
  });
}

function groupNotificationTexts(h: Harness): string[] {
  return h.telegram
    .callsOf("sendMessage")
    .filter((c) => c.target.chatId === GROUP_ID && c.target.messageThreadId == null)
    .map((c) => c.payload.text as string);
}

describe("ad-text detection (广告防护)", () => {
  it("rejects an unverified user's ad message, auto-blocks, and quarantines the copy into the spam topic", async () => {
    const h = makeHarness(adConfig({ AD_KEYWORDS: "加微信" }));
    const services = buildServices(h.ctx);
    // An unverified user has a row but never passed the arithmetic gate.
    await services.users.getOrCreate(profile(42));

    const result = await services.processor.process(1, userMessage(42, 100, profile(42), text("扫码 加微信 联系")));
    expect(result.status).toBe("message_rejected");

    // Nothing was relayed and no conversation was opened.
    expect(h.db.messages.rows.size).toBe(0);
    expect(h.db.conversations.rows.size).toBe(0);

    // The user was auto-blocked with the system marker.
    const block = await h.db.blocks.getByTelegramUserId(42);
    expect(block?.createdByTelegramUserId).toBe(0);

    // The quarantine topic was created lazily and its id persisted.
    const spamTopicId = Number(await h.db.settings.get("spam_topic_id"));
    expect(Number.isInteger(spamTopicId) && spamTopicId > 0).toBe(true);

    // The ad message was silently forwarded into the quarantine topic...
    const quarantineForwards = topicSends(h, spamTopicId, "forwardMessage");
    expect(quarantineForwards).toHaveLength(1);
    expect(quarantineForwards[0].payload.fromChatId).toBe(42);
    expect(quarantineForwards[0].payload.messageId).toBe(100);

    // ...and the notification lives INSIDE that topic, not the group's general chat.
    const notice = topicSends(h, spamTopicId, "sendMessage")
      .map((c) => c.payload.text as string)
      .find((t) => t.includes("Ad detected"));
    expect(notice).toBeTruthy();
    expect(notice).toContain("id 42");
    expect(notice).toContain("/unban 42");
    expect(groupNotificationTexts(h).some((t) => t.includes("Ad detected"))).toBe(false);

    expect(h.logger.has("ad_blocked")).toBe(true);
    expect(h.logger.has("ad_quarantined")).toBe(true);
  });

  it("/ad restore forwards a quarantined copy into the user's topic and clears the mapping", async () => {
    const h = makeHarness(adConfig({ AD_KEYWORDS: "加微信" }));
    const services = buildServices(h.ctx);
    await services.operators.seed();
    await services.users.getOrCreate(profile(42));

    await services.processor.process(1, userMessage(42, 100, profile(42), text("扫码 加微信 联系")));
    const spamTopicId = Number(await h.db.settings.get("spam_topic_id"));
    const quarantineForwards = topicSends(h, spamTopicId, "forwardMessage");
    expect(quarantineForwards).toHaveLength(1);
    const fwdId = quarantineForwards[0].id!;
    expect(await h.db.settings.get(`spam_q:${fwdId}`)).not.toBeNull();

    // The admin replies to the quarantined copy inside the quarantine topic.
    const restored = await services.processor.process(
      2,
      operatorMessage(GROUP_ID, 300, profile(111), text("/ad restore"), spamTopicId, fwdId),
    );
    expect(restored.status).toBe("command_handled");

    // Confirmation is echoed inside the quarantine topic.
    expect(
      topicSends(h, spamTopicId, "sendMessage")
        .map((c) => c.payload.text as string)
        .some((t) => t === OPERATOR_TEXTS("en").adRestoreDone),
    ).toBe(true);

    // A conversation + topic were opened for the user, and the quarantined copy
    // forwarded from the group into it.
    const conv = await h.db.conversations.getByTelegramUserId(42);
    expect(conv).not.toBeNull();
    const topicForwards = topicSends(h, conv!.telegramTopicId!, "forwardMessage");
    expect(topicForwards).toHaveLength(1);
    expect(topicForwards[0].payload.fromChatId).toBe(GROUP_ID);
    expect(topicForwards[0].payload.messageId).toBe(fwdId);

    // The relay is recorded against the original message, the mapping is
    // cleared (a second restore is refused), and — per design — the user stays
    // blocked: unblocking remains a separate /unban.
    const record = recordsForConversation(h, conv!.id).find((m) => m.telegramMessageId === 100);
    expect(record?.direction).toBe("USER_TO_OPERATOR");
    expect(record?.contentType).toBe("text");
    expect(await h.db.settings.get(`spam_q:${fwdId}`)).toBe("");
    expect(await h.db.blocks.getByTelegramUserId(42)).not.toBeNull();
    expect(h.logger.has("quarantine_restored")).toBe(true);
  });

  it("/ad restore refuses a message that was never quarantined", async () => {
    const h = makeHarness(adConfig());
    const services = buildServices(h.ctx);
    await services.operators.seed();
    // Reply to an arbitrary message id in the general chat — no spam_q mapping.
    const result = await services.processor.process(
      1,
      operatorMessage(GROUP_ID, 2, profile(111), text("/ad restore"), null, 9001),
    );
    expect(result.status).toBe("command_handled");
    expect(
      h.telegram
        .callsOf("sendMessage")
        .some((c) => c.target.chatId === GROUP_ID && c.payload.text === OPERATOR_TEXTS("en").adRestoreNotFound),
    ).toBe(true);
  });

  it("a repeat ad message is caught by the block check without re-creating a row", async () => {
    const h = makeHarness(adConfig({ AD_KEYWORDS: "加微信" }));
    const services = buildServices(h.ctx);

    await services.processor.process(1, userMessage(42, 100, profile(42), text("加微信联系")));
    const afterFirst = await services.processor.process(2, userMessage(42, 101, profile(42), text("加微信再来")));
    expect(afterFirst.status).toBe("blocked");
    expect(h.db.blocks.rows.size).toBe(1);
  });

  it("editing a message into an ad is rejected and blocks an unverified user", async () => {
    const h = makeHarness(adConfig({ AD_KEYWORDS: "返利" }));
    const services = buildServices(h.ctx);
    await services.users.getOrCreate(profile(42));

    const result = await services.processor.process(1, editedUserMessage(42, 100, profile(42), text("限时返利 5 元")));
    expect(result.status).toBe("message_rejected");
    expect(h.telegram.callsOf("editMessageText")).toHaveLength(0);
    expect(await h.db.blocks.getByTelegramUserId(42)).not.toBeNull();
  });

  it("catches a first-contact ad before any user/conversation row is created", async () => {
    const h = makeHarness(adConfig({ AD_KEYWORDS: "代购" }));
    const services = buildServices(h.ctx);

    const result = await services.processor.process(1, userMessage(42, 100, profile(42), text("代购 加我")));
    expect(result.status).toBe("message_rejected");

    expect(h.db.users.rows.size).toBe(0);
    expect(h.db.conversations.rows.size).toBe(0);
    expect(h.db.messages.rows.size).toBe(0);
    expect(await h.db.blocks.getByTelegramUserId(42)).not.toBeNull();
  });

  it("with AD_AUTO_BLOCK=false the message is dropped but the user is not blocked", async () => {
    const h = makeHarness(adConfig({ AD_KEYWORDS: "加微信", AD_AUTO_BLOCK: "false" }));
    const services = buildServices(h.ctx);

    const result = await services.processor.process(1, userMessage(42, 100, profile(42), text("加微信联系")));
    expect(result.status).toBe("message_rejected");
    expect(await h.db.blocks.getByTelegramUserId(42)).toBeNull();
  });

  it("a verified user is not subject to the ad blacklist", async () => {
    const h = makeHarness(adConfig({ AD_KEYWORDS: "加微信" }));
    const services = buildServices(h.ctx);
    await verifiedUser(h, 42);
    const conv = await openConversation(h, 42);

    const result = await services.processor.process(1, userMessage(42, 100, profile(42), text("扫码 加微信 联系")));
    expect(result.status).toBe("processed");
    expect(topicSends(h, conv.telegramTopicId!, "forwardMessage")).toHaveLength(1);
    expect(await h.db.blocks.getByTelegramUserId(42)).toBeNull();
    expect(groupNotificationTexts(h).some((t) => t.includes("Ad detected"))).toBe(false);
    expect(h.logger.has("ad_blocked")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Pending queue (未验证消息暂存)
// ---------------------------------------------------------------------------

describe("pending queue (未验证消息暂存)", () => {
  it("queues an unverified user's messages and flushes them in order after verification + purpose", async () => {
    const h = makeHarness(adConfig());
    const services = buildServices(h.ctx);

    // Two plain messages while the user is not verified: both are queued, and a
    // live challenge is re-asked in place (no user/conversation rows yet).
    const first = await services.processor.process(1, userMessage(42, 100, profile(42), text("hello, is anyone there?")));
    expect(first.status).toBe("verification_issued");
    const second = await services.processor.process(2, userMessage(42, 101, profile(42), text("i have a question")));
    expect(second.status).toBe("verification_issued");

    const queued = JSON.parse((await h.db.settings.get("pending:42"))!);
    expect(queued.map((e: { messageId: number }) => e.messageId)).toEqual([100, 101]);
    expect(await h.db.users.getByTelegramUserId(42)).toBeNull();
    expect(await h.db.conversations.getByTelegramUserId(42)).toBeNull();

    // Correct verification answer: verified, but the purpose gate holds — the
    // queue is NOT flushed yet (there is no conversation to flush into).
    const state = (await h.store.get(42))!;
    const answered = await services.processor.process(
      3,
      verificationAnswer(42, state.questionMessageId!, state.answer, "cq", profile(42)),
    );
    expect(answered.status).toBe("purpose_pending");
    expect(await h.db.settings.get("pending:42")).not.toBe("");

    // The purpose statement opens the conversation and flushes the queue in order.
    const opened = await services.processor.process(4, userMessage(42, 200, profile(42), text("checking my order")));
    expect(opened.status).toBe("processed");
    const conv = await h.db.conversations.getByTelegramUserId(42);
    expect(conv).not.toBeNull();

    // Both queued messages were forwarded into the topic, in arrival order.
    const forwards = topicSends(h, conv!.telegramTopicId!, "forwardMessage");
    expect(forwards.map((c) => c.payload.messageId)).toEqual([100, 101]);
    // The purpose statement itself was consumed and is NOT relayed.
    expect(forwards.some((c) => c.payload.messageId === 200)).toBe(false);

    // Both relays are recorded; the queue is empty; the purpose was consumed.
    expect(recordsForConversation(h, conv!.id).map((m) => m.telegramMessageId)).toEqual([100, 101]);
    expect(await h.db.settings.get("pending:42")).toBe("");
    expect((await h.db.users.getByTelegramUserId(42))?.purpose).toBe("checking my order");

    expect(h.logger.has("message_queued")).toBe(true);
    expect(h.logger.lines.filter((l) => l.event === "message_relayed" && l.fields?.kind === "pending")).toHaveLength(2);
  });

  it("keeps ad and rate-limited messages out of the queue (rejected at earlier gates)", async () => {
    const h = makeHarness(adConfig({ AD_KEYWORDS: "加微信" }));
    const services = buildServices(h.ctx);

    // An ad message is rejected before the gate — nothing is enqueued.
    await services.processor.process(1, userMessage(42, 100, profile(42), text("扫码 加微信 联系")));
    expect(await h.db.settings.get("pending:42")).toBeNull();
    expect(h.logger.has("message_queued")).toBe(false);
  });
});