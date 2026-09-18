// ---------------------------------------------------------------------------
// Message-level pipeline tests (task 6): MessageService records & resolution
// (6.1-6.2), reply preservation (6.3), media groups (6.4), topic recovery
// (6.5), and edit relay (6.6).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { loadConfig, type MessageContent } from "@relaytg/shared";
import { buildServices, MEDIA_GROUP_WINDOW_MS } from "./index.ts";
import {
  makeHarness,
  profile,
  text,
  photo,
  userMessage,
  operatorMessage,
  editedUserMessage,
  editedOperatorMessage,
  GROUP_ID,
} from "./harness.ts";
import { verifiedUser, openConversation, topicSends, recordsForConversation, textOf, drainMicrotasks } from "./pipeline.test-helpers.ts";

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
      botId: "main",
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
      botId: "main",
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
      botId: "main",
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
        BOTS: "main:test-token",
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
      { botId: "main", telegramUserId: 42, telegramTopicId: null, assignedOperatorId: null },
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
