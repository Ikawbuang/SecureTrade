-- Database rules that protect money records even if the server code has a bug.
-- Until now only the server enforced them. Nothing here changes existing rows.
-- Everything runs as one unit: if any step fails, none of it is saved.
-- Safe to run more than once. Run it in the Supabase SQL Editor.
--
-- To correct data by hand later (for example to remove test trades), an owner can switch a rule
-- off for a moment:   ALTER TABLE transactions DISABLE TRIGGER trade_rules;   ... ENABLE TRIGGER ...
BEGIN;


-- ---------------------------------------------------------------------------------------------
-- 1. A trade's records cannot be deleted along with it
-- ---------------------------------------------------------------------------------------------
-- Deleting a trade used to delete its payment, receipt, dispute, evidence, chat, ratings and log
-- without a word (ON DELETE CASCADE). Now the database refuses to delete a trade that has any.
ALTER TABLE escrow_payments DROP CONSTRAINT IF EXISTS escrow_payments_transaction_id_fkey,
  ADD CONSTRAINT escrow_payments_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id);
ALTER TABLE receipts DROP CONSTRAINT IF EXISTS receipts_transaction_id_fkey,
  ADD CONSTRAINT receipts_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id);
ALTER TABLE disputes DROP CONSTRAINT IF EXISTS disputes_transaction_id_fkey,
  ADD CONSTRAINT disputes_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id);
ALTER TABLE evidence DROP CONSTRAINT IF EXISTS evidence_dispute_id_fkey,
  ADD CONSTRAINT evidence_dispute_id_fkey FOREIGN KEY (dispute_id) REFERENCES disputes(dispute_id);
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_transaction_id_fkey,
  ADD CONSTRAINT messages_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id);
ALTER TABLE ratings DROP CONSTRAINT IF EXISTS ratings_transaction_id_fkey,
  ADD CONSTRAINT ratings_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id);
ALTER TABLE activity_log DROP CONSTRAINT IF EXISTS activity_log_transaction_id_fkey,
  ADD CONSTRAINT activity_log_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id);
ALTER TABLE xendit_sessions DROP CONSTRAINT IF EXISTS xendit_sessions_transaction_id_fkey,
  ADD CONSTRAINT xendit_sessions_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES transactions(transaction_id);


-- ---------------------------------------------------------------------------------------------
-- 2. The activity log can only be added to
-- ---------------------------------------------------------------------------------------------
-- The server reads payment times and admin decisions from this log, so a changed or deleted line
-- could change what happens to a trade. One change stays possible: when a user is deleted, the
-- database empties their id on their old lines.
CREATE OR REPLACE FUNCTION st_activity_log_keep() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'The activity log cannot be deleted from.';
  END IF;
  IF NEW.user_id IS NULL
     AND NEW.log_id = OLD.log_id
     AND NEW.transaction_id IS NOT DISTINCT FROM OLD.transaction_id
     AND NEW.action = OLD.action
     AND NEW.detail IS NOT DISTINCT FROM OLD.detail
     AND NEW.created_at = OLD.created_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'The activity log cannot be changed.';
END $$;

DROP TRIGGER IF EXISTS activity_log_keep ON activity_log;
CREATE TRIGGER activity_log_keep BEFORE UPDATE OR DELETE ON activity_log
  FOR EACH ROW EXECUTE FUNCTION st_activity_log_keep();


-- ---------------------------------------------------------------------------------------------
-- 3. A trade can only move forward along the allowed steps
-- ---------------------------------------------------------------------------------------------
--   pending   -> accepted, cancelled
--   accepted  -> paid, cancelled
--   paid      -> delivered, disputed, refunded
--   delivered -> completed, disputed, refunded
--   disputed  -> completed, refunded
--   completed, refunded, cancelled: finished, no further change
-- The price and the two people can never change after the trade is created.
CREATE OR REPLACE FUNCTION st_trade_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending' THEN
      RAISE EXCEPTION 'A new trade must start as "pending", not "%".', NEW.status;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.amount <> OLD.amount OR NEW.buyer_id <> OLD.buyer_id OR NEW.seller_id <> OLD.seller_id
     OR NEW.created_by <> OLD.created_by THEN
    RAISE EXCEPTION 'The price and the people of trade % cannot be changed.', OLD.transaction_id;
  END IF;

  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF (OLD.status = 'pending'   AND NEW.status IN ('accepted', 'cancelled'))
  OR (OLD.status = 'accepted'  AND NEW.status IN ('paid', 'cancelled'))
  OR (OLD.status = 'paid'      AND NEW.status IN ('delivered', 'disputed', 'refunded'))
  OR (OLD.status = 'delivered' AND NEW.status IN ('completed', 'disputed', 'refunded'))
  OR (OLD.status = 'disputed'  AND NEW.status IN ('completed', 'refunded')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Trade % cannot go from "%" to "%".', OLD.transaction_id, OLD.status, NEW.status;
END $$;

DROP TRIGGER IF EXISTS trade_rules ON transactions;
CREATE TRIGGER trade_rules BEFORE INSERT OR UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION st_trade_rules();


-- ---------------------------------------------------------------------------------------------
-- 4. A held payment can only be released or refunded, once, and its amount never changes
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION st_payment_rules() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.payment_status NOT IN ('pending', 'held') THEN
      RAISE EXCEPTION 'A new payment must start as "held", not "%".', NEW.payment_status;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.amount_held <> OLD.amount_held OR NEW.transaction_id <> OLD.transaction_id THEN
    RAISE EXCEPTION 'The amount and the trade of payment % cannot be changed.', OLD.payment_id;
  END IF;

  IF NEW.payment_status = OLD.payment_status THEN
    RETURN NEW;
  END IF;
  IF (OLD.payment_status = 'pending' AND NEW.payment_status = 'held')
  OR (OLD.payment_status = 'held'    AND NEW.payment_status IN ('released', 'refunded')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Payment % cannot go from "%" to "%".', OLD.payment_id, OLD.payment_status, NEW.payment_status;
END $$;

DROP TRIGGER IF EXISTS payment_rules ON escrow_payments;
CREATE TRIGGER payment_rules BEFORE INSERT OR UPDATE ON escrow_payments
  FOR EACH ROW EXECUTE FUNCTION st_payment_rules();


-- ---------------------------------------------------------------------------------------------
-- 5. A trade and its payment must always agree
-- ---------------------------------------------------------------------------------------------
--   pending, accepted, cancelled : no payment
--   paid, delivered, disputed    : payment held
--   completed                    : payment released
--   refunded                     : payment refunded
-- The server changes the payment and the trade in two steps inside one transaction, so this is
-- checked when that transaction is saved (a deferred check), not between the two steps.
CREATE OR REPLACE FUNCTION st_money_matches() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  trade_id      bigint;
  trade_status  text;
  pay_status    text;
  expected      text;
BEGIN
  IF TG_OP = 'DELETE' THEN trade_id := OLD.transaction_id; ELSE trade_id := NEW.transaction_id; END IF;

  SELECT status::text INTO trade_status FROM transactions WHERE transaction_id = trade_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  SELECT payment_status::text INTO pay_status FROM escrow_payments WHERE transaction_id = trade_id;

  expected := CASE
    WHEN trade_status IN ('paid', 'delivered', 'disputed') THEN 'held'
    WHEN trade_status = 'completed' THEN 'released'
    WHEN trade_status = 'refunded'  THEN 'refunded'
    ELSE NULL
  END;
  IF pay_status IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'Trade % is "%" but its payment is "%" (it should be "%").',
      trade_id, trade_status, COALESCE(pay_status, 'missing'), COALESCE(expected, 'missing');
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trade_money_matches ON transactions;
CREATE CONSTRAINT TRIGGER trade_money_matches AFTER INSERT OR UPDATE ON transactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION st_money_matches();

DROP TRIGGER IF EXISTS payment_money_matches ON escrow_payments;
CREATE CONSTRAINT TRIGGER payment_money_matches AFTER INSERT OR UPDATE OR DELETE ON escrow_payments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION st_money_matches();

-- Nobody calls these directly; they only run from the triggers above
REVOKE ALL ON FUNCTION st_activity_log_keep(), st_trade_rules(), st_payment_rules(), st_money_matches()
  FROM PUBLIC, anon, authenticated;


-- ---------------------------------------------------------------------------------------------
-- 6. Smaller rules
-- ---------------------------------------------------------------------------------------------
-- Emails are saved in small letters, so Ana@x.com and ana@x.com can never be two accounts
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_lowercase,
  ADD CONSTRAINT users_email_lowercase CHECK (email = lower(email));

-- Only the values the server uses
ALTER TABLE xendit_sessions DROP CONSTRAINT IF EXISTS xendit_sessions_status_check,
  ADD CONSTRAINT xendit_sessions_status_check CHECK (status IN ('ACTIVE', 'COMPLETED', 'EXPIRED', 'CANCELED'));
ALTER TABLE review_reports DROP CONSTRAINT IF EXISTS review_reports_status_check,
  ADD CONSTRAINT review_reports_status_check CHECK (status IN ('open', 'resolved', 'dismissed'));

-- A report must point at a review that exists
ALTER TABLE review_reports DROP CONSTRAINT IF EXISTS review_reports_review_ref_fkey,
  ADD CONSTRAINT review_reports_review_ref_fkey FOREIGN KEY (review_ref) REFERENCES ratings(review_ref);


-- ---------------------------------------------------------------------------------------------
-- 7. Indexes on the columns that link tables (faster lookups as the tables grow)
-- ---------------------------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_transactions_created_by   ON transactions (created_by);
CREATE INDEX IF NOT EXISTS idx_transactions_cancelled_by ON transactions (cancelled_by);
CREATE INDEX IF NOT EXISTS idx_messages_sender           ON messages (sender_id);
CREATE INDEX IF NOT EXISTS idx_disputes_filed_by         ON disputes (filed_by);
CREATE INDEX IF NOT EXISTS idx_disputes_resolved_by      ON disputes (resolved_by);
CREATE INDEX IF NOT EXISTS idx_evidence_submitted_by     ON evidence (submitted_by);
CREATE INDEX IF NOT EXISTS idx_ratings_rated_by          ON ratings (rated_by);
CREATE INDEX IF NOT EXISTS idx_ratings_deleted_by        ON ratings (deleted_by);
CREATE INDEX IF NOT EXISTS idx_verifications_decided_by  ON verifications (decided_by);
CREATE INDEX IF NOT EXISTS idx_favorites_favorite_user   ON favorites (favorite_user_id);
CREATE INDEX IF NOT EXISTS idx_rate_dismissals_trade     ON rate_dismissals (transaction_id);
CREATE INDEX IF NOT EXISTS idx_trade_attempts_from       ON trade_attempts (from_user_id);
CREATE INDEX IF NOT EXISTS idx_support_messages_sender   ON support_messages (sender_id);
CREATE INDEX IF NOT EXISTS idx_review_reports_reporter   ON review_reports (reported_by);
CREATE INDEX IF NOT EXISTS idx_delivery_proofs_submitter ON delivery_proofs (submitted_by);

-- disputes already has a unique index on transaction_id; this second one only repeats it
DROP INDEX IF EXISTS idx_disputes_transaction;


-- ---------------------------------------------------------------------------------------------
-- 8. Remove leftovers the server no longer uses (only if they are empty)
-- ---------------------------------------------------------------------------------------------
DO $$
BEGIN
  IF to_regclass('public.paymongo_checkouts') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM paymongo_checkouts) THEN
      RAISE EXCEPTION 'paymongo_checkouts is not empty, so it was not removed. Nothing was changed.';
    END IF;
    DROP TABLE paymongo_checkouts;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'verifications' AND column_name = 'typed_first') THEN
    IF EXISTS (SELECT 1 FROM verifications WHERE typed_first IS NOT NULL OR typed_last IS NOT NULL) THEN
      RAISE EXCEPTION 'verifications.typed_first / typed_last hold data, so they were not removed. Nothing was changed.';
    END IF;
    ALTER TABLE verifications DROP COLUMN typed_first, DROP COLUMN typed_last;
  END IF;
END $$;


COMMIT;
