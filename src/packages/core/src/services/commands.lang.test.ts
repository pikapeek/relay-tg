// ---------------------------------------------------------------------------
// /lang — per-user language preference (zh|en|auto) overriding detection,
// shared between the user private-chat route and the operator dispatcher.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { OPERATOR_COMMANDS_ZH, USER_COMMANDS_ZH } from "./command-menu.ts";
import { buildServices } from "./index.ts";
import {
  makeHarness,
  profile,
  text,
  userMessage,
  operatorMessage,
  verificationAnswer,
  GROUP_ID,
  type Harness,
} from "./harness.ts";
import { OPERATOR_TEXTS, TEXTS } from "./texts.ts";
import { seeded, replyText } from "./commands.test-helpers.ts";

// ---------------------------------------------------------------------------
// 9 /lang — per-user language preference (zh|en|auto) overriding detection
// ---------------------------------------------------------------------------

describe("/lang (9)", () => {
  function sentTo(h: Harness, chatId: number): string[] {
    return h.telegram
      .callsOf("sendMessage")
      .filter((c) => c.target.chatId === chatId && c.payload.text != null)
      .map((c) => c.payload.text as string);
  }

  it("a new user can switch the bot to 简体中文 before verifying", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    const result = await services.processor.process(1, userMessage(42, 100, profile(42, { languageCode: "en" }), text("/lang zh")));
    expect(result.status).toBe("command_handled");
    expect((await h.db.users.getByTelegramUserId(42))?.preferredLanguage).toBe("zh");
    expect(sentTo(h, 42)).toContain(TEXTS("zh").langSet);
    // The suggestion menu is re-applied in 简体中文 immediately (not just the
    // bot's own copy) — Telegram caches it per chat scope.
    const zhDefault = h.telegram.commandMenus.find(
      (m) => m.scope?.type === "chat" && m.scope.chat_id === 42 && m.languageCode === undefined,
    );
    expect(zhDefault?.commands).toEqual(USER_COMMANDS_ZH);
    // /lang is not a gate pass — no conversation was created.
    expect(await h.db.conversations.getByTelegramUserId(42)).toBeNull();
  });

  it("post-verification purpose prompt follows the chosen language", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await services.processor.process(1, userMessage(42, 100, profile(42, { languageCode: "en" }), text("/lang zh")));
    await services.processor.process(2, userMessage(42, 101, profile(42, { languageCode: "en" }), text("/start")));
    const state = (await h.store.get("main", 42))!;
    const ok = await services.processor.process(
      3,
      verificationAnswer(42, state.questionMessageId!, state.answer, "cq-ok", profile(42, { languageCode: "en" })),
    );
    // Verified, but the first-contact purpose gate asks in the chosen language.
    expect(ok.status).toBe("purpose_pending");
    expect(sentTo(h, 42)).toContain(TEXTS("zh").purposePrompt);
    expect(sentTo(h, 42)).not.toContain(TEXTS("en").purposePrompt);

    // The purpose statement still opens the conversation (no welcome to follow).
    await services.processor.process(4, userMessage(42, 102, profile(42, { languageCode: "en" }), text("咨询退款")));
    expect(await h.db.conversations.getByTelegramUserId(42)).not.toBeNull();
  });

  it("/lang with no argument reports the current language", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await services.processor.process(1, userMessage(42, 100, profile(42), text("/lang zh")));
    h.telegram.calls = [];
    await services.processor.process(2, userMessage(42, 101, profile(42), text("/lang")));
    expect(sentTo(h, 42)).toContain(TEXTS("zh").langCurrent("zh"));
  });

  it("/lang auto clears the preference and falls back to the detected language", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await services.processor.process(1, userMessage(42, 100, profile(42, { languageCode: "zh" }), text("/lang zh")));
    await services.processor.process(2, userMessage(42, 101, profile(42, { languageCode: "zh" }), text("/lang auto")));
    expect((await h.db.users.getByTelegramUserId(42))?.preferredLanguage).toBeNull();
    expect(sentTo(h, 42)).toContain(TEXTS("zh").langAuto);
  });

  it("an invalid argument shows usage in the current language and stores nothing", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await services.processor.process(1, userMessage(42, 100, profile(42, { languageCode: "en" }), text("/lang fr")));
    expect(sentTo(h, 42)).toContain(TEXTS("en").langUsage);
    expect((await h.db.users.getByTelegramUserId(42))?.preferredLanguage).toBeNull();
  });

  it("user-facing help follows the stored preference", async () => {
    const h = makeHarness();
    const services = buildServices(h.ctx);
    await services.processor.process(1, userMessage(42, 100, profile(42), text("/lang zh")));
    h.telegram.calls = [];
    await services.processor.process(2, userMessage(42, 101, profile(42), text("/help")));
    expect(sentTo(h, 42)).toContain(TEXTS("zh").userHelp);
  });

  it("an operator can switch and the group echo uses the new language", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    const result = await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(222), text("/lang zh"), null));
    expect(result.status).toBe("command_handled");
    expect(replyText(h)).toEqual([OPERATOR_TEXTS("zh").langSet]);
    expect((await h.db.users.getByTelegramUserId(222))?.preferredLanguage).toBe("zh");
    // The operator's per-user menus (private chat + group member) flip to zh.
    const zhDefault = h.telegram.commandMenus.find(
      (m) => m.scope?.type === "chat" && m.scope.chat_id === 222 && m.languageCode === undefined,
    );
    expect(zhDefault?.commands).toEqual(OPERATOR_COMMANDS_ZH);
  });

  it("an operator /lang with no argument reports the stored choice", async () => {
    const h = makeHarness();
    const services = await seeded(h);
    await services.processor.process(1, operatorMessage(GROUP_ID, 1, profile(222), text("/lang zh"), null));
    h.telegram.calls = [];
    await services.processor.process(2, operatorMessage(GROUP_ID, 2, profile(222), text("/lang"), null));
    expect(replyText(h)).toEqual([OPERATOR_TEXTS("zh").langCurrent("zh")]);
  });
});
