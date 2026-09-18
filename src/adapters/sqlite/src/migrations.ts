// ---------------------------------------------------------------------------
// Embedded migrations for the Node/CLI runtime (single source of truth).
//
// The Docker runtime used to `fs`-read `migrations/*.sql` resolved off
// `import.meta.url` — that breaks when the app is bundled into a Node SEA
// (the path points at the executable, the files are gone). So the schema is
// embedded here as a plain module, shared by the Docker runtime and (via a
// re-export) the Cloudflare runtime. The drift test in
// src/apps/worker/src/index.test.ts reads the on-disk `.sql` files and asserts
// they equal these strings, so the two cannot silently diverge.
// ---------------------------------------------------------------------------

import type { Migration } from "./migrate.ts";

const INITIAL_SQL = `-- RelayTG initial schema (migration 001).
--
-- SQLite dialect, shared verbatim by the Docker runtime (node:sqlite) and the
-- Cloudflare Durable Object SQLite storage. Applied through the migration
-- runner (adapters/sqlite/src/migrate.ts) — the database is never dropped and
-- recreated.

-- users: one row per Telegram identity, keyed by telegram_user_id.
-- username is display-only (Telegram usernames are mutable) and never a key.
CREATE TABLE users (
  id                 TEXT PRIMARY KEY,
  telegram_user_id   INTEGER NOT NULL,
  username           TEXT,
  first_name         TEXT NOT NULL,
  last_name          TEXT,
  language_code      TEXT,
  is_bot             INTEGER NOT NULL DEFAULT 0,
  verified_at        TEXT, -- ISO timestamp, set once arithmetic verification passes
  approved_at        TEXT, -- ISO timestamp, set once an admin approves a /apply application
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

-- conversations: one per user, no status lifecycle (stateless, task 2.x).
CREATE TABLE conversations (
  id                   TEXT PRIMARY KEY,
  telegram_user_id     INTEGER NOT NULL,
  telegram_topic_id    INTEGER, -- forum topic in the support group
  assigned_operator_id TEXT,    -- informational only, never gates who may operate
  last_activity_at     TEXT NOT NULL, -- inactivity-timer base (2.3, hide spec)
  hidden_at            TEXT,          -- ISO timestamp set when auto-hidden
  hide_after_hours     INTEGER,       -- NULL = global default, 0 = never hide
  created_at           TEXT NOT NULL
);

-- messages: every relayed copy, source-keyed for idempotency, edits, replies.
CREATE TABLE messages (
  id                 TEXT PRIMARY KEY,
  conversation_id    TEXT NOT NULL,
  telegram_chat_id   INTEGER NOT NULL,
  telegram_message_id INTEGER NOT NULL,
  telegram_topic_id  INTEGER,       -- topic the user message was relayed to
  relayed_message_id INTEGER,       -- message id of the copy delivered on the other side
  direction          TEXT NOT NULL, -- USER_TO_OPERATOR | OPERATOR_TO_USER | SYSTEM
  sender_type        TEXT NOT NULL, -- USER | OPERATOR | SYSTEM
  content_type       TEXT NOT NULL, -- text | photo | video | document | audio | voice | sticker
  reply_to_message_id INTEGER,      -- reply anchor in the sending chat
  created_at         TEXT NOT NULL
);

-- operators: registry seeded from OPERATOR_IDS + ADMIN_IDS at boot.
CREATE TABLE operators (
  id               TEXT PRIMARY KEY,
  telegram_user_id INTEGER NOT NULL,
  role             TEXT NOT NULL, -- ADMIN | OPERATOR
  created_at       TEXT NOT NULL
);

-- conversation_notes: internal notes, never delivered to users.
CREATE TABLE conversation_notes (
  id             TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  operator_id    TEXT NOT NULL,
  text           TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

-- blocks: user-level block records (admin-only).
CREATE TABLE blocks (
  id                         TEXT PRIMARY KEY,
  telegram_user_id           INTEGER NOT NULL,
  created_by_telegram_user_id INTEGER NOT NULL,
  created_at                 TEXT NOT NULL
);

-- applications: /apply requests. A user may re-apply after a rejection, so
-- telegram_user_id is a hot lookup, not unique.
CREATE TABLE applications (
  id                        TEXT PRIMARY KEY,
  telegram_user_id          INTEGER NOT NULL,
  status                    TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  created_at                TEXT NOT NULL,
  decided_at                TEXT,
  decided_by_telegram_user_id INTEGER
);

-- processed_updates: idempotency claim ledger (claimed before processing).
-- claim_id is a per-claim nonce so two claims of the same update can be told
-- apart even when the runtime clock is frozen (tests) or millisecond-equal.
CREATE TABLE processed_updates (
  update_id    INTEGER PRIMARY KEY,
  claim_id     TEXT NOT NULL,
  processed_at TEXT NOT NULL
);

-- settings: key/value store (reserved for future system-level config).
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Required indexes (storage spec): high-frequency lookups.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX idx_users_telegram_user_id ON users(telegram_user_id);
CREATE UNIQUE INDEX idx_conversations_telegram_user_id ON conversations(telegram_user_id);
CREATE INDEX idx_conversations_telegram_topic_id ON conversations(telegram_topic_id);
CREATE UNIQUE INDEX idx_messages_source ON messages(telegram_chat_id, telegram_message_id);
-- Reply-anchor resolution (conversation_id, direction, relayed_message_id) and,
-- via its leftmost column, every conversation_id-prefixed scan (last-message,
-- cascade delete). processed_updates.update_id needs no separate index:
-- INTEGER PRIMARY KEY is already an index.
CREATE INDEX idx_messages_relay_lookup ON messages(conversation_id, direction, relayed_message_id);
CREATE INDEX idx_applications_telegram_user_id ON applications(telegram_user_id);

-- Per-row identity lookups backing the registry/block user checks.
CREATE UNIQUE INDEX idx_operators_telegram_user_id ON operators(telegram_user_id);
CREATE UNIQUE INDEX idx_blocks_telegram_user_id ON blocks(telegram_user_id);
CREATE INDEX idx_conversation_notes_conversation_id ON conversation_notes(conversation_id);`;

const PREFERRED_LANGUAGE_SQL = `-- migration 002: per-user language preference (set via /lang).
--
-- NULL = follow the Telegram-detected language; a set value (e.g. 'zh' or
-- 'en') overrides auto-detection for every outbound message to that user.
-- \`language_code\` keeps holding whatever Telegram reports; resolution is
-- \`preferred_language ?? language_code\`.
ALTER TABLE users ADD COLUMN preferred_language TEXT;
`;

const PURPOSE_SQL = `-- migration 003: first-contact purpose (来意) + the /delete access reset.
--
-- purpose: the reason for contact a user states at first contact, required
-- before the first conversation/topic is created. NULL = the gate is pending.
-- The stated purpose is shown to operators in /info and forwarded verbatim as
-- the new topic's first, pinned message. purpose_at records when it was stated.
--
-- Clearing verified_at/approved_at AND purpose/purpose_at is done by /delete
-- (via users.resetAccess), which re-requires verification and a fresh purpose
-- on the user's next contact — no new column.
ALTER TABLE users ADD COLUMN purpose TEXT;
ALTER TABLE users ADD COLUMN purpose_at TEXT;
`;

const MULTI_BOT_SQL = `-- migration 004: multi-bot support.
--
-- Every bot is a distinct Telegram bot with its own token and webhook; the
-- support group stays ONE shared forum. Conversations, message rows and the
-- update-claim ledger become per-bot:
--   conversations.id is unchanged (uuid); (bot_id, telegram_user_id) is now the
--     uniqueness key — one topic per (bot × human).
--   messages.telegram_chat_id is the same numeric user id across every bot's
--     private chat (a private chat id equals the user id), while message ids
--     restart at 1 per (bot, chat), so source uniqueness becomes (bot_id,
--     chat_id, message_id). A plain (chat_id, message_id) index is kept for
--     edit-time lookups — group message ids are globally unique, so those never
--     collide across bots.
--   processed_updates.update_id increments per bot; claims are keyed by
--     (bot_id, update_id) — the table is rebuilt with a composite primary key.
-- Existing single-bot rows are tagged with the identity 'primary'.
--
-- The first statement is an ALTER so the fake DO SQL handle routes the whole
-- script through multi-statement exec (its dispatch looks at the first keyword).

ALTER TABLE conversations ADD COLUMN bot_id TEXT NOT NULL DEFAULT 'primary';
ALTER TABLE messages ADD COLUMN bot_id TEXT NOT NULL DEFAULT 'primary';

DROP INDEX idx_conversations_telegram_user_id;
CREATE UNIQUE INDEX idx_conversations_bot_user ON conversations(bot_id, telegram_user_id);

DROP INDEX idx_messages_source;
CREATE UNIQUE INDEX idx_messages_source_bot ON messages(bot_id, telegram_chat_id, telegram_message_id);
CREATE INDEX idx_messages_source ON messages(telegram_chat_id, telegram_message_id);

CREATE TABLE processed_updates_new (
  bot_id       TEXT NOT NULL,
  update_id    INTEGER NOT NULL,
  claim_id     TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  PRIMARY KEY (bot_id, update_id)
);

INSERT INTO processed_updates_new (bot_id, update_id, claim_id, processed_at)
  SELECT 'primary', update_id, claim_id, processed_at FROM processed_updates;

DROP TABLE processed_updates;
ALTER TABLE processed_updates_new RENAME TO processed_updates;`;

const PER_BOT_VERIFICATION_SQL = `-- migration 005: per-bot independent human verification.
--
-- Previously a single users.verified_at marked the human verified on EVERY
-- bot: passing the arithmetic gate on bot1 auto-verified them on bot2. Now the
-- gate is per (bot, human) — a user who contacts two bots must pass the
-- challenge separately on each. The identity-level fields that stay global
-- (approved_at, purpose, block, language, role) remain on \`users\`;
-- verification moves to its own per-bot table. The legacy users.verified_at
-- column is kept in the schema (harmless, never read) so single-bot data maps
-- onto the primary bot's namespace without rewriting.
--
-- Existing single-bot verification rows are backfilled onto the primary bot's
-- namespace ('primary'): a pre-005 user verified on their only bot keeps being
-- verified on that bot, exactly as before.
--
-- The first statement is a CREATE so the fake DO SQL handle routes the whole
-- script through multi-statement exec (its dispatch looks at the first keyword).

CREATE TABLE user_verifications (
  bot_id           TEXT NOT NULL,
  telegram_user_id INTEGER NOT NULL,
  verified_at      TEXT NOT NULL, -- ISO timestamp, per (bot, human)
  PRIMARY KEY (bot_id, telegram_user_id)
);

CREATE INDEX idx_user_verifications_telegram_user_id ON user_verifications(telegram_user_id);

INSERT INTO user_verifications (bot_id, telegram_user_id, verified_at)
  SELECT 'primary', telegram_user_id, verified_at FROM users WHERE verified_at IS NOT NULL;
`;

/** Migration list, version-sorted (001 < 002 < ...). Kept in sync with the
 *  on-disk files by the drift test. */
export const MIGRATIONS: Migration[] = [
  { version: "001_initial", sql: INITIAL_SQL },
  { version: "002_preferred_language", sql: PREFERRED_LANGUAGE_SQL },
  { version: "003_purpose", sql: PURPOSE_SQL },
  { version: "004_multi_bot", sql: MULTI_BOT_SQL },
  { version: "005_per_bot_verification", sql: PER_BOT_VERIFICATION_SQL },
];
