const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const { auth, assertLoginAllowed, recordLoginFailure, clearLoginFailures } = require('../lib/auth');
const { HttpError, logActivity, pool, queryOne, route, withTx } = require('../lib/core');
const { sendSecurityNotice } = require('../lib/mail');
const { checkSecondFactor, decryptSecret, encryptSecret, getTwoFactor, hashRecovery, matchStep, newRecoveryCodes, newSecret, otpauthUrl } = require('../lib/totp');


const NOT_READY = 'Two-step sign-in is not available on this server yet (migration 007 was not run).';

// Replace this user's recovery codes with 8 new ones. The plain codes are returned once and never saved.
async function replaceRecoveryCodes(client, userId) {
  const codes = newRecoveryCodes();
  await client.query('DELETE FROM recovery_codes WHERE user_id = $1', [userId]);
  for (const code of codes) {
    await client.query('INSERT INTO recovery_codes (user_id, code_hash) VALUES ($1, $2)', [userId, hashRecovery(code)]);
  }
  return codes;
}


// Adds these routes to the app
function register(app) {

  // ---------- Two-step sign-in (authenticator app). Required for admin accounts. ----------

  // Where I stand: is it on, must I set it up, how many recovery codes are left
  app.get('/api/2fa', auth, route(async (req, res) => {
    const two = await getTwoFactor(pool, req.user.user_id);
    let left = 0;
    if (two.enabled) {
      left = Number((await queryOne(pool, 'SELECT COUNT(*) AS n FROM recovery_codes WHERE user_id = $1 AND used_at IS NULL', [req.user.user_id])).n);
    }
    res.json({ available: two.available, enabled: two.enabled, required: two.required, recovery_codes_left: left });
  }));


  // Step 1: my password, then a new secret to scan as a QR code. Nothing is switched on yet.
  // Replacing a working setup (new phone) also needs a current code or a recovery code.
  app.post('/api/2fa/setup', auth, route(async (req, res) => {
    const id = req.user.user_id;
    const two = await getTwoFactor(pool, id);
    if (!two.available) throw new HttpError(503, NOT_READY);
    if (!two.required) throw new HttpError(403, 'Two-step sign-in is for admin accounts for now.');

    const me = await queryOne(pool, 'SELECT username, email, password_hash FROM users WHERE user_id = $1', [id]);
    if (!(await bcrypt.compare(String(req.body.password || ''), me.password_hash))) {
      throw new HttpError(400, 'Your password is wrong.');
    }
    if (two.enabled) await checkSecondFactor(id, req.body.code);

    const secret = newSecret();
    await pool.query('UPDATE users SET totp_pending_secret = $1 WHERE user_id = $2', [encryptSecret(secret), id]);
    res.json({
      secret,
      account: me.email,
      qr_image: await QRCode.toDataURL(otpauthUrl(me.email, secret), { margin: 1, width: 240, errorCorrectionLevel: 'M' }),
    });
  }));


  // Step 2: one code from the app proves it was scanned. Two-step sign-in is now on,
  // and the 8 recovery codes are shown this one time.
  app.post('/api/2fa/enable', auth, route(async (req, res) => {
    const id = req.user.user_id;
    const two = await getTwoFactor(pool, id);
    if (!two.available) throw new HttpError(503, NOT_READY);
    if (!two.pending) throw new HttpError(409, 'Start the setup again: there is no QR code waiting.');

    const key = 'totp|' + id;
    await assertLoginAllowed(key);
    let secret;
    try { secret = decryptSecret(two.pending); } catch { throw new HttpError(409, 'Start the setup again.'); }
    const step = matchStep(secret, req.body.code, null);
    if (step === null) {
      await recordLoginFailure(key);
      throw new HttpError(400, 'Wrong code. Check the 6-digit code in your authenticator app, and that your phone\'s clock is right.');
    }
    await clearLoginFailures(key);

    const codes = await withTx(async client => {
      await client.query(
        `UPDATE users SET totp_secret = totp_pending_secret, totp_pending_secret = NULL, totp_enabled_at = now(), totp_last_step = $2
         WHERE user_id = $1`,
        [id, step]
      );
      await logActivity(client, id, null, 'twofa_enabled', two.enabled ? 'moved to a new authenticator' : null);
      return replaceRecoveryCodes(client, id);
    });
    const me = await queryOne(pool, 'SELECT email FROM users WHERE user_id = $1', [id]);
    sendSecurityNotice(me.email, 'Two-step sign-in was turned on for your SecureTrade account',
      'An authenticator app was just connected to your SecureTrade account. Signing in now needs a 6-digit code from it.\n\n' +
      'If this was not you, contact the site owner right away.');
    res.json({ ok: true, recovery_codes: codes });
  }));


  // New recovery codes (the old ones stop working). Needs a current code from the app.
  app.post('/api/2fa/recovery-codes', auth, route(async (req, res) => {
    const id = req.user.user_id;
    await checkSecondFactor(id, req.body.code);
    const codes = await withTx(async client => {
      await logActivity(client, id, null, 'twofa_recovery_renewed', null);
      return replaceRecoveryCodes(client, id);
    });
    res.json({ ok: true, recovery_codes: codes });
  }));
}

module.exports = { register, replaceRecoveryCodes };
