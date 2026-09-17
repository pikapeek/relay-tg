// ---------------------------------------------------------------------------
// Update idempotency (7.1) and per-conversation serialization with the keyed
// mutex (7.5).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { KeyedMutexSerializer } from "../testing.ts";
import { baseConfig, makeHarness, profile, text, userMessage } from "./harness.ts";
import { buildServices } from "./index.ts";
import { verifiedUser, topicSends, recordsForConversation } from "./pipeline.test-helpers.ts";

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
