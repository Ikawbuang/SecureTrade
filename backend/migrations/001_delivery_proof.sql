-- Delivery proof and a longer protection period for game accounts.
-- Safe to run more than once. Run it in the Supabase SQL Editor.
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS item_type VARCHAR(10) NOT NULL DEFAULT 'item'
  CHECK (item_type IN ('account', 'item', 'currency'));

CREATE TABLE IF NOT EXISTS delivery_proofs (
  proof_id       BIGSERIAL PRIMARY KEY,
  transaction_id BIGINT NOT NULL REFERENCES transactions(transaction_id),
  submitted_by   BIGINT NOT NULL REFERENCES users(user_id),
  file_url       TEXT NOT NULL,
  description    TEXT,
  uploaded_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS delivery_proofs_transaction_idx ON delivery_proofs (transaction_id);
ALTER TABLE delivery_proofs ENABLE ROW LEVEL SECURITY;
