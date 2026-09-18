-- migration 004: multi-bot support.
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
ALTER TABLE processed_updates_new RENAME TO processed_updates;