import { describe, expect, it } from "vitest";
import type { OperatorRecord } from "@relaytg/shared";
import { CaptureLogger, FakeTelegramClient } from "../testing.ts";
import {
  ADMIN_COMMANDS,
  ADMIN_COMMANDS_ZH,
  OPERATOR_COMMANDS,
  OPERATOR_COMMANDS_ZH,
  USER_COMMANDS,
  USER_COMMANDS_ZH,
  applyUserMenu,
  setCommandMenu,
} from "./command-menu.ts";
import { baseConfig } from "./harness.ts";

function operator(telegramUserId: number, role: "ADMIN" | "OPERATOR"): OperatorRecord {
  return { id: `op-${telegramUserId}`, telegramUserId, role, createdAt: "2026-01-01T00:00:00Z" };
}

describe("setCommandMenu", () => {
  it("registers default, private-chat, group, and per-role scopes in both languages", async () => {
    const telegram = new FakeTelegramClient();
    const logger = new CaptureLogger();
    const config = baseConfig();

    await setCommandMenu(telegram, config, logger, async () => [
      operator(111, "ADMIN"),
      operator(222, "OPERATOR"),
    ]);

    expect(telegram.commandMenus).toEqual([
      { scope: { type: "default" }, commands: [] },
      { scope: { type: "all_private_chats" }, commands: USER_COMMANDS },
      { scope: { type: "all_private_chats" }, commands: USER_COMMANDS_ZH, languageCode: "zh" },
      // Support group: operator menu for everyone, admin menu for moderators.
      { scope: { type: "chat", chat_id: config.supportGroupId }, commands: OPERATOR_COMMANDS },
      { scope: { type: "chat", chat_id: config.supportGroupId }, commands: OPERATOR_COMMANDS_ZH, languageCode: "zh" },
      { scope: { type: "chat_administrators", chat_id: config.supportGroupId }, commands: ADMIN_COMMANDS },
      { scope: { type: "chat_administrators", chat_id: config.supportGroupId }, commands: ADMIN_COMMANDS_ZH, languageCode: "zh" },
      // Staff private chats: the `chat` scope keyed by user id overrides the
      // /start-only all_private_chats default with the full role menu.
      { scope: { type: "chat", chat_id: 111 }, commands: ADMIN_COMMANDS },
      { scope: { type: "chat", chat_id: 111 }, commands: ADMIN_COMMANDS_ZH, languageCode: "zh" },
      { scope: { type: "chat_member", chat_id: config.supportGroupId, user_id: 111 }, commands: ADMIN_COMMANDS },
      { scope: { type: "chat_member", chat_id: config.supportGroupId, user_id: 111 }, commands: ADMIN_COMMANDS_ZH, languageCode: "zh" },
      { scope: { type: "chat", chat_id: 222 }, commands: OPERATOR_COMMANDS },
      { scope: { type: "chat", chat_id: 222 }, commands: OPERATOR_COMMANDS_ZH, languageCode: "zh" },
      { scope: { type: "chat_member", chat_id: config.supportGroupId, user_id: 222 }, commands: OPERATOR_COMMANDS },
      { scope: { type: "chat_member", chat_id: config.supportGroupId, user_id: 222 }, commands: OPERATOR_COMMANDS_ZH, languageCode: "zh" },
    ]);
  });

  it("gives everyone only /start in private chats (/lang is not exposed to users) and nothing in other chats", async () => {
    expect(USER_COMMANDS.map((c) => c.command)).toEqual(["start"]);
    expect(USER_COMMANDS_ZH.map((c) => c.command)).toEqual(["start"]);
    expect(ADMIN_COMMANDS.map((c) => c.command)).toEqual([
      "list",
      "info",
      "assign",
      "note",
      "rename",
      "hide",
      "ban",
      "unban",
      "delete",
      "restore",
      "help",
      "lang",
      "selfcheck",
    ]);
    expect(ADMIN_COMMANDS_ZH.map((c) => c.command)).toEqual([
      "list",
      "info",
      "assign",
      "note",
      "rename",
      "hide",
      "ban",
      "unban",
      "delete",
      "restore",
      "help",
      "lang",
      "selfcheck",
    ]);
    expect(OPERATOR_COMMANDS.map((c) => c.command)).toEqual(["list", "info", "assign", "note", "rename", "delete", "hide", "restore", "help", "lang"]);
    expect(OPERATOR_COMMANDS_ZH.map((c) => c.command)).toEqual(["list", "info", "assign", "note", "rename", "delete", "hide", "restore", "help", "lang"]);
  });

  it("registers no per-member scopes when the registry is empty", async () => {
    const telegram = new FakeTelegramClient();
    const logger = new CaptureLogger();
    const config = baseConfig();

    await setCommandMenu(telegram, config, logger, async () => []);

    // default + all_private_chats (en + zh) + support-group chat/administrators
    // (en + zh) — no per-member scopes.
    expect(telegram.commandMenus).toHaveLength(7);
    expect(telegram.commandMenus.some((m) => m.scope?.type === "chat_member")).toBe(false);
    expect(telegram.commandMenus.some((m) => m.scope?.type === "chat" && m.scope.chat_id === config.supportGroupId)).toBe(true);
  });

  it("keeps going and logs a warning when a scope fails", async () => {
    const telegram = new FakeTelegramClient();
    const logger = new CaptureLogger();
    const config = baseConfig();

    telegram.failAlwaysWith("network", "setMyCommands");

    await setCommandMenu(telegram, config, logger, async () => [operator(111, "ADMIN")]);

    expect(telegram.commandMenus).toEqual([]);
    expect(logger.has("command_menu_failed")).toBe(true);
  });
});

describe("applyUserMenu", () => {
  it("forces a staff member's private-chat and group menus to the chosen language", async () => {
    const telegram = new FakeTelegramClient();
    const logger = new CaptureLogger();
    const config = baseConfig();

    await applyUserMenu(telegram, config, logger, async () => [operator(111, "ADMIN")], 111, "zh");

    expect(telegram.commandMenus).toEqual([
      { scope: { type: "chat", chat_id: 111 }, commands: ADMIN_COMMANDS_ZH },
      { scope: { type: "chat", chat_id: 111 }, commands: ADMIN_COMMANDS_ZH, languageCode: "zh" },
      { scope: { type: "chat_member", chat_id: config.supportGroupId, user_id: 111 }, commands: ADMIN_COMMANDS_ZH },
      { scope: { type: "chat_member", chat_id: config.supportGroupId, user_id: 111 }, commands: ADMIN_COMMANDS_ZH, languageCode: "zh" },
    ]);
  });

  it("mirrors the zh twin for /lang en so zh-client users see English too", async () => {
    const telegram = new FakeTelegramClient();
    const logger = new CaptureLogger();
    const config = baseConfig();

    await applyUserMenu(telegram, config, logger, async () => [], 42, "en");

    expect(telegram.commandMenus).toEqual([
      { scope: { type: "chat", chat_id: 42 }, commands: USER_COMMANDS },
      { scope: { type: "chat", chat_id: 42 }, commands: USER_COMMANDS, languageCode: "zh" },
    ]);
  });

  it("/lang auto restores the client-language-driven EN default + zh twin", async () => {
    const telegram = new FakeTelegramClient();
    const logger = new CaptureLogger();
    const config = baseConfig();

    await applyUserMenu(telegram, config, logger, async () => [], 42, "auto");

    expect(telegram.commandMenus).toEqual([
      { scope: { type: "chat", chat_id: 42 }, commands: USER_COMMANDS },
      { scope: { type: "chat", chat_id: 42 }, commands: USER_COMMANDS_ZH, languageCode: "zh" },
    ]);
  });
});