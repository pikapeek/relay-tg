// ---------------------------------------------------------------------------
// Conversation visibility: /restore (8.9) and /hide (8.10).
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { makeHarness, profile, text, operatorMessage, GROUP_ID } from "./harness.ts";
import { OPERATOR_TEXTS } from "./texts.ts";
import { seeded, verifiedUser, hiddenConversation, replyText } from "./commands.test-helpers.ts";

// ---------------------------------------------------------------------------
// 8.9 /restore
// ---------------------------------------------------------------------------

describe("/restore (8.9)", () => {
  it("restores by telegram_user_id", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    await hiddenConversation(h, 42);
    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(222), text("/restore 42"), null));
    expect(h.telegram.callsOf("restoreForumTopic")).toHaveLength(1);
    expect((await h.db.conversations.getByTelegramUserId(42))!.hiddenAt).toBeNull();
    expect(replyText(h)).toEqual([OPERATOR_TEXTS("en").conversationRestored]);
  });

  it("restores by @username", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    // Keep the username attached to the user row (a later bare-profile upsert
    // would clear it, so set it once at creation).
    const { user } = await services.users.getOrCreate(profile(42, { username: "alice" }));
    await services.users.markVerified(user.telegramUserId, h.bots.primary());
    const conv = await services.conversations.grantAccess(user, h.bots.primary());
    await h.telegram.hideForumTopic({ chatId: GROUP_ID, messageThreadId: conv.telegramTopicId! });
    await h.db.conversations.setHidden(conv.id, h.runtime.now().toISOString());

    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(222), text("/restore @alice"), null));
    expect((await h.db.conversations.getByTelegramUserId(42))!.hiddenAt).toBeNull();
    expect(replyText(h)).toEqual([OPERATOR_TEXTS("en").conversationRestored]);
  });

  it("restores by conversation id", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const conv = await hiddenConversation(h, 42);
    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(222), text(`/restore ${conv.id}`), null));
    expect((await h.db.conversations.getByTelegramUserId(42))!.hiddenAt).toBeNull();
    expect(replyText(h)).toEqual([OPERATOR_TEXTS("en").conversationRestored]);
  });

  it("rejects an unknown target", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(222), text("/restore c-does-not-exist"), null));
    expect(replyText(h)).toEqual([OPERATOR_TEXTS("en").unknownRestoreTarget]);
  });
});

// ---------------------------------------------------------------------------
// 8.10 /hide
// ---------------------------------------------------------------------------

describe("/hide (8.10)", () => {
  it("sets custom hours, off, and default", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const conv = await verifiedUser(h, 42);
    const topicId = conv.telegramTopicId!;

    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(222), text("/hide 48"), topicId));
    expect((await h.db.conversations.getByTelegramUserId(42))!.hideAfterHours).toBe(48);

    await services.processor.process(2, operatorMessage(GROUP_ID, 2, profile(222), text("/hide off"), topicId));
    expect((await h.db.conversations.getByTelegramUserId(42))!.hideAfterHours).toBe(0);

    await services.processor.process(3, operatorMessage(GROUP_ID, 3, profile(222), text("/hide default"), topicId));
    expect((await h.db.conversations.getByTelegramUserId(42))!.hideAfterHours).toBeNull();
  });

  it("rejects invalid arguments", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const conv = await verifiedUser(h, 42);
    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(222), text("/hide soon"), conv.telegramTopicId!));
    expect(replyText(h, conv.telegramTopicId!)).toEqual([OPERATOR_TEXTS("en").usageHide]);
    expect((await h.db.conversations.getByTelegramUserId(42))!.hideAfterHours).toBeNull();
  });

  it("restores a hidden conversation when its policy changes", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const conv = await hiddenConversation(h, 42);
    const topicId = conv.telegramTopicId!;
    expect(h.telegram.callsOf("restoreForumTopic")).toHaveLength(0);

    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(222), text("/hide 96"), topicId));
    expect((await h.db.conversations.getByTelegramUserId(42))!.hideAfterHours).toBe(96);
    expect((await h.db.conversations.getByTelegramUserId(42))!.hiddenAt).toBeNull();
    expect(h.telegram.callsOf("restoreForumTopic")).toHaveLength(1);
  });
});
