-- Refunds now save when the money left escrow (released_at), like releases already did.
-- This fills in the time for refunds made before that change, from the activity log.
-- Safe to run more than once. Run it in the Supabase SQL Editor.
UPDATE escrow_payments e
SET released_at = (
  SELECT max(a.created_at) FROM activity_log a
  WHERE a.transaction_id = e.transaction_id
    AND a.action IN ('dispute_resolved', 'seller_cancelled', 'admin_refund')
)
WHERE e.payment_status = 'refunded' AND e.released_at IS NULL;
