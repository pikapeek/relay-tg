// ---------------------------------------------------------------------------
// Core ports. Core depends only on these injected interfaces — never on Node,
// Cloudflare, a SQL driver, an HTTP framework, or the Telegram API. Both
// storage adapters and both runtimes compile against this single contract.
// ---------------------------------------------------------------------------

import type {
  ApplicationRecord,
  ApplicationStatus,
  ApplicationCreateInput,
  BlockCreateInput,
  BlockRecord,
  ConversationCreateInput,
  ConversationNoteRecord,
  ConversationRecord,
  Direction,
  MessageCreateInput,
  MessageRecord,
  NoteCreateInput,
  OperatorRecord,
  OperatorUpsertInput,
  UserRecord,
  UserUpsertInput,
  MessageContent,
} from "@relaytg/shared";
import type { BotCommand, BotCommandScope, InlineKeyboard } from "./telegram-types.ts";

// ---------------------------------------------------------------------------
// Runtime abstraction (D2 / runtime spec).
// ---------------------------------------------------------------------------

export interface Runtime {
  now(): Date;
  randomId(): string;
  /** Run `callback` once after `delayMs` (fire-and-forget; nothing cancels it).
   *  Backs the media-group aggregation window — both runtimes must deliver it
   *  even though the caller never awaits the result. */
  schedule(delayMs: number, callback: () => void): void;
}

// ---------------------------------------------------------------------------
// Repository ports (storage spec).
// ---------------------------------------------------------------------------

export interface UserUpsertResult {
  user: UserRecord;
  /** True when the row did not exist before this call. */
  created: boolean;
}

export interface UserRepository {
  getByTelegramUserId(telegramUserId: number): Promise<UserRecord | null>;
  /** Username lookup is for operator commands only — never an identity key. */
  getByUsername(username: string): Promise<UserRecord | null>;
  /** Create-or-refresh from an inbound profile; returns the stored row. */
  upsertProfile(input: UserUpsertInput, now: Date): Promise<UserUpsertResult>;
  /** Set/clear the user-set language override (`en` | `zh`, null = auto). */
  setPreferredLanguage(telegramUserId: number, language: string | null, now: Date): Promise<void>;
  /** Users with an explicit `/lang` override, for re-applying their menus at boot. */
  listPreferredLanguageUsers(): Promise<UserRecord[]>;
  setVerifiedAt(telegramUserId: number, at: Date): Promise<void>;
  setApprovedAt(telegramUserId: number, at: Date): Promise<void>;
  /** Persist the purpose stated at first contact; clears the purpose gate. */
  setPurpose(telegramUserId: number, purpose: string, at: Date): Promise<void>;
  /** Clear verified_at, approved_at, and the stored purpose — the "delete =
   *  re-verify + re-state purpose" reset. */
  resetAccess(telegramUserId: number): Promise<void>;
}

export interface ConversationRepository {
  getById(id: string): Promise<ConversationRecord | null>;
  getByTelegramUserId(telegramUserId: number): Promise<ConversationRecord | null>;
  getByTopicId(telegramTopicId: number): Promise<ConversationRecord | null>;
  create(input: ConversationCreateInput, now: Date): Promise<ConversationRecord>;
  updateTopicId(id: string, telegramTopicId: number): Promise<void>;
  setAssignedOperatorId(id: string, operatorId: string | null): Promise<void>;
  touchActivity(id: string, at: Date): Promise<void>;
  /** hiddenAt string is an ISO timestamp; null clears the hidden state. */
  setHidden(id: string, hiddenAt: string | null): Promise<void>;
  /** hideAfterHours null/0 = permanent display — only the global auto-hide cap
   *  (7 days) applies; N = a *sooner* custom hide threshold. */
  setHideAfterHours(id: string, hideAfterHours: number | null): Promise<void>;
  /** All conversations, for `/list` and the tap-to-delete picker. */
  list(): Promise<ConversationRecord[]>;
  /** Conversations due for the inactivity hide: idle past the global auto-hide
   *  hard cap (`autoHideHours`), OR beyond their custom `hide_after_hours`
   *  policy. null/0 policies are permanent, so only the cap applies. */
  listStaleHiddenCandidates(now: Date, autoHideHours: number): Promise<ConversationRecord[]>;
  delete(id: string): Promise<void>;
}

export interface MessageRepository {
  create(input: MessageCreateInput, now: Date): Promise<MessageRecord>;
  /** Source-keyed lookup `(chat_id, message_id)` — the idempotency backstop and edit/reply anchor. */
  getBySource(telegramChatId: number, telegramMessageId: number): Promise<MessageRecord | null>;
  /** Reply resolution: the copy id on one side → the record it was relayed from.
   *  `direction` scopes the lookup so a private-chat id and a topic id that
   *  happen to be numerically equal can never resolve to the wrong record. */
  getByConversationAndRelayedId(conversationId: string, relayedMessageId: number, direction: Direction): Promise<MessageRecord | null>;
  /** Most recent message of a conversation, for `/info`. */
  getLastByConversation(conversationId: string): Promise<MessageRecord | null>;
  deleteByConversationId(conversationId: string): Promise<void>;
  /** `relayed_message_id` of every `OPERATOR_TO_USER` copy delivered into the
   *  user's private chat — the copies `/delete` tries to remove on the user's
   *  side. Read before the cascade delete, then best-effort `deleteMessage`. */
  listUserChatCopyIds(conversationId: string): Promise<number[]>;
}

export interface OperatorRepository {
  getByTelegramUserId(telegramUserId: number): Promise<OperatorRecord | null>;
  upsert(input: OperatorUpsertInput, now: Date): Promise<OperatorRecord>;
  list(): Promise<OperatorRecord[]>;
}

export interface NoteRepository {
  create(input: NoteCreateInput, now: Date): Promise<ConversationNoteRecord>;
  listByConversation(conversationId: string): Promise<ConversationNoteRecord[]>;
  deleteByConversationId(conversationId: string): Promise<void>;
}

export interface BlockRepository {
  getByTelegramUserId(telegramUserId: number): Promise<BlockRecord | null>;
  create(input: BlockCreateInput, now: Date): Promise<BlockRecord>;
  deleteByTelegramUserId(telegramUserId: number): Promise<void>;
}

export interface ApplicationRepository {
  getById(id: string): Promise<ApplicationRecord | null>;
  getLatestByTelegramUserId(telegramUserId: number): Promise<ApplicationRecord | null>;
  create(input: ApplicationCreateInput, now: Date): Promise<ApplicationRecord>;
  update(input: {
    id: string;
    status: ApplicationStatus;
    decidedAt: Date;
    decidedByTelegramUserId: number;
  }): Promise<void>;
}

export interface ProcessedUpdatesRepository {
  /** Claim an update_id before processing; false when already claimed. */
  claim(updateId: number, now: Date): Promise<boolean>;
}

export interface SettingsRepository {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

/** Settings key holding the topic's first pinned opening card message id —
 *  the purpose+info card `recordPurposeAndOpen` pins at first contact. `/delete`
 *  refuses to remove it; only deleting the conversation clears it. */
export const TOPIC_PIN_KEY = (conversationId: string): string => `topic_pin:${conversationId}`;

export interface Database {
  /** Run a unit of work inside one storage transaction. `db` inside `fn` is the transactional view. */
  transaction<T>(fn: (db: Database) => Promise<T>): Promise<T>;
  users: UserRepository;
  conversations: ConversationRepository;
  messages: MessageRepository;
  operators: OperatorRepository;
  notes: NoteRepository;
  blocks: BlockRepository;
  applications: ApplicationRepository;
  processedUpdates: ProcessedUpdatesRepository;
  settings: SettingsRepository;
}

// ---------------------------------------------------------------------------
// Transient verification store (D14). Challenge state intentionally never hits
// the database — a runtime restart only loses in-flight challenges.
// ---------------------------------------------------------------------------

export interface VerificationState {
  challengeId: string;
  /** Human display form of the expression, e.g. "3 + 5 × 2 − 8 ÷ 4 + 6". */
  expression: string;
  answer: number;
  /** Four distinct integers, exactly one correct, in display order. */
  choices: number[];
  attemptsLeft: number;
  /** ISO timestamp; checked lazily, no background timer. */
  expiresAt: string;
  /** Message id of the question in the user's chat, for in-place re-asks. */
  questionMessageId: number | null;
}

export interface VerificationStore {
  get(telegramUserId: number): Promise<VerificationState | null>;
  set(telegramUserId: number, state: VerificationState): Promise<void>;
  delete(telegramUserId: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// TelegramClient port (D2 / telegram spec). Core calls outbound through this
// interface only; the adapter implements it over the Bot API.
// ---------------------------------------------------------------------------

export interface SendTarget {
  chatId: number;
  /** Forum topic id when sending into the support group. */
  messageThreadId?: number;
  /** Reply to a copy already present in the target chat. */
  replyToMessageId?: number;
}

/** Per-conversation serialization hook (task 7.5). Both runtimes provide one:
 * Docker uses an in-process keyed mutex; Cloudflare relies on the DO queue,
 * where a run is already strictly serial per instance. */
export interface Serializer {
  runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

export interface TelegramClient {
  sendMessage(target: SendTarget & { text: string; replyMarkup?: InlineKeyboard }): Promise<number>;
  sendPhoto(target: SendTarget & { fileId: string; caption?: string }): Promise<number>;
  sendVideo(target: SendTarget & { fileId: string; caption?: string }): Promise<number>;
  sendDocument(target: SendTarget & { fileId: string; caption?: string }): Promise<number>;
  sendAudio(target: SendTarget & { fileId: string; caption?: string }): Promise<number>;
  sendVoice(target: SendTarget & { fileId: string; caption?: string }): Promise<number>;
  sendSticker(target: SendTarget & { fileId: string }): Promise<number>;

  /** Edit an already-delivered copy in place. */
  editMessageText(p: { chatId: number; messageId: number; text: string; replyMarkup?: InlineKeyboard }): Promise<void>;
  editMessageCaption(p: { chatId: number; messageId: number; caption?: string; replyMarkup?: InlineKeyboard }): Promise<void>;

  /** Dispatch an outbound send by unified content type. */
  sendContent(target: SendTarget, content: MessageContent, replyMarkup?: InlineKeyboard): Promise<number>;

  /** Send an album (media group) into a chat/topic. Bot API allows 2–10 items
   *  and a caption on the FIRST item only; returns the new message ids in item
   *  order — the per-copy reply anchors for the topic. */
  sendMediaGroup(p: {
    chatId: number;
    messageThreadId?: number;
    items: Array<{ type: "photo" | "video" | "document" | "audio"; fileId: string; caption?: string }>;
  }): Promise<number[]>;

  /** Largest `file_id` of the user's current profile photo (reusable in this
   *  bot's own `sendPhoto` calls), or null when the user has no profile photo.
   *  Used to build the pinned personal info card at topic creation. */
  getUserProfilePhoto(p: { userId: number }): Promise<string | null>;

  /** The bot's own identity — the token-validity probe for the boot self-check. */
  getMe(): Promise<{ id: number; username: string; first_name: string }>;
  /** A chat's metadata; `is_forum` is present on supergroups and is the support
   *  group's forum check. */
  getChat(p: { chatId: number }): Promise<{ id: number; type: string; is_forum?: boolean; title?: string }>;
  /** A member's status in a chat ("administrator"/"creator" = the bot can post
   *  into topics). */
  getChatMember(p: { chatId: number; userId: number }): Promise<{ status: string }>;

  /** Relay a user's message verbatim into the support group as a forwarded
   *  copy. The forward keeps the original sender's name and avatar
   *  attribution, and returns the new message id (the reply anchor for the
   *  topic copy). */
  forwardMessage(p: {
    chatId: number;
    /** Target forum topic in the support group. */
    messageThreadId?: number;
    /** The private chat the user wrote in. */
    fromChatId: number;
    /** The user's original message id. */
    messageId: number;
  }): Promise<number>;

  /** Pin a message in a chat / forum topic (e.g. the user's personal info
   *  card, so it stays pinned at the top of their topic). */
  pinChatMessage(p: { chatId: number; messageId: number; messageThreadId?: number }): Promise<void>;

  /** Delete a message in a chat. Best-effort by design: the Bot API only lets
   *  a bot delete its own messages sent less than 48 h ago, so a rejection
   *  (message too old, already deleted) is a logged-and-dropped outcome, never
   *  an error the pipeline fails on. */
  deleteMessage(p: { chatId: number; messageId: number }): Promise<void>;

  createForumTopic(p: { chatId: number; name: string }): Promise<number>;
  /** Rename an existing forum topic (the `/rename` command). */
  editForumTopic(p: { chatId: number; messageThreadId: number; name: string }): Promise<void>;
  /** Close (and, where supported, hide) a topic. */
  hideForumTopic(p: { chatId: number; messageThreadId: number }): Promise<void>;
  /** Reopen a closed topic; never recreates it. */
  restoreForumTopic(p: { chatId: number; messageThreadId: number }): Promise<void>;
  deleteForumTopic(p: { chatId: number; messageThreadId: number }): Promise<void>;

  /** Acknowledge / answer a callback_query (also used for refusal toasts). */
  answerCallbackQuery(p: { callbackQueryId: string; text?: string; showAlert?: boolean }): Promise<void>;

  /**
   * Register the bot command menu for a scope (empty commands clears it).
   * `languageCode` sets the Bot API `language_code` so Telegram picks the
   * matching-language menu for each user (falling back to the unscoped one).
   */
  setMyCommands(p: { commands: BotCommand[]; scope?: BotCommandScope; languageCode?: string }): Promise<void>;
}
