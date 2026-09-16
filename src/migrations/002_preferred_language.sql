-- migration 002: per-user language preference (set via /lang).
--
-- NULL = follow the Telegram-detected language; a set value (e.g. 'zh' or
-- 'en') overrides auto-detection for every outbound message to that user.
-- `language_code` keeps holding whatever Telegram reports; resolution is
-- `preferred_language ?? language_code`.
ALTER TABLE users ADD COLUMN preferred_language TEXT;
