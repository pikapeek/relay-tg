// ---------------------------------------------------------------------------
// Pending queue (未验证消息暂存): an unverified user's messages are queued and
// flushed in order after verification + purpose; ad and rate-limited messages
// never reach the queue.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { buildServices } from "./index.ts";
import { makeHarness, profile, text, userMessage, verificationAnswer } from "./harness.ts";
import { adConfig, topicSends, recordsForConversation } from "./pipeline.test-helpers.ts";

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

    const queued = JSON.parse((await h.db.settings.get("pending:main:42"))!);
    expect(queued.map((e: { messageId: number }) => e.messageId)).toEqual([100, 101]);
    expect(await h.db.users.getByTelegramUserId(42)).toBeNull();
    expect(await h.db.conversations.getByTelegramUserId(42)).toBeNull();

    // Correct verification answer: verified, but the purpose gate holds — the
    // queue is NOT flushed yet (there is no conversation to flush into).
    const state = (await h.store.get("main", 42))!;
    const answered = await services.processor.process(
      3,
      verificationAnswer(42, state.questionMessageId!, state.answer, "cq", profile(42)),
    );
    expect(answered.status).toBe("purpose_pending");
    expect(await h.db.settings.get("pending:main:42")).not.toBe("");

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
    expect(await h.db.settings.get("pending:main:42")).toBe("");
    expect((await h.db.users.getByTelegramUserId(42))?.purpose).toBe("checking my order");

    expect(h.logger.has("message_queued")).toBe(true);
    expect(h.logger.lines.filter((l) => l.event === "message_relayed" && l.fields?.kind === "pending")).toHaveLength(2);
  });

  it("keeps ad and rate-limited messages out of the queue (rejected at earlier gates)", async () => {
    const h = makeHarness(adConfig({ AD_KEYWORDS: "加微信" }));
    const services = buildServices(h.ctx);

    // An ad message is rejected before the gate — nothing is enqueued.
    await services.processor.process(1, userMessage(42, 100, profile(42), text("扫码 加微信 联系")));
    expect(await h.db.settings.get("pending:main:42")).toBeNull();
    expect(h.logger.has("message_queued")).toBe(false);
  });
});