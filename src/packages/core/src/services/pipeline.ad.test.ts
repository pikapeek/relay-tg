// ---------------------------------------------------------------------------
// Ad-text detection (广告防护): keyword/allowlist/link rules, auto-block, the
// quarantine topic, and /ad restore.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { buildServices } from "./index.ts";
import {
  makeHarness,
  profile,
  text,
  editedUserMessage,
  userMessage,
  operatorMessage,
  GROUP_ID,
  type Harness,
} from "./harness.ts";
import { OPERATOR_TEXTS } from "./texts.ts";
import { adConfig, verifiedUser, openConversation, topicSends, recordsForConversation } from "./pipeline.test-helpers.ts";

function groupNotificationTexts(h: Harness): string[] {
  return h.telegram
    .callsOf("sendMessage")
    .filter((c) => c.target.chatId === GROUP_ID && c.target.messageThreadId == null)
    .map((c) => c.payload.text as string);
}

describe("ad-text detection (广告防护)", () => {
  it("rejects an unverified user's ad message, auto-blocks, and quarantines the copy into the spam topic", async () => {
    const h = makeHarness(adConfig({ AD_KEYWORDS: "加微信" }));
    const services = buildServices(h.ctx);
    // An unverified user has a row but never passed the arithmetic gate.
    await services.users.getOrCreate(profile(42));

    const result = await services.processor.process(1, userMessage(42, 100, profile(42), text("扫码 加微信 联系")));
    expect(result.status).toBe("message_rejected");

    // Nothing was relayed and no conversation was opened.
    expect(h.db.messages.rows.size).toBe(0);
    expect(h.db.conversations.rows.size).toBe(0);

    // The user was auto-blocked with the system marker.
    const block = await h.db.blocks.getByTelegramUserId(42);
    expect(block?.createdByTelegramUserId).toBe(0);

    // The quarantine topic was created lazily and its id persisted.
    const spamTopicId = Number(await h.db.settings.get("spam_topic_id"));
    expect(Number.isInteger(spamTopicId) && spamTopicId > 0).toBe(true);

    // The ad message was silently forwarded into the quarantine topic...
    const quarantineForwards = topicSends(h, spamTopicId, "forwardMessage");
    expect(quarantineForwards).toHaveLength(1);
    expect(quarantineForwards[0].payload.fromChatId).toBe(42);
    expect(quarantineForwards[0].payload.messageId).toBe(100);

    // ...and the notification lives INSIDE that topic, not the group's general chat.
    const notice = topicSends(h, spamTopicId, "sendMessage")
      .map((c) => c.payload.text as string)
      .find((t) => t.includes("Ad detected"));
    expect(notice).toBeTruthy();
    expect(notice).toContain("id 42");
    expect(notice).toContain("/unban 42");
    expect(groupNotificationTexts(h).some((t) => t.includes("Ad detected"))).toBe(false);

    expect(h.logger.has("ad_blocked")).toBe(true);
    expect(h.logger.has("ad_quarantined")).toBe(true);
  });

  it("/ad restore forwards a quarantined copy into the user's topic and clears the mapping", async () => {
    const h = makeHarness(adConfig({ AD_KEYWORDS: "加微信" }));
    const services = buildServices(h.ctx);
    await services.operators.seed();
    await services.users.getOrCreate(profile(42));

    await services.processor.process(1, userMessage(42, 100, profile(42), text("扫码 加微信 联系")));
    const spamTopicId = Number(await h.db.settings.get("spam_topic_id"));
    const quarantineForwards = topicSends(h, spamTopicId, "forwardMessage");
    expect(quarantineForwards).toHaveLength(1);
    const fwdId = quarantineForwards[0].id!;
    expect(await h.db.settings.get(`spam_q:${fwdId}`)).not.toBeNull();

    // The admin replies to the quarantined copy inside the quarantine topic.
    const restored = await services.processor.process(
      2,
      operatorMessage(GROUP_ID, 300, profile(111), text("/ad restore"), spamTopicId, fwdId),
    );
    expect(restored.status).toBe("command_handled");

    // Confirmation is echoed inside the quarantine topic.
    expect(
      topicSends(h, spamTopicId, "sendMessage")
        .map((c) => c.payload.text as string)
        .some((t) => t === OPERATOR_TEXTS("en").adRestoreDone),
    ).toBe(true);

    // A conversation + topic were opened for the user, and the quarantined copy
    // forwarded from the group into it.
    const conv = await h.db.conversations.getByTelegramUserId(42);
    expect(conv).not.toBeNull();
    const topicForwards = topicSends(h, conv!.telegramTopicId!, "forwardMessage");
    expect(topicForwards).toHaveLength(1);
    expect(topicForwards[0].payload.fromChatId).toBe(GROUP_ID);
    expect(topicForwards[0].payload.messageId).toBe(fwdId);

    // The relay is recorded against the original message, the mapping is
    // cleared (a second restore is refused), and — per design — the user stays
    // blocked: unblocking remains a separate /unban.
    const record = recordsForConversation(h, conv!.id).find((m) => m.telegramMessageId === 100);
    expect(record?.direction).toBe("USER_TO_OPERATOR");
    expect(record?.contentType).toBe("text");
    expect(await h.db.settings.get(`spam_q:${fwdId}`)).toBe("");
    expect(await h.db.blocks.getByTelegramUserId(42)).not.toBeNull();
    expect(h.logger.has("quarantine_restored")).toBe(true);
  });

  it("/ad restore refuses a message that was never quarantined", async () => {
    const h = makeHarness(adConfig());
    const services = buildServices(h.ctx);
    await services.operators.seed();
    // Reply to an arbitrary message id in the general chat — no spam_q mapping.
    const result = await services.processor.process(
      1,
      operatorMessage(GROUP_ID, 2, profile(111), text("/ad restore"), null, 9001),
    );
    expect(result.status).toBe("command_handled");
    expect(
      h.telegram
        .callsOf("sendMessage")
        .some((c) => c.target.chatId === GROUP_ID && c.payload.text === OPERATOR_TEXTS("en").adRestoreNotFound),
    ).toBe(true);
  });

  it("a repeat ad message is caught by the block check without re-creating a row", async () => {
    const h = makeHarness(adConfig({ AD_KEYWORDS: "加微信" }));
    const services = buildServices(h.ctx);

    await services.processor.process(1, userMessage(42, 100, profile(42), text("加微信联系")));
    const afterFirst = await services.processor.process(2, userMessage(42, 101, profile(42), text("加微信再来")));
    expect(afterFirst.status).toBe("blocked");
    expect(h.db.blocks.rows.size).toBe(1);
  });

  it("editing a message into an ad is rejected and blocks an unverified user", async () => {
    const h = makeHarness(adConfig({ AD_KEYWORDS: "返利" }));
    const services = buildServices(h.ctx);
    await services.users.getOrCreate(profile(42));

    const result = await services.processor.process(1, editedUserMessage(42, 100, profile(42), text("限时返利 5 元")));
    expect(result.status).toBe("message_rejected");
    expect(h.telegram.callsOf("editMessageText")).toHaveLength(0);
    expect(await h.db.blocks.getByTelegramUserId(42)).not.toBeNull();
  });

  it("catches a first-contact ad before any user/conversation row is created", async () => {
    const h = makeHarness(adConfig({ AD_KEYWORDS: "代购" }));
    const services = buildServices(h.ctx);

    const result = await services.processor.process(1, userMessage(42, 100, profile(42), text("代购 加我")));
    expect(result.status).toBe("message_rejected");

    expect(h.db.users.rows.size).toBe(0);
    expect(h.db.conversations.rows.size).toBe(0);
    expect(h.db.messages.rows.size).toBe(0);
    expect(await h.db.blocks.getByTelegramUserId(42)).not.toBeNull();
  });

  it("with AD_AUTO_BLOCK=false the message is dropped but the user is not blocked", async () => {
    const h = makeHarness(adConfig({ AD_KEYWORDS: "加微信", AD_AUTO_BLOCK: "false" }));
    const services = buildServices(h.ctx);

    const result = await services.processor.process(1, userMessage(42, 100, profile(42), text("加微信联系")));
    expect(result.status).toBe("message_rejected");
    expect(await h.db.blocks.getByTelegramUserId(42)).toBeNull();
  });

  it("a verified user is not subject to the ad blacklist", async () => {
    const h = makeHarness(adConfig({ AD_KEYWORDS: "加微信" }));
    const services = buildServices(h.ctx);
    await verifiedUser(h, 42);
    const conv = await openConversation(h, 42);

    const result = await services.processor.process(1, userMessage(42, 100, profile(42), text("扫码 加微信 联系")));
    expect(result.status).toBe("processed");
    expect(topicSends(h, conv.telegramTopicId!, "forwardMessage")).toHaveLength(1);
    expect(await h.db.blocks.getByTelegramUserId(42)).toBeNull();
    expect(groupNotificationTexts(h).some((t) => t.includes("Ad detected"))).toBe(false);
    expect(h.logger.has("ad_blocked")).toBe(false);
  });
});
