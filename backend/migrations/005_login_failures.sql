-- Wrong-password counts, kept in the database so a restart or a new deploy does not forget them.
-- Before this, the counts lived in the server's memory: every deploy gave an attacker a fresh start.
-- "key" is a fingerprint (SHA-256) of the visitor's address + the email typed, never the email itself.
-- Safe to run more than once. Run it in the Supabase SQL Editor.
CREATE TABLE IF NOT EXISTS login_failures (
  key       text        PRIMARY KEY,
  count     integer     NOT NULL DEFAULT 1 CHECK (count > 0),
  reset_at  timestamptz NOT NULL
);

-- Old counts are deleted by the server once an hour; this index keeps that fast
CREATE INDEX IF NOT EXISTS login_failures_reset_idx ON login_failures (reset_at);

-- Same protection as every other table: only the server may read or change it
ALTER TABLE login_failures ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON login_failures FROM anon, authenticated;
