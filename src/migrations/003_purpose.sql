-- migration 003: first-contact purpose (来意) + the /delete access reset.
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
