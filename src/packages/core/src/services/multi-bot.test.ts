// ---------------------------------------------------------------------------
// Multi-bot behavior (multi-bot capability): N bots sharing ONE support group.
// Conversations are keyed (bot × user); each topic's user-facing sends go out
// through THAT bot's client; the group control surface belongs to the PRIMARY
// bot alone (other bots' copies of group events are claimed but ignored); and
// update dedup is per (bot, update) so the same update id on two bots never
// collides. Identity (purpose / language / blocks) stays global across bots,
// but human verification is per (bot, user): passing on one bot gets you
// nowhere on another.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { loadConfig } from "@relaytg/shared";
import { FakeTelegramClient, type RecordedCall } from "../testing.ts";
import { buildServices } from "./index.ts";
import { makeHarness, profile, text, userMessage, operatorMessage, verificationAnswer, GROUP_ID, type Harness } from "./harness.ts";
import { verifiedUser } from "./pipeline.test-helpers.ts";

/** The `.text` of every `sendContent` delivery into the user's private chat.
 *  The fake records `sendContent` under the concrete send method (text →
 *  sendMessage) with the content object in `payload.content`; the info card is
 *  posted in the group, so filtering by `telegramUserId` picks up replies only. */
function replyTexts(calls: RecordedCall[], telegramUserId: number): Array<string | undefined> {
  return calls
    .filter((c) => c.target.chatId === telegramUserId && c.payload.content != null)
    .map((c) => {
      const content = c.payload.content as { type: string; text?: string } | undefined;
      return content?.text;
    });
}

function multiBotConfig() {
  return loadConfig({
    BOTS: "main:test-token,second:test-token-2",
    GROUP_ID: "-100123456789",
    ADMIN_IDS: "111",
    OPERATOR_IDS: "222,333",
  });
}

/** The second bot's fake client (the registry's `bots.get("second").client`). */
function secondClient(h: Harness): FakeTelegramClient {
  return h.bots.get("second").client as FakeTelegramClient;
}

describe("multi-bot: one support group, one topic per (bot × user)", () => {
  it("a user talking to two bots gets two independent topics, each prefixed by its bot", async () => {
    const h = makeHarness(multiBotConfig());
    const services = buildServices(h.ctx);
    // Verification is per (bot, user): the user passes the gate on BOTH bots —
    // being verified on main does not open a topic on second.
    await verifiedUser(h, 42);
    await verifiedUser(h, 42, "test purpose", "second");

    const r1 = await services.processor.process(1, userMessage(42, 100, profile(42), text("hi")), "main");
    expect(r1.status).toBe("processed");
    const convMain = await h.db.conversations.getByBotAndUser("main", 42);
    expect(convMain).not.toBeNull();

    const r2 = await services.processor.process(2, userMessage(42, 200, profile(42), text("hi again")), "second");
    expect(r2.status).toBe("processed");
    const convSecond = await h.db.conversations.getByBotAndUser("second", 42);
    expect(convSecond).not.toBeNull();

    // Distinct conversations and topics — nothing shared between the two bots.
    expect(convMain!.id).not.toBe(convSecond!.id);
    expect(convMain!.telegramTopicId).not.toBe(convSecond!.telegramTopicId);
    expect(convMain!.botId).toBe("main");
    expect(convSecond!.botId).toBe("second");

    // Topic creation is a support-group operation: both topics are created
    // through the PRIMARY bot's client, each named `botId | …`. The names land
    // on the shared group topic store, so each conversation's topic id maps to
    // the right prefixed name.
    const topicCalls = h.telegram.callsOf("createForumTopic");
    expect(topicCalls.map((c) => c.payload.name)).toContain("main | User42 | 42");
    expect(topicCalls.map((c) => c.payload.name)).toContain("second | User42 | 42");
    expect(secondClient(h).callsOf("createForumTopic")).toHaveLength(0);
    expect(h.telegram.topics.get(convMain!.telegramTopicId!)?.name).toBe("main | User42 | 42");
    expect(h.telegram.topics.get(convSecond!.telegramTopicId!)?.name).toBe("second | User42 | 42");
  });

  it("operator replies in each topic go out through that topic's bot", async () => {
    const h = makeHarness(multiBotConfig());
    const services = buildServices(h.ctx);
    // buildServices does not seed the operator registry (that is bootServices'
    // job) — an operator reply needs the registry to pass the role gate.
    await services.operators.seed();
    // The same human is verified on both bots (verification is per (bot, user)).
    await verifiedUser(h, 42);
    await verifiedUser(h, 42, "test purpose", "second");

    // Open a conversation on each bot for the same user.
    const convMain = await services.conversations.grantAccess((await services.users.getByTelegramUserId(42))!, h.bots.primary());
    const convSecond = await services.conversations.grantAccess((await services.users.getByTelegramUserId(42))!, h.bots.get("second"));

    const op = profile(222, { username: "op1", firstName: "Op" });
    // Both operator events arrive through the primary webhook (the group
    // control surface); the relayer routes each reply through the target
    // conversation's own bot.
    await services.processor.process(3, operatorMessage(GROUP_ID, 301, op, text("reply in A"), convMain.telegramTopicId), "main");
    await services.processor.process(4, operatorMessage(GROUP_ID, 302, op, text("reply in B"), convSecond.telegramTopicId), "main");

    const mainReplies = replyTexts(h.telegram.calls, 42);
    const secondReplies = replyTexts(secondClient(h).calls, 42);
    expect(mainReplies).toContain("reply in A");
    expect(secondReplies).toContain("reply in B");
    // No cross-talk: bot1 never delivers bot2's reply and vice versa.
    expect(mainReplies).not.toContain("reply in B");
    expect(secondReplies).not.toContain("reply in A");
  });

  it("group control events arriving through a non-primary bot are ignored", async () => {
    const h = makeHarness(multiBotConfig());
    const services = buildServices(h.ctx);
    const op = profile(222, { username: "op1", firstName: "Op" });

    // The same group command arrives on every bot's webhook; only the primary
    // processes it — the second bot's copy is claimed (dedup) but ignored.
    const ignored = await services.processor.process(5, operatorMessage(GROUP_ID, 501, op, text("/list"), null), "second");
    expect(ignored.status).toBe("ignored");
    expect(secondClient(h).callsOf("sendMessage").length).toBe(0);

    const handled = await services.processor.process(6, operatorMessage(GROUP_ID, 502, op, text("/list"), null), "main");
    expect(handled.status).toBe("command_handled");
    expect(h.telegram.callsOf("sendMessage").length).toBeGreaterThan(0);
  });

  it("claims update ids per bot — the same id on two bots does not dedupe each other", async () => {
    const h = makeHarness(multiBotConfig());
    const services = buildServices(h.ctx);

    // Unverified user: each bot issues its own challenge in its own chat.
    const a = await services.processor.process(10, userMessage(42, 100, profile(42), text("hi")), "main");
    expect(a.status).toBe("verification_issued");
    const aDup = await services.processor.process(10, userMessage(42, 100, profile(42), text("hi")), "main");
    expect(aDup.status).toBe("duplicate");

    // Update id 10 is fresh for the second bot — not a duplicate.
    const b = await services.processor.process(10, userMessage(42, 101, profile(42), text("hi")), "second");
    expect(b.status).toBe("verification_issued");

    // The two challenges went through their own clients, and the pending
    // queues are keyed per (bot, user) — neither bot sees the other's entry.
    expect(h.telegram.callsOf("sendMessage").length).toBe(1);
    expect(secondClient(h).callsOf("sendMessage").length).toBe(1);
    expect(await services.pending.list("main", 42)).toHaveLength(1);
    expect(await services.pending.list("second", 42)).toHaveLength(1);
  });

  it("a user verified on one bot must verify again on another", async () => {
    const h = makeHarness(multiBotConfig());
    const services = buildServices(h.ctx);

    // Pass the gate and open a topic on the primary bot: challenge, answer,
    // then a purpose statement (the first-contact gate).
    const first = await services.processor.process(1, userMessage(42, 100, profile(42), text("hi")), "main");
    expect(first.status).toBe("verification_issued");
    const mainState = (await h.store.get("main", 42))!;
    const answeredMain = await services.processor.process(
      2,
      verificationAnswer(42, mainState.questionMessageId!, mainState.answer, "cq-main", profile(42)),
      "main",
    );
    expect(answeredMain.status).toBe("purpose_pending");
    await services.processor.process(3, userMessage(42, 101, profile(42), text("asking about a refund")), "main");
    expect(await h.db.conversations.getByBotAndUser("main", 42)).not.toBeNull();

    // The SAME user messaging a second bot is NOT auto-trusted by the main-bot
    // verification: a fresh challenge is issued on the second bot, and no topic
    // is opened there.
    const secondFirst = await services.processor.process(4, userMessage(42, 200, profile(42), text("also, hi")), "second");
    expect(secondFirst.status).toBe("verification_issued");
    expect(await h.db.conversations.getByBotAndUser("second", 42)).toBeNull();

    // Answering the SECOND bot's challenge verifies them on second only; the
    // global purpose is already stated, so the second conversation opens
    // immediately (no second purpose prompt).
    const secondState = (await h.store.get("second", 42))!;
    expect(secondState.challengeId).not.toBe(mainState.challengeId);
    const answeredSecond = await services.processor.process(
      5,
      verificationAnswer(42, secondState.questionMessageId!, secondState.answer, "cq-second", profile(42)),
      "second",
    );
    expect(answeredSecond.status).toBe("processed");
    expect(await h.db.conversations.getByBotAndUser("second", 42)).not.toBeNull();

    // Each (bot, user) pair carries its own verification mark; neither record
    // was overwritten by the other bot's flow.
    expect(await h.db.users.getVerifiedAt("main", 42)).not.toBeNull();
    expect(await h.db.users.getVerifiedAt("second", 42)).not.toBeNull();
  });
});
