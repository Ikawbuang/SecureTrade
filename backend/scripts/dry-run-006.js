// Dry run of migrations/006_database_rules.sql. NOTHING IS SAVED.
//
//   cd backend
//   node scripts/dry-run-006.js
//
// It opens one transaction, applies the migration inside it, plays every trade step the server
// makes (and the mistakes the rules must stop) on made-up trades, and then ROLLS EVERYTHING BACK:
// the rules, the made-up trades, all of it. Made-up rows use ids from 900000001, so no real
// trade number is used up. While it runs (a few seconds) other queries on these tables wait.
const fs = require('fs');
const path = require('path');
const { pool } = require('../lib/core');

const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '006_database_rules.sql'), 'utf8')
  .replace(/^BEGIN;\s*$/m, '').replace(/^COMMIT;\s*$/m, '');   // this script holds the transaction itself

(async () => {
  const c = await pool.connect();
  let passed = 0, failed = 0;
  const say = (ok, name, extra = '') => { ok ? passed++ : failed++; console.log((ok ? '  ok    ' : '  FAIL  ') + name + (extra ? '  -> ' + extra : '')); };

  // A step that must work
  const works = async (name, fn) => {
    await c.query('SAVEPOINT s');
    try { await fn(); await c.query('SET CONSTRAINTS ALL IMMEDIATE'); await c.query('SET CONSTRAINTS ALL DEFERRED'); say(true, name); }
    catch (e) { say(false, name, e.message); }
    await c.query('ROLLBACK TO SAVEPOINT s');
  };
  // A step the rules must stop. "Saving" is forced with SET CONSTRAINTS ALL IMMEDIATE.
  const stopped = async (name, fn) => {
    await c.query('SAVEPOINT s');
    try { await fn(); await c.query('SET CONSTRAINTS ALL IMMEDIATE'); say(false, name, 'it was allowed'); }
    catch (e) { say(true, name, e.message.slice(0, 90)); }
    await c.query('ROLLBACK TO SAVEPOINT s');
    await c.query('SET CONSTRAINTS ALL DEFERRED');
  };

  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL lock_timeout = '5s'`);
    await c.query(sql);
    console.log('The migration applied without an error.\n');

    const users = (await c.query(`SELECT user_id FROM users WHERE role = 'user' ORDER BY user_id LIMIT 2`)).rows.map(r => r.user_id);
    if (users.length < 2) throw new Error('Two user accounts are needed for the made-up trades.');
    const [buyer, seller] = users;
    const T = 900000001;

    // The same statements, in the same order, as the server code
    const newTrade = () => c.query(
      `INSERT INTO transactions (transaction_id, buyer_id, seller_id, item_description, amount, created_by, item_type)
       OVERRIDING SYSTEM VALUE VALUES ($1, $2, $3, 'dry run', 200, $2, 'item')`, [T, buyer, seller]);
    const setStatus = s => c.query(`UPDATE transactions SET status = $1 WHERE transaction_id = $2`, [s, T]);
    const accept = () => setStatus('accepted');
    const pay = async () => {            // lib/escrow.js markTradePaid
      await c.query(`INSERT INTO escrow_payments (payment_id, transaction_id, payment_method, payer_number, amount_held, payment_status)
                     OVERRIDING SYSTEM VALUE VALUES ($1, $1, 'gcash', NULL, 200, 'held')`, [T]);
      await setStatus('paid');
    };
    const deliver = () => c.query(      // routes/trades.js deliver
      `UPDATE transactions SET status = 'delivered', delivered_at = now(), payout_method = 'gcash', payout_number = '09171234567' WHERE transaction_id = $1`, [T]);
    const release = async () => {        // lib/escrow.js releasePayment
      await c.query(`UPDATE escrow_payments SET payment_status = 'released', released_at = now() WHERE transaction_id = $1`, [T]);
      await setStatus('completed');
      await c.query(`INSERT INTO receipts (receipt_id, transaction_id, receipt_number) OVERRIDING SYSTEM VALUE VALUES ($1, $1, 'ST-DRYRUN') ON CONFLICT DO NOTHING`, [T]);
    };
    const refund = async () => {         // lib/escrow.js markPaymentRefunded, then the route
      await c.query(`UPDATE escrow_payments SET payment_status = 'refunded', released_at = now() WHERE transaction_id = $1`, [T]);
      await setStatus('refunded');
    };
    const log = () => c.query(`INSERT INTO activity_log (log_id, user_id, transaction_id, action, detail) OVERRIDING SYSTEM VALUE VALUES ($1, $2, $1, 'paid', 'dry run')`, [T, buyer]);

    console.log('Steps the server makes (all must work):');
    await works('create a request', newTrade);
    await works('request -> accepted', async () => { await newTrade(); await accept(); });
    await works('request -> cancelled (declined, cancelled or expired)', async () => { await newTrade(); await setStatus('cancelled'); });
    await works('accepted -> cancelled (before payment)', async () => { await newTrade(); await accept(); await setStatus('cancelled'); });
    await works('accepted -> paid, payment held', async () => { await newTrade(); await accept(); await pay(); });
    await works('paid -> delivered', async () => { await newTrade(); await accept(); await pay(); await deliver(); });
    await works('delivered -> completed, payment released, receipt', async () => { await newTrade(); await accept(); await pay(); await deliver(); await release(); });
    await works('paid -> refunded (seller or late-delivery cancel, admin refund)', async () => { await newTrade(); await accept(); await pay(); await refund(); });
    await works('delivered -> refunded (admin refund)', async () => { await newTrade(); await accept(); await pay(); await deliver(); await refund(); });
    await works('paid -> disputed -> refunded', async () => { await newTrade(); await accept(); await pay(); await setStatus('disputed'); await refund(); });
    await works('delivered -> disputed -> completed', async () => { await newTrade(); await accept(); await pay(); await deliver(); await setStatus('disputed'); await release(); });
    await works('a log line is added; chat on a trade', async () => { await newTrade(); await log(); await c.query(`INSERT INTO messages (transaction_id, sender_id, content) VALUES ($1, $2, 'hi')`, [T, buyer]); });
    await works('saving the same status again changes nothing', async () => { await newTrade(); await accept(); await accept(); });

    console.log('\nMistakes the rules must stop:');
    await stopped('request jumps straight to completed', async () => { await newTrade(); await setStatus('completed'); });
    await stopped('accepted -> delivered (skips payment)', async () => { await newTrade(); await accept(); await setStatus('delivered'); });
    await stopped('trade marked paid with no payment row', async () => { await newTrade(); await accept(); await setStatus('paid'); });
    await stopped('completed while the payment is still held', async () => { await newTrade(); await accept(); await pay(); await deliver(); await setStatus('completed'); });
    await stopped('payment released while the trade stays delivered', async () => { await newTrade(); await accept(); await pay(); await deliver(); await c.query(`UPDATE escrow_payments SET payment_status = 'released' WHERE transaction_id = $1`, [T]); });
    await stopped('payment released twice / refunded after release', async () => { await newTrade(); await accept(); await pay(); await deliver(); await release(); await c.query(`UPDATE escrow_payments SET payment_status = 'refunded' WHERE transaction_id = $1`, [T]); });
    await stopped('completed trade reopened as refunded', async () => { await newTrade(); await accept(); await pay(); await deliver(); await release(); await setStatus('refunded'); });
    await stopped('cancelled trade revived as accepted', async () => { await newTrade(); await setStatus('cancelled'); await setStatus('accepted'); });
    await stopped('payment taken for a cancelled trade', async () => { await newTrade(); await setStatus('cancelled'); await c.query(`INSERT INTO escrow_payments (payment_id, transaction_id, payment_method, amount_held, payment_status) OVERRIDING SYSTEM VALUE VALUES ($1, $1, 'gcash', 200, 'held')`, [T]); });
    await stopped('price changed after the trade was made', async () => { await newTrade(); await c.query(`UPDATE transactions SET amount = 1 WHERE transaction_id = $1`, [T]); });
    await stopped('the person who made the request changed', async () => { await newTrade(); await c.query(`UPDATE transactions SET created_by = $2 WHERE transaction_id = $1`, [T, seller]); });
    await stopped('held amount changed', async () => { await newTrade(); await accept(); await pay(); await c.query(`UPDATE escrow_payments SET amount_held = 1 WHERE transaction_id = $1`, [T]); });
    await stopped('payment row deleted while the trade is paid', async () => { await newTrade(); await accept(); await pay(); await c.query(`DELETE FROM escrow_payments WHERE transaction_id = $1`, [T]); });
    await stopped('trade with a payment deleted', async () => { await newTrade(); await accept(); await pay(); await c.query(`DELETE FROM transactions WHERE transaction_id = $1`, [T]); });
    await stopped('trade with a log line deleted', async () => { await newTrade(); await log(); await c.query(`DELETE FROM transactions WHERE transaction_id = $1`, [T]); });
    await stopped('log line edited', async () => { await newTrade(); await log(); await c.query(`UPDATE activity_log SET detail = 'changed' WHERE log_id = $1`, [T]); });
    await stopped('log line deleted', async () => { await newTrade(); await log(); await c.query(`DELETE FROM activity_log WHERE log_id = $1`, [T]); });
    await stopped('a new trade that does not start as pending', () => c.query(
      `INSERT INTO transactions (transaction_id, buyer_id, seller_id, item_description, amount, created_by, item_type, status)
       OVERRIDING SYSTEM VALUE VALUES ($1, $2, $3, 'dry run', 200, $2, 'item', 'completed')`, [T, buyer, seller]));
    await stopped('email saved with capital letters', () => c.query(`UPDATE users SET email = upper(email) WHERE user_id = $1`, [buyer]));
    await stopped('checkout saved with an unknown status', async () => { await newTrade(); await c.query(`INSERT INTO xendit_sessions (session_id, transaction_id, amount, status, expires_at) VALUES ('dry-run', $1, 200, 'PAID', now())`, [T]); });

    console.log('\nExisting data:');
    const bad = (await c.query(`
      SELECT count(*) AS n FROM transactions t LEFT JOIN escrow_payments p USING (transaction_id)
      WHERE p.payment_status::text IS DISTINCT FROM (CASE WHEN t.status IN ('paid','delivered','disputed') THEN 'held'
            WHEN t.status = 'completed' THEN 'released' WHEN t.status = 'refunded' THEN 'refunded' END)`)).rows[0].n;
    say(bad === '0', 'every existing trade already agrees with its payment', bad === '0' ? '' : bad + ' do not');
  } catch (e) {
    failed++;
    console.log('\nSTOPPED: ' + e.message);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }

  // Proof that nothing was left behind
  const left = (await pool.query(`SELECT
      (SELECT count(*) FROM pg_proc WHERE proname LIKE 'st\\_%' AND pronamespace = 'public'::regnamespace) AS functions,
      (SELECT count(*) FROM transactions WHERE transaction_id >= 900000000) AS trades,
      (to_regclass('public.paymongo_checkouts') IS NOT NULL) AS old_table_still_there`)).rows[0];
  console.log('\nRolled back. Left behind: ' + left.functions + ' rule functions, ' + left.trades + ' made-up trades. Old table still there: ' + left.old_table_still_there);
  console.log('\n' + passed + ' passed, ' + failed + ' failed.');
  await pool.end();
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e.message); process.exit(1); });
