// ---------------------------------------------------------------------------
// /ban · /unban (8.3) and their group-level by-target forms (广告防护):
// bare telegram_user_id or @username from the general chat, reachable even for
// users with no conversation/topic row.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { makeHarness, profile, text, userMessage, operatorMessage, GROUP_ID } from "./harness.ts";
import { OPERATOR_TEXTS } from "./texts.ts";
import { seeded, verifiedUser, replyText } from "./commands.test-helpers.ts";

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
