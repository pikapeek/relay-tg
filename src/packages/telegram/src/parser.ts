// ---------------------------------------------------------------------------
// Update parser: raw Telegram Update JSON -> internal event. The parser is
// config-free: private-chat messages become user events, non-private chat
// messages become operator events (core rejects anything outside the support
// group), and callback_query becomes a verification-answer or application-
// decision event. Bot senders and unsupported content are ignored here.
// ---------------------------------------------------------------------------

import type {
  ApplicationDecisionEvent,
  ConversationDeleteEvent,
  EditedOperatorMessageEvent,
  EditedUserMessageEvent,
  InboundEvent,
  MessageContent,
  OperatorMessageEvent,
  UserMessageEvent,
  UserProfile,
  VerificationAnswerEvent,
} from "@relaytg/shared";

interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

interface TgChat {
  id: number;
  type: string;
}

interface TgMedia {
  file_id?: string;
  file_size?: number;
}

interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  text?: string;
  caption?: string;
  message_thread_id?: number;
  reply_to_message?: { message_id: number };
  media_group_id?: string;
  photo?: TgMedia[];
  video?: TgMedia;
  document?: TgMedia;
  audio?: TgMedia;
  voice?: TgMedia;
  sticker?: TgMedia;
}

interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: { message_id: number; chat: TgChat };
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface ParsedUpdate {
  updateId: number;
  event: InboundEvent;
}

export function parseUpdate(update: TgUpdate): ParsedUpdate {
  if (update.message) return { updateId: update.update_id, event: parseMessageEvent(update.message) };
  if (update.edited_message) return { updateId: update.update_id, event: parseEditedMessageEvent(update.edited_message) };
  if (update.callback_query) return { updateId: update.update_id, event: parseCallbackQueryEvent(update.callback_query) };
  return { updateId: update.update_id, event: { kind: "ignored", reason: "not a message or callback update" } };
}

function parseMessageEvent(m: TgMessage): InboundEvent {
  if (!m.from || m.from.is_bot) return { kind: "ignored", reason: "bot sender" };
  const content = extractContent(m);
  if (!content) return { kind: "ignored", reason: "unsupported content type" };
  const sender = extractProfile(m.from);
  const replyToMessageId = m.reply_to_message?.message_id ?? null;

  if (m.chat.type === "private") {
    const event: UserMessageEvent = {
      kind: "user_message",
      chatId: m.chat.id,
      messageId: m.message_id,
      sender,
      content,
      replyToMessageId,
      mediaGroupId: m.media_group_id ?? null,
    };
    return event;
  }

  const event: OperatorMessageEvent = {
    kind: "operator_message",
    chatId: m.chat.id,
    messageId: m.message_id,
    messageThreadId: m.message_thread_id ?? null,
    sender,
    content,
    replyToMessageId,
  };
  return event;
}

function parseEditedMessageEvent(m: TgMessage): InboundEvent {
  if (!m.from || m.from.is_bot) return { kind: "ignored", reason: "bot sender" };
  const content = extractContent(m);
  if (!content) return { kind: "ignored", reason: "unsupported content type" };
  const sender = extractProfile(m.from);

  if (m.chat.type === "private") {
    const event: EditedUserMessageEvent = {
      kind: "edited_user_message",
      chatId: m.chat.id,
      messageId: m.message_id,
      sender,
      content,
    };
    return event;
  }

  const event: EditedOperatorMessageEvent = {
    kind: "edited_operator_message",
    chatId: m.chat.id,
    messageId: m.message_id,
    messageThreadId: m.message_thread_id ?? null,
    sender,
    content,
  };
  return event;
}

function parseCallbackQueryEvent(cq: TgCallbackQuery): InboundEvent {
  if (!cq.from || cq.from.is_bot) return { kind: "ignored", reason: "bot sender" };
  const sender = extractProfile(cq.from);
  const chatId = cq.message?.chat.id;
  const messageId = cq.message?.message_id;
  const data = cq.data ?? "";

  const verifyMatch = /^verify:(-?\d+)$/.exec(data);
  if (verifyMatch) {
    // Strict match: `Number()` would coerce "0x10"→16, "1e2"→100 and ""→0, so a
    // malformed/truncated payload must not be consumed as a wrong-but-valid tap.
    const answer = Number(verifyMatch[1]);
    if (chatId === undefined || messageId === undefined) return { kind: "ignored", reason: "callback without message" };
    const event: VerificationAnswerEvent = {
      kind: "verification_answer",
      callbackQueryId: cq.id,
      chatId,
      messageId,
      sender,
      answer,
    };
    return event;
  }

  const applyMatch = /^apply:(approve|reject):(.+)$/.exec(data);
  if (applyMatch) {
    if (chatId === undefined || messageId === undefined) return { kind: "ignored", reason: "callback without message" };
    const event: ApplicationDecisionEvent = {
      kind: "application_decision",
      callbackQueryId: cq.id,
      chatId,
      messageId,
      sender,
      decision: applyMatch[1] as "approve" | "reject",
      applicationId: applyMatch[2] ?? "",
    };
    return event;
  }

  const deleteMatch = /^del:(.+)$/.exec(data);
  if (deleteMatch) {
    if (chatId === undefined || messageId === undefined) return { kind: "ignored", reason: "callback without message" };
    const event: ConversationDeleteEvent = {
      kind: "conversation_delete",
      callbackQueryId: cq.id,
      chatId,
      messageId,
      sender,
      conversationId: deleteMatch[1] ?? "",
    };
    return event;
  }

  return { kind: "ignored", reason: "unknown callback data" };
}

function extractProfile(u: TgUser): UserProfile {
  return {
    telegramUserId: u.id,
    username: u.username ?? null,
    firstName: u.first_name ?? null,
    lastName: u.last_name ?? null,
    languageCode: u.language_code ?? null,
    isBot: u.is_bot ?? false,
  };
}

/** Unified content extraction for the MVP content set; null for anything else. */
function extractContent(m: TgMessage): MessageContent | null {
  if (m.text !== undefined) return { type: "text", text: m.text };
  if (m.photo && m.photo.length > 0) {
    const largest = m.photo[m.photo.length - 1];
    if (largest?.file_id) {
      return { type: "photo", fileId: largest.file_id, caption: m.caption ?? null, fileSize: largest.file_size ?? null };
    }
  }
  if (m.video?.file_id) return { type: "video", fileId: m.video.file_id, caption: m.caption ?? null, fileSize: m.video.file_size ?? null };
  if (m.document?.file_id) return { type: "document", fileId: m.document.file_id, caption: m.caption ?? null, fileSize: m.document.file_size ?? null };
  if (m.audio?.file_id) return { type: "audio", fileId: m.audio.file_id, caption: m.caption ?? null, fileSize: m.audio.file_size ?? null };
  if (m.voice?.file_id) return { type: "voice", fileId: m.voice.file_id, caption: m.caption ?? null, fileSize: m.voice.file_size ?? null };
  if (m.sticker?.file_id) return { type: "sticker", fileId: m.sticker.file_id, fileSize: m.sticker.file_size ?? null };
  return null;
}
