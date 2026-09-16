// ---------------------------------------------------------------------------
// Bilingual copy (English + 简体中文). Messages are resolved per recipient:
// `resolveLanguage` maps a Telegram `language_code` (e.g. "zh-hans", "en") to
// the closest supported language, defaulting to English. TEXTS(lang) returns
// the user-facing texts; OPERATOR_TEXTS(lang) returns the staff-facing texts.
// Single source of truth so unit tests and the relay pipeline (task 7)
// reference the same strings the services actually send.
// ---------------------------------------------------------------------------

import type { SelfCheckProbe, SelfCheckReport } from "./selfcheck-service.ts";

export type Language = "en" | "zh";

export function resolveLanguage(languageCode: string | null | undefined): Language {
  return typeof languageCode === "string" && languageCode.toLowerCase().startsWith("zh") ? "zh" : "en";
}

/** Effective language for a stored user: an explicit `/lang` preference
 *  overrides the Telegram auto-detected `language_code`. */
export function languageOf(user: { languageCode: string | null; preferredLanguage: string | null }): Language {
  return resolveLanguage(user.preferredLanguage ?? user.languageCode);
}

// -- user-facing copy --------------------------------------------------------

interface UserTexts {
  verifyQuestion: (expression: string) => string;
  verifyCorrect: string;
  verifyExpired: string;

  /** First-contact purpose gate: a newly verified/approved user must state why
   *  they're contacting before any conversation or topic is created. */
  purposePrompt: string;

  // User help advertises /start only — /lang is not exposed to users.
  userHelp: string;

  // /lang — manual language switch (zh|en|auto overrides auto-detection).
  langUsage: string;
  langCurrent: (lang: Language) => string;
  langSet: string;
  langAuto: string;

  applySubmitted: string;
  applyPending: string;
  applyAlreadyApproved: string;
  applyAlreadyConnected: string;
  applyRejected: string;

  // Verification callback taps and toasts (delivered in the user's own chat).
  alreadyHandled: string;
  verifyBlocked: string;
  tooManyRequests: string;
  verifyWrong: string;
  outOfAttempts: string;
  challengeExpired: string;
  noActiveChallenge: string;
}

const EN_USER: UserTexts = {
  verifyQuestion: (expression) =>
    `To prove you're human, solve:\n\n${expression}\n\nTap one of the four answers below.`,

  verifyCorrect: "✅ Verified.",

  verifyExpired: "That challenge has expired. Send /start to get a new one.",

  purposePrompt: "Before I open your conversation, please briefly tell me what you're contacting about.",

  userHelp: "This is a support bot. Send /start to begin chatting with support.",

  langUsage: "Usage: /lang <en | zh | auto>\nSet the bot's language, or `auto` to follow your Telegram language.",
  langCurrent: (lang) => `Current language: ${lang === "zh" ? "简体中文" : "English"}.`,
  langSet: "Language set to English.",
  langAuto: "Language set to auto — using your Telegram language.",

  applySubmitted: "Application submitted. We'll review it and reply here shortly.",
  applyPending: "Your application is still being reviewed. Please wait.",
  applyAlreadyApproved:
    "You're already approved — just send a message and we'll get back to you.",
  applyAlreadyConnected:
    "You already have an open conversation. Send a message anytime.",
  applyRejected:
    "Your application was not approved this time. You can send /apply again later.",

  alreadyHandled: "Already handled.",
  verifyBlocked: "Blocked.",
  tooManyRequests: "Too many requests. Slow down.",
  verifyWrong: "Not quite — try again.",
  outOfAttempts: "Out of attempts.",
  challengeExpired: "Challenge expired.",
  noActiveChallenge: "No active challenge. Send /start.",
};

const ZH_USER: UserTexts = {

  verifyQuestion: (expression) =>
    `为了证明你不是机器人，请解答：\n\n${expression}\n\n点击下面四个答案之一。`,

  verifyCorrect: "✅ 验证通过。",

  verifyExpired: "该挑战已过期。发送 /start 获取新的挑战。",

  purposePrompt: "在开启会话前，请简要说明你本次联系的来意。",

  userHelp: "这是一个客服机器人。发送 /start 开始与客服沟通。",

  langUsage: "用法：/lang <en | zh | auto>\n设置机器人语言，或使用 auto 跟随你的 Telegram 语言。",
  langCurrent: (lang) => `当前语言：${lang === "zh" ? "简体中文" : "English"}。`,
  langSet: "语言已设为中文。",
  langAuto: "已设为自动——将跟随你的 Telegram 语言。",

  applySubmitted: "申请已提交，我们会在审核后于此回复你。",
  applyPending: "你的申请仍在审核中，请稍候。",
  applyAlreadyApproved: "你已通过审核——直接发消息即可，我们会回复你。",
  applyAlreadyConnected: "你已有进行中的会话，随时可以发消息。",
  applyRejected: "你的申请本次未通过。可以稍后再次发送 /apply。",

  alreadyHandled: "已处理。",
  verifyBlocked: "你已被屏蔽。",
  tooManyRequests: "请求过于频繁，请慢一点。",
  verifyWrong: "不对哦——再试一次。",
  outOfAttempts: "尝试次数已用完。",
  challengeExpired: "验证已过期。",
  noActiveChallenge: "没有进行中的验证。发送 /start。",
};

// -- staff-facing copy -------------------------------------------------------

export interface OperatorTexts {
  helpTopic: string;
  helpGeneral: string;
  outOfTopic: string;
  unknownTopic: string;
  unknownCommand: string;

  usageAssign: string;
  usageNote: string;
  usageRename: string;
  usageHide: string;
  usageRestore: string;

  // /lang — manual language switch (zh|en|auto overrides auto-detection).
  langUsage: string;
  langCurrent: (lang: Language) => string;
  langSet: string;
  langAuto: string;

  adminOnly: string;
  notOperator: string;
  /** `/delete` protects the requester's own conversation, the bot's, and staff threads. */
  deleteStaffRefused: string;

  // Reply-to /delete — retract. The Bot API never notifies a bot that a message
  // was deleted, so retracting an operator→user message has to be an explicit
  // command: reply to the topic message and send /delete. The topic message
  // stays (operators keep their archive); only the delivered copy in the user's
  // private chat is removed, best-effort (Bot API 48 h limit). Replying to a
  // *user* message cannot be retracted (the bot can only delete messages it
  // sent itself) and is silently ignored.
  delDone: string;
  delFailed: string;
  nothingToRetract: string;
  /** `/delete` refused on the first pinned purpose+info card (operator and admin). */
  pinCardProtected: string;

  assigned: (target: string) => string;
  noteSaved: string;
  topicRenamed: (name: string) => string;
  renameFailed: string;
  hideUpdated: (policy: string) => string;
  hidePolicyPermanent: string;
  hidePolicyHours: (hours: number) => string;

  userBlocked: string;
  userUnblocked: string;
  conversationDeleted: (name: string, username: string | null, userId: number, conversationId: string) => string;
  conversationRestored: string;
  unknownRestoreTarget: string;

  // Ad-text detection (广告防护): auto-block + group notification.
  adAutoBlocked: (name: string, username: string | null, userId: number, reason: string, excerpt: string) => string;
  adUsage: string;
  adAdded: (word: string) => string;
  adRemoved: (word: string) => string;
  adListHeader: (count: number) => string;
  adEmpty: string;
  // /ad allow — allowlist override (allow beats block).
  adAllowUsage: string;
  adAllowAdded: (word: string) => string;
  adAllowRemoved: (word: string) => string;
  adAllowListHeader: (count: number) => string;
  adAllowEmpty: string;
  // /ad links — link-count rule.
  adLinksUsage: string;
  adLinksCurrent: (count: number) => string;
  adLinksOff: string;
  adLinksSet: (value: string) => string;
  // /ad restore — quarantine recovery.
  adRestoreUsage: string;
  adRestoreNotFound: string;
  adRestoreDone: string;

  // /list and the tap-to-delete picker.
  listHeader: (count: number) => string;
  listEmpty: string;
  conversationLabel: (name: string, username: string | null, conversationId: string) => string;
  listItem: (index: number, label: string) => string;
  deletePickerHeader: (count: number) => string;
  deleteButtonLabel: (name: string, username: string | null) => string;
  deletedToast: (name: string, username: string | null, userId: number) => string;
  deleteGone: string;

  // /info summary labels.
  infoUser: (name: string, username: string | null) => string;
  infoId: (id: number) => string;
  infoPurpose: (purpose: string) => string;
  infoConversation: (id: string) => string;
  infoCreated: (at: string) => string;
  infoLastMessage: (text: string) => string;
  /** Header for the internal /note lines shown by /info (only when a
   *  conversation has at least one note). */
  infoNotes: string;
  none: string;
  infoAssigned: (target: string) => string;
  infoHidePolicy: (policy: string, hidden: boolean) => string;

  // /apply approval flow (posted/answered in the support group).
  onlyAdmins: string;
  applicationNotFound: string;
  approvedAsOperator: string;
  rejected: string;
  applyNotice: (name: string, userId: number, username: string | null) => string;
  approveButton: string;
  rejectButton: string;

  // /selfcheck config self-check report (admin only).
  selfcheckReport: (report: SelfCheckReport) => string;
}

/** One self-check line: ✅ ok · ⏭ skipped · ❌ failed. */
function probeLine(label: string, probe: SelfCheckProbe): string {
  const mark = probe.ok ? "✅" : probe.skipped ? "⏭" : "❌";
  return `${mark} ${label}: ${probe.detail}`;
}

const EN_OPERATOR: OperatorTexts = {
  helpTopic: [
    "In this topic:",
    "/info — conversation summary",
    "/assign <@user|id> — assign an operator",
    "/note <text> — internal note (private)",
    "/rename <name> — rename this topic",
    "/delete — reply to retract your message; no reply = delete (admin)",
    "/hide <hours|off|default> — hide policy (permanent by default)",
    "/ban · /unban — admin only",
    "",
    "Group level:",
    "/list — all conversations",
    "/restore <@user|id|conv> — restore",
    "/delete <@user|id|conv> — direct delete (admin)",
    "/ban · /unban <@user|id> — admin only",
    "/ad — ad keywords & rules (admin)",
    "/help — this help",
    "/lang <en|zh|auto> — language",
    "/selfcheck — config check (admin)",
  ].join("\n"),

  helpGeneral: [
    "Group level:",
    "/list — all conversations",
    "/restore <@user|id|conv> — restore",
    "/delete — picker, or <@user|id|conv> (admin)",
    "/ban · /unban <@user|id> — admin only",
    "/ad — ad keywords & rules (admin)",
    "/help — this help",
    "/lang <en|zh|auto> — language",
    "/selfcheck — config check (admin)",
    "",
    "In a topic:",
    "/info — conversation summary",
    "/assign <@user|id> — assign an operator",
    "/note <text> — internal note",
    "/rename <name> — rename this topic",
    "/hide <hours|off|default> — hide policy (permanent by default)",
    "/delete — reply to retract a sent message",
    "/ban · /unban — admin only",
  ].join("\n"),

  outOfTopic:
    "This command only works inside a conversation topic. Group-level: /list, /restore <@user|id|conversation>, /delete or /help.",
  unknownTopic: "No conversation is mapped to this topic.",
  unknownCommand: "Unknown command. Send /help for the list.",
  usageAssign: "Usage: /assign <@username | telegram_user_id>",
  usageNote: "Usage: /note <text>",
  usageRename: "Usage: /rename <new topic name>",
  usageHide: "Usage: /hide <hours | off | default>",
  usageRestore: "Usage: /restore <@username | telegram_user_id | conversation_id>",

  langUsage: "Usage: /lang <en | zh | auto>\nSet the bot's language, or `auto` to follow your Telegram language.",
  langCurrent: (lang) => `Current language: ${lang === "zh" ? "简体中文" : "English"}.`,
  langSet: "Language set to English.",
  langAuto: "Language set to auto — using your Telegram language.",

  adminOnly: "Admin only.",
  notOperator: "You are not registered as an operator.",
  deleteStaffRefused: "You can't delete your own conversation, a staff member's, or the bot's.",
  delDone: "Deleted.",
  delFailed: "Couldn't delete the user-side copy (older than 48 h or already gone).",
  nothingToRetract:
    "Nothing to retract here — reply to a message you sent to the user. Admins can send /delete without a reply to delete the whole conversation.",
  pinCardProtected:
    "The pinned opening card is permanent — it is only removed by deleting the conversation (admin).",
  assigned: (target) => `Conversation assigned to ${target}.`,
  noteSaved: "Note saved.",
  topicRenamed: (name) => `Topic renamed to "${name}".`,
  renameFailed: "Couldn't rename the topic.",
  hideUpdated: (policy) => `Hide policy set to ${policy}.`,
  hidePolicyPermanent: "permanent display (auto-hides after 7 days idle)",
  hidePolicyHours: (hours) => `${hours}h`,
  userBlocked: "User blocked.",
  userUnblocked: "User unblocked.",
  conversationDeleted: (name, username, userId, conversationId) =>
    `Deleted conversation ${conversationId} — ${name}${username ? ` (@${username})` : ""} (id ${userId}).`,
  conversationRestored: "Conversation restored.",
  unknownRestoreTarget: "Unknown target conversation.",

  adAutoBlocked: (name, username, userId, reason, excerpt) =>
    [
      "🚫 Ad detected — user blocked",
      `User: ${name}${username ? ` (@${username})` : ""} (id ${userId})`,
      `Matched: ${reason}`,
      `Message: ${excerpt}`,
      `False positive? Reply to the forwarded copy with /ad restore to resend it.`,
      `Unblock: /unban ${userId}`,
    ].join("\n"),
  adUsage: "Usage: /ad <list|add|del|allow|links|restore>",
  adAdded: (word) => `Ad keyword added: ${word}`,
  adRemoved: (word) => `Ad keyword deleted: ${word}`,
  adListHeader: (count) => `Ad keywords (${count}):`,
  adEmpty: "No ad keywords configured.",
  adAllowUsage: "Usage: /ad allow <list|add|del> <word>",
  adAllowAdded: (word) => `Allow keyword added: ${word}`,
  adAllowRemoved: (word) => `Allow keyword deleted: ${word}`,
  adAllowListHeader: (count) => `Allow keywords (${count}):`,
  adAllowEmpty: "No allow keywords configured.",
  adLinksUsage: "Usage: /ad links <n | off>",
  adLinksCurrent: (count) => `Link rule: reject messages with ${count}+ links.`,
  adLinksOff: "Link rule off.",
  adLinksSet: (value) => `Link rule set to ${value}.`,
  adRestoreUsage: "Usage: reply to a quarantined message with /ad restore to forward it to the user's topic.",
  adRestoreNotFound: "That message isn't a quarantined ad (or was already restored).",
  adRestoreDone: "Message restored to the user's topic. Unblock separately with /unban if needed.",

  listHeader: (count) => `Conversations (${count}):`,
  listEmpty: "No conversations yet.",
  conversationLabel: (name, username, conversationId) => `👤 ${name}${username ? ` (@${username})` : ""} — ${conversationId}`,
  listItem: (index, label) => `${index}. ${label}`,
  deletePickerHeader: (count) => `Tap a user to delete their conversation and topic (${count}):`,
  deleteButtonLabel: (name, username) => `🗑 ${name}${username ? ` (@${username})` : ""}`,
  deletedToast: (name, username, userId) =>
    `Deleted ${name}${username ? ` (@${username})` : ""} (id ${userId}).`,
  deleteGone: "Already deleted.",

  infoUser: (name, username) => `User: ${name}${username ? ` (@${username})` : ""}`,
  infoId: (id) => `ID: ${id}`,
  infoPurpose: (purpose) => `Purpose: ${purpose}`,
  infoConversation: (id) => `Conversation: ${id}`,
  infoCreated: (at) => `Created: ${at}`,
  infoLastMessage: (text) => `Last message: ${text}`,
  infoNotes: "Notes:",
  none: "none",
  infoAssigned: (target) => `Assigned operator: ${target}`,
  infoHidePolicy: (policy, hidden) => `Hide policy: ${policy}${hidden ? " (hidden)" : ""}`,

  onlyAdmins: "Only admins can decide applications.",
  applicationNotFound: "Application not found.",
  approvedAsOperator: "Approved as operator.",
  rejected: "Rejected.",
  applyNotice: (name, userId, username) =>
    [
      "New support application",
      "",
      `Name: ${name}`,
      `ID: ${userId}`,
      username ? `@${username}` : "",
      "",
      "Approve to add as an operator, or reject.",
    ]
      .filter((line) => line !== "")
      .join("\n"),
  approveButton: "Approve",
  rejectButton: "Reject",

  selfcheckReport: (report) => [
    "🔍 Self-check",
    probeLine("Token", report.bot),
    probeLine("Support group", report.group),
    probeLine("Admin rights", report.admin),
  ].join("\n"),
};

const ZH_OPERATOR: OperatorTexts = {
  helpTopic: [
    "本话题内：",
    "/info — 会话摘要",
    "/assign <@用户名|ID> — 指派客服",
    "/note <文本> — 内部备注（不会发给用户）",
    "/rename <新名> — 重命名话题",
    "/delete — 回复撤回你发的消息；无回复=删除（仅管理员）",
    "/hide <小时|off|default> — 隐藏策略（默认永久显示）",
    "/ban · /unban — 仅管理员",
    "",
    "群组级：",
    "/list — 列出会话",
    "/restore <@用户名|ID|会话> — 恢复",
    "/delete <@用户名|ID|会话> — 直接删除（仅管理员）",
    "/ban · /unban <@用户|ID> — 仅管理员",
    "/ad — 广告词与规则（仅管理员）",
    "/help — 本帮助",
    "/lang <en|zh|auto> — 语言",
    "/selfcheck — 配置自检（仅管理员）",
  ].join("\n"),

  helpGeneral: [
    "群组级：",
    "/list — 列出会话",
    "/restore <@用户名|ID|会话> — 恢复",
    "/delete — 点击列表，或 <@用户名|ID|会话>（仅管理员）",
    "/ban · /unban <@用户|ID> — 仅管理员",
    "/ad — 广告词与规则（仅管理员）",
    "/help — 本帮助",
    "/lang <en|zh|auto> — 语言",
    "/selfcheck — 配置自检（仅管理员）",
    "",
    "话题内：",
    "/info — 会话摘要",
    "/assign <@用户名|ID> — 指派客服",
    "/note <文本> — 内部备注",
    "/rename <新名> — 重命名话题",
    "/hide <小时|off|default> — 隐藏策略（默认永久显示）",
    "/delete — 回复撤回已发消息",
    "/ban · /unban — 仅管理员",
  ].join("\n"),

  outOfTopic: "该命令只能在会话话题内使用。群组级：/list、/restore <@用户|id|会话>、/delete 或 /help。",
  unknownTopic: "该话题没有对应的会话。",
  unknownCommand: "未知命令。发送 /help 查看命令列表。",
  usageAssign: "用法：/assign <@用户名 | 用户ID>",
  usageNote: "用法：/note <文本>",
  usageRename: "用法：/rename <新话题名>",
  usageHide: "用法：/hide <小时 | off | default>",
  usageRestore: "用法：/restore <@用户名 | 用户ID | 会话ID>",

  langUsage: "用法：/lang <en | zh | auto>\n设置机器人语言，或使用 auto 跟随你的 Telegram 语言。",
  langCurrent: (lang) => `当前语言：${lang === "zh" ? "简体中文" : "English"}。`,
  langSet: "语言已设为中文。",
  langAuto: "已设为自动——将跟随你的 Telegram 语言。",

  adminOnly: "仅管理员可用。",
  notOperator: "你不是已注册的客服。",
  deleteStaffRefused: "不能删除自己、客服或机器人的会话。",
  delDone: "删除成功",
  delFailed: "用户侧副本删除失败（可能超过 48 小时或已被删除）。",
  nothingToRetract:
    "此处没有可撤回的内容——请回复你发给用户的消息。管理员不带回复发送 /delete 可删除整个会话。",
  pinCardProtected: "置顶的开场信息卡为永久内容——只有删除整个会话（管理员）才能移除。",
  assigned: (target) => `会话已分配给 ${target}。`,
  noteSaved: "备注已保存。",
  topicRenamed: (name) => `话题已改名为「${name}」。`,
  renameFailed: "话题改名失败。",
  hideUpdated: (policy) => `隐藏策略已设置为 ${policy}。`,
  hidePolicyPermanent: "永久显示（7天无回复自动隐藏）",
  hidePolicyHours: (hours) => `${hours}小时`,
  userBlocked: "用户已屏蔽。",
  userUnblocked: "用户已解除屏蔽。",
  conversationDeleted: (name, username, userId, conversationId) =>
    `已删除会话 ${conversationId} — ${name}${username ? `（@${username}）` : ""}（ID ${userId}）。`,
  conversationRestored: "会话已恢复。",
  unknownRestoreTarget: "未找到目标会话。",

  adAutoBlocked: (name, username, userId, reason, excerpt) =>
    [
      "🚫 检测到广告——已屏蔽该用户",
      `用户：${name}${username ? `（@${username}）` : ""}（ID ${userId}）`,
      `命中：${reason}`,
      `消息：${excerpt}`,
      `误判？回复上面的转发消息发 /ad restore 即可恢复。`,
      `解封：/unban ${userId}`,
    ].join("\n"),
  adUsage: "用法：/ad <list|add|del|allow|links|restore>",
  adAdded: (word) => `已添加广告词：${word}`,
  adRemoved: (word) => `已删除广告词：${word}`,
  adListHeader: (count) => `广告词（${count}）：`,
  adEmpty: "尚未配置广告词。",
  adAllowUsage: "用法：/ad allow <list|add|del> <词>",
  adAllowAdded: (word) => `已添加白名单词：${word}`,
  adAllowRemoved: (word) => `已删除白名单词：${word}`,
  adAllowListHeader: (count) => `白名单词（${count}）：`,
  adAllowEmpty: "尚未配置白名单词。",
  adLinksUsage: "用法：/ad links <数量|off>",
  adLinksCurrent: (count) => `链接规则：含 ${count} 个及以上链接的消息将被拦截。`,
  adLinksOff: "链接规则已关闭。",
  adLinksSet: (value) => `链接规则已设为 ${value}。`,
  adRestoreUsage: "用法：回复隔离话题里的消息发送 /ad restore，将其转发到用户的话题。",
  adRestoreNotFound: "该消息不是被隔离的广告（或已被恢复）。",
  adRestoreDone: "消息已恢复到用户的话题。如需解封请另行 /unban。",

  listHeader: (count) => `会话列表（${count}）：`,
  listEmpty: "暂无会话。",
  conversationLabel: (name, username, conversationId) => `👤 ${name}${username ? `（@${username}）` : ""} — ${conversationId}`,
  listItem: (index, label) => `${index}. ${label}`,
  deletePickerHeader: (count) => `点击用户即可删除其会话与话题（共 ${count} 个）：`,
  deleteButtonLabel: (name, username) => `🗑 ${name}${username ? `（@${username}）` : ""}`,
  deletedToast: (name, username, userId) =>
    `已删除 ${name}${username ? `（@${username}）` : ""}（ID ${userId}）。`,
  deleteGone: "已删除。",

  infoUser: (name, username) => `用户：${name}${username ? `（@${username}）` : ""}`,
  infoId: (id) => `ID：${id}`,
  infoPurpose: (purpose) => `来意：${purpose}`,
  infoConversation: (id) => `会话：${id}`,
  infoCreated: (at) => `创建时间：${at}`,
  infoLastMessage: (text) => `最后一条消息：${text}`,
  infoNotes: "备注：",
  none: "无",
  infoAssigned: (target) => `负责客服：${target}`,
  infoHidePolicy: (policy, hidden) => `隐藏策略：${policy}${hidden ? "（已隐藏）" : ""}`,

  onlyAdmins: "只有管理员才能处理申请。",
  applicationNotFound: "未找到该申请。",
  approvedAsOperator: "已批准为客服。",
  rejected: "已拒绝。",
  applyNotice: (name, userId, username) =>
    [
      "新的客服申请",
      "",
      `姓名：${name}`,
      `ID：${userId}`,
      username ? `@${username}` : "",
      "",
      "批准后将成为客服，或拒绝。",
    ]
      .filter((line) => line !== "")
      .join("\n"),
  approveButton: "批准",
  rejectButton: "拒绝",

  selfcheckReport: (report) => [
    "🔍 开机自检",
    probeLine("Token", report.bot),
    probeLine("支持群", report.group),
    probeLine("管理员权限", report.admin),
  ].join("\n"),
};

export const TEXTS = (lang: Language): UserTexts => (lang === "zh" ? ZH_USER : EN_USER);

export const OPERATOR_TEXTS = (lang: Language): OperatorTexts =>
  lang === "zh" ? ZH_OPERATOR : EN_OPERATOR;