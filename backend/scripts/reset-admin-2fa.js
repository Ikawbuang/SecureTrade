// Turn two-step sign-in OFF for one account, when the phone and the recovery codes are both lost,
// or after JWT_SECRET was changed (saved secrets can then no longer be read).
// Only someone with the database password (backend/.env) can run this:
//
//   cd backend
//   node scripts/reset-admin-2fa.js admin@example.com
//
// The account then signs in with its password only, and an admin account must set two-step
// sign-in up again before it can open the admin panel. The reset is written in the activity log.
const { pool } = require('../lib/core');

(async () => {
  const email = String(process.argv[2] || '').trim().toLowerCase();
  if (!email) {
    console.log('Give the account email:  node scripts/reset-admin-2fa.js admin@example.com');
    process.exit(1);
  }
  const user = (await pool.query('SELECT user_id, username, role, totp_enabled_at FROM users WHERE email = $1', [email])).rows[0];
  if (!user) {
    console.log('No account has that email.');
    process.exit(1);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      'UPDATE users SET totp_secret = NULL, totp_pending_secret = NULL, totp_enabled_at = NULL, totp_last_step = NULL, session_id = NULL WHERE user_id = $1',
      [user.user_id]
    );
    await client.query('DELETE FROM recovery_codes WHERE user_id = $1', [user.user_id]);
    await client.query(
      `INSERT INTO activity_log (user_id, transaction_id, action, detail) VALUES ($1, NULL, 'twofa_reset', 'with the reset script')`,
      [user.user_id]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  console.log('Two-step sign-in is ' + (user.totp_enabled_at ? 'now off' : 'off (it was not on)') + ' for @' + user.username + ' (' + user.role + '). They were signed out everywhere.');
  await pool.end();
  process.exit(0);
})().catch(err => { console.error(err.message); process.exit(1); });
