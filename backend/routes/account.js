const bcrypt = require('bcryptjs');
const { MAX_FAILS_PER_ACCOUNT, addLoginFailure, assertLoginAllowed, auth, loginFailures, warnAboutBlockedLogin } = require('../lib/auth');
const { EMAIL_RE, HttpError, IDLE_MINUTES, NAME_PART_RE, USERNAME_RE, cleanEmail, cleanName, pool, queryOne, route, signToken, splitFullName, startSession, verifiedSql } = require('../lib/core');
const { checkPin, deletePins, issuePin, sendSecurityNotice } = require('../lib/mail');

// Compared against when the email is unknown, so a wrong email is as slow as a wrong password
const DUMMY_HASH = bcrypt.hashSync('no account has this password', 10);



// Adds these routes to the app
function register(app) {

  // ---------- Health check and settings ----------
  app.get('/api/health', async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok' });
    } catch (err) {
      console.error(err);
      res.status(500).json({ status: 'error' });
    }
  });


  // The pages ask for the idle limit so their timer matches the server
  app.get('/api/config', (req, res) => res.json({ idle_minutes: IDLE_MINUTES }));


  // ---------- Create account: step 1, check the form and email a PIN ----------
  app.post('/api/register/start', route(async (req, res) => {
    const first_name = cleanName(req.body.first_name);
    const last_name = cleanName(req.body.last_name);
    const username = String(req.body.username || '').trim();
    const email = cleanEmail(req.body.email);
    const password = String(req.body.password || '');
    const adult = req.body.is_adult === true || req.body.is_adult === 'true';

    if (!first_name || !last_name || !username || !EMAIL_RE.test(email) || password.length < 8) throw new HttpError(400, 'First name, last name, username, a valid email, and a password of at least 8 characters are required.');
    if (Buffer.byteLength(password) > 72) throw new HttpError(400, 'The password is too long. Please use up to 72 characters.');
    if (!adult) throw new HttpError(400, 'SecureTrade is for users 18 and older. Please confirm that you are 18 years old or older.');
    if (!NAME_PART_RE.test(first_name) || !NAME_PART_RE.test(last_name)) throw new HttpError(400, 'Names can have letters, spaces, dots, apostrophes, and hyphens only (up to 45 characters each).');
    if (!USERNAME_RE.test(username)) throw new HttpError(400, 'Username must be 3 to 30 letters, numbers, or underscores.');
    const taken = await pool.query(
      'SELECT email, username FROM users WHERE email = $1 OR lower(username) = lower($2)',
      [email, username]
    );
    if (taken.rows.some(u => u.username.toLowerCase() === username.toLowerCase() && u.email !== email)) throw new HttpError(409, 'That username is taken.');
    // An email that already has an account gets the same answer as a new one, so nobody can test
    // which emails are registered. The owner gets an email that explains what to do instead.
    if (taken.rows.some(u => u.email === email)) {
      sendSecurityNotice(email, 'Someone tried to create a SecureTrade account with your email',
        'Someone tried to create a new SecureTrade account with this email, but you already have one.\n\n' +
        'If this was you, sign in instead, or use "Forgot password" to set a new password.\n' +
        'If this was not you, you can ignore this email. Your account was not changed.');
      return res.json({ ok: true, email });
    }

    const password_hash = await bcrypt.hash(password, 10);
    await issuePin(email, 'signup', { first_name, last_name, username, password_hash, adult_confirmed: true });
    res.json({ ok: true, email });
  }));


  // ---------- Create account: step 2, check the PIN and create the account ----------
  app.post('/api/register/verify', route(async (req, res) => {
    const email = cleanEmail(req.body.email);
    const row = await checkPin(email, 'signup', req.body.pin);
    const data = row.signup_data;
    if (!data) throw new HttpError(400, 'Please start again.');

    // A signup started before the first/last name change only has one full name
    const names = data.first_name
      ? { first: data.first_name, last: data.last_name || '' }
      : splitFullName(data.full_name);
    const fullName = (names.first + ' ' + names.last).trim();

    let user;
    try {
      const created = await pool.query(
        `INSERT INTO users (first_name, last_name, full_name, username, email, password_hash, last_seen)
         VALUES ($1, $2, $3, $4, $5, $6, now())
         RETURNING user_id, first_name, last_name, full_name, username, email, role, account_status`,
        [names.first, names.last, fullName, data.username, email, data.password_hash]
      );
      user = created.rows[0];
    } catch (err) {
      if (err.code === '23505') {
        await deletePins(email, 'signup');
        throw new HttpError(409, 'That username or email was just taken. Please start again.');
      }
      throw err;
    }

    await deletePins(email, 'signup');
    const sid = await startSession(user.user_id);
    const token = signToken(user, sid);
    res.status(201).json({ token, user: { ...user, account_status: String(user.account_status), verified: false } });
  }));


  // ---------- Create account: send the PIN again ----------
  app.post('/api/register/resend', route(async (req, res) => {
    const email = cleanEmail(req.body.email);
    const r = await pool.query(
      `SELECT signup_data FROM email_pins WHERE email = $1 AND purpose = 'signup' ORDER BY created_at DESC LIMIT 1`,
      [email]
    );
    if (!r.rows[0] || !r.rows[0].signup_data) {
      throw new HttpError(404, 'Please fill in the sign-up form again.');
    }
    await issuePin(email, 'signup', r.rows[0].signup_data);
    res.json({ ok: true });
  }));


  // ---------- Forgot password: email a PIN ----------
  app.post('/api/password/forgot', route(async (req, res) => {
    const email = cleanEmail(req.body.email);
    if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Enter a valid email.');
    const found = await pool.query(`SELECT 1 FROM users WHERE email = $1 AND account_status = 'active'`, [email]);
    if (found.rows[0]) {
      try {
        await issuePin(email, 'reset', null);
      } catch (err) {
        // Waiting period: answer the same way, so nobody can tell whether an account exists
        if (!(err instanceof HttpError && err.status === 429)) throw err;
      }
    }
    res.json({ ok: true });
  }));


  // ---------- Forgot password: check the PIN and set the new password ----------
  // Every device that was signed in is signed out.
  app.post('/api/password/reset', route(async (req, res) => {
    const email = cleanEmail(req.body.email);
    const newPassword = String(req.body.new_password || '');
    if (newPassword.length < 8) throw new HttpError(400, 'The new password must be at least 8 characters.');
    if (Buffer.byteLength(newPassword) > 72) throw new HttpError(400, 'The new password is too long. Please use up to 72 characters.');
    await checkPin(email, 'reset', req.body.pin);
    const password_hash = await bcrypt.hash(newPassword, 10);
    const updated = await pool.query(
      'UPDATE users SET password_hash = $1, session_id = NULL WHERE email = $2 RETURNING user_id',
      [password_hash, email]
    );
    await deletePins(email, 'reset');
    if (!updated.rows[0]) throw new HttpError(400, 'Wrong or expired PIN. Please request a new one.');
    res.json({ ok: true });
  }));


  // ---------- Login ----------
  // A new login replaces the old session, so the account is open on one device at a time.
  // If another device is active right now, the person is warned first (they send force: true to continue).
  // Banned accounts cannot sign in. Suspended accounts can, but they can only use Support.
  app.post('/api/login', route(async (req, res) => {
    const email = typeof req.body.email === 'string' ? req.body.email.trim() : '';
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const force = req.body.force === true;
    if (!email || !password) throw new HttpError(400, 'Email and password are required.');
    const accountKey = req.ip + '|' + String(email).toLowerCase();
    assertLoginAllowed(accountKey);

    const user = await queryOne(pool, 'SELECT * FROM users WHERE email = $1', [String(email).toLowerCase()]);
    // An unknown email still runs one password check, so the answer takes as long as for a real account
    if (!user || !(await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH))) {
      const failures = addLoginFailure(accountKey);
      if (user && failures === MAX_FAILS_PER_ACCOUNT) warnAboutBlockedLogin(user, req.ip);
      throw new HttpError(401, 'Wrong email or password.');
    }
    loginFailures.delete(accountKey);

    const status = String(user.account_status);
    if (status === 'banned') throw new HttpError(403, 'This account was banned.');
    if (status !== 'active' && status !== 'suspended') throw new HttpError(403, 'This account is not active.');

    // The password is right, so it is safe to say the account is open somewhere else
    const otherDeviceActive = user.session_id && user.last_activity_at &&
      Date.now() - new Date(user.last_activity_at).getTime() <= IDLE_MINUTES * 60000;
    if (otherDeviceActive && !force) {
      return res.status(409).json({
        code: 'ALREADY_LOGGED_IN',
        message: 'This account is already logged in on another device. If you continue, the other device will be signed out.'
      });
    }

    const sid = await startSession(user.user_id);
    const token = signToken(user, sid);
    res.json({
      token,
      user: {
        user_id: user.user_id, first_name: user.first_name, last_name: user.last_name,
        full_name: user.full_name, username: user.username,
        email: user.email, role: user.role, avatar_file: user.avatar_file,
        account_status: status,
        verified: !!user.verified_at || user.role === 'admin'
      },
    });
  }));


  // Heartbeat: the pages call this every minute (keeps the Online status, not the idle timer)
  app.post('/api/heartbeat', auth, (req, res) => res.json({ ok: true }));


  // The pages call this now and then while the user is really using them
  app.post('/api/activity', auth, (req, res) => res.json({ ok: true }));


  // Sign out: this device's session is cleared on the server too, so the next login is not warned
  app.post('/api/logout', auth, route(async (req, res) => {
    await pool.query(
      'UPDATE users SET session_id = NULL WHERE user_id = $1 AND session_id = $2',
      [req.user.user_id, req.user.sid]
    );
    res.json({ ok: true });
  }));


  // Who am I?
  app.get('/api/me', auth, route(async (req, res) => {
    const result = await pool.query(
      `SELECT user_id, first_name, last_name, full_name, username, email, role, avatar_file,
              account_status::text AS account_status,
              ${verifiedSql()} AS verified
       FROM users WHERE user_id = $1`,
      [req.user.user_id]
    );
    res.json(result.rows[0]);
  }));
}

module.exports = { register };
