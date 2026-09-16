-- RelayTG initial schema (migration 001).
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
CREATE INDEX idx_conversation_notes_conversation_id ON conversation_notes(conversation_id);