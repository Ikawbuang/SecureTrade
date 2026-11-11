const bcrypt = require('bcryptjs');
const path = require('path');
const { auth } = require('../lib/auth');
const { AVG_RATING_SQL, EMAIL_RE, HttpError, PROCESS_STATUSES, RATING_COUNT_SQL, USERNAME_COOLDOWN_DAYS, USERNAME_RE, cleanEmail, logActivity, numberOrNull, pool, queryOne, route, verifiedSql, withTx } = require('../lib/core');
const { MAX_PIN_TRIES, deleteEmailChange, issueEmailChangePin, sendSecurityNotice } = require('../lib/mail');
const { AVATAR_DIR, looksLikeImage, removeAvatarFile, uploadAvatar } = require('../lib/uploads');



// Adds these routes to the app
function register(app) {

  // A profile photo. The file names are random, so only people who are shown the link can open it.
  app.get('/api/avatars/:file', (req, res) => {
    if (!/^[a-f0-9]{32}\.(jpg|png|webp)$/.test(req.params.file)) return res.status(404).end();
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.sendFile(req.params.file, { root: AVATAR_DIR }, err => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });


  // My profile, my numbers, and what I am allowed to change right now
  app.get('/api/profile', auth, route(async (req, res) => {
    const u = await queryOne(
      pool,
      `SELECT user_id, first_name, last_name, full_name, username, email, role, created_at, avatar_file,
              username_changed_at, verified_at,
              ${verifiedSql()} AS verified
       FROM users WHERE user_id = $1`,
      [req.user.user_id]
    );
    const stats = await queryOne(
      pool,
      `SELECT
         (SELECT COUNT(*) FROM transactions
           WHERE status::text = ANY($2) AND (buyer_id = $1 OR seller_id = $1)) AS active_trades,
         (SELECT COUNT(*) FROM transactions
           WHERE status = 'completed' AND (buyer_id = $1 OR seller_id = $1)) AS completed_trades,
         ${AVG_RATING_SQL} AS avg_rating,
         ${RATING_COUNT_SQL} AS rating_count`,
      [req.user.user_id, PROCESS_STATUSES]
    );

    let nextChange = null;
    if (u.username_changed_at) {
      const ready = new Date(u.username_changed_at).getTime() + USERNAME_COOLDOWN_DAYS * 86400000;
      if (ready > Date.now()) nextChange = new Date(ready).toISOString();
    }
    res.json({
      ...u,
      next_username_change: nextChange,
      active_trades: Number(stats.active_trades),
      completed_trades: Number(stats.completed_trades),
      avg_rating: numberOrNull(stats.avg_rating),
      rating_count: Number(stats.rating_count),
    });
  }));


  // Upload or replace my profile photo
  app.post('/api/profile/avatar', auth, uploadAvatar, route(async (req, res) => {
    const file = req.file;
    try {
      if (!file) throw new HttpError(400, 'Choose a photo.');
      if (!(await looksLikeImage(file.path, path.extname(file.filename)))) {
        throw new HttpError(400, 'That file is not a valid JPG, PNG, or WEBP image.');
      }
      const old = await queryOne(pool, 'SELECT avatar_file FROM users WHERE user_id = $1', [req.user.user_id]);
      await pool.query('UPDATE users SET avatar_file = $1 WHERE user_id = $2', [file.filename, req.user.user_id]);
      await removeAvatarFile(old && old.avatar_file);
      await logActivity(pool, req.user.user_id, null, 'avatar_changed', null);
      res.json({ ok: true, avatar_file: file.filename });
    } catch (err) {
      if (file) await removeAvatarFile(file.filename);
      throw err;
    }
  }));


  // Remove my profile photo
  app.delete('/api/profile/avatar', auth, route(async (req, res) => {
    const old = await queryOne(pool, 'SELECT avatar_file FROM users WHERE user_id = $1', [req.user.user_id]);
    await pool.query('UPDATE users SET avatar_file = NULL WHERE user_id = $1', [req.user.user_id]);
    await removeAvatarFile(old && old.avatar_file);
    res.json({ ok: true, avatar_file: null });
  }));


  // Change my username: once every 30 days, and never while I have trades on process
  app.put('/api/profile/username', auth, route(async (req, res) => {
    const username = String(req.body.username || '').trim();
    if (!USERNAME_RE.test(username)) throw new HttpError(400, 'Username must be 3 to 30 letters, numbers, or underscores.');
    try {
      await withTx(async client => {
        const id = req.user.user_id;
        const me = await queryOne(client, 'SELECT username, username_changed_at FROM users WHERE user_id = $1 FOR UPDATE', [id]);

        if (me.username === username) throw new HttpError(400, 'That is already your username.');

        if (me.username_changed_at) {
          const ready = new Date(me.username_changed_at).getTime() + USERNAME_COOLDOWN_DAYS * 86400000;
          if (ready > Date.now()) {
            const when = new Date(ready).toLocaleDateString('en-PH', { month: 'long', day: 'numeric', year: 'numeric' });
            throw new HttpError(409, 'You can change your username again on ' + when + '.');
          }
        }

        const active = await queryOne(
          client,
          `SELECT COUNT(*) AS n FROM transactions
           WHERE status::text = ANY($2) AND (buyer_id = $1 OR seller_id = $1)`,
          [id, PROCESS_STATUSES]
        );
        if (Number(active.n) > 0) {
          throw new HttpError(409, 'You cannot change your username while you have trades on process.');
        }

        await client.query('UPDATE users SET username = $1, username_changed_at = now() WHERE user_id = $2', [username, id]);
        await logActivity(client, id, null, 'username_changed', '@' + me.username + ' to @' + username);
      });
      res.json({ ok: true, username });
    } catch (err) {
      if (err.code === '23505') throw new HttpError(409, 'That username is taken.');
      throw err;
    }
  }));


  // Change my email, step 1: the current password, then a PIN goes to the NEW email
  app.post('/api/profile/email/start', auth, route(async (req, res) => {
    const newEmail = cleanEmail(req.body.new_email);
    const password = String(req.body.password || '');
    if (!EMAIL_RE.test(newEmail)) throw new HttpError(400, 'Enter a valid email.');
    const me = await queryOne(pool, 'SELECT email, password_hash FROM users WHERE user_id = $1', [req.user.user_id]);
    if (newEmail === me.email) throw new HttpError(400, 'That is already your email.');
    if (!(await bcrypt.compare(password, me.password_hash))) {
      throw new HttpError(400, 'Your current password is wrong.');
    }
    const taken = await pool.query('SELECT 1 FROM users WHERE email = $1', [newEmail]);
    if (taken.rows[0]) throw new HttpError(409, 'That email is already used by another account.');

    await issueEmailChangePin(req.user.user_id, newEmail);
    res.json({ ok: true, new_email: newEmail });
  }));


  // Change my email, step 2: the PIN from the new email
  app.post('/api/profile/email/verify', auth, route(async (req, res) => {
    const pin = String(req.body.pin || '').trim();
    if (!/^\d{6}$/.test(pin)) throw new HttpError(400, 'Enter the 6-digit PIN.');
    const id = req.user.user_id;
    const row = await queryOne(pool, 'SELECT * FROM email_changes WHERE user_id = $1', [id]);
    if (!row || new Date(row.expires_at) < new Date()) {
      if (row) await deleteEmailChange(id);
      throw new HttpError(400, 'Wrong or expired PIN. Please start again.');
    }
    const tooManyTries = async () => {
      await deleteEmailChange(id);
      throw new HttpError(429, 'Too many wrong tries. Please start again.');
    };
    // The try is counted in the database first, so guesses sent at the same moment all count
    const claimed = await queryOne(
      pool,
      'UPDATE email_changes SET attempts = attempts + 1 WHERE user_id = $1 AND attempts < $2 RETURNING attempts',
      [id, MAX_PIN_TRIES]
    );
    if (!claimed) return tooManyTries();
    if (!(await bcrypt.compare(pin, row.pin_hash))) {
      if (claimed.attempts >= MAX_PIN_TRIES) return tooManyTries();
      throw new HttpError(400, 'Wrong PIN. ' + (MAX_PIN_TRIES - claimed.attempts) + ' tries left.');
    }

    const before = await queryOne(pool, 'SELECT email FROM users WHERE user_id = $1', [id]);
    try {
      await pool.query('UPDATE users SET email = $1 WHERE user_id = $2', [row.new_email, id]);
    } catch (err) {
      if (err.code === '23505') {
        await deleteEmailChange(id);
        throw new HttpError(409, 'That email was just taken by someone else. Please start again.');
      }
      throw err;
    }
    await deleteEmailChange(id);
    await logActivity(pool, id, null, 'email_changed', null);
    sendSecurityNotice(before.email, 'Your SecureTrade email was changed',
      'The email on your SecureTrade account was just changed. If this was not you, contact SecureTrade Support right away.');
    res.json({ ok: true, email: row.new_email });
  }));


  // Change my password while signed in: the current password is needed
  app.post('/api/profile/password', auth, route(async (req, res) => {
    const current = String(req.body.current_password || '');
    const next = String(req.body.new_password || '');
    if (next.length < 8) throw new HttpError(400, 'The new password must be at least 8 characters.');
    if (Buffer.byteLength(next) > 72) throw new HttpError(400, 'The new password is too long. Please use up to 72 characters.');
    if (next === current) throw new HttpError(400, 'The new password must be different from the current one.');
    const me = await queryOne(pool, 'SELECT email, password_hash FROM users WHERE user_id = $1', [req.user.user_id]);
    if (!(await bcrypt.compare(current, me.password_hash))) throw new HttpError(400, 'Your current password is wrong.');
    await pool.query('UPDATE users SET password_hash = $1 WHERE user_id = $2', [await bcrypt.hash(next, 10), req.user.user_id]);
    await logActivity(pool, req.user.user_id, null, 'password_changed', null);
    sendSecurityNotice(me.email, 'Your SecureTrade password was changed',
      'The password on your SecureTrade account was just changed. If this was not you, reset your password now and contact Support.');
    res.json({ ok: true });
  }));


  // Change my email: send the PIN again
  app.post('/api/profile/email/resend', auth, route(async (req, res) => {
    const row = await queryOne(pool, 'SELECT new_email FROM email_changes WHERE user_id = $1', [req.user.user_id]);
    if (!row) throw new HttpError(404, 'Please start again.');
    await issueEmailChangePin(req.user.user_id, row.new_email);
    res.json({ ok: true });
  }));
}

module.exports = { register };
