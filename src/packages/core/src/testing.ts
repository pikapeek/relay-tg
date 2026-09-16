// ---------------------------------------------------------------------------
// In-memory fakes for the core ports. These are the test doubles for the
// service and pipeline unit tests and for both integration suites (task 13).
// They mirror the storage spec's repository behavior so the real adapters in
// task 10 are tested against the same expectations.
//
// The fake TelegramClient also simulates realistic topic behavior: sending
// into a missing thread throws `topic_not_found`, into a closed thread throws
// `topic_closed`, and hide/restore/delete on a missing thread throw too.
// ---------------------------------------------------------------------------

import {
  type ApplicationRecord,
  type BlockRecord,
  type ConversationNoteRecord,
  type ConversationRecord,
  type Direction,
  type MessageRecord,
  type OperatorRecord,
  type TelegramErrorKind,
  type UserRecord,
  type UserUpsertInput,
  type MessageContent,
  type OperatorUpsertInput,
  type NoteCreateInput,
  type BlockCreateInput,
  type ApplicationCreateInput,
  type ConversationCreateInput,
  type MessageCreateInput,
  TelegramError,
} from "@relaytg/shared";
import {
  type ApplicationRepository,
  type BlockRepository,
  type ConversationRepository,
  type Database,
  type MessageRepository,
  type NoteRepository,
  type OperatorRepository,
  type ProcessedUpdatesRepository,
  type Runtime,
  type SendTarget,
  type SettingsRepository,
  type TelegramClient,
  type UserRepository,
  type UserUpsertResult,
} from "./ports.ts";
import type { BotCommand, BotCommandScope, InlineKeyboard } from "./telegram-types.ts";
import type { Logger, LogEvent, LogFields } from "@relaytg/shared";

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export class FakeRuntime implements Runtime {
  private timeMs: number;
  private idCounter = 0;
  private timers: Array<{ at: number; callback: () => void; seq: number }> = [];
  private timerSeq = 0;

  constructor(initialMs = 1_700_000_000_000) {
    this.timeMs = initialMs;
  }

  now(): Date {
    return new Date(this.timeMs);
  }

  randomId(): string {
    this.idCounter += 1;
    return `fake-${this.idCounter}`;
  }

  schedule(delayMs: number, callback: () => void): void {
    this.timers.push({ at: this.timeMs + delayMs, callback, seq: ++this.timerSeq });
    this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
  }

  advance(ms: number): void {
    this.timeMs += ms;
    this.fireDueTimers();
  }

  set(ms: number): void {
    this.timeMs = ms;
    this.fireDueTimers();
  }

  /** Fire every timer due at or before now, in order. One-shot: fired timers
   *  are removed. Callbacks may schedule new timers mid-fire, so keep draining
   *  until none are due (a callback scheduling a future timer never re-fires
   *  within this window — its `at` lands past the advanced clock). */
  private fireDueTimers(): void {
    for (;;) {
      const due = this.timers.filter((t) => t.at <= this.timeMs);
      if (due.length === 0) return;
      this.timers = this.timers.filter((t) => t.at > this.timeMs);
      for (const t of due) t.callback();
    }
  }
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export class CaptureLogger implements Logger {
  lines: Array<{ level: string; event: LogEvent; fields?: LogFields }> = [];

  debug(event: LogEvent, fields?: LogFields): void {
    this.lines.push({ level: "debug", event, fields });
  }
  info(event: LogEvent, fields?: LogFields): void {
    this.lines.push({ level: "info", event, fields });
  }
  warn(event: LogEvent, fields?: LogFields): void {
    this.lines.push({ level: "warn", event, fields });
  }
  error(event: LogEvent, fields?: LogFields): void {
    this.lines.push({ level: "error", event, fields });
  }

  has(event: LogEvent): boolean {
    return this.lines.some((l) => l.event === event);
  }
}

// ---------------------------------------------------------------------------
// Repository fakes (one in-memory "table" each)
// ---------------------------------------------------------------------------

class MemoryUsers implements UserRepository {
  rows = new Map<number, UserRecord>();
  private seq = 0;

  async getByTelegramUserId(id: number): Promise<UserRecord | null> {
    return this.rows.get(id) ?? null;
  }

  async getByUsername(username: string): Promise<UserRecord | null> {
    for (const row of this.rows.values()) if (row.username === username) return row;
    return null;
  }

  async upsertProfile(input: UserUpsertInput, now: Date): Promise<UserUpsertResult> {
    const iso = now.toISOString();
    const existing = this.rows.get(input.telegramUserId);
    if (existing) {
      const updated: UserRecord = {
        ...existing,
        username: input.username,
        firstName: input.firstName ?? input.username ?? String(input.telegramUserId),
        lastName: input.lastName,
        languageCode: input.languageCode,
        isBot: input.isBot,
        updatedAt: iso,
      };
      this.rows.set(input.telegramUserId, updated);
      return { user: updated, created: false };
    }
    const created: UserRecord = {
      id: `u-${++this.seq}`,
      telegramUserId: input.telegramUserId,
      username: input.username,
      firstName: input.firstName ?? input.username ?? String(input.telegramUserId),
      lastName: input.lastName,
      languageCode: input.languageCode,
      preferredLanguage: null,
      isBot: input.isBot,
      verifiedAt: null,
      approvedAt: null,
      purpose: null,
      purposeAt: null,
      createdAt: iso,
      updatedAt: iso,
    };
    this.rows.set(input.telegramUserId, created);
    return { user: created, created: true };
  }

  async setPreferredLanguage(telegramUserId: number, language: string | null, now: Date): Promise<void> {
    const row = this.rows.get(telegramUserId);
    if (row) {
      row.preferredLanguage = language;
      row.updatedAt = now.toISOString();
    }
  }

  async listPreferredLanguageUsers(): Promise<UserRecord[]> {
    return [...this.rows.values()].filter((u) => u.preferredLanguage != null);
  }

  async setVerifiedAt(id: number, at: Date): Promise<void> {
    const row = this.rows.get(id);
    if (row) {
      row.verifiedAt = at.toISOString();
      row.updatedAt = at.toISOString();
    }
  }

  async setApprovedAt(id: number, at: Date): Promise<void> {
    const row = this.rows.get(id);
    if (row) {
      row.approvedAt = at.toISOString();
      row.updatedAt = at.toISOString();
    }
  }

  async setPurpose(id: number, purpose: string, at: Date): Promise<void> {
    const row = this.rows.get(id);
    if (row) {
      row.purpose = purpose;
      row.purposeAt = at.toISOString();
      row.updatedAt = at.toISOString();
    }
  }

  async resetAccess(id: number): Promise<void> {
    const row = this.rows.get(id);
    if (row) {
      row.verifiedAt = null;
      row.approvedAt = null;
      // Clearing the purpose re-engages the purpose gate: the next conversation
      // opens with a freshly stated purpose on its single pinned purpose+info card.
      row.purpose = null;
      row.purposeAt = null;
      row.updatedAt = new Date().toISOString();
    }
  }
}

class MemoryConversations implements ConversationRepository {
  rows = new Map<string, ConversationRecord>();
  private byUser = new Map<number, string>();
  private byTopic = new Map<number, string>();
  private seq = 0;

  async getById(id: string): Promise<ConversationRecord | null> {
    return this.rows.get(id) ?? null;
  }

  async getByTelegramUserId(telegramUserId: number): Promise<ConversationRecord | null> {
    const id = this.byUser.get(telegramUserId);
    return id ? (this.rows.get(id) ?? null) : null;
  }

  async getByTopicId(telegramTopicId: number): Promise<ConversationRecord | null> {
    const id = this.byTopic.get(telegramTopicId);
    return id ? (this.rows.get(id) ?? null) : null;
  }

  async create(input: ConversationCreateInput, now: Date): Promise<ConversationRecord> {
    const row: ConversationRecord = {
      id: `c-${++this.seq}`,
      telegramUserId: input.telegramUserId,
      telegramTopicId: input.telegramTopicId,
      assignedOperatorId: input.assignedOperatorId,
      lastActivityAt: now.toISOString(),
      hiddenAt: null,
      hideAfterHours: null,
      createdAt: now.toISOString(),
    };
    this.rows.set(row.id, row);
    this.byUser.set(row.telegramUserId, row.id);
    if (row.telegramTopicId != null) this.byTopic.set(row.telegramTopicId, row.id);
    return row;
  }

  async updateTopicId(id: string, telegramTopicId: number): Promise<void> {
    const row = this.rows.get(id);
    if (!row) return;
    if (row.telegramTopicId != null) this.byTopic.delete(row.telegramTopicId);
    row.telegramTopicId = telegramTopicId;
    this.byTopic.set(telegramTopicId, id);
  }

  async setAssignedOperatorId(id: string, operatorId: string | null): Promise<void> {
    const row = this.rows.get(id);
    if (row) row.assignedOperatorId = operatorId;
  }

  async touchActivity(id: string, at: Date): Promise<void> {
    const row = this.rows.get(id);
    if (row) row.lastActivityAt = at.toISOString();
  }

  async setHidden(id: string, hiddenAt: string | null): Promise<void> {
    const row = this.rows.get(id);
    if (row) row.hiddenAt = hiddenAt;
  }

  async setHideAfterHours(id: string, hideAfterHours: number | null): Promise<void> {
    const row = this.rows.get(id);
    if (row) row.hideAfterHours = hideAfterHours;
  }

  async list(): Promise<ConversationRecord[]> {
    return [...this.rows.values()];
  }

  async listStaleHiddenCandidates(now: Date, autoHideHours: number): Promise<ConversationRecord[]> {
    const out: ConversationRecord[] = [];
    for (const row of this.rows.values()) {
      if (row.hiddenAt != null) continue; // already hidden
      if (row.telegramTopicId == null) continue;
      const last = new Date(row.lastActivityAt).getTime();
      const nowMs = now.getTime();
      const staleByHardCap = last < nowMs - autoHideHours * 3_600_000;
      const custom = row.hideAfterHours;
      const staleByPolicy = custom != null && custom > 0 && last < nowMs - custom * 3_600_000;
      if (staleByHardCap || staleByPolicy) out.push(row);
    }
    return out;
  }

  async delete(id: string): Promise<void> {
    const row = this.rows.get(id);
    if (!row) return;
    this.rows.delete(id);
    this.byUser.delete(row.telegramUserId);
    if (row.telegramTopicId != null) this.byTopic.delete(row.telegramTopicId);
  }
}

class MemoryMessages implements MessageRepository {
  rows = new Map<string, MessageRecord>();
  private bySource = new Map<string, string>();
  private seq = 0;

  async create(input: MessageCreateInput, now: Date): Promise<MessageRecord> {
    const row: MessageRecord = {
      id: `m-${++this.seq}`,
      conversationId: input.conversationId,
      telegramChatId: input.telegramChatId,
      telegramMessageId: input.telegramMessageId,
      telegramTopicId: input.telegramTopicId,
      relayedMessageId: input.relayedMessageId,
      direction: input.direction,
      senderType: input.senderType,
      contentType: input.contentType,
      replyToMessageId: input.replyToMessageId,
      createdAt: now.toISOString(),
    };
    this.rows.set(row.id, row);
    this.bySource.set(`${row.telegramChatId}:${row.telegramMessageId}`, row.id);
    return row;
  }

  async getBySource(telegramChatId: number, telegramMessageId: number): Promise<MessageRecord | null> {
    const id = this.bySource.get(`${telegramChatId}:${telegramMessageId}`);
    return id ? (this.rows.get(id) ?? null) : null;
  }

  async getByConversationAndRelayedId(
    conversationId: string,
    relayedMessageId: number,
    direction: Direction,
  ): Promise<MessageRecord | null> {
    for (const row of this.rows.values()) {
      if (
        row.conversationId === conversationId &&
        row.direction === direction &&
        row.relayedMessageId === relayedMessageId
      ) {
        return row;
      }
    }
    return null;
  }

  async getLastByConversation(conversationId: string): Promise<MessageRecord | null> {
    let last: MessageRecord | null = null;
    let lastAt = -1;
    for (const row of this.rows.values()) {
      if (row.conversationId === conversationId) {
        const t = new Date(row.createdAt).getTime();
        if (t >= lastAt) {
          lastAt = t;
          last = row;
        }
      }
    }
    return last;
  }

  async deleteByConversationId(conversationId: string): Promise<void> {
    for (const [key, row] of this.rows) {
      if (row.conversationId === conversationId) {
        this.rows.delete(key);
        this.bySource.delete(`${row.telegramChatId}:${row.telegramMessageId}`);
      }
    }
  }

  async listUserChatCopyIds(conversationId: string): Promise<number[]> {
    const ids: number[] = [];
    for (const row of this.rows.values()) {
      if (row.conversationId === conversationId && row.direction === "OPERATOR_TO_USER" && row.relayedMessageId != null) {
        ids.push(row.relayedMessageId);
      }
    }
    return ids;
  }
}

class MemoryOperators implements OperatorRepository {
  rows = new Map<number, OperatorRecord>();
  private seq = 0;

  async getByTelegramUserId(id: number): Promise<OperatorRecord | null> {
    return this.rows.get(id) ?? null;
  }

  async upsert(input: OperatorUpsertInput, now: Date): Promise<OperatorRecord> {
    const existing = this.rows.get(input.telegramUserId);
    if (existing && existing.role === "ADMIN") return existing; // never demote
    const row: OperatorRecord = {
      id: existing?.id ?? `op-${++this.seq}`,
      telegramUserId: input.telegramUserId,
      role: input.role,
      createdAt: existing?.createdAt ?? now.toISOString(),
    };
    this.rows.set(input.telegramUserId, row);
    return row;
  }

  async list(): Promise<OperatorRecord[]> {
    return [...this.rows.values()];
  }
}

class MemoryNotes implements NoteRepository {
  rows = new Map<string, ConversationNoteRecord>();
  private seq = 0;

  async create(input: NoteCreateInput, now: Date): Promise<ConversationNoteRecord> {
    const row: ConversationNoteRecord = {
      id: `n-${++this.seq}`,
      conversationId: input.conversationId,
      operatorId: input.operatorId,
      text: input.text,
      createdAt: now.toISOString(),
    };
    this.rows.set(row.id, row);
    return row;
  }

  async listByConversation(conversationId: string): Promise<ConversationNoteRecord[]> {
    return [...this.rows.values()].filter((row) => row.conversationId === conversationId);
  }

  async deleteByConversationId(conversationId: string): Promise<void> {
    for (const [key, row] of this.rows) {
      if (row.conversationId === conversationId) this.rows.delete(key);
    }
  }
}

class MemoryBlocks implements BlockRepository {
  rows = new Map<number, BlockRecord>();
  private seq = 0;

  async getByTelegramUserId(id: number): Promise<BlockRecord | null> {
    return this.rows.get(id) ?? null;
  }

  async create(input: BlockCreateInput, now: Date): Promise<BlockRecord> {
    const row: BlockRecord = {
      id: `b-${++this.seq}`,
      telegramUserId: input.telegramUserId,
      createdByTelegramUserId: input.createdByTelegramUserId,
      createdAt: now.toISOString(),
    };
    this.rows.set(input.telegramUserId, row);
    return row;
  }

  async deleteByTelegramUserId(id: number): Promise<void> {
    this.rows.delete(id);
  }
}

class MemoryApplications implements ApplicationRepository {
  rows = new Map<string, ApplicationRecord>();
  private byUser: Array<{ userId: number; id: string; createdAt: number }> = [];
  private seq = 0;

  async getById(id: string): Promise<ApplicationRecord | null> {
    return this.rows.get(id) ?? null;
  }

  async getLatestByTelegramUserId(telegramUserId: number): Promise<ApplicationRecord | null> {
    let latestId: string | null = null;
    let latestAt = -1;
    for (const entry of this.byUser) {
      if (entry.userId === telegramUserId && entry.createdAt >= latestAt) {
        latestAt = entry.createdAt;
        latestId = entry.id;
      }
    }
    return latestId ? (this.rows.get(latestId) ?? null) : null;
  }

  async create(input: ApplicationCreateInput, now: Date): Promise<ApplicationRecord> {
    const row: ApplicationRecord = {
      id: `app-${++this.seq}`,
      telegramUserId: input.telegramUserId,
      status: "pending",
      createdAt: now.toISOString(),
      decidedAt: null,
      decidedByTelegramUserId: null,
    };
    this.rows.set(row.id, row);
    this.byUser.push({ userId: input.telegramUserId, id: row.id, createdAt: now.getTime() });
    return row;
  }

  async update(input: {
    id: string;
    status: "pending" | "approved" | "rejected";
    decidedAt: Date;
    decidedByTelegramUserId: number;
  }): Promise<void> {
    const row = this.rows.get(input.id);
    if (row) {
      row.status = input.status;
      row.decidedAt = input.decidedAt.toISOString();
      row.decidedByTelegramUserId = input.decidedByTelegramUserId;
    }
  }
}

class MemoryProcessedUpdates implements ProcessedUpdatesRepository {
  private claimed = new Set<number>();

  async claim(updateId: number, now: Date): Promise<boolean> {
    if (this.claimed.has(updateId)) return false;
    this.claimed.add(updateId);
    void now;
    return true;
  }
}

class MemorySettings implements SettingsRepository {
  rows = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.rows.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this.rows.set(key, value);
  }
}

export class MemoryDatabase implements Database {
  users = new MemoryUsers();
  conversations = new MemoryConversations();
  messages = new MemoryMessages();
  operators = new MemoryOperators();
  notes = new MemoryNotes();
  blocks = new MemoryBlocks();
  applications = new MemoryApplications();
  processedUpdates = new MemoryProcessedUpdates();
  settings = new MemorySettings();

  async transaction<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    // In-memory: the same objects back every "transactional view".
    return fn(this);
  }
}

// ---------------------------------------------------------------------------
// TelegramClient fake
// ---------------------------------------------------------------------------

const CONTENT_METHODS: Record<MessageContent["type"], string> = {
  text: "sendMessage",
  photo: "sendPhoto",
  video: "sendVideo",
  document: "sendDocument",
  audio: "sendAudio",
  voice: "sendVoice",
  sticker: "sendSticker",
};

const THREAD_SEND_METHODS = new Set([
  "sendMessage",
  "sendPhoto",
  "sendVideo",
  "sendDocument",
  "sendAudio",
  "sendVoice",
  "sendSticker",
  "forwardMessage",
]);

/** Shape of a delivered copy, keyed by its message id. The fake validates edits
 *  against it the way Telegram does: text edits need a text message, caption
 *  edits need a caption-carrying message (photo/video/document/audio/voice). */
type CopyShape = "text" | "photo" | "video" | "document" | "audio" | "voice" | "sticker";

const SEND_SHAPE: Record<string, CopyShape | undefined> = {
  sendMessage: "text",
  sendPhoto: "photo",
  sendVideo: "video",
  sendDocument: "document",
  sendAudio: "audio",
  sendVoice: "voice",
  sendSticker: "sticker",
  // forwardMessage copies arrive in the topic but are not editable.
  forwardMessage: undefined,
};

export interface RecordedCall {
  method: string;
  target: SendTarget & { messageId?: number };
  payload: Record<string, unknown>;
  replyMarkup?: InlineKeyboard;
  /** The message id the fake returned for a send call (absent for non-sends). */
  id?: number;
}

export class FakeTelegramClient implements TelegramClient {
  calls: RecordedCall[] = [];
  topics = new Map<number, { name: string; closed: boolean }>();
  answers: Array<{ callbackQueryId: string; text?: string; showAlert?: boolean }> = [];
  /** Registered command menus, in call order. */
  commandMenus: Array<{ scope?: BotCommandScope; commands: BotCommand[]; languageCode?: string }> = [];

  /** Profile photos by user id — the bot-usable largest file_id, or absent to
   *  simulate "no profile photo". */
  profilePhotos = new Map<number, string | null>();
  /** userIds of every getUserProfilePhoto call, in order — feeds the pinned
   *  info-card photo at topic creation. */
  profilePhotoLookups: number[] = [];
  /** Self-check responses — default to a healthy deployment; tests override
   *  them to exercise failure paths. */
  meResult: { id: number; username: string; first_name: string } = {
    id: 42_000,
    username: "relaytg_test_bot",
    first_name: "RelayTG Test Bot",
  };
  chatResult: { id: number; type: string; is_forum?: boolean; title?: string } = {
    id: -100123456789,
    type: "supergroup",
    is_forum: true,
    title: "Support",
  };
  chatMemberResult: { status: string } = { status: "administrator" };
  /** Message ids pinned via pinChatMessage (e.g. the personal info card). */
  pinnedMessageIds = new Set<number>();
  /** Messages deleted via deleteMessage — the user-chat copies `/delete` cleans up. */
  deletedMessages: Array<{ chatId: number; messageId: number }> = [];
  /** Shape of each delivered copy, keyed by the message id the fake returned. */
  private readonly copyShape = new Map<number, CopyShape>();
  private nextMessageId = 1000;
  private nextTopicId = 100;
  private failOnce: { method?: string; kind: TelegramErrorKind } | null = null;
  private failAlways: { method?: string; kind: TelegramErrorKind } | null = null;
  /** Fail the n-th matching call (1-based), then clear. */
  private failNth: { n: number; method?: string; kind: TelegramErrorKind } | null = null;
  private failCounts: Record<string, number> = {};

  failOnceWith(kind: TelegramErrorKind, method?: string): void {
    this.failOnce = { kind, method };
  }

  failAlwaysWith(kind: TelegramErrorKind, method?: string): void {
    this.failAlways = { kind, method };
  }

  failNthWith(n: number, kind: TelegramErrorKind, method?: string): void {
    this.failNth = { n, kind, method };
  }

  /** Give a user a profile photo whose largest file_id is `fileId` — the avatar
   *  the pinned personal info card uses for a photo card. */
  setProfilePhoto(telegramUserId: number, fileId: string): void {
    this.profilePhotos.set(telegramUserId, fileId);
  }

  /** Remove any profile photo; getUserProfilePhoto then returns null. */
  clearProfilePhoto(telegramUserId: number): void {
    this.profilePhotos.delete(telegramUserId);
  }

  // -- sends ---------------------------------------------------------------

  async sendMessage(target: SendTarget & { text: string; replyMarkup?: InlineKeyboard }): Promise<number> {
    return this.record("sendMessage", target, { text: target.text }, target.replyMarkup);
  }

  async sendPhoto(target: SendTarget & { fileId: string; caption?: string }): Promise<number> {
    return this.record("sendPhoto", target, { fileId: target.fileId, caption: target.caption });
  }

  async sendVideo(target: SendTarget & { fileId: string; caption?: string }): Promise<number> {
    return this.record("sendVideo", target, { fileId: target.fileId, caption: target.caption });
  }

  async sendDocument(target: SendTarget & { fileId: string; caption?: string }): Promise<number> {
    return this.record("sendDocument", target, { fileId: target.fileId, caption: target.caption });
  }

  async sendAudio(target: SendTarget & { fileId: string; caption?: string }): Promise<number> {
    return this.record("sendAudio", target, { fileId: target.fileId, caption: target.caption });
  }

  async sendVoice(target: SendTarget & { fileId: string; caption?: string }): Promise<number> {
    return this.record("sendVoice", target, { fileId: target.fileId, caption: target.caption });
  }

  async sendSticker(target: SendTarget & { fileId: string }): Promise<number> {
    return this.record("sendSticker", target, { fileId: target.fileId });
  }

  async sendContent(target: SendTarget, content: MessageContent, replyMarkup?: InlineKeyboard): Promise<number> {
    return this.record(CONTENT_METHODS[content.type], target, { content }, replyMarkup);
  }

  async sendMediaGroup(p: {
    chatId: number;
    messageThreadId?: number;
    items: Array<{ type: "photo" | "video" | "document" | "audio"; fileId: string; caption?: string }>;
  }): Promise<number[]> {
    this.checkFail("sendMediaGroup");
    if (p.messageThreadId != null) {
      const topic = this.topics.get(p.messageThreadId);
      if (!topic) throw new TelegramError("message thread not found", { kind: "topic_not_found", httpStatus: 400 });
      if (topic.closed) throw new TelegramError("message thread is closed", { kind: "topic_closed", httpStatus: 400 });
    }
    const ids = p.items.map(() => this.nextMessageId++);
    this.calls.push({
      method: "sendMediaGroup",
      target: { chatId: p.chatId, messageThreadId: p.messageThreadId },
      payload: { items: p.items },
    });
    return ids;
  }

  async getUserProfilePhoto(p: { userId: number }): Promise<string | null> {
    this.checkFail("getUserProfilePhoto");
    this.profilePhotoLookups.push(p.userId);
    return this.profilePhotos.get(p.userId) ?? null;
  }

  async getMe(): Promise<{ id: number; username: string; first_name: string }> {
    this.checkFail("getMe");
    this.calls.push({ method: "getMe", target: { chatId: 0 }, payload: {} });
    return this.meResult;
  }

  async getChat(p: { chatId: number }): Promise<{ id: number; type: string; is_forum?: boolean; title?: string }> {
    this.checkFail("getChat");
    this.calls.push({ method: "getChat", target: { chatId: p.chatId }, payload: {} });
    return this.chatResult;
  }

  async getChatMember(p: { chatId: number; userId: number }): Promise<{ status: string }> {
    this.checkFail("getChatMember");
    this.calls.push({ method: "getChatMember", target: { chatId: p.chatId }, payload: { userId: p.userId } });
    return this.chatMemberResult;
  }

  async forwardMessage(p: {
    chatId: number;
    messageThreadId?: number;
    fromChatId: number;
    messageId: number;
  }): Promise<number> {
    return this.record(
      "forwardMessage",
      { chatId: p.chatId, messageThreadId: p.messageThreadId },
      { fromChatId: p.fromChatId, messageId: p.messageId },
    );
  }

  async pinChatMessage(p: { chatId: number; messageId: number; messageThreadId?: number }): Promise<void> {
    this.checkFail("pinChatMessage");
    this.pinnedMessageIds.add(p.messageId);
    this.calls.push({
      method: "pinChatMessage",
      target: { chatId: p.chatId, messageThreadId: p.messageThreadId },
      payload: { messageId: p.messageId },
    });
  }

  async deleteMessage(p: { chatId: number; messageId: number }): Promise<void> {
    this.checkFail("deleteMessage");
    this.deletedMessages.push({ chatId: p.chatId, messageId: p.messageId });
    this.calls.push({ method: "deleteMessage", target: { chatId: p.chatId }, payload: { messageId: p.messageId } });
  }

  // -- edits ---------------------------------------------------------------

  async editMessageText(p: { chatId: number; messageId: number; text: string; replyMarkup?: InlineKeyboard }): Promise<void> {
    this.checkFail("editMessageText");
    // A failed shape attempt is recorded too — the call reached the API — so the
    // relayer's caption→text fallback is observable in the call list.
    this.pushEdit("editMessageText", p, { text: p.text }, p.replyMarkup, ["text"], "there is no text in the message to edit");
  }

  async editMessageCaption(p: { chatId: number; messageId: number; caption?: string; replyMarkup?: InlineKeyboard }): Promise<void> {
    this.checkFail("editMessageCaption");
    const payload: Record<string, unknown> = {};
    if (p.caption !== undefined) payload.caption = p.caption;
    this.pushEdit(
      "editMessageCaption",
      p,
      payload,
      p.replyMarkup,
      ["photo", "video", "document", "audio", "voice"],
      "there is no caption in the message to edit",
    );
  }

  // -- topics --------------------------------------------------------------

  async createForumTopic(p: { chatId: number; name: string }): Promise<number> {
    this.checkFail("createForumTopic");
    const topicId = this.nextTopicId++;
    this.calls.push({ method: "createForumTopic", target: { chatId: p.chatId }, payload: { name: p.name } });
    this.topics.set(topicId, { name: p.name, closed: false });
    return topicId;
  }

  async editForumTopic(p: { chatId: number; messageThreadId: number; name: string }): Promise<void> {
    this.checkFail("editForumTopic");
    const topic = this.topics.get(p.messageThreadId);
    if (!topic) throw new TelegramError("message thread not found", { kind: "topic_not_found", httpStatus: 400 });
    topic.name = p.name;
    this.calls.push({ method: "editForumTopic", target: p, payload: { name: p.name } });
  }

  async hideForumTopic(p: { chatId: number; messageThreadId: number }): Promise<void> {
    this.checkFail("hideForumTopic");
    const topic = this.topics.get(p.messageThreadId);
    if (!topic) throw new TelegramError("message thread not found", { kind: "topic_not_found", httpStatus: 400 });
    topic.closed = true;
    this.calls.push({ method: "hideForumTopic", target: p, payload: {} });
  }

  async restoreForumTopic(p: { chatId: number; messageThreadId: number }): Promise<void> {
    this.checkFail("restoreForumTopic");
    const topic = this.topics.get(p.messageThreadId);
    if (!topic) throw new TelegramError("message thread not found", { kind: "topic_not_found", httpStatus: 400 });
    topic.closed = false;
    this.calls.push({ method: "restoreForumTopic", target: p, payload: {} });
  }

  async deleteForumTopic(p: { chatId: number; messageThreadId: number }): Promise<void> {
    this.checkFail("deleteForumTopic");
    const topic = this.topics.get(p.messageThreadId);
    if (!topic) throw new TelegramError("message thread not found", { kind: "topic_not_found", httpStatus: 400 });
    this.topics.delete(p.messageThreadId);
    this.calls.push({ method: "deleteForumTopic", target: p, payload: {} });
  }

  // -- callbacks -----------------------------------------------------------

  async answerCallbackQuery(p: { callbackQueryId: string; text?: string; showAlert?: boolean }): Promise<void> {
    this.checkFail("answerCallbackQuery");
    this.answers.push(p);
  }

  async setMyCommands(p: { commands: BotCommand[]; scope?: BotCommandScope; languageCode?: string }): Promise<void> {
    this.checkFail("setMyCommands");
    this.commandMenus.push(
      p.languageCode !== undefined
        ? { scope: p.scope, commands: p.commands, languageCode: p.languageCode }
        : { scope: p.scope, commands: p.commands },
    );
  }

  // -------------------------------------------------------------------------

  private record(method: string, target: SendTarget & { messageId?: number }, payload: Record<string, unknown>, replyMarkup?: InlineKeyboard): number {
    this.checkFail(method);
    if (THREAD_SEND_METHODS.has(method) && target.messageThreadId != null) {
      const topic = this.topics.get(target.messageThreadId);
      if (!topic) throw new TelegramError("message thread not found", { kind: "topic_not_found", httpStatus: 400 });
      if (topic.closed) throw new TelegramError("message thread is closed", { kind: "topic_closed", httpStatus: 400 });
    }
    const id = this.nextMessageId++;
    this.calls.push({ method, target: { ...target }, payload, replyMarkup, id });
    const shape = SEND_SHAPE[method];
    if (shape) this.copyShape.set(id, shape);
    return id;
  }

  /** Record an edit attempt and throw when the target copy can't be edited that
   *  way (mirrors Telegram's "there is no text/caption in the message to edit").
   *  Unknown copies (e.g. manually seeded records) are treated leniently. */
  private pushEdit(
    method: string,
    target: SendTarget & { messageId?: number },
    payload: Record<string, unknown>,
    replyMarkup: InlineKeyboard | undefined,
    allowedShapes: CopyShape[],
    mismatchDescription: string,
  ): void {
    const call: RecordedCall = { method, target: { chatId: target.chatId, messageId: target.messageId }, payload };
    if (replyMarkup) call.replyMarkup = replyMarkup;
    this.calls.push(call);
    const shape = this.copyShape.get(target.messageId!);
    if (shape !== undefined && !allowedShapes.includes(shape)) {
      throw new TelegramError(mismatchDescription, { kind: "bad_request", httpStatus: 400 });
    }
  }

  private checkFail(method: string): void {
    if (this.failOnce && (!this.failOnce.method || this.failOnce.method === method)) {
      const f = this.failOnce;
      this.failOnce = null;
      throw new TelegramError(`simulated ${method} failure`, { kind: f.kind });
    }
    if (this.failAlways && (!this.failAlways.method || this.failAlways.method === method)) {
      throw new TelegramError(`simulated ${method} failure`, { kind: this.failAlways.kind });
    }
    if (this.failNth && (!this.failNth.method || this.failNth.method === method)) {
      const n = (this.failCounts[method] ?? 0) + 1;
      this.failCounts[method] = n;
      if (n === this.failNth.n) {
        const f = this.failNth;
        this.failNth = null;
        throw new TelegramError(`simulated ${method} failure`, { kind: f.kind });
      }
    }
  }

  // -- test helpers ----------------------------------------------------------

  lastCall(): RecordedCall | null {
    return this.calls.length > 0 ? this.calls[this.calls.length - 1] : null;
  }

  callsOf(method: string): RecordedCall[] {
    return this.calls.filter((c) => c.method === method);
  }

  /** Create the topic that a fresh conversation would have created. */
  seedTopic(): number {
    const id = this.nextTopicId++;
    this.topics.set(id, { name: "seed", closed: false });
    return id;
  }
}

// ---------------------------------------------------------------------------
// Serializers (task 7.5) and the verification store — shared with production
// (platform.ts); re-exported here as aliases so tests keep importing them from
// the harness module.
// ---------------------------------------------------------------------------

export { KeyedMutexSerializer, immediateSerializer } from "./platform.ts";
export { InMemoryVerificationStore as MemoryVerificationStore } from "./platform.ts";

// ---------------------------------------------------------------------------
// Record shapes the fakes store (kept so tests can import the type).
// ---------------------------------------------------------------------------

export type { ConversationRecord, UserRecord, MessageRecord };
