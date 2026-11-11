const { LOGIN_LIMIT_MINUTES, currentLoginFailure, loginFailures } = require('./auth');
const { ACCOUNT_HOLD_HOURS, AUTO_RELEASE_HOURS, JOIN_BUYER_SELLER, REQUEST_EXPIRE_HOURS, logActivity, pool, queryAll, queryOne, withTx } = require('./core');
const { releasePayment } = require('./escrow');
const { checkoutEnabled, syncSessionSafely } = require('./xendit');



// Background jobs. They are started only when the server really runs, not in tests.
function startJobs() {

  // Clean up old PINs and old notices once an hour
  setInterval(() => {
    pool.query(`DELETE FROM email_pins WHERE expires_at < now() - interval '1 day'`).catch(() => {});
    pool.query(`DELETE FROM email_changes WHERE expires_at < now() - interval '1 day'`).catch(() => {});
    pool.query(`DELETE FROM trade_attempts WHERE created_at < now() - interval '30 days'`).catch(() => {});
    pool.query(`DELETE FROM rate_dismissals WHERE created_at < now() - interval '30 days'`).catch(() => {});
  }, 60 * 60 * 1000);


  // Forget old counts so the list does not keep growing
  setInterval(() => {
    for (const key of loginFailures.keys()) {
      if (!currentLoginFailure(key)) loginFailures.delete(key);
    }
  }, LOGIN_LIMIT_MINUTES * 60000);


  // Every minute, check the checkout pages that are still open (a page stays checkable for an hour after it expires)
  setInterval(async () => {
    if (!checkoutEnabled) return;
    try {
      const open = await queryAll(
        pool,
        `SELECT session_id FROM xendit_sessions
         WHERE status = 'ACTIVE' AND created_at < now() - interval '1 minute' AND expires_at > now() - interval '1 hour'
         ORDER BY created_at LIMIT 20`
      );
      for (const { session_id: sessionId } of open) await syncSessionSafely(sessionId);
    } catch (err) {
      console.error('Checkout check failed:', err.message);
    }
  }, 60 * 1000);


  // Requests nobody answers are cancelled after 12 hours
  setInterval(async () => {
    try {
      const expired = await pool.query(
        `UPDATE transactions SET status = 'cancelled'
         WHERE status = 'pending' AND created_at < now() - interval '${REQUEST_EXPIRE_HOURS} hours'
         RETURNING transaction_id`
      );
      for (const row of expired.rows) {
        await logActivity(pool, null, row.transaction_id, 'request_expired', 'nobody answered in ' + REQUEST_EXPIRE_HOURS + ' hours');
      }
    } catch (err) {
      console.error('Request expiry failed:', err.message);
    }
  }, 60 * 1000);


  // Auto-release: if the buyer does nothing for AUTO_RELEASE_HOURS after delivery, pay the seller.
  // A trade in dispute is not released, and neither is a trade where the buyer or the seller is
  // suspended or banned: it waits for an admin to decide.
  setInterval(async () => {
    try {
      const due = await pool.query(
        `SELECT t.transaction_id
         FROM transactions t
         ${JOIN_BUYER_SELLER}
         WHERE t.status = 'delivered'
           AND t.delivered_at < now() - make_interval(hours => CASE t.item_type WHEN 'account' THEN ${ACCOUNT_HOLD_HOURS} ELSE ${AUTO_RELEASE_HOURS} END)
           AND b.account_status::text = 'active' AND s.account_status::text = 'active'`
      );
      for (const row of due.rows) {
        await withTx(async client => {
          const t = await queryOne(
            client,
            `SELECT t.status, b.account_status::text AS buyer_status, s.account_status::text AS seller_status
             FROM transactions t
             ${JOIN_BUYER_SELLER}
             WHERE t.transaction_id = $1
             FOR UPDATE OF t`,
            [row.transaction_id]
          );
          if (t && t.status === 'delivered' && t.buyer_status === 'active' && t.seller_status === 'active') {
            await releasePayment(client, row.transaction_id);
            await logActivity(client, null, row.transaction_id, 'auto_released', null);
          }
        });
      }
    } catch (err) {
      console.error('Auto-release failed:', err.message);
    }
  }, 60 * 1000);
}

module.exports = { startJobs };
