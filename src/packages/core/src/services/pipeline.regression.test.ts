// ---------------------------------------------------------------------------
// Full-review regression fixes (2026-09) and the boot-config self-check
// (feature 2: healthy deployment + the failure short-circuits).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { buildServices } from "./index.ts";
import { makeHarness, profile, text, userMessage, operatorMessage, editedUserMessage, verificationAnswer, GROUP_ID } from "./harness.ts";
import { verifiedUser, openConversation, topicSends } from "./pipeline.test-helpers.ts";

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
