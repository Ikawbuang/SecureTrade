-- QR Ph payments (scan with GCash, Maya, or a bank app).
-- A QR code is saved in the same table as a checkout page, marked with kind = 'qr'.
-- Safe to run more than once. Run it in the Supabase SQL Editor.
ALTER TABLE xendit_sessions
  ADD COLUMN IF NOT EXISTS kind VARCHAR(10) NOT NULL DEFAULT 'session'
  CHECK (kind IN ('session', 'qr'));
ALTER TABLE xendit_sessions ADD COLUMN IF NOT EXISTS qr_string TEXT;
ALTER TABLE xendit_sessions ALTER COLUMN payment_link_url DROP NOT NULL;
