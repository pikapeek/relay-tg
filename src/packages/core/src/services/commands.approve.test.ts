// ---------------------------------------------------------------------------
// Application-decision callbacks (8.8): the approve/reject path of the
// callback handler. Verify taps are covered by the pipeline suite.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { buildServices } from "./index.ts";
import { makeHarness, profile, text, userMessage, type Harness } from "./harness.ts";
import { TEXTS } from "./texts.ts";
import { seeded, applicationDecision } from "./commands.test-helpers.ts";

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
