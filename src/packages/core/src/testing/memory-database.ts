// ---------------------------------------------------------------------------
// In-memory repository fakes (one "table" each) plus MemoryDatabase, the test
// double for the Database port. They mirror the storage spec's repository
// behavior so the real adapters are tested against the same expectations.
// ---------------------------------------------------------------------------

import {
  type ApplicationRecord,
  type BlockRecord,
  type ConversationNoteRecord,
  type ConversationRecord,
  type Direction,
  type MessageRecord,
  type OperatorRecord,
  type UserRecord,
  type UserUpsertInput,
  type OperatorUpsertInput,
  type NoteCreateInput,
  type BlockCreateInput,
  type ApplicationCreateInput,
  type ConversationCreateInput,
  type MessageCreateInput,
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
  type SettingsRepository,
  type UserRepository,
  type UserUpsertResult,
} from "../ports.ts";

class MemoryUsers implements UserRepository {
  rows = new Map<number, UserRecord>();
  /** Per-(bot × user) verification rows, mirroring `user_verifications`. */
  private verified = new Map<string, string>(); // `${botId}:${userId}` → ISO timestamp
  private seq = 0;

  private verifiedKey(botId: string, telegramUserId: number): string {
    return `${botId}:${telegramUserId}`;
  }

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

  async getVerifiedAt(botId: string, telegramUserId: number): Promise<string | null> {
    return this.verified.get(this.verifiedKey(botId, telegramUserId)) ?? null;
  }

  async setVerifiedAt(botId: string, telegramUserId: number, at: Date): Promise<void> {
    // Deliberately does NOT bump users.updatedAt — matches the sqlite repo,
    // which keeps the per-(bot, user) mark out of the global user row.
    this.verified.set(this.verifiedKey(botId, telegramUserId), at.toISOString());
  }

  async clearVerified(botId: string, telegramUserId: number): Promise<void> {
    this.verified.delete(this.verifiedKey(botId, telegramUserId));
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
  private byBotUser = new Map<string, string>(); // `${botId}:${userId}` → id
  private byTopic = new Map<number, string>();
  private seq = 0;

  async getById(id: string): Promise<ConversationRecord | null> {
    return this.rows.get(id) ?? null;
  }

  /** The user's most recent conversation across all bots (multi-bot fallback;
   *  exact (bot, user) lookup is getByBotAndUser). */
  async getByTelegramUserId(telegramUserId: number): Promise<ConversationRecord | null> {
    let best: ConversationRecord | null = null;
    for (const row of this.rows.values()) {
      if (row.telegramUserId !== telegramUserId) continue;
      if (best == null || row.lastActivityAt > best.lastActivityAt) best = row;
    }
    return best;
  }

  async getByBotAndUser(botId: string, telegramUserId: number): Promise<ConversationRecord | null> {
    const id = this.byBotUser.get(`${botId}:${telegramUserId}`);
    return id ? (this.rows.get(id) ?? null) : null;
  }

  async getByTopicId(telegramTopicId: number): Promise<ConversationRecord | null> {
    const id = this.byTopic.get(telegramTopicId);
    return id ? (this.rows.get(id) ?? null) : null;
  }

  async create(input: ConversationCreateInput, now: Date): Promise<ConversationRecord> {
    const row: ConversationRecord = {
      id: `c-${++this.seq}`,
      botId: input.botId,
      telegramUserId: input.telegramUserId,
      telegramTopicId: input.telegramTopicId,
      assignedOperatorId: input.assignedOperatorId,
      lastActivityAt: now.toISOString(),
      hiddenAt: null,
      hideAfterHours: null,
      createdAt: now.toISOString(),
    };
    this.rows.set(row.id, row);
    this.byBotUser.set(`${row.botId}:${row.telegramUserId}`, row.id);
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
    this.byBotUser.delete(`${row.botId}:${row.telegramUserId}`);
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
      botId: input.botId,
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
    // Source lookup is (chat_id, message_id) — a user's private chat id is the
    // same number across bots and message ids restart at 1 per bot, so the same
    // (chat, message) can legitimately exist once per bot. Mirror SQLite's
    // `.get()` (earliest row wins): keep the FIRST mapping.
    const key = `${row.telegramChatId}:${row.telegramMessageId}`;
    if (!this.bySource.has(key)) this.bySource.set(key, row.id);
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
        // Only drop the source mapping when it points at this row — the same
        // (chat, message) may be owned by a different bot's conversation.
        const src = `${row.telegramChatId}:${row.telegramMessageId}`;
        if (this.bySource.get(src) === key) this.bySource.delete(src);
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
  private claimed = new Set<string>();

  async claim(botId: string, updateId: number, now: Date): Promise<boolean> {
    const key = `${botId}:${updateId}`;
    if (this.claimed.has(key)) return false;
    this.claimed.add(key);
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