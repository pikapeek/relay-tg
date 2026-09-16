// ---------------------------------------------------------------------------
// Domain records and shared value types. These are the persistence records
// used by the repository ports and the value types flowing through core.
// No runtime, storage, or Telegram knowledge lives here.
// ---------------------------------------------------------------------------

export type Direction = "USER_TO_OPERATOR" | "OPERATOR_TO_USER" | "SYSTEM";

export type SenderType = "USER" | "OPERATOR" | "SYSTEM";

export type OperatorRole = "ADMIN" | "OPERATOR";

export type ApplicationStatus = "pending" | "approved" | "rejected";

export interface UserRecord {
  id: string;
  /** Sole identity key. Username is display-only and never a key. */
  telegramUserId: number;
  username: string | null;
  firstName: string;
  lastName: string | null;
  languageCode: string | null;
  /** User-set language override (`en` | `zh`), null = follow auto-detection.
   *  Resolution is `preferredLanguage ?? languageCode`. */
  preferredLanguage: string | null;
  isBot: boolean;
  /** ISO timestamp set once the user passes the arithmetic verification. */
  verifiedAt: string | null;
  /** ISO timestamp set once an admin approves a `/apply` application. */
  approvedAt: string | null;
  /** The purpose of contact stated at first contact (来意), gate for opening
   *  the first conversation. Null = gate still pending. Persists across
   *  conversation deletion, so a returning user is never asked twice. */
  purpose: string | null;
  /** ISO timestamp the purpose was stated. */
  purposeAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Profile fields carried on inbound events, upserted on every contact. */
export interface UserProfile {
  telegramUserId: number;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  languageCode: string | null;
  isBot: boolean;
}

export function displayName(p: UserProfile): string {
  return p.firstName || p.username || String(p.telegramUserId);
}

export interface ConversationRecord {
  id: string;
  telegramUserId: number;
  /** Forum topic id in the support group; null until a topic is created. */
  telegramTopicId: number | null;
  /** Informational assignment only — never gates who may operate. */
  assignedOperatorId: string | null;
  /** Inactivity timer base; refreshed on every relayed message and restore. */
  lastActivityAt: string;
  /** ISO timestamp set when the conversation is auto-hidden. Null = visible. */
  hiddenAt: string | null;
  /** Per-conversation hide override: null = global default, 0 = never hide. */
  hideAfterHours: number | null;
  createdAt: string;
}

export interface MessageRecord {
  id: string;
  conversationId: string;
  /** Chat where the message was created (user private chat or support group). */
  telegramChatId: number;
  /** Message id where the message was created. */
  telegramMessageId: number;
  /** Topic the user-side message was relayed to (null for operator replies). */
  telegramTopicId: number | null;
  /** Id of the copy delivered on the other side. */
  relayedMessageId: number | null;
  direction: Direction;
  senderType: SenderType;
  contentType: string;
  replyToMessageId: number | null;
  createdAt: string;
}

export interface OperatorRecord {
  id: string;
  telegramUserId: number;
  role: OperatorRole;
  createdAt: string;
}

export interface ConversationNoteRecord {
  id: string;
  conversationId: string;
  operatorId: string;
  text: string;
  createdAt: string;
}

export interface BlockRecord {
  id: string;
  telegramUserId: number;
  createdByTelegramUserId: number;
  createdAt: string;
}

export interface ApplicationRecord {
  id: string;
  telegramUserId: number;
  status: ApplicationStatus;
  createdAt: string;
  decidedAt: string | null;
  decidedByTelegramUserId: number | null;
}

export interface ProcessedUpdateRecord {
  updateId: number;
  processedAt: string;
}

export interface SettingsRecord {
  key: string;
  value: string;
}

// ---------------------------------------------------------------------------
// Unified message content. Every MVP media type goes through this one shape so
// core never branches on a Telegram-specific payload.
// ---------------------------------------------------------------------------

export type MessageContent =
  | { type: "text"; text: string }
  | { type: "photo"; fileId: string; caption: string | null; fileSize: number | null }
  | { type: "video"; fileId: string; caption: string | null; fileSize: number | null }
  | { type: "document"; fileId: string; caption: string | null; fileSize: number | null }
  | { type: "audio"; fileId: string; caption: string | null; fileSize: number | null }
  | { type: "voice"; fileId: string; caption: string | null; fileSize: number | null }
  | { type: "sticker"; fileId: string; fileSize: number | null };

export function isTextContent(c: MessageContent): c is Extract<MessageContent, { type: "text" }> {
  return c.type === "text";
}

export function isMediaContent(c: MessageContent): c is Exclude<MessageContent, { type: "text" }> {
  return c.type !== "text";
}

/** The user-visible text a message carries: its body, or a media caption.
 *  `null` when neither exists (a sticker, or a caption-less media item). */
export function messageText(c: MessageContent): string | null {
  if (c.type === "text") return c.text;
  if (c.type !== "sticker" && c.caption != null) return c.caption;
  return null;
}

// ---------------------------------------------------------------------------
// Repository inputs (drafts) — the minimal data core hands to the storage
// adapters. Adapters convert these to rows.
// ---------------------------------------------------------------------------

export interface UserUpsertInput {
  telegramUserId: number;
  username: string | null;
  firstName: string | null;
  lastName: string | null;
  languageCode: string | null;
  isBot: boolean;
}

export interface ConversationCreateInput {
  telegramUserId: number;
  telegramTopicId: number | null;
  assignedOperatorId: string | null;
}

export interface MessageCreateInput {
  conversationId: string;
  telegramChatId: number;
  telegramMessageId: number;
  telegramTopicId: number | null;
  relayedMessageId: number | null;
  direction: Direction;
  senderType: SenderType;
  contentType: string;
  replyToMessageId: number | null;
}

export interface OperatorUpsertInput {
  telegramUserId: number;
  role: OperatorRole;
}

export interface NoteCreateInput {
  conversationId: string;
  operatorId: string;
  text: string;
}

export interface BlockCreateInput {
  telegramUserId: number;
  createdByTelegramUserId: number;
}

export interface ApplicationCreateInput {
  telegramUserId: number;
}

export interface ApplicationUpdateInput {
  status: ApplicationStatus;
  decidedAt: string;
  decidedByTelegramUserId: number;
}
