// ---------------------------------------------------------------------------
// SqliteDatabase (tasks 10.3-10.4): the core `Database` port implemented over
// the shared SqlDb surface. This module is platform-neutral — it never imports
// node:sqlite or the DO storage — so both runtimes (Docker via node-sqlite-db,
// Cloudflare via the DO wrapper) build the same repository layer.
// Rows come back from SqlDb keyed by snake_case column name; every repository
// maps them to the camelCase core records.
// ---------------------------------------------------------------------------

import type {
  ApplicationCreateInput,
  ApplicationRecord,
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
} from "@relaytg/shared";
import type {
  ApplicationRepository,
  BlockRepository,
  ConversationRepository,
  Database,
  MessageRepository,
  NoteRepository,
  OperatorRepository,
  ProcessedUpdatesRepository,
  SettingsRepository,
  UserRepository,
  UserUpsertResult,
} from "@relaytg/core";
import type { SqlDb, SqlRow } from "./sql-db.ts";

// ---------------------------------------------------------------------------
// Row mapping helpers
// ---------------------------------------------------------------------------

function camelize(key: string): string {
  return key.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
}

function mapRow<T>(row: SqlRow | null): T | null {
  if (row == null) return null;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) out[camelize(key)] = value;
  return out as T;
}

function mapRows<T>(rows: SqlRow[]): T[] {
  return rows.map((row) => mapRow<T>(row) as T);
}

function iso(date: Date): string {
  return date.toISOString();
}

function newId(): string {
  return crypto.randomUUID();
}

/** The `first_name` fallback mirrors UserService: profile first name, else
 *  username, else the numeric id. */
function normalizedFirstName(telegramUserId: number, firstName: string | null, username: string | null): string {
  return firstName ?? username ?? String(telegramUserId);
}

/** users.is_bot is stored as 0/1; core records carry a real boolean. */
function mapUser(row: SqlRow | null): UserRecord | null {
  const mapped = mapRow<UserRecord>(row);
  if (!mapped) return null;
  return { ...mapped, isBot: Number(mapped.isBot) === 1 };
}

// ---------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------

class SqliteUsers implements UserRepository {
  constructor(private readonly sql: SqlDb) {}

  async getByTelegramUserId(telegramUserId: number): Promise<UserRecord | null> {
    return mapUser(this.sql.prepare("SELECT * FROM users WHERE telegram_user_id = ?").get(telegramUserId));
  }

  async getByUsername(username: string): Promise<UserRecord | null> {
    return mapUser(this.sql.prepare("SELECT * FROM users WHERE username = ?").get(username));
  }

  async upsertProfile(input: UserUpsertInput, now: Date): Promise<UserUpsertResult> {
    const existing = this.sql
      .prepare("SELECT * FROM users WHERE telegram_user_id = ?")
      .get(input.telegramUserId);
    const firstName = normalizedFirstName(input.telegramUserId, input.firstName, input.username);
    if (existing) {
      const updatedAt = iso(now);
      this.sql
        .prepare(
          `UPDATE users
             SET username = ?, first_name = ?, last_name = ?, language_code = ?, is_bot = ?, updated_at = ?
           WHERE telegram_user_id = ?`,
        )
        .run(input.username, firstName, input.lastName, input.languageCode, input.isBot ? 1 : 0, updatedAt, input.telegramUserId);
      const row = mapUser(
        this.sql.prepare("SELECT * FROM users WHERE telegram_user_id = ?").get(input.telegramUserId),
      );
      return { user: row as UserRecord, created: false };
    }
    const createdAt = iso(now);
    const id = newId();
    this.sql
      .prepare(
        `INSERT INTO users (id, telegram_user_id, username, first_name, last_name, language_code, preferred_language, is_bot, verified_at, approved_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, ?)`,
      )
      .run(id, input.telegramUserId, input.username, firstName, input.lastName, input.languageCode, input.isBot ? 1 : 0, createdAt, createdAt);
    const user: UserRecord = {
      id,
      telegramUserId: input.telegramUserId,
      username: input.username,
      firstName,
      lastName: input.lastName,
      languageCode: input.languageCode,
      preferredLanguage: null,
      isBot: input.isBot,
      verifiedAt: null,
      approvedAt: null,
      purpose: null,
      purposeAt: null,
      createdAt,
      updatedAt: createdAt,
    };
    return { user, created: true };
  }

  async setPreferredLanguage(telegramUserId: number, language: string | null, now: Date): Promise<void> {
    this.sql
      .prepare("UPDATE users SET preferred_language = ?, updated_at = ? WHERE telegram_user_id = ?")
      .run(language, iso(now), telegramUserId);
  }

  async listPreferredLanguageUsers(): Promise<UserRecord[]> {
    const rows = this.sql.prepare("SELECT * FROM users WHERE preferred_language IS NOT NULL").all();
    return rows.map((row) => mapUser(row) as UserRecord);
  }

  async setVerifiedAt(telegramUserId: number, at: Date): Promise<void> {
    this.sql
      .prepare("UPDATE users SET verified_at = ?, updated_at = ? WHERE telegram_user_id = ?")
      .run(iso(at), iso(at), telegramUserId);
  }

  async setApprovedAt(telegramUserId: number, at: Date): Promise<void> {
    this.sql
      .prepare("UPDATE users SET approved_at = ?, updated_at = ? WHERE telegram_user_id = ?")
      .run(iso(at), iso(at), telegramUserId);
  }

  async setPurpose(telegramUserId: number, purpose: string, at: Date): Promise<void> {
    this.sql
      .prepare("UPDATE users SET purpose = ?, purpose_at = ?, updated_at = ? WHERE telegram_user_id = ?")
      .run(purpose, iso(at), iso(at), telegramUserId);
  }

  async resetAccess(telegramUserId: number): Promise<void> {
    // A /delete resets the whole gate, including the stored purpose: the next
    // contact must verify again AND state a fresh purpose, which opens the new
    // topic as its single pinned purpose+info card.
    this.sql
      .prepare("UPDATE users SET verified_at = NULL, approved_at = NULL, purpose = NULL, purpose_at = NULL, updated_at = ? WHERE telegram_user_id = ?")
      .run(iso(new Date()), telegramUserId);
  }
}

class SqliteConversations implements ConversationRepository {
  constructor(private readonly sql: SqlDb) {}

  async getById(id: string): Promise<ConversationRecord | null> {
    return mapRow<ConversationRecord>(this.sql.prepare("SELECT * FROM conversations WHERE id = ?").get(id));
  }

  async getByTelegramUserId(telegramUserId: number): Promise<ConversationRecord | null> {
    return mapRow<ConversationRecord>(
      this.sql.prepare("SELECT * FROM conversations WHERE telegram_user_id = ?").get(telegramUserId),
    );
  }

  async getByTopicId(telegramTopicId: number): Promise<ConversationRecord | null> {
    return mapRow<ConversationRecord>(
      this.sql.prepare("SELECT * FROM conversations WHERE telegram_topic_id = ?").get(telegramTopicId),
    );
  }

  async create(input: ConversationCreateInput, now: Date): Promise<ConversationRecord> {
    const createdAt = iso(now);
    const row: ConversationRecord = {
      id: newId(),
      telegramUserId: input.telegramUserId,
      telegramTopicId: input.telegramTopicId,
      assignedOperatorId: input.assignedOperatorId,
      lastActivityAt: createdAt,
      hiddenAt: null,
      hideAfterHours: null,
      createdAt,
    };
    this.sql
      .prepare(
        `INSERT INTO conversations
           (id, telegram_user_id, telegram_topic_id, assigned_operator_id, last_activity_at, hidden_at, hide_after_hours, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
      )
      .run(row.id, row.telegramUserId, row.telegramTopicId, row.assignedOperatorId, row.lastActivityAt, row.createdAt);
    return row;
  }

  async updateTopicId(id: string, telegramTopicId: number): Promise<void> {
    this.sql.prepare("UPDATE conversations SET telegram_topic_id = ? WHERE id = ?").run(telegramTopicId, id);
  }

  async setAssignedOperatorId(id: string, operatorId: string | null): Promise<void> {
    this.sql.prepare("UPDATE conversations SET assigned_operator_id = ? WHERE id = ?").run(operatorId, id);
  }

  async touchActivity(id: string, at: Date): Promise<void> {
    this.sql.prepare("UPDATE conversations SET last_activity_at = ? WHERE id = ?").run(iso(at), id);
  }

  async setHidden(id: string, hiddenAt: string | null): Promise<void> {
    this.sql.prepare("UPDATE conversations SET hidden_at = ? WHERE id = ?").run(hiddenAt, id);
  }

  async setHideAfterHours(id: string, hideAfterHours: number | null): Promise<void> {
    this.sql.prepare("UPDATE conversations SET hide_after_hours = ? WHERE id = ?").run(hideAfterHours, id);
  }

  async list(): Promise<ConversationRecord[]> {
    return mapRows<ConversationRecord>(this.sql.prepare("SELECT * FROM conversations ORDER BY created_at").all());
  }

  async listStaleHiddenCandidates(now: Date, autoHideHours: number): Promise<ConversationRecord[]> {
    // The global auto-hide cap applies to EVERY conversation (permanent-policy
    // and never-hide included); a custom hide_after_hours > 0 only makes the
    // threshold sooner. Computing per-row cutoffs needs date math that differs
    // subtly across SQLite bindings, so the scan filters in JS — identical to
    // the in-memory port.
    const rows = this.sql
      .prepare(
        `SELECT * FROM conversations
          WHERE hidden_at IS NULL
            AND telegram_topic_id IS NOT NULL`,
      )
      .all();
    const out: ConversationRecord[] = [];
    for (const row of rows) {
      const record = mapRow<ConversationRecord>(row) as ConversationRecord;
      const last = new Date(record.lastActivityAt).getTime();
      const nowMs = now.getTime();
      const staleByHardCap = last < nowMs - autoHideHours * 3_600_000;
      const custom = record.hideAfterHours;
      const staleByPolicy = custom != null && custom > 0 && last < nowMs - custom * 3_600_000;
      if (staleByHardCap || staleByPolicy) out.push(record);
    }
    return out;
  }

  async delete(id: string): Promise<void> {
    this.sql.prepare("DELETE FROM conversations WHERE id = ?").run(id);
  }
}

class SqliteMessages implements MessageRepository {
  constructor(private readonly sql: SqlDb) {}

  async create(input: MessageCreateInput, now: Date): Promise<MessageRecord> {
    const createdAt = iso(now);
    const row: MessageRecord = {
      id: newId(),
      conversationId: input.conversationId,
      telegramChatId: input.telegramChatId,
      telegramMessageId: input.telegramMessageId,
      telegramTopicId: input.telegramTopicId,
      relayedMessageId: input.relayedMessageId,
      direction: input.direction,
      senderType: input.senderType,
      contentType: input.contentType,
      replyToMessageId: input.replyToMessageId,
      createdAt,
    };
    this.sql
      .prepare(
        `INSERT INTO messages
           (id, conversation_id, telegram_chat_id, telegram_message_id, telegram_topic_id, relayed_message_id,
            direction, sender_type, content_type, reply_to_message_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.conversationId,
        row.telegramChatId,
        row.telegramMessageId,
        row.telegramTopicId,
        row.relayedMessageId,
        row.direction,
        row.senderType,
        row.contentType,
        row.replyToMessageId,
        row.createdAt,
      );
    return row;
  }

  async getBySource(telegramChatId: number, telegramMessageId: number): Promise<MessageRecord | null> {
    return mapRow<MessageRecord>(
      this.sql
        .prepare("SELECT * FROM messages WHERE telegram_chat_id = ? AND telegram_message_id = ?")
        .get(telegramChatId, telegramMessageId),
    );
  }

  async getByConversationAndRelayedId(
    conversationId: string,
    relayedMessageId: number,
    direction: Direction,
  ): Promise<MessageRecord | null> {
    return mapRow<MessageRecord>(
      this.sql
        .prepare("SELECT * FROM messages WHERE conversation_id = ? AND direction = ? AND relayed_message_id = ?")
        .get(conversationId, direction, relayedMessageId),
    );
  }

  async getLastByConversation(conversationId: string): Promise<MessageRecord | null> {
    return mapRow<MessageRecord>(
      this.sql
        .prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
        .get(conversationId),
    );
  }

  async deleteByConversationId(conversationId: string): Promise<void> {
    this.sql.prepare("DELETE FROM messages WHERE conversation_id = ?").run(conversationId);
  }

  async listUserChatCopyIds(conversationId: string): Promise<number[]> {
    const rows = this.sql
      .prepare(
        `SELECT relayed_message_id FROM messages
          WHERE conversation_id = ? AND direction = 'OPERATOR_TO_USER' AND relayed_message_id IS NOT NULL`,
      )
      .all(conversationId);
    return rows.map((row) => Number(row.relayed_message_id));
  }
}

class SqliteOperators implements OperatorRepository {
  constructor(private readonly sql: SqlDb) {}

  async getByTelegramUserId(telegramUserId: number): Promise<OperatorRecord | null> {
    return mapRow<OperatorRecord>(
      this.sql.prepare("SELECT * FROM operators WHERE telegram_user_id = ?").get(telegramUserId),
    );
  }

  async upsert(input: OperatorUpsertInput, now: Date): Promise<OperatorRecord> {
    const existing = this.sql
      .prepare("SELECT * FROM operators WHERE telegram_user_id = ?")
      .get(input.telegramUserId);
    if (existing) {
      // Admins are never demoted.
      if (existing.role === "ADMIN") return mapRow<OperatorRecord>(existing) as OperatorRecord;
      this.sql.prepare("UPDATE operators SET role = ? WHERE telegram_user_id = ?").run(input.role, input.telegramUserId);
      return mapRow<OperatorRecord>(
        this.sql.prepare("SELECT * FROM operators WHERE telegram_user_id = ?").get(input.telegramUserId),
      ) as OperatorRecord;
    }
    const createdAt = iso(now);
    const row: OperatorRecord = {
      id: newId(),
      telegramUserId: input.telegramUserId,
      role: input.role,
      createdAt,
    };
    this.sql
      .prepare("INSERT INTO operators (id, telegram_user_id, role, created_at) VALUES (?, ?, ?, ?)")
      .run(row.id, row.telegramUserId, row.role, row.createdAt);
    return row;
  }

  async list(): Promise<OperatorRecord[]> {
    return mapRows<OperatorRecord>(this.sql.prepare("SELECT * FROM operators ORDER BY created_at ASC, rowid ASC").all());
  }
}

class SqliteNotes implements NoteRepository {
  constructor(private readonly sql: SqlDb) {}

  async create(input: NoteCreateInput, now: Date): Promise<ConversationNoteRecord> {
    const createdAt = iso(now);
    const row: ConversationNoteRecord = {
      id: newId(),
      conversationId: input.conversationId,
      operatorId: input.operatorId,
      text: input.text,
      createdAt,
    };
    this.sql
      .prepare(
        "INSERT INTO conversation_notes (id, conversation_id, operator_id, text, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(row.id, row.conversationId, row.operatorId, row.text, row.createdAt);
    return row;
  }

  async listByConversation(conversationId: string): Promise<ConversationNoteRecord[]> {
    return mapRows<ConversationNoteRecord>(
      this.sql
        .prepare("SELECT * FROM conversation_notes WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC")
        .all(conversationId),
    );
  }

  async deleteByConversationId(conversationId: string): Promise<void> {
    this.sql.prepare("DELETE FROM conversation_notes WHERE conversation_id = ?").run(conversationId);
  }
}

class SqliteBlocks implements BlockRepository {
  constructor(private readonly sql: SqlDb) {}

  async getByTelegramUserId(telegramUserId: number): Promise<BlockRecord | null> {
    return mapRow<BlockRecord>(
      this.sql.prepare("SELECT * FROM blocks WHERE telegram_user_id = ?").get(telegramUserId),
    );
  }

  async create(input: BlockCreateInput, now: Date): Promise<BlockRecord> {
    // Re-blocking keeps the original row id; blocking is keyed by user id.
    this.sql
      .prepare(
        `INSERT INTO blocks (id, telegram_user_id, created_by_telegram_user_id, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(telegram_user_id) DO UPDATE SET
           created_by_telegram_user_id = excluded.created_by_telegram_user_id,
           created_at = excluded.created_at`,
      )
      .run(newId(), input.telegramUserId, input.createdByTelegramUserId, iso(now));
    return (await this.getByTelegramUserId(input.telegramUserId)) as BlockRecord;
  }

  async deleteByTelegramUserId(telegramUserId: number): Promise<void> {
    this.sql.prepare("DELETE FROM blocks WHERE telegram_user_id = ?").run(telegramUserId);
  }
}

class SqliteApplications implements ApplicationRepository {
  constructor(private readonly sql: SqlDb) {}

  async getById(id: string): Promise<ApplicationRecord | null> {
    return mapRow<ApplicationRecord>(this.sql.prepare("SELECT * FROM applications WHERE id = ?").get(id));
  }

  async getLatestByTelegramUserId(telegramUserId: number): Promise<ApplicationRecord | null> {
    return mapRow<ApplicationRecord>(
      this.sql
        .prepare("SELECT * FROM applications WHERE telegram_user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1")
        .get(telegramUserId),
    );
  }

  async create(input: ApplicationCreateInput, now: Date): Promise<ApplicationRecord> {
    const createdAt = iso(now);
    const row: ApplicationRecord = {
      id: newId(),
      telegramUserId: input.telegramUserId,
      status: "pending",
      createdAt,
      decidedAt: null,
      decidedByTelegramUserId: null,
    };
    this.sql
      .prepare(
        "INSERT INTO applications (id, telegram_user_id, status, created_at, decided_at, decided_by_telegram_user_id) VALUES (?, ?, 'pending', ?, NULL, NULL)",
      )
      .run(row.id, row.telegramUserId, row.createdAt);
    return row;
  }

  async update(input: {
    id: string;
    status: "pending" | "approved" | "rejected";
    decidedAt: Date;
    decidedByTelegramUserId: number;
  }): Promise<void> {
    this.sql
      .prepare(
        "UPDATE applications SET status = ?, decided_at = ?, decided_by_telegram_user_id = ? WHERE id = ?",
      )
      .run(input.status, iso(input.decidedAt), input.decidedByTelegramUserId, input.id);
  }
}

class SqliteProcessedUpdates implements ProcessedUpdatesRepository {
  constructor(private readonly sql: SqlDb) {}

  /** Claim an update_id before processing. The INSERT OR IGNORE writes the row
   *  exactly once; the per-claim nonce distinguishes the inserting claim from a
   *  duplicate (which keeps its own nonce in the row), independent of the
   *  runtime clock. */
  async claim(updateId: number, now: Date): Promise<boolean> {
    const claimId = newId();
    this.sql
      .prepare("INSERT OR IGNORE INTO processed_updates (update_id, claim_id, processed_at) VALUES (?, ?, ?)")
      .run(updateId, claimId, iso(now));
    const check = this.sql
      .prepare("SELECT COUNT(*) AS c FROM processed_updates WHERE update_id = ? AND claim_id = ?")
      .get(updateId, claimId);
    return check != null && Number(check.c) === 1;
  }
}

class SqliteSettings implements SettingsRepository {
  constructor(private readonly sql: SqlDb) {}

  async get(key: string): Promise<string | null> {
    const row = this.sql.prepare("SELECT value FROM settings WHERE key = ?").get(key);
    return row != null ? String(row.value) : null;
  }

  async set(key: string, value: string): Promise<void> {
    this.sql
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }
}

// ---------------------------------------------------------------------------
// Database facade
// ---------------------------------------------------------------------------

export class SqliteDatabase implements Database {
  readonly users: UserRepository;
  readonly conversations: ConversationRepository;
  readonly messages: MessageRepository;
  readonly operators: OperatorRepository;
  readonly notes: NoteRepository;
  readonly blocks: BlockRepository;
  readonly applications: ApplicationRepository;
  readonly processedUpdates: ProcessedUpdatesRepository;
  readonly settings: SettingsRepository;

  constructor(private readonly sql: SqlDb) {
    this.users = new SqliteUsers(sql);
    this.conversations = new SqliteConversations(sql);
    this.messages = new SqliteMessages(sql);
    this.operators = new SqliteOperators(sql);
    this.notes = new SqliteNotes(sql);
    this.blocks = new SqliteBlocks(sql);
    this.applications = new SqliteApplications(sql);
    this.processedUpdates = new SqliteProcessedUpdates(sql);
    this.settings = new SqliteSettings(sql);
  }

  /** The underlying SqlDb owns transaction semantics: node:sqlite brackets with
   *  BEGIN/COMMIT/ROLLBACK; the DO binding runs the unit as-is (per-instance
   *  serialization already isolates requests). The same Database instance backs
   *  every transactional view. */
  transaction<T>(fn: (db: Database) => Promise<T>): Promise<T> {
    return this.sql.transaction(async () => fn(this));
  }
}
