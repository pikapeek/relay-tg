// ---------------------------------------------------------------------------
// Conversation inspection and assignment: /info (8.5), /assign (8.6),
// /note (8.7), and /rename (8.7b).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { makeHarness, profile, text, userMessage, operatorMessage, GROUP_ID } from "./harness.ts";
import { OPERATOR_TEXTS } from "./texts.ts";
import { seeded, verifiedUser, replyText } from "./commands.test-helpers.ts";

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
