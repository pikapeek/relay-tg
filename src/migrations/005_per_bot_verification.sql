-- migration 005: per-bot independent human verification.
--
-- Previously a single users.verified_at marked the human verified on EVERY
-- bot: passing the arithmetic gate on bot1 auto-verified them on bot2. Now the
-- gate is per (bot, human) — a user who contacts two bots must pass the
-- challenge separately on each. The identity-level fields that stay global
-- (approved_at, purpose, block, language, role) remain on `users`;
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
