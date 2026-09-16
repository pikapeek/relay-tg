// ---------------------------------------------------------------------------
// Command menu registration (Bot API setMyCommands). Both runtimes call this
// once at boot so Telegram shows a menu next to the chat input.
//
// Telegram's per-scope precedence (most specific wins):
//   default < all_private_chats < all_group_chats < all_chat_administrators
//   < chat < chat_administrators < chat_member.
//
// Layout:
//   - default scope: nothing anywhere.
//   - private chats: only /start for the general public. A `chat` scope keyed
//     by a staff user's id overrides that with their full role menu, so admins
//     (and operators) see all their commands when chatting with the bot.
//   - support group: the operator menu at the group `chat` scope so the slash
//     hints actually render in topics — `chat_member` scopes on their own
//     render inconsistently across Telegram clients. Group admins get the
//     admin menu via the more specific `chat_administrators` scope, and each
//     registered staff member's `chat_member` scope keeps their menu exact
//     wherever per-member scopes do render.
//
// /ban /unban are ADMIN-only (see CommandService); /delete is a hybrid:
// replying to a topic message retracts its delivered user-chat copy (OPERATOR+),
// while a replyless /delete removes the whole conversation (ADMIN only). The
// operator menu therefore carries /delete too. Every (scope, language) pair is
// registered in English and 简体中文 and guarded individually — a transient
// Telegram error must never take the bot down, and one failed pair must not
// block the others.
// ---------------------------------------------------------------------------

import type { Config, Logger, OperatorRecord, UserRecord } from "@relaytg/shared";
import type { Database, TelegramClient } from "../ports.ts";
import type { BotCommand, BotCommandScope } from "../telegram-types.ts";
import type { Language } from "./texts.ts";

/** Default user-facing menu, shown in every private chat unless the sender is
 *  a registered staff member (whose `chat` scope overrides this). /lang is
 *  deliberately absent — users don't get the language command. Typed commands
 *  like /apply and /help still work for everyone. */
export const USER_COMMANDS: BotCommand[] = [{ command: "start", description: "Contact support" }];
export const USER_COMMANDS_ZH: BotCommand[] = [{ command: "start", description: "联系客服" }];

/** Full admin menu — the private-chat menu for ADMINS and the support-group
 *  menu for group admins. Includes the ADMIN-only /ban /unban /delete
 *  /selfcheck. */
export const ADMIN_COMMANDS: BotCommand[] = [
  { command: "list", description: "List conversations" },
  { command: "info", description: "Conversation summary" },
  { command: "assign", description: "Assign operator" },
  { command: "note", description: "Save a note" },
  { command: "rename", description: "Rename topic" },
  { command: "hide", description: "Set hide policy" },
  { command: "ban", description: "Ban user" },
  { command: "unban", description: "Unban user" },
  { command: "delete", description: "Retract message / delete conversation" },
  { command: "restore", description: "Restore conversation" },
  { command: "help", description: "Show help" },
  { command: "lang", description: "Change language" },
  { command: "selfcheck", description: "Run config self-check" },
];

export const ADMIN_COMMANDS_ZH: BotCommand[] = [
  { command: "list", description: "列出会话" },
  { command: "info", description: "会话摘要" },
  { command: "assign", description: "指派客服" },
  { command: "note", description: "保存备注" },
  { command: "rename", description: "重命名话题" },
  { command: "hide", description: "设置隐藏策略" },
  { command: "ban", description: "封禁用户" },
  { command: "unban", description: "解封用户" },
  { command: "delete", description: "撤回消息 / 删除会话" },
  { command: "restore", description: "恢复会话" },
  { command: "help", description: "帮助" },
  { command: "lang", description: "切换语言" },
  { command: "selfcheck", description: "运行配置自检" },
];

export const OPERATOR_COMMANDS: BotCommand[] = [
  { command: "list", description: "List conversations" },
  { command: "info", description: "Conversation summary" },
  { command: "assign", description: "Assign operator" },
  { command: "note", description: "Save a note" },
  { command: "rename", description: "Rename topic" },
  { command: "delete", description: "Retract sent message" },
  { command: "hide", description: "Set hide policy" },
  { command: "restore", description: "Restore conversation" },
  { command: "help", description: "Show help" },
  { command: "lang", description: "Change language" },
];

export const OPERATOR_COMMANDS_ZH: BotCommand[] = [
  { command: "list", description: "列出会话" },
  { command: "info", description: "会话摘要" },
  { command: "assign", description: "指派客服" },
  { command: "note", description: "保存备注" },
  { command: "rename", description: "重命名话题" },
  { command: "delete", description: "撤回已发消息" },
  { command: "hide", description: "设置隐藏策略" },
  { command: "restore", description: "恢复会话" },
  { command: "help", description: "帮助" },
  { command: "lang", description: "切换语言" },
];

/**
 * Register the command menu, scope by scope and language by language.
 * `listOperators` supplies the current operator registry (role drives the
 * per-member menus), so calling this again after a role change re-syncs the
 * menus. The `default` scope clears the menu (empty list) in English only — an
 * empty menu is the same in every language, so a `zh` twin is redundant.
 */
export async function setCommandMenu(
  telegram: TelegramClient,
  config: Config,
  logger: Logger,
  listOperators: () => Promise<OperatorRecord[]>,
): Promise<void> {
  const register = async (scope: BotCommandScope, commands: BotCommand[], languageCode?: string): Promise<void> => {
    try {
      await telegram.setMyCommands({ commands, scope, languageCode });
    } catch (err) {
      logger.warn("command_menu_failed", { scope: scope.type });
    }
  };

  // Nothing anywhere by default — per-chat scopes below opt specific chats in.
  await register({ type: "default" }, []);
  // Every private chat: only /start (overridden for staff below).
  await register({ type: "all_private_chats" }, USER_COMMANDS);
  await register({ type: "all_private_chats" }, USER_COMMANDS_ZH, "zh");
  // Support group: operator menu for everyone here (staff workspace), with the
  // admin menu for the group's moderators via the more specific scope.
  await register({ type: "chat", chat_id: config.supportGroupId }, OPERATOR_COMMANDS);
  await register({ type: "chat", chat_id: config.supportGroupId }, OPERATOR_COMMANDS_ZH, "zh");
  await register({ type: "chat_administrators", chat_id: config.supportGroupId }, ADMIN_COMMANDS);
  await register({ type: "chat_administrators", chat_id: config.supportGroupId }, ADMIN_COMMANDS_ZH, "zh");

  let operators: OperatorRecord[] = [];
  try {
    operators = await listOperators();
  } catch (err) {
    logger.warn("command_menu_failed", { scope: "list" });
  }

  for (const op of operators) {
    const commands = op.role === "ADMIN" ? ADMIN_COMMANDS : OPERATOR_COMMANDS;
    const commandsZh = op.role === "ADMIN" ? ADMIN_COMMANDS_ZH : OPERATOR_COMMANDS_ZH;
    // Private chat with the bot: a `chat` scope keyed by the user id overrides
    // the /start-only all_private_chats default with the full role menu.
    await register({ type: "chat", chat_id: op.telegramUserId }, commands);
    await register({ type: "chat", chat_id: op.telegramUserId }, commandsZh, "zh");
    // In the group, refine the group-wide menu per member.
    const memberScope: BotCommandScope = {
      type: "chat_member",
      chat_id: config.supportGroupId,
      user_id: op.telegramUserId,
    };
    await register(memberScope, commands);
    await register(memberScope, commandsZh, "zh");
  }
}

export type UserMenuChoice = Language | "auto";

/**
 * Re-apply one user's menus after a `/lang` change.
 *
 * Telegram chooses which menu variant to show from the *client's* language, so
 * a stored `/lang` preference has no effect on the suggestion menu by itself.
 * A `chat` scope keyed by the user's id overrides `all_private_chats` (and,
 * for staff, the boot role menu) with the chosen language. The `zh`
 * language-twin is set to the *same* menu so a zh client-language user is
 * forced to the chosen language too instead of Telegram restoring the Chinese
 * twin. `/lang auto` restores the default EN + zh twin pair, handing the choice
 * back to the client language.
 */
export async function applyUserMenu(
  telegram: TelegramClient,
  config: Config,
  logger: Logger,
  listOperators: () => Promise<OperatorRecord[]>,
  telegramUserId: number,
  lang: UserMenuChoice,
): Promise<void> {
  const register = (scope: BotCommandScope, commands: BotCommand[], languageCode?: string): Promise<void> =>
    telegram.setMyCommands({ commands, scope, languageCode }).catch(() => logger.warn("command_menu_failed", { scope: scope.type }));

  let operators: OperatorRecord[] = [];
  try {
    operators = await listOperators();
  } catch {
    logger.warn("command_menu_failed", { scope: "list" });
  }
  const op = operators.find((o) => o.telegramUserId === telegramUserId);
  const en = op ? (op.role === "ADMIN" ? ADMIN_COMMANDS : OPERATOR_COMMANDS) : USER_COMMANDS;
  const zh = op ? (op.role === "ADMIN" ? ADMIN_COMMANDS_ZH : OPERATOR_COMMANDS_ZH) : USER_COMMANDS_ZH;
  const defaultCommands = lang === "zh" ? zh : en;
  const zhTwin = lang === "en" ? en : zh;

  await register({ type: "chat", chat_id: telegramUserId }, defaultCommands);
  await register({ type: "chat", chat_id: telegramUserId }, zhTwin, "zh");
  // Staff additionally get their role menu in the support group, refined per
  // member — carry the same language over so the hints match the preference.
  if (op) {
    const memberScope: BotCommandScope = {
      type: "chat_member",
      chat_id: config.supportGroupId,
      user_id: telegramUserId,
    };
    await register(memberScope, defaultCommands);
    await register(memberScope, zhTwin, "zh");
  }
}

/**
 * Re-apply the persisted `/lang` preferences after a boot (or menu refresh):
 * every user with an explicit override gets their private-chat menu (and, for
 * staff, their group refinement) set to their chosen language. Guards each
 * scope individually so a Telegram hiccup can't fail the rest.
 */
export async function syncPreferredLanguageMenus(
  db: Database,
  telegram: TelegramClient,
  config: Config,
  logger: Logger,
  listOperators: () => Promise<OperatorRecord[]>,
): Promise<void> {
  let users: UserRecord[] = [];
  try {
    users = await db.users.listPreferredLanguageUsers();
  } catch {
    logger.warn("command_menu_failed", { scope: "list" });
    return;
  }
  for (const user of users) {
    const lang = user.preferredLanguage === "zh" || user.preferredLanguage === "en" ? user.preferredLanguage : "auto";
    await applyUserMenu(telegram, config, logger, listOperators, user.telegramUserId, lang);
  }
}