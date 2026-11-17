-- Two-step sign-in for admins: a 6-digit code from an authenticator app, after the password.
-- This only adds empty columns and one empty table. Nothing changes for anyone until an admin
-- account sets it up. Once this is run, each admin must set it up before using the admin panel.
-- Safe to run more than once. Run it in the Supabase SQL Editor.
BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS totp_secret          text,          -- the authenticator secret, encrypted by the server
  ADD COLUMN IF NOT EXISTS totp_pending_secret  text,          -- a new secret being set up, not active yet
  ADD COLUMN IF NOT EXISTS totp_enabled_at      timestamptz,   -- when two-step sign-in was turned on
  ADD COLUMN IF NOT EXISTS totp_last_step       bigint;        -- the last code used, so a code never works twice

-- On means there is a secret, and off means there is none
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_totp_complete,
  ADD CONSTRAINT users_totp_complete CHECK ((totp_enabled_at IS NULL) = (totp_secret IS NULL));

-- Recovery codes for a lost phone: 8 per account, each works once. Only a hash of each is saved.
CREATE TABLE IF NOT EXISTS recovery_codes (
  code_id     bigint       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     bigint       NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  code_hash   text         NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz  NOT NULL DEFAULT now(),
  UNIQUE (user_id, code_hash)
);

-- Same protection as every other table: only the server may read or change it
ALTER TABLE recovery_codes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON recovery_codes FROM anon, authenticated;

COMMIT;
