const fs = require('fs');
const path = require('path');
const { LOGIN_LIMIT_MINUTES, currentLoginFailure, loginFailures } = require('./auth');
const { ACCOUNT_HOLD_HOURS, AUTO_RELEASE_HOURS, DELIVERY_DUE_HOURS, JOIN_BUYER_SELLER, PAID_AT_SQL, PAYMENT_DUE_HOURS, REQUEST_EXPIRE_HOURS, logActivity, pool, queryAll, queryOne, withTx } = require('./core');
const { manilaTime, notify, peso } = require('./notify');
const { releasePayment } = require('./escrow');
const { VERIF_DIR, removeSavedFile, storage } = require('./uploads');
const { cancelOpenCheckouts, checkoutEnabled, syncSessionSafely, syncTradeCheckouts } = require('./xendit');

// A picture younger than this may still be in the middle of being submitted, so it is left alone
const UPLOAD_GRACE_MS = 60 * 60 * 1000;



// Background jobs. They are started only when the server really runs, not in tests.
function startJobs() {

  // ID pictures must not outlive the admin's decision: check now, then once an hour
  cleanupVerificationFiles();
  setInterval(cleanupVerificationFiles, 60 * 60 * 1000);

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
         RETURNING transaction_id, created_by`
      );
      for (const row of expired.rows) {
        await logActivity(pool, null, row.transaction_id, 'request_expired', 'nobody answered in ' + REQUEST_EXPIRE_HOURS + ' hours');
        await notify(pool, [row.created_by], row.transaction_id, 'Your trade request expired because nobody answered in ' + REQUEST_EXPIRE_HOURS + ' hours.');
      }
    } catch (err) {
      console.error('Request expiry failed:', err.message);
    }
  }, 60 * 1000);


  // Accepted trades the buyer never pays for are cancelled after PAYMENT_DUE_HOURS
  setInterval(cancelUnpaidTrades, 5 * 60 * 1000);

  // Reminders before an auto-release and about late deliveries
  setInterval(sendReminders, 15 * 60 * 1000);


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
            `SELECT t.status, t.buyer_id, b.account_status::text AS buyer_status, s.account_status::text AS seller_status
             FROM transactions t
             ${JOIN_BUYER_SELLER}
             WHERE t.transaction_id = $1
             FOR UPDATE OF t`,
            [row.transaction_id]
          );
          if (t && t.status === 'delivered' && t.buyer_status === 'active' && t.seller_status === 'active') {
            await releasePayment(client, row.transaction_id, 'The buyer did not report a problem in time, so the payment was released automatically.');
            await logActivity(client, null, row.transaction_id, 'auto_released', null);
            await notify(client, [t.buyer_id], row.transaction_id, 'The payment was released to the seller automatically, because no problem was reported in time.');
          }
        });
      }
    } catch (err) {
      console.error('Auto-release failed:', err.message);
    }
  }, 60 * 1000);
}

// The time of acceptance comes from the activity log. Xendit is asked first, so a payment
// made a moment ago is counted, and a trade with a checkout page still open is left alone.
// A payment that still arrives later is flagged for an admin (see completeCheckout).
async function cancelUnpaidTrades() {
  try {
    const due = await queryAll(
      pool,
      `SELECT t.transaction_id
       FROM transactions t
       WHERE t.status = 'accepted'
         AND COALESCE((SELECT max(a.created_at) FROM activity_log a
                       WHERE a.transaction_id = t.transaction_id AND a.action = 'trade_accepted'), t.created_at)
             < now() - make_interval(hours => ${PAYMENT_DUE_HOURS})
       ORDER BY t.transaction_id LIMIT 20`
    );
    for (const { transaction_id: tradeId } of due) {
      await syncTradeCheckouts(tradeId);
      const cancelled = await withTx(async client => {
        const t = await queryOne(client, 'SELECT status, buyer_id, seller_id FROM transactions WHERE transaction_id = $1 FOR UPDATE', [tradeId]);
        if (!t || t.status !== 'accepted') return false;
        const paying = await queryOne(client,
          `SELECT 1 FROM xendit_sessions WHERE transaction_id = $1 AND status = 'ACTIVE' AND expires_at > now()`, [tradeId]);
        if (paying) return false;
        await client.query(
          `UPDATE transactions SET status = 'cancelled', cancel_reason = $1 WHERE transaction_id = $2`,
          ['Not paid within ' + PAYMENT_DUE_HOURS + ' hours', tradeId]
        );
        await logActivity(client, null, tradeId, 'payment_expired', 'the buyer did not pay within ' + PAYMENT_DUE_HOURS + ' hours');
        await notify(client, [t.buyer_id, t.seller_id], tradeId, 'The trade was cancelled because the buyer did not pay within ' + PAYMENT_DUE_HOURS + ' hours.');
        return true;
      });
      if (cancelled) await cancelOpenCheckouts(tradeId);
    }
  } catch (err) {
    console.error('Unpaid trade check failed:', err.message);
  }
}

async function listFolder(dir) {
  const out = [];
  for (const name of await fs.promises.readdir(dir)) {
    const stat = await fs.promises.stat(path.join(dir, name));
    if (stat.isFile()) out.push({ name, savedAt: stat.mtimeMs });
  }
  return out;
}

// Delete every ID picture and selfie that no pending verification needs any more.
// The admin's decision already deletes them; this catches any that were left behind.
async function cleanupVerificationFiles(dir = VERIF_DIR) {
  try {
    const pending = await queryAll(pool, `SELECT id_file, selfie_file FROM verifications WHERE status = 'pending'`);
    const keep = new Set(pending.flatMap(v => [v.id_file, v.selfie_file]).filter(Boolean).map(name => path.basename(name)));
    let removed = 0;
    // The real ID folder may be on disk or in the bucket; any other folder (the tests) is on disk
    const files = dir === VERIF_DIR ? await storage.list('verifications') : await listFolder(dir);
    for (const { name, savedAt } of files) {
      if (keep.has(name) || Date.now() - savedAt < UPLOAD_GRACE_MS) continue;
      await removeSavedFile(dir, name);
      removed++;
    }
    if (removed) console.log('Removed ' + removed + ' leftover ID picture(s).');
  } catch (err) {
    console.error('ID picture cleanup failed:', err.message);
  }
}

// Each reminder is sent once per trade: the activity log remembers it was sent.
const RELEASE_REMINDER_HOURS = 6;
const REMINDERS = [
  {
    // The buyer: the payment releases soon
    action: 'reminder_release',
    sql: `SELECT t.transaction_id, t.buyer_id, t.amount, s.username AS seller,
                  t.delivered_at + make_interval(hours => CASE t.item_type WHEN 'account' THEN ${ACCOUNT_HOLD_HOURS} ELSE ${AUTO_RELEASE_HOURS} END) AS release_at
           FROM transactions t JOIN users s ON s.user_id = t.seller_id
           WHERE t.status = 'delivered'
             AND t.delivered_at + make_interval(hours => CASE t.item_type WHEN 'account' THEN ${ACCOUNT_HOLD_HOURS} ELSE ${AUTO_RELEASE_HOURS} END)
                 BETWEEN now() AND now() + interval '${RELEASE_REMINDER_HOURS} hours'`,
    send: r => [[r.buyer_id], 'Reminder: ' + peso(r.amount) + ' releases to @' + r.seller + ' on ' + manilaTime(r.release_at) + '. If something is wrong with the item, report it on the trade page before then.'],
  },
  {
    // The seller: half the delivery time has passed
    action: 'reminder_delivery',
    sql: `SELECT t.transaction_id, t.seller_id, t.amount, ${PAID_AT_SQL} AS paid_at FROM transactions t
           WHERE t.status = 'paid' AND ${PAID_AT_SQL} < now() - interval '${DELIVERY_DUE_HOURS / 2} hours'`,
    send: r => [[r.seller_id], 'Please deliver: the buyer paid ' + peso(r.amount) + ' on ' + manilaTime(r.paid_at) + '. If it is not delivered by '
      + manilaTime(new Date(r.paid_at).getTime() + DELIVERY_DUE_HOURS * 3600000) + ', the buyer can cancel and get a full refund.'],
  },
  {
    // Both: the delivery deadline passed, so the buyer may now cancel
    action: 'delivery_overdue',
    sql: `SELECT t.transaction_id, t.buyer_id, t.seller_id FROM transactions t
           WHERE t.status = 'paid' AND ${PAID_AT_SQL} < now() - interval '${DELIVERY_DUE_HOURS} hours'`,
    send: r => [[r.buyer_id, r.seller_id], 'The item was not delivered within ' + DELIVERY_DUE_HOURS + ' hours. The buyer can now cancel on the trade page and get a full refund, or keep waiting.'],
  },
];

async function sendReminders() {
  for (const reminder of REMINDERS) {
    try {
      const due = await queryAll(pool, `SELECT * FROM (${reminder.sql}) r
         WHERE NOT EXISTS (SELECT 1 FROM activity_log a WHERE a.transaction_id = r.transaction_id AND a.action = '${reminder.action}')
         LIMIT 50`);
      for (const row of due) {
        await logActivity(pool, null, row.transaction_id, reminder.action, null);
        const [userIds, text] = reminder.send(row);
        await notify(pool, userIds, row.transaction_id, text);
      }
    } catch (err) {
      console.error('Reminder ' + reminder.action + ' failed:', err.message);
    }
  }
}

module.exports = { startJobs, cancelUnpaidTrades, cleanupVerificationFiles, sendReminders };
