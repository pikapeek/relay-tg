// ---------------------------------------------------------------------------
// Operator command tests (task 8): the operator registry (8.1), the command
// dispatcher (8.2), and /help (8.11). The remaining command groups live in
// their own files: commands.ban/ad/delete/info/approve/restore-hide/lang/
// selfcheck.test.ts.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { buildServices } from "./index.ts";
import { makeHarness, profile, text, userMessage, operatorMessage, GROUP_ID } from "./harness.ts";
import { OPERATOR_TEXTS, TEXTS } from "./texts.ts";
import { seeded, verifiedUser, replyText } from "./commands.test-helpers.ts";

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
// 8.11 /help
// ---------------------------------------------------------------------------

describe("/help (8.11)", () => {
  it("advertises only /start to users and leaves a pending verification untouched", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    // Start a challenge so there is a pending verification to preserve.
    await services.processor.process(1, userMessage(42, 100, profile(42), text("/start")));
    const before = (await h.store.get("main", 42))!;

    const result = await services.processor.process(2, userMessage(42, 101, profile(42), text("/help")));
    expect(result.status).toBe("command_handled");
    expect(h.telegram.callsOf("sendMessage").find((c) => c.target.chatId === 42 && c.payload.text === TEXTS("en").userHelp)).toBeDefined();

    const after = (await h.store.get("main", 42))!;
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
