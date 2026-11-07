require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const multer = require('multer');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// A user counts as online if we heard from them in the last 2 minutes
const ONLINE_SQL = `(last_seen IS NOT NULL AND last_seen > now() - interval '2 minutes')`;

// Trades that are still moving (not finished)
const PROCESS_STATUSES = ['pending', 'accepted', 'paid', 'delivered', 'disputed'];
const ALL_TRADE_STATUSES = ['pending', 'accepted', 'paid', 'delivered', 'disputed', 'completed', 'refunded', 'cancelled'];

// Only GCash is used, to pay in and to receive the money
const METHOD_LABEL = { gcash: 'GCash' };

// Signed out after this many minutes without the user doing anything (set IDLE_MINUTES in .env)
const IDLE_MINUTES = Number(process.env.IDLE_MINUTES || 15);
// A trade request nobody answers is cancelled after this many hours
const REQUEST_EXPIRE_HOURS = 12;
// Identity verification
const ID_TYPES = ['PhilSys National ID', "Driver's License", 'Passport', 'UMID', 'Postal ID'];
const VERIFY_CODE_HOURS = 24;
const MAX_FAVORITES = 50;
// Support chat
const SUPPORT_MAX = 1000;
const SUPPORT_PER_MINUTE = 10;

// ---------- Small helpers ----------
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function sendError(res, err) {
  if (err instanceof HttpError) return res.status(err.status).json({ message: err.message });
  console.error(err);
  res.status(500).json({ message: 'Server error.' });
}

// Run several queries as one unit: all succeed or none are saved
async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Show only the start and end of a mobile number: 09••••••123
function maskNumber(n) {
  return n ? n.slice(0, 2) + '••••••' + n.slice(-3) : null;
}

// ---------- Names: first name and last name ----------
// One part of a name: letters, spaces, dots, apostrophes, and hyphens (1 to 45 characters)
const NAME_PART_RE = /^[\p{L}][\p{L} .'-]{0,44}$/u;

function cleanName(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

// For old data that only has one full name: the last word is the last name
function splitFullName(full) {
  const text = cleanName(full);
  const i = text.lastIndexOf(' ');
  return i < 0 ? { first: text, last: '' } : { first: text.slice(0, i), last: text.slice(i + 1) };
}

// Is this user an admin? Checked in the database, not only in the login token
async function isAdmin(userId) {
  const r = await pool.query('SELECT role FROM users WHERE user_id = $1', [userId]);
  return !!(r.rows[0] && r.rows[0].role === 'admin');
}

// Everyone must be verified to start or accept a trade (admin accounts count as verified)
async function assertVerified(userId, message) {
  const r = await pool.query('SELECT verified_at, role FROM users WHERE user_id = $1', [userId]);
  const u = r.rows[0];
  if (!u || (!u.verified_at && u.role !== 'admin')) {
    throw new HttpError(403, message || 'Verify your identity first. Open "Edit profile" on your dashboard and complete the verification.');
  }
}

// Remember that someone wanted to trade with a person who is not verified yet,
// so that person sees it on their dashboard and knows to verify.
async function recordTradeAttempt(targetUserId, fromUserId) {
  try {
    await pool.query(
      `INSERT INTO trade_attempts (target_user_id, from_user_id) VALUES ($1, $2)
       ON CONFLICT (target_user_id, from_user_id) DO UPDATE SET created_at = now()`,
      [targetUserId, fromUserId]
    );
  } catch (err) {
    console.error('Trade attempt failed:', err.message);
  }
}

// Write one line in the activity log (what a user did). Inside a transaction, pass the client.
async function logActivity(db, userId, transactionId, action, detail) {
  try {
    await db.query(
      'INSERT INTO activity_log (user_id, transaction_id, action, detail) VALUES ($1, $2, $3, $4)',
      [userId, transactionId, action, detail || null]
    );
  } catch (err) {
    if (db !== pool) throw err;
    console.error('Activity log failed:', err.message);
  }
}

// Start a new login session. Only the newest session stays valid, so an older device is signed out.
async function startSession(userId) {
  const sid = crypto.randomBytes(16).toString('hex');
  await pool.query(
    'UPDATE users SET session_id = $1, last_activity_at = now(), last_seen = now() WHERE user_id = $2',
    [sid, userId]
  );
  return sid;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_RE = /^[A-Za-z0-9_]{3,30}$/;
const USERNAME_COOLDOWN_DAYS = 30;

// ---------- Email PINs (signup, password reset, and changing the email) ----------
const PIN_MINUTES = 10;       // a PIN works for 10 minutes
const MAX_PIN_TRIES = 5;      // wrong tries before the PIN is cancelled
const RESEND_SECONDS = 60;    // wait before asking for another PIN

function mailConfigured() {
  return process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_KEY && process.env.MAIL_FROM;
}

let transporter = null;
function getTransporter() {
  if (!transporter) {
    const port = Number(process.env.SMTP_PORT || 587);
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_KEY },
    });
  }
  return transporter;
}

const PIN_COPY = {
  signup:       { subject: 'Your SecureTrade verification code', intro: 'Use this code to finish creating your SecureTrade account:' },
  reset:        { subject: 'Your SecureTrade password reset code', intro: 'Use this code to reset your SecureTrade password:' },
  email_change: { subject: 'Confirm your new SecureTrade email', intro: 'Use this code to confirm this email address for your SecureTrade account:' },
};

async function sendPinEmail(to, pin, purpose) {
  const { subject, intro } = PIN_COPY[purpose];

  if (!mailConfigured()) {
    if (process.env.DEV_LOG_PIN === 'true') {
      console.log(`[DEV] ${purpose} PIN for ${to}: ${pin}`);
      return;
    }
    throw new HttpError(500, 'Email is not set up on the server yet.');
  }

  try {
    await getTransporter().sendMail({
      from: `"SecureTrade" <${process.env.MAIL_FROM}>`,
      to,
      subject,
      text: `${intro}\n\n${pin}\n\nThe code expires in ${PIN_MINUTES} minutes. If you did not ask for it, you can ignore this email.`,
      html: `<div style="font-family:Arial,sans-serif;max-width:420px;margin:auto;padding:24px;border:1px solid #e4e6f6;border-radius:12px">
        <h2 style="margin:0 0 12px;color:#0f1535">SecureTrade</h2>
        <p style="margin:0 0 16px;color:#333">${intro}</p>
        <p style="font-size:32px;font-weight:700;letter-spacing:8px;margin:0 0 16px;color:#0f1535">${pin}</p>
        <p style="margin:0;color:#666;font-size:13px">The code expires in ${PIN_MINUTES} minutes. If you did not ask for it, you can ignore this email.</p>
      </div>`,
    });
  } catch (err) {
    console.error('Email failed:', err.message);
    throw new HttpError(502, 'We could not send the email. Please try again in a moment.');
  }
}

// Make a new 6-digit PIN, save only its hash, and email it
async function issuePin(email, purpose, signupData) {
  const last = await pool.query(
    `SELECT EXTRACT(EPOCH FROM (now() - created_at)) AS age
     FROM email_pins WHERE email = $1 AND purpose = $2
     ORDER BY created_at DESC LIMIT 1`,
    [email, purpose]
  );
  if (last.rows[0] && Number(last.rows[0].age) < RESEND_SECONDS) {
    const wait = Math.ceil(RESEND_SECONDS - Number(last.rows[0].age));
    throw new HttpError(429, 'Please wait ' + wait + ' seconds before asking for another PIN.');
  }

  const pin = String(crypto.randomInt(100000, 1000000));
  const pin_hash = await bcrypt.hash(pin, 8);

  await pool.query('DELETE FROM email_pins WHERE email = $1 AND purpose = $2', [email, purpose]);
  const inserted = await pool.query(
    `INSERT INTO email_pins (purpose, email, pin_hash, signup_data, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '${PIN_MINUTES} minutes')
     RETURNING pin_id`,
    [purpose, email, pin_hash, signupData ? JSON.stringify(signupData) : null]
  );

  try {
    await sendPinEmail(email, pin, purpose);
  } catch (err) {
    await pool.query('DELETE FROM email_pins WHERE pin_id = $1', [inserted.rows[0].pin_id]);
    throw err;
  }
}

// Check the PIN the user typed. Returns the saved row, or throws a clear error.
async function checkPin(email, purpose, pin) {
  if (!/^\d{6}$/.test(String(pin || ''))) throw new HttpError(400, 'Enter the 6-digit PIN.');

  const r = await pool.query(
    `SELECT * FROM email_pins WHERE email = $1 AND purpose = $2 ORDER BY created_at DESC LIMIT 1`,
    [email, purpose]
  );
  const row = r.rows[0];
  if (!row || new Date(row.expires_at) < new Date()) {
    if (row) await pool.query('DELETE FROM email_pins WHERE pin_id = $1', [row.pin_id]);
    throw new HttpError(400, 'Wrong or expired PIN. Please request a new one.');
  }
  if (row.attempts >= MAX_PIN_TRIES) {
    await pool.query('DELETE FROM email_pins WHERE pin_id = $1', [row.pin_id]);
    throw new HttpError(429, 'Too many wrong tries. Please request a new PIN.');
  }
  if (!(await bcrypt.compare(String(pin), row.pin_hash))) {
    const used = row.attempts + 1;
    if (used >= MAX_PIN_TRIES) {
      await pool.query('DELETE FROM email_pins WHERE pin_id = $1', [row.pin_id]);
      throw new HttpError(429, 'Too many wrong tries. Please request a new PIN.');
    }
    await pool.query('UPDATE email_pins SET attempts = $1 WHERE pin_id = $2', [used, row.pin_id]);
    throw new HttpError(400, 'Wrong PIN. ' + (MAX_PIN_TRIES - used) + ' tries left.');
  }
  return row;
}

// Clean up old PINs and old notices once an hour
setInterval(() => {
  pool.query(`DELETE FROM email_pins WHERE expires_at < now() - interval '1 day'`).catch(() => {});
  pool.query(`DELETE FROM email_changes WHERE expires_at < now() - interval '1 day'`).catch(() => {});
  pool.query(`DELETE FROM trade_attempts WHERE created_at < now() - interval '30 days'`).catch(() => {});
  pool.query(`DELETE FROM rate_dismissals WHERE created_at < now() - interval '30 days'`).catch(() => {});
}, 60 * 60 * 1000);

// ---------- Health check and settings ----------
app.get('/api/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT COUNT(*) AS users FROM users');
    res.json({ status: 'ok', users: Number(result.rows[0].users) });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      status: 'error',
      code: err.code,
      detail: (err.errors && err.errors[0] && err.errors[0].message) || err.message,
    });
  }
});

// The pages ask for the idle limit so their timer matches the server
app.get('/api/config', (req, res) => res.json({ idle_minutes: IDLE_MINUTES }));

// ---------- Create account: step 1, check the form and email a PIN ----------
app.post('/api/register/start', async (req, res) => {
  const first_name = cleanName(req.body.first_name);
  const last_name = cleanName(req.body.last_name);
  const username = String(req.body.username || '').trim();
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const adult = req.body.is_adult === true || req.body.is_adult === 'true';

  if (!first_name || !last_name || !username || !EMAIL_RE.test(email) || password.length < 8) {
    return res.status(400).json({ message: 'First name, last name, username, a valid email, and a password of at least 8 characters are required.' });
  }
  if (!adult) {
    return res.status(400).json({ message: 'SecureTrade is for users 18 and older. Please confirm that you are 18 years old or older.' });
  }
  if (!NAME_PART_RE.test(first_name) || !NAME_PART_RE.test(last_name)) {
    return res.status(400).json({ message: 'Names can have letters, spaces, dots, apostrophes, and hyphens only (up to 45 characters each).' });
  }
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ message: 'Username must be 3 to 30 letters, numbers, or underscores.' });
  }
  try {
    const taken = await pool.query(
      'SELECT email, username FROM users WHERE email = $1 OR lower(username) = lower($2)',
      [email, username]
    );
    if (taken.rows.some(u => u.email === email)) {
      return res.status(409).json({ message: 'That email is already registered.' });
    }
    if (taken.rows.length > 0) {
      return res.status(409).json({ message: 'That username is taken.' });
    }

    const password_hash = await bcrypt.hash(password, 10);
    await issuePin(email, 'signup', { first_name, last_name, username, password_hash, adult_confirmed: true });
    res.json({ ok: true, email });
  } catch (err) {
    sendError(res, err);
  }
});

// ---------- Create account: step 2, check the PIN and create the account ----------
app.post('/api/register/verify', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  try {
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
        await pool.query('DELETE FROM email_pins WHERE email = $1 AND purpose = $2', [email, 'signup']);
        throw new HttpError(409, 'That username or email was just taken. Please start again.');
      }
      throw err;
    }

    await pool.query('DELETE FROM email_pins WHERE email = $1 AND purpose = $2', [email, 'signup']);
    const sid = await startSession(user.user_id);
    const token = jwt.sign({ user_id: user.user_id, role: user.role, sid }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.status(201).json({ token, user: { ...user, account_status: String(user.account_status), verified: false } });
  } catch (err) {
    sendError(res, err);
  }
});

// ---------- Create account: send the PIN again ----------
app.post('/api/register/resend', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  try {
    const r = await pool.query(
      `SELECT signup_data FROM email_pins WHERE email = $1 AND purpose = 'signup' ORDER BY created_at DESC LIMIT 1`,
      [email]
    );
    if (!r.rows[0] || !r.rows[0].signup_data) {
      throw new HttpError(404, 'Please fill in the sign-up form again.');
    }
    await issuePin(email, 'signup', r.rows[0].signup_data);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

// ---------- Forgot password: email a PIN ----------
app.post('/api/password/forgot', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email)) return res.status(400).json({ message: 'Enter a valid email.' });
  try {
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
  } catch (err) {
    sendError(res, err);
  }
});

// ---------- Forgot password: check the PIN and set the new password ----------
// Every device that was signed in is signed out.
app.post('/api/password/reset', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const newPassword = String(req.body.new_password || '');
  if (newPassword.length < 8) {
    return res.status(400).json({ message: 'The new password must be at least 8 characters.' });
  }
  try {
    await checkPin(email, 'reset', req.body.pin);
    const password_hash = await bcrypt.hash(newPassword, 10);
    const updated = await pool.query(
      'UPDATE users SET password_hash = $1, session_id = NULL WHERE email = $2 RETURNING user_id',
      [password_hash, email]
    );
    await pool.query('DELETE FROM email_pins WHERE email = $1 AND purpose = $2', [email, 'reset']);
    if (!updated.rows[0]) throw new HttpError(400, 'Wrong or expired PIN. Please request a new one.');
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

// ---------- Login ----------
// A new login replaces the old session, so the account is open on one device at a time.
// If another device is active right now, the person is warned first (they send force: true to continue).
// Banned accounts cannot sign in. Suspended accounts can, but they can only use Support.
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const force = req.body.force === true;
  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required.' });
  }
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [String(email).toLowerCase()]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ message: 'Wrong email or password.' });
    }
    const status = String(user.account_status);
    if (status === 'banned') {
      return res.status(403).json({ message: 'This account was banned.' });
    }
    if (status !== 'active' && status !== 'suspended') {
      return res.status(403).json({ message: 'This account is not active.' });
    }

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
    const token = jwt.sign(
      { user_id: user.user_id, role: user.role, sid },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
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
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error.' });
  }
});

// Suspended accounts may only use these (Support, who am I, sign out, and the keep-alive pings)
const SUSPENDED_ALLOWED = ['/api/support', '/api/me', '/api/logout', '/api/heartbeat', '/api/activity'];
function suspendedMayUse(p) {
  return SUSPENDED_ALLOWED.some(x => p === x || p.startsWith(x + '/'));
}

// Protect routes: checks the login token, that the account is active (or suspended, for Support),
// that this is still the newest session, and that the user was not idle for too long.
async function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'Please log in.' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ message: 'Invalid or expired token.' });
  }
  try {
    const r = await pool.query(
      'SELECT account_status, role, last_seen, session_id, last_activity_at FROM users WHERE user_id = $1',
      [req.user.user_id]
    );
    const u = r.rows[0];
    const status = u ? String(u.account_status) : '';
    if (!u || (status !== 'active' && status !== 'suspended')) {
      return res.status(401).json({ message: 'Your account is not active.' });
    }
    if (!u.session_id || req.user.sid !== u.session_id) {
      return res.status(401).json({
        message: u.session_id
          ? 'You were signed out because your account was opened on another device.'
          : 'Please sign in again.'
      });
    }
    if (u.last_activity_at && Date.now() - new Date(u.last_activity_at).getTime() > IDLE_MINUTES * 60000) {
      return res.status(401).json({ message: 'You were signed out because you were inactive.' });
    }
    req.user.role = u.role;
    req.user.account_status = status;

    // A suspended account can only reach Support
    if (status === 'suspended' && !suspendedMayUse(req.path)) {
      return res.status(403).json({
        code: 'SUSPENDED',
        message: 'Your account is suspended. You can only use Support until an admin reactivates it.'
      });
    }

    // Real actions count as activity. Reading data and the background heartbeat do not,
    // so a page left open does not keep the account signed in.
    const background = req.method === 'GET' || req.path === '/api/heartbeat';
    if (!background) {
      await pool.query('UPDATE users SET last_activity_at = now() WHERE user_id = $1', [req.user.user_id]);
    }
    if (!u.last_seen || Date.now() - new Date(u.last_seen).getTime() > 30000) {
      pool.query('UPDATE users SET last_seen = now() WHERE user_id = $1', [req.user.user_id]).catch(() => {});
    }
  } catch (err) {
    return sendError(res, err);
  }
  next();
}

// Only admins may continue (the role is read from the database)
async function adminOnly(req, res, next) {
  try {
    if (!(await isAdmin(req.user.user_id))) {
      return res.status(403).json({ message: 'This page is for admins only.' });
    }
    next();
  } catch (err) {
    sendError(res, err);
  }
}

// Heartbeat: the pages call this every minute (keeps the Online status, not the idle timer)
app.post('/api/heartbeat', auth, (req, res) => res.json({ ok: true }));

// The pages call this now and then while the user is really using them
app.post('/api/activity', auth, (req, res) => res.json({ ok: true }));

// Sign out: this device's session is cleared on the server too, so the next login is not warned
app.post('/api/logout', auth, async (req, res) => {
  try {
    await pool.query(
      'UPDATE users SET session_id = NULL WHERE user_id = $1 AND session_id = $2',
      [req.user.user_id, req.user.sid]
    );
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

// Who am I?
app.get('/api/me', auth, async (req, res) => {
  const result = await pool.query(
    `SELECT user_id, first_name, last_name, full_name, username, email, role, avatar_file,
            account_status::text AS account_status,
            (verified_at IS NOT NULL OR role = 'admin') AS verified
     FROM users WHERE user_id = $1`,
    [req.user.user_id]
  );
  res.json(result.rows[0]);
});

// ---------- Support chat (a user and the admins) ----------
// A suspended account can use this to ask for help.

// My conversation with the admins. Opening it marks the admin's messages as read.
app.get('/api/support', auth, async (req, res) => {
  try {
    const me = req.user.user_id;
    const messages = (await pool.query(
      `SELECT message_id, from_admin, content, sent_at
       FROM support_messages WHERE user_id = $1
       ORDER BY sent_at, message_id LIMIT 300`,
      [me]
    )).rows;
    await pool.query(
      `UPDATE support_messages SET read_at = now() WHERE user_id = $1 AND from_admin AND read_at IS NULL`,
      [me]
    );

    // Why the account is suspended (the note the admin wrote, without the admin's name)
    let reason = null;
    if (req.user.account_status === 'suspended') {
      const log = (await pool.query(
        `SELECT detail FROM activity_log
         WHERE user_id = $1 AND action = 'account_suspended'
         ORDER BY created_at DESC, log_id DESC LIMIT 1`,
        [me]
      )).rows[0];
      if (log && log.detail) {
        const i = log.detail.indexOf(': ');
        reason = i >= 0 ? log.detail.slice(i + 2) : null;
      }
    }
    res.json({ account_status: req.user.account_status, suspension_reason: reason, messages });
  } catch (err) {
    sendError(res, err);
  }
});

// How many admin messages I have not read yet (the menu shows this number)
app.get('/api/support/unread', auth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT COUNT(*) AS n FROM support_messages WHERE user_id = $1 AND from_admin AND read_at IS NULL`,
      [req.user.user_id]
    );
    res.json({ unread: Number(r.rows[0].n) });
  } catch (err) {
    sendError(res, err);
  }
});

// Write to the admins
app.post('/api/support', auth, async (req, res) => {
  try {
    const me = req.user.user_id;
    const content = String(req.body.content || '').trim();
    if (!content || content.length > SUPPORT_MAX) {
      throw new HttpError(400, 'Write a message of 1 to ' + SUPPORT_MAX + ' characters.');
    }
    const recent = Number((await pool.query(
      `SELECT COUNT(*) AS n FROM support_messages
       WHERE sender_id = $1 AND sent_at > now() - interval '1 minute'`,
      [me]
    )).rows[0].n);
    if (recent >= SUPPORT_PER_MINUTE) {
      throw new HttpError(429, 'You are sending messages too fast. Please wait a moment.');
    }
    await pool.query(
      `INSERT INTO support_messages (user_id, sender_id, from_admin, content) VALUES ($1, $1, false, $2)`,
      [me, content]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

// ---------- Find trade partners ----------
// Usernames only, never emails or real names.
// ?status=all|recent|online|offline|favorites  ?search=  ?limit=  (admins are not listed)
app.get('/api/users', auth, async (req, res) => {
  const search = String(req.query.search || '').replace(/^@/, '').replace(/[%_]/g, '');
  const status = String(req.query.status || 'all');
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
  const me = req.user.user_id;

  const together = `((t.buyer_id = $1 AND t.seller_id = u.user_id) OR (t.seller_id = $1 AND t.buyer_id = u.user_id))`;
  let extra = '';
  if (status === 'online') extra = ` AND ${ONLINE_SQL}`;
  if (status === 'offline') extra = ` AND NOT ${ONLINE_SQL}`;
  if (status === 'favorites') extra = ` AND f.user_id IS NOT NULL`;
  if (status === 'recent') extra = ` AND EXISTS (SELECT 1 FROM transactions t WHERE ${together})`;
  const order = status === 'recent'
    ? 'last_trade_at DESC NULLS LAST, u.username'
    : `${ONLINE_SQL} DESC, u.username`;

  try {
    const result = await pool.query(
      `SELECT u.username, u.avatar_file, u.created_at, u.last_seen, ${ONLINE_SQL} AS online,
              (u.verified_at IS NOT NULL OR u.role = 'admin') AS verified,
              (f.user_id IS NOT NULL) AS is_favorite, f.note,
              (SELECT COUNT(*) FROM transactions t WHERE t.status = 'completed' AND ${together}) AS trades_together,
              (SELECT MAX(t.created_at) FROM transactions t WHERE ${together}) AS last_trade_at
       FROM users u
       LEFT JOIN favorites f ON f.user_id = $1 AND f.favorite_user_id = u.user_id
       WHERE u.account_status = 'active' AND u.role <> 'admin' AND u.user_id <> $1
         AND u.username ILIKE $2${extra}
       ORDER BY ${order}
       LIMIT $3`,
      [me, `%${search}%`, limit + 1]
    );
    const rows = result.rows.slice(0, limit).map(u => ({ ...u, trades_together: Number(u.trades_together) }));
    res.json({ users: rows, has_more: result.rows.length > limit });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error.' });
  }
});

// View a user's public profile (username only, never email or real name).
// The reviews are anonymous: they show the stars, the comment, and whether the writer was the buyer or the seller.
app.get('/api/users/:username', auth, async (req, res) => {
  try {
    const me = req.user.user_id;
    const found = await pool.query(
      `SELECT u.user_id, u.username, u.avatar_file, u.created_at, u.last_seen, ${ONLINE_SQL} AS online,
              (u.verified_at IS NOT NULL OR u.role = 'admin') AS verified,
              (f.user_id IS NOT NULL) AS is_favorite, f.note
       FROM users u
       LEFT JOIN favorites f ON f.user_id = $2 AND f.favorite_user_id = u.user_id
       WHERE lower(u.username) = lower($1) AND u.account_status = 'active'`,
      [req.params.username, me]
    );
    const user = found.rows[0];
    if (!user) return res.status(404).json({ message: 'User not found.' });

    const stats = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM transactions
           WHERE status = 'completed' AND (buyer_id = $1 OR seller_id = $1)) AS completed_trades,
         (SELECT ROUND(AVG(score)::numeric, 1) FROM ratings WHERE rated_user_id = $1 AND deleted_at IS NULL) AS avg_rating,
         (SELECT COUNT(*) FROM ratings WHERE rated_user_id = $1 AND deleted_at IS NULL) AS rating_count,
         (SELECT COUNT(*) FROM transactions t WHERE t.status = 'completed'
           AND ((t.buyer_id = $1 AND t.seller_id = $2) OR (t.seller_id = $1 AND t.buyer_id = $2))) AS trades_together`,
      [user.user_id, me]
    );
    const reviews = await pool.query(
      `SELECT r.review_ref, r.score, r.feedback, r.rated_at,
              CASE WHEN t.buyer_id = r.rated_by THEN 'Buyer' ELSE 'Seller' END AS as_role,
              (r.rated_by = $2) AS is_mine,
              EXISTS (SELECT 1 FROM review_reports rr WHERE rr.review_ref = r.review_ref AND rr.reported_by = $2) AS reported_by_me
       FROM ratings r
       JOIN transactions t ON t.transaction_id = r.transaction_id
       WHERE r.rated_user_id = $1 AND r.deleted_at IS NULL
       ORDER BY r.rated_at DESC
       LIMIT 5`,
      [user.user_id, me]
    );

    const s = stats.rows[0];
    res.json({
      username: user.username,
      avatar_file: user.avatar_file,
      verified: user.verified,
      is_favorite: user.is_favorite,
      note: user.note,
      joined: user.created_at,
      online: user.online,
      last_seen: user.last_seen,
      completed_trades: Number(s.completed_trades),
      trades_together: Number(s.trades_together),
      avg_rating: s.avg_rating === null ? null : Number(s.avg_rating),
      rating_count: Number(s.rating_count),
      reviews: reviews.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error.' });
  }
});

// ---------- Reviews about me, and reporting an abusive review ----------

// The reviews other people wrote about me (anonymous)
app.get('/api/reviews/mine', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.review_ref, r.score, r.feedback, r.rated_at,
              CASE WHEN t.buyer_id = r.rated_by THEN 'Buyer' ELSE 'Seller' END AS as_role,
              EXISTS (SELECT 1 FROM review_reports rr WHERE rr.review_ref = r.review_ref AND rr.reported_by = $1) AS reported_by_me
       FROM ratings r
       JOIN transactions t ON t.transaction_id = r.transaction_id
       WHERE r.rated_user_id = $1 AND r.deleted_at IS NULL
       ORDER BY r.rated_at DESC
       LIMIT 50`,
      [req.user.user_id]
    );
    res.json(result.rows);
  } catch (err) {
    sendError(res, err);
  }
});

// Report a review (abusive, false, or it has personal information). An admin looks at it.
app.post('/api/reviews/:ref/report', auth, async (req, res) => {
  try {
    if (!/^\d+$/.test(req.params.ref)) throw new HttpError(400, 'Invalid review.');
    const me = req.user.user_id;
    const reason = String(req.body.reason || '').trim().slice(0, 300);

    const review = (await pool.query(
      'SELECT rated_by, deleted_at FROM ratings WHERE review_ref = $1', [req.params.ref]
    )).rows[0];
    if (!review || review.deleted_at) throw new HttpError(404, 'Review not found.');
    if (String(review.rated_by) === String(me)) throw new HttpError(400, 'You cannot report your own review.');

    const inserted = await pool.query(
      `INSERT INTO review_reports (review_ref, reported_by, reason) VALUES ($1, $2, $3)
       ON CONFLICT (review_ref, reported_by) DO NOTHING
       RETURNING report_id`,
      [req.params.ref, me, reason || null]
    );
    if (!inserted.rows[0]) throw new HttpError(409, 'You already reported this review.');
    res.status(201).json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

// ---------- Favorites (private: the other person is never told) ----------
app.get('/api/favorites', auth, async (req, res) => {
  try {
    const me = req.user.user_id;
    const result = await pool.query(
      `SELECT u.username, u.avatar_file, u.last_seen, ${ONLINE_SQL} AS online,
              (u.verified_at IS NOT NULL OR u.role = 'admin') AS verified, f.note, f.created_at
       FROM favorites f JOIN users u ON u.user_id = f.favorite_user_id
       WHERE f.user_id = $1 AND u.account_status = 'active'
       ORDER BY f.created_at DESC`,
      [me]
    );
    res.json(result.rows);
  } catch (err) {
    sendError(res, err);
  }
});

// Add a favorite, or change its private note (send { note } only when the note changes)
app.put('/api/favorites/:username', auth, async (req, res) => {
  const username = String(req.params.username || '').replace(/^@/, '');
  const hasNote = typeof req.body.note === 'string';
  const note = hasNote ? req.body.note.trim().slice(0, 200) : null;
  try {
    const me = req.user.user_id;
    const target = (await pool.query(
      `SELECT user_id FROM users WHERE lower(username) = lower($1) AND account_status = 'active'`, [username]
    )).rows[0];
    if (!target) throw new HttpError(404, 'User not found.');
    if (String(target.user_id) === String(me)) throw new HttpError(400, 'You cannot add yourself to your favorites.');

    const existing = (await pool.query(
      'SELECT 1 FROM favorites WHERE user_id = $1 AND favorite_user_id = $2', [me, target.user_id]
    )).rows[0];

    if (existing) {
      if (hasNote) {
        await pool.query('UPDATE favorites SET note = $3 WHERE user_id = $1 AND favorite_user_id = $2',
          [me, target.user_id, note || null]);
      }
    } else {
      const count = Number((await pool.query('SELECT COUNT(*) AS n FROM favorites WHERE user_id = $1', [me])).rows[0].n);
      if (count >= MAX_FAVORITES) throw new HttpError(409, 'You can have up to ' + MAX_FAVORITES + ' favorites. Remove one first.');
      await pool.query('INSERT INTO favorites (user_id, favorite_user_id, note) VALUES ($1, $2, $3)',
        [me, target.user_id, note || null]);
    }
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

app.delete('/api/favorites/:username', auth, async (req, res) => {
  try {
    const username = String(req.params.username || '').replace(/^@/, '');
    await pool.query(
      `DELETE FROM favorites
       WHERE user_id = $1 AND favorite_user_id = (SELECT user_id FROM users WHERE lower(username) = lower($2))`,
      [req.user.user_id, username]
    );
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

// ---------- Trades ----------

// A verified user pressed "Trade" on someone who is not verified yet.
// We remember it, and that person sees it on their dashboard.
app.post('/api/trade-attempts', auth, async (req, res) => {
  const username = String(req.body.username || '').trim().replace(/^@/, '');
  try {
    await assertVerified(req.user.user_id, 'Verify your identity first.');
    const target = (await pool.query(
      `SELECT user_id, verified_at, role FROM users WHERE lower(username) = lower($1) AND account_status = 'active'`,
      [username]
    )).rows[0];
    if (!target) throw new HttpError(404, 'User not found.');
    if (String(target.user_id) === String(req.user.user_id)) throw new HttpError(400, 'You cannot trade with yourself.');
    if (target.verified_at || target.role === 'admin') throw new HttpError(400, 'That user is already verified.');

    await recordTradeAttempt(target.user_id, req.user.user_id);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

// Create a transaction request (sent to the partner). Both people must be verified.
app.post('/api/transactions', auth, async (req, res) => {
  const { my_role, item_description, amount } = req.body;
  const partner_username = String(req.body.partner_username || '').trim().replace(/^@/, '');
  if (!partner_username || !['buyer', 'seller'].includes(my_role) || !item_description || !(Number(amount) > 0)) {
    return res.status(400).json({ message: 'Partner username, your role, item description, and a valid amount are required.' });
  }
  try {
    await assertVerified(req.user.user_id, 'Verify your identity first. Open "Edit profile" on your dashboard and complete the verification to start trades.');

    const partner = await pool.query(
      `SELECT user_id, verified_at, role FROM users WHERE lower(username) = lower($1) AND account_status = 'active'`,
      [partner_username]
    );
    if (!partner.rows[0]) {
      return res.status(404).json({ message: 'No active user with that username.' });
    }
    const partnerId = partner.rows[0].user_id;
    if (String(partnerId) === String(req.user.user_id)) {
      return res.status(400).json({ message: 'You cannot trade with yourself.' });
    }
    if (!partner.rows[0].verified_at && partner.rows[0].role !== 'admin') {
      await recordTradeAttempt(partnerId, req.user.user_id);
      return res.status(400).json({ message: '@' + partner_username + ' is not verified yet, so you cannot trade with them. We told them you tried.' });
    }
    const buyer_id  = my_role === 'buyer'  ? req.user.user_id : partnerId;
    const seller_id = my_role === 'seller' ? req.user.user_id : partnerId;
    const result = await pool.query(
      `INSERT INTO transactions (buyer_id, seller_id, item_description, amount, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING transaction_id, buyer_id, seller_id, item_description, amount, service_fee, status, created_at, created_by`,
      [buyer_id, seller_id, item_description, amount, req.user.user_id]
    );
    const trade = result.rows[0];
    await logActivity(pool, req.user.user_id, trade.transaction_id, 'trade_created', 'as the ' + my_role + ', ₱' + Number(amount));
    res.status(201).json(trade);
  } catch (err) {
    sendError(res, err);
  }
});

// List my transactions
app.get('/api/transactions', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.transaction_id, t.buyer_id, t.seller_id, t.item_description, t.amount, t.service_fee,
              t.status, t.created_at, t.created_by,
              b.username AS buyer_username, s.username AS seller_username
       FROM transactions t
       JOIN users b ON b.user_id = t.buyer_id
       JOIN users s ON s.user_id = t.seller_id
       WHERE t.buyer_id = $1 OR t.seller_id = $1
       ORDER BY t.created_at DESC`,
      [req.user.user_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error.' });
  }
});

// Requests that other users sent me (waiting for my answer)
app.get('/api/requests', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.transaction_id, t.item_description, t.amount, t.created_at,
              CASE WHEN t.buyer_id = $1 THEN 'buyer' ELSE 'seller' END AS my_role,
              c.username AS from_username
       FROM transactions t
       JOIN users c ON c.user_id = t.created_by
       WHERE t.status = 'pending'
         AND t.created_by <> $1
         AND (t.buyer_id = $1 OR t.seller_id = $1)
       ORDER BY t.created_at DESC`,
      [req.user.user_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error.' });
  }
});

// Accept or decline a request (only the partner who received it can answer). Accepting needs verification.
app.post('/api/transactions/:id/respond', auth, async (req, res) => {
  const { action } = req.body;
  if (!['accept', 'decline'].includes(action) || !/^\d+$/.test(req.params.id)) {
    return res.status(400).json({ message: 'Invalid request.' });
  }
  try {
    if (action === 'accept') {
      await assertVerified(req.user.user_id, 'Verify your identity first before you accept a trade. Open "Edit profile" on your dashboard.');
    }
    const result = action === 'accept'
      ? await pool.query(
          `UPDATE transactions SET status = 'accepted'
           WHERE transaction_id = $1 AND status = 'pending'
             AND created_by <> $2 AND (buyer_id = $2 OR seller_id = $2)
           RETURNING transaction_id, status`,
          [req.params.id, req.user.user_id]
        )
      : await pool.query(
          `UPDATE transactions SET status = 'cancelled', cancelled_by = $2
           WHERE transaction_id = $1 AND status = 'pending'
             AND created_by <> $2 AND (buyer_id = $2 OR seller_id = $2)
           RETURNING transaction_id, status`,
          [req.params.id, req.user.user_id]
        );
    if (!result.rows[0]) {
      return res.status(404).json({ message: 'Request not found, or it was already answered.' });
    }
    await logActivity(pool, req.user.user_id, result.rows[0].transaction_id,
      action === 'accept' ? 'trade_accepted' : 'trade_declined', null);
    res.json(result.rows[0]);
  } catch (err) {
    sendError(res, err);
  }
});

// Cancel a trade. What is allowed depends on where the trade is:
//   pending   : only the person who sent the request
//   accepted  : either person (nothing was paid yet)
//   paid      : only the seller, with a reason, and the buyer is refunded in full
// After delivery or during a dispute the trade cannot be cancelled here.
app.post('/api/transactions/:id/cancel', auth, async (req, res) => {
  const reason = String(req.body.reason || '').trim();
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ message: 'Invalid trade.' });
  if (reason.length > 300) return res.status(400).json({ message: 'Please keep the reason under 300 characters.' });

  try {
    let outcome;
    await withTx(async client => {
      const userId = req.user.user_id;
      const t = (await client.query('SELECT * FROM transactions WHERE transaction_id = $1 FOR UPDATE', [req.params.id])).rows[0];
      if (!t || (String(t.buyer_id) !== String(userId) && String(t.seller_id) !== String(userId))) {
        throw new HttpError(404, 'Trade not found.');
      }
      const isSeller = String(t.seller_id) === String(userId);

      if (t.status === 'pending') {
        if (String(t.created_by) !== String(userId)) {
          throw new HttpError(403, 'Only the person who sent the request can cancel it. You can decline it from your dashboard.');
        }
        await client.query(`UPDATE transactions SET status = 'cancelled', cancelled_by = $1, cancel_reason = $2 WHERE transaction_id = $3`,
          [userId, reason || null, t.transaction_id]);
        await logActivity(client, userId, t.transaction_id, 'trade_cancelled', 'cancelled the request' + (reason ? ': ' + reason : ''));
        outcome = 'cancelled';

      } else if (t.status === 'accepted') {
        await client.query(`UPDATE transactions SET status = 'cancelled', cancelled_by = $1, cancel_reason = $2 WHERE transaction_id = $3`,
          [userId, reason || null, t.transaction_id]);
        await logActivity(client, userId, t.transaction_id, 'trade_cancelled', 'cancelled before payment' + (reason ? ': ' + reason : ''));
        outcome = 'cancelled';

      } else if (t.status === 'paid') {
        if (!isSeller) {
          throw new HttpError(403, 'Only the seller can cancel after payment. If something is wrong, open a dispute.');
        }
        if (reason.length < 5) throw new HttpError(400, 'Write a short reason for cancelling.');
        const pay = (await client.query(
          'SELECT payment_status FROM escrow_payments WHERE transaction_id = $1 FOR UPDATE', [t.transaction_id]
        )).rows[0];
        if (!pay || pay.payment_status !== 'held') throw new HttpError(409, 'There is no held payment for this trade.');

        await client.query(`UPDATE escrow_payments SET payment_status = 'refunded' WHERE transaction_id = $1`, [t.transaction_id]);
        await client.query(`UPDATE transactions SET status = 'refunded', cancelled_by = $1, cancel_reason = $2 WHERE transaction_id = $3`,
          [userId, reason, t.transaction_id]);
        await logActivity(client, userId, t.transaction_id, 'seller_cancelled', reason);
        outcome = 'refunded';

      } else if (t.status === 'delivered') {
        throw new HttpError(409, 'The item was already delivered. The buyer confirms it, or opens a dispute if something is wrong.');
      } else if (t.status === 'disputed') {
        throw new HttpError(409, 'This trade is in dispute. An admin will decide it.');
      } else {
        throw new HttpError(409, 'This trade is already finished.');
      }
    });
    res.json({ ok: true, status: outcome });
  } catch (err) {
    sendError(res, err);
  }
});

// Lock one trade and make sure this user may do this step
async function lockTrade(client, id, userId, { role, status }) {
  const r = await client.query('SELECT * FROM transactions WHERE transaction_id = $1 FOR UPDATE', [id]);
  const t = r.rows[0];
  if (!t || (String(t.buyer_id) !== String(userId) && String(t.seller_id) !== String(userId))) {
    throw new HttpError(404, 'Trade not found.');
  }
  const owner = role === 'buyer' ? t.buyer_id : t.seller_id;
  if (String(owner) !== String(userId)) throw new HttpError(403, 'Only the ' + role + ' can do this.');
  if (t.status !== status) throw new HttpError(409, 'This step is not available for the trade\'s current status.');
  return t;
}

// Release the held payment to the seller and issue the receipt
async function releasePayment(client, transactionId) {
  await client.query(
    `UPDATE escrow_payments SET payment_status = 'released', released_at = now() WHERE transaction_id = $1`,
    [transactionId]
  );
  await client.query(`UPDATE transactions SET status = 'completed' WHERE transaction_id = $1`, [transactionId]);
  const number = 'ST-' + String(transactionId).padStart(4, '0');
  await client.query(
    `INSERT INTO receipts (transaction_id, receipt_number) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [transactionId, number]
  );
}

// One trade: details, payment, receipt, and chat messages (participants only).
// Mobile numbers are never sent in full, only a masked copy.
app.get('/api/transactions/:id', auth, async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ message: 'Invalid trade.' });
  try {
    const found = await pool.query(
      `SELECT t.*, b.username AS buyer_username, s.username AS seller_username,
              b.avatar_file AS buyer_avatar, s.avatar_file AS seller_avatar,
              (b.verified_at IS NOT NULL OR b.role = 'admin') AS buyer_verified,
              (s.verified_at IS NOT NULL OR s.role = 'admin') AS seller_verified,
              c.username AS cancelled_by_username,
              EXISTS (SELECT 1 FROM favorites fv WHERE fv.user_id = $2
                      AND fv.favorite_user_id = (CASE WHEN t.buyer_id = $2 THEN t.seller_id ELSE t.buyer_id END)) AS partner_is_favorite,
              CASE WHEN t.buyer_id = $2 THEN 'buyer' ELSE 'seller' END AS my_role,
              (t.created_by = $2) AS created_by_me
       FROM transactions t
       JOIN users b ON b.user_id = t.buyer_id
       JOIN users s ON s.user_id = t.seller_id
       LEFT JOIN users c ON c.user_id = t.cancelled_by
       WHERE t.transaction_id = $1 AND (t.buyer_id = $2 OR t.seller_id = $2)`,
      [req.params.id, req.user.user_id]
    );
    const row = found.rows[0];
    if (!row) return res.status(404).json({ message: 'Trade not found.' });
    const { payout_number, ...trade } = row;

    const paymentResult = await pool.query(
      'SELECT payment_method, payment_status, released_at, payer_number FROM escrow_payments WHERE transaction_id = $1',
      [req.params.id]
    );
    const p = paymentResult.rows[0];
    const payment = p
      ? {
          payment_method: p.payment_method,
          payment_status: p.payment_status,
          released_at: p.released_at,
          payer_masked: maskNumber(p.payer_number),
        }
      : null;

    const receipt = await pool.query(
      'SELECT receipt_number, issued_at FROM receipts WHERE transaction_id = $1',
      [req.params.id]
    );
    const messages = await pool.query(
      `SELECT m.message_id, m.sender_id, u.username, u.avatar_file, m.content, m.sent_at
       FROM messages m JOIN users u ON u.user_id = m.sender_id
       WHERE m.transaction_id = $1
       ORDER BY m.sent_at, m.message_id`,
      [req.params.id]
    );

    res.json({
      ...trade,
      payout_masked: maskNumber(payout_number),
      payment,
      receipt: receipt.rows[0] || null,
      messages: messages.rows,
    });
  } catch (err) {
    sendError(res, err);
  }
});

// Buyer pays into escrow (simulated for now). Only GCash is accepted: the buyer says which GCash number they pay from.
app.post('/api/transactions/:id/pay', auth, async (req, res) => {
  const number = String(req.body.number || '').replace(/[\s-]/g, '');
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ message: 'Invalid trade.' });
  if (req.body.method && req.body.method !== 'gcash') {
    return res.status(400).json({ message: 'Only GCash is accepted.' });
  }
  if (!/^09\d{9}$/.test(number)) {
    return res.status(400).json({
      message: 'Enter the 11-digit GCash number you are paying from (it starts with 09).'
    });
  }
  try {
    await withTx(async client => {
      const t = await lockTrade(client, req.params.id, req.user.user_id, { role: 'buyer', status: 'accepted' });
      await client.query(
        `INSERT INTO escrow_payments (transaction_id, payment_method, payer_number, amount_held, payment_status)
         VALUES ($1, 'gcash', $2, $3, 'held')`,
        [t.transaction_id, number, t.amount]
      );
      await client.query(`UPDATE transactions SET status = 'paid' WHERE transaction_id = $1`, [t.transaction_id]);
      await logActivity(client, req.user.user_id, t.transaction_id, 'paid', 'with GCash, ₱' + Number(t.amount));
    });
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

// Seller says the item was delivered, and says which GCash number should receive the money
app.post('/api/transactions/:id/deliver', auth, async (req, res) => {
  const number = String(req.body.number || '').replace(/[\s-]/g, '');
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ message: 'Invalid trade.' });
  if (req.body.method && req.body.method !== 'gcash') {
    return res.status(400).json({ message: 'Only GCash is accepted.' });
  }
  if (!/^09\d{9}$/.test(number)) {
    return res.status(400).json({
      message: 'Enter the 11-digit GCash number (it starts with 09) where you want to receive your money.'
    });
  }
  try {
    await withTx(async client => {
      const t = await lockTrade(client, req.params.id, req.user.user_id, { role: 'seller', status: 'paid' });
      await client.query(
        `UPDATE transactions
         SET status = 'delivered', delivered_at = now(), payout_method = 'gcash', payout_number = $1
         WHERE transaction_id = $2`,
        [number, t.transaction_id]
      );
      await logActivity(client, req.user.user_id, t.transaction_id, 'delivered', 'payout to GCash');
    });
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

// Buyer confirms receipt: the payment is released to the seller
app.post('/api/transactions/:id/confirm', auth, async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ message: 'Invalid trade.' });
  try {
    await withTx(async client => {
      const t = await lockTrade(client, req.params.id, req.user.user_id, { role: 'buyer', status: 'delivered' });
      await releasePayment(client, t.transaction_id);
      await logActivity(client, req.user.user_id, t.transaction_id, 'confirmed', null);
    });
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

// Chat: send a message in a trade
app.post('/api/transactions/:id/messages', auth, async (req, res) => {
  const content = String(req.body.content || '').trim();
  if (!/^\d+$/.test(req.params.id) || !content || content.length > 1000) {
    return res.status(400).json({ message: 'Write a message of 1 to 1000 characters.' });
  }
  try {
    const mine = await pool.query(
      'SELECT 1 FROM transactions WHERE transaction_id = $1 AND (buyer_id = $2 OR seller_id = $2)',
      [req.params.id, req.user.user_id]
    );
    if (!mine.rows[0]) return res.status(404).json({ message: 'Trade not found.' });
    await pool.query(
      'INSERT INTO messages (transaction_id, sender_id, content) VALUES ($1, $2, $3)',
      [req.params.id, req.user.user_id, content]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

// ---------- History and ratings ----------

// My finished trades (completed, refunded, cancelled) with the details a receipt needs.
// Mobile numbers are only sent masked. rate_later tells the dashboard to stop reminding me.
app.get('/api/history', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.transaction_id, t.item_description, t.amount, t.service_fee, t.status, t.created_at,
              b.username AS buyer_username, s.username AS seller_username,
              CASE WHEN t.buyer_id = $1 THEN 'buyer' ELSE 'seller' END AS my_role,
              CASE WHEN t.buyer_id = $1 THEN s.username ELSE b.username END AS partner_username,
              EXISTS (SELECT 1 FROM favorites fv WHERE fv.user_id = $1
                      AND fv.favorite_user_id = (CASE WHEN t.buyer_id = $1 THEN t.seller_id ELSE t.buyer_id END)) AS partner_is_favorite,
              t.payout_method, t.payout_number,
              p.payment_method, p.payer_number,
              r.receipt_number, r.issued_at,
              EXISTS (SELECT 1 FROM disputes d WHERE d.transaction_id = t.transaction_id) AS had_dispute,
              EXISTS (SELECT 1 FROM rate_dismissals rd WHERE rd.user_id = $1 AND rd.transaction_id = t.transaction_id) AS rate_later,
              mr.score AS my_score
       FROM transactions t
       JOIN users b ON b.user_id = t.buyer_id
       JOIN users s ON s.user_id = t.seller_id
       LEFT JOIN escrow_payments p ON p.transaction_id = t.transaction_id
       LEFT JOIN receipts r ON r.transaction_id = t.transaction_id
       LEFT JOIN ratings mr ON mr.transaction_id = t.transaction_id AND mr.rated_by = $1
       WHERE (t.buyer_id = $1 OR t.seller_id = $1)
         AND t.status IN ('completed', 'refunded', 'cancelled')
       ORDER BY COALESCE(r.issued_at, t.created_at) DESC
       LIMIT 200`,
      [req.user.user_id]
    );
    res.json(result.rows.map(h => ({
      transaction_id: h.transaction_id,
      item_description: h.item_description,
      amount: Number(h.amount),
      service_fee: Number(h.service_fee),
      status: h.status,
      date: h.issued_at || h.created_at,
      my_role: h.my_role,
      buyer_username: h.buyer_username,
      seller_username: h.seller_username,
      partner_username: h.partner_username,
      partner_is_favorite: h.partner_is_favorite,
      payout_method: h.payout_method,
      payout_masked: maskNumber(h.payout_number),
      payment_method: h.payment_method,
      payer_masked: maskNumber(h.payer_number),
      receipt_number: h.receipt_number,
      had_dispute: h.had_dispute,
      rate_later: h.rate_later,
      my_score: h.my_score,
    })));
  } catch (err) {
    sendError(res, err);
  }
});

// Rate the other person in a completed trade. Optional, once per person, and it cannot be changed.
// The public only sees the stars and the comment, not who wrote it. Admins can see who.
app.post('/api/transactions/:id/rating', auth, async (req, res) => {
  const score = Number(req.body.score);
  const feedback = String(req.body.feedback || '').trim();
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ message: 'Invalid trade.' });
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    return res.status(400).json({ message: 'Choose 1 to 5 stars.' });
  }
  if (feedback.length > 500) {
    return res.status(400).json({ message: 'Please keep the feedback under 500 characters.' });
  }
  try {
    const r = await pool.query(
      'SELECT buyer_id, seller_id, status FROM transactions WHERE transaction_id = $1',
      [req.params.id]
    );
    const t = r.rows[0];
    const me = String(req.user.user_id);
    if (!t || (String(t.buyer_id) !== me && String(t.seller_id) !== me)) {
      throw new HttpError(404, 'Trade not found.');
    }
    if (t.status !== 'completed') {
      throw new HttpError(409, 'You can only rate a trade after it is completed.');
    }
    const other = String(t.buyer_id) === me ? t.seller_id : t.buyer_id;
    await pool.query(
      `INSERT INTO ratings (transaction_id, rated_by, rated_user_id, score, feedback)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.params.id, req.user.user_id, other, score, feedback || null]
    );
    await logActivity(pool, req.user.user_id, Number(req.params.id), 'rated', score + ' of 5 stars');
    res.status(201).json({ ok: true });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ message: 'You already rated this trade.' });
    }
    sendError(res, err);
  }
});

// "Rate later": stop reminding me about this trade on the dashboard.
// I can still rate it from History or the trade page.
app.post('/api/transactions/:id/rate-later', auth, async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ message: 'Invalid trade.' });
  try {
    const t = (await pool.query(
      'SELECT buyer_id, seller_id, status FROM transactions WHERE transaction_id = $1',
      [req.params.id]
    )).rows[0];
    const me = String(req.user.user_id);
    if (!t || (String(t.buyer_id) !== me && String(t.seller_id) !== me)) {
      throw new HttpError(404, 'Trade not found.');
    }
    if (t.status !== 'completed') {
      throw new HttpError(409, 'Only a completed trade can be rated.');
    }
    await pool.query(
      `INSERT INTO rate_dismissals (user_id, transaction_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [req.user.user_id, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

// ---------- Disputes ----------
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const IMAGE_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
const MIME_BY_EXT = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
const MAX_FILES = 5;
const MAX_FILE_MB = 5;

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + IMAGE_TYPES[file.mimetype]),
  }),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: MAX_FILES },
  fileFilter: (req, file, cb) => {
    if (IMAGE_TYPES[file.mimetype]) return cb(null, true);
    cb(new HttpError(400, 'Only image files (JPG, PNG, WEBP, or GIF) are allowed.'));
  },
});

// Read the uploaded images (field name "files") and turn upload problems into clear messages
function uploadFiles(req, res, next) {
  upload.array('files', MAX_FILES)(req, res, err => {
    if (!err) return next();
    if (err instanceof HttpError) return sendError(res, err);
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ message: 'Each image must be ' + MAX_FILE_MB + ' MB or smaller.' });
    }
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ message: 'You can upload up to ' + MAX_FILES + ' images.' });
    }
    console.error(err);
    res.status(500).json({ message: 'Could not read the upload.' });
  });
}

async function removeFiles(files) {
  await Promise.all((files || []).map(f => fs.promises.unlink(f.path).catch(() => {})));
}

const REASONS = {
  buyer: [
    'I did not receive the item',
    'The item is different from the description',
    'The item is missing parts or was changed after delivery',
    'The seller stopped replying',
    'Other',
  ],
  seller: [
    'I delivered the item but the buyer says they did not receive it',
    'The buyer stopped replying',
    'The buyer is asking for more than what we agreed',
    'Other',
  ],
};

const OUTCOMES = {
  buyer: [
    { value: 'refund', label: 'Refund me', hint: 'The full amount goes back to you.' },
    { value: 'fix', label: 'Ask the seller to fix it', hint: 'The seller gets a chance to correct the delivery first.' },
  ],
  seller: [
    { value: 'release', label: 'Release the payment to me', hint: 'The item was delivered, so the money should be sent to you.' },
    { value: 'fix', label: 'Ask the buyer to fix it', hint: 'The buyer gets a chance to clear up the problem first.' },
  ],
};

async function saveEvidence(client, disputeId, userId, files) {
  for (const f of files) {
    const name = path.basename(String(f.originalname || 'image')).slice(0, 100);
    await client.query(
      'INSERT INTO evidence (dispute_id, submitted_by, file_url, description) VALUES ($1, $2, $3, $4)',
      [disputeId, userId, f.filename, name]
    );
  }
}

// All the disputes I am part of (the list shown when "Disputes" is opened from the menu)
app.get('/api/disputes', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT d.dispute_id, d.dispute_status, d.opened_at, d.filed_by, d.reply,
              t.transaction_id, t.item_description, t.amount, t.status AS trade_status,
              CASE WHEN t.buyer_id = $1 THEN 'buyer' ELSE 'seller' END AS my_role,
              CASE WHEN t.buyer_id = $1 THEN s.username ELSE b.username END AS partner_username,
              f.username AS filed_by_username
       FROM disputes d
       JOIN transactions t ON t.transaction_id = d.transaction_id
       JOIN users b ON b.user_id = t.buyer_id
       JOIN users s ON s.user_id = t.seller_id
       JOIN users f ON f.user_id = d.filed_by
       WHERE t.buyer_id = $1 OR t.seller_id = $1
       ORDER BY (d.dispute_status = 'resolved'), d.opened_at DESC
       LIMIT 100`,
      [req.user.user_id]
    );
    res.json(result.rows.map(d => ({
      dispute_id: d.dispute_id,
      dispute_status: d.dispute_status,
      opened_at: d.opened_at,
      transaction_id: d.transaction_id,
      item_description: d.item_description,
      amount: Number(d.amount),
      trade_status: d.trade_status,
      my_role: d.my_role,
      partner_username: d.partner_username,
      filed_by_username: d.filed_by_username,
      filed_by_me: String(d.filed_by) === String(req.user.user_id),
      needs_my_reply: d.dispute_status !== 'resolved' && String(d.filed_by) !== String(req.user.user_id) && !d.reply,
    })));
  } catch (err) {
    sendError(res, err);
  }
});

// The dispute page: the trade, whether I can open a dispute, and the dispute itself (if any)
app.get('/api/transactions/:id/dispute', auth, async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ message: 'Invalid trade.' });
  const userId = req.user.user_id;
  try {
    const found = await pool.query(
      `SELECT t.transaction_id, t.item_description, t.amount, t.status, t.buyer_id,
              b.username AS buyer_username, s.username AS seller_username
       FROM transactions t
       JOIN users b ON b.user_id = t.buyer_id
       JOIN users s ON s.user_id = t.seller_id
       WHERE t.transaction_id = $1 AND (t.buyer_id = $2 OR t.seller_id = $2)`,
      [req.params.id, userId]
    );
    const t = found.rows[0];
    if (!t) return res.status(404).json({ message: 'Trade not found.' });
    const role = String(t.buyer_id) === String(userId) ? 'buyer' : 'seller';

    const d = (await pool.query(
      `SELECT d.*, f.username AS filed_by_username
       FROM disputes d JOIN users f ON f.user_id = d.filed_by
       WHERE d.transaction_id = $1`,
      [req.params.id]
    )).rows[0];

    let dispute = null;
    if (d) {
      const evidence = await pool.query(
        `SELECT e.evidence_id, e.description AS name, e.uploaded_at,
                u.username AS submitted_by_username, (e.submitted_by = $2) AS mine
         FROM evidence e JOIN users u ON u.user_id = e.submitted_by
         WHERE e.dispute_id = $1
         ORDER BY e.uploaded_at, e.evidence_id`,
        [d.dispute_id, userId]
      );
      const filedByMe = String(d.filed_by) === String(userId);
      dispute = {
        dispute_id: d.dispute_id,
        reason: d.reason,
        description: d.description,
        requested_outcome: d.requested_outcome,
        dispute_status: d.dispute_status,
        resolution: d.resolution,
        opened_at: d.opened_at,
        filed_by_username: d.filed_by_username,
        filed_by_me: filedByMe,
        reply: d.reply,
        replied_at: d.replied_at,
        can_reply: d.dispute_status !== 'resolved' && !filedByMe,
        evidence: evidence.rows,
      };
    }

    res.json({
      trade: {
        transaction_id: t.transaction_id,
        item_description: t.item_description,
        amount: t.amount,
        status: t.status,
        my_role: role,
        buyer_username: t.buyer_username,
        seller_username: t.seller_username,
      },
      can_file: !d && ['paid', 'delivered'].includes(t.status),
      reasons: REASONS[role],
      outcomes: OUTCOMES[role],
      dispute,
    });
  } catch (err) {
    sendError(res, err);
  }
});

// Open a dispute (with up to 5 screenshots). The payment stays in escrow.
app.post('/api/transactions/:id/dispute', auth, uploadFiles, async (req, res) => {
  const files = req.files || [];
  try {
    if (!/^\d+$/.test(req.params.id)) throw new HttpError(400, 'Invalid trade.');
    const reason = String(req.body.reason || '').trim();
    const description = String(req.body.description || '').trim();
    const outcome = String(req.body.outcome || '').trim();
    if (!description) throw new HttpError(400, 'Tell us what happened.');
    if (description.length > 2000) throw new HttpError(400, 'Please keep the description under 2000 characters.');

    await withTx(async client => {
      const r = await client.query('SELECT * FROM transactions WHERE transaction_id = $1 FOR UPDATE', [req.params.id]);
      const t = r.rows[0];
      const userId = req.user.user_id;
      if (!t || (String(t.buyer_id) !== String(userId) && String(t.seller_id) !== String(userId))) {
        throw new HttpError(404, 'Trade not found.');
      }
      const role = String(t.buyer_id) === String(userId) ? 'buyer' : 'seller';

      if (!['paid', 'delivered'].includes(t.status)) {
        throw new HttpError(409, 'You can only report a problem while the trade is paid or delivered.');
      }
      if (!REASONS[role].includes(reason)) throw new HttpError(400, 'Choose a reason.');
      if (!OUTCOMES[role].some(o => o.value === outcome)) throw new HttpError(400, 'Choose the outcome you want.');

      const existing = await client.query('SELECT 1 FROM disputes WHERE transaction_id = $1', [t.transaction_id]);
      if (existing.rows[0]) throw new HttpError(409, 'A dispute was already opened for this trade.');

      const created = await client.query(
        `INSERT INTO disputes (transaction_id, filed_by, reason, description, requested_outcome)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING dispute_id`,
        [t.transaction_id, userId, reason, description, outcome]
      );
      await saveEvidence(client, created.rows[0].dispute_id, userId, files);
      await client.query(`UPDATE transactions SET status = 'disputed' WHERE transaction_id = $1`, [t.transaction_id]);
      await logActivity(client, userId, t.transaction_id, 'dispute_opened', reason);
    });
    res.status(201).json({ ok: true });
  } catch (err) {
    await removeFiles(files);
    sendError(res, err);
  }
});

// The other person replies to a dispute and can add their own screenshots
app.post('/api/transactions/:id/dispute/reply', auth, uploadFiles, async (req, res) => {
  const files = req.files || [];
  try {
    if (!/^\d+$/.test(req.params.id)) throw new HttpError(400, 'Invalid trade.');
    const message = String(req.body.message || '').trim();
    if (!message) throw new HttpError(400, 'Write your reply.');
    if (message.length > 2000) throw new HttpError(400, 'Please keep the reply under 2000 characters.');

    await withTx(async client => {
      const userId = req.user.user_id;
      const r = await client.query(
        `SELECT d.dispute_id, d.filed_by, d.dispute_status, t.transaction_id, t.buyer_id, t.seller_id
         FROM disputes d JOIN transactions t ON t.transaction_id = d.transaction_id
         WHERE d.transaction_id = $1
         FOR UPDATE OF d`,
        [req.params.id]
      );
      const d = r.rows[0];
      if (!d || (String(d.buyer_id) !== String(userId) && String(d.seller_id) !== String(userId))) {
        throw new HttpError(404, 'Dispute not found.');
      }
      if (String(d.filed_by) === String(userId)) {
        throw new HttpError(403, 'You opened this dispute. The other person replies to it.');
      }
      if (d.dispute_status === 'resolved') throw new HttpError(409, 'This dispute was already decided.');

      await client.query(
        `UPDATE disputes SET reply = $1, replied_at = now(), dispute_status = 'under_review' WHERE dispute_id = $2`,
        [message, d.dispute_id]
      );
      await saveEvidence(client, d.dispute_id, userId, files);
      await logActivity(client, userId, d.transaction_id, 'dispute_reply', null);
    });
    res.json({ ok: true });
  } catch (err) {
    await removeFiles(files);
    sendError(res, err);
  }
});

// One evidence image. Only the two traders (and admins) can open it.
app.get('/api/evidence/:id/file', auth, async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ message: 'Invalid file.' });
  try {
    const r = await pool.query(
      `SELECT e.file_url, t.buyer_id, t.seller_id
       FROM evidence e
       JOIN disputes d ON d.dispute_id = e.dispute_id
       JOIN transactions t ON t.transaction_id = d.transaction_id
       WHERE e.evidence_id = $1`,
      [req.params.id]
    );
    const row = r.rows[0];
    const userId = String(req.user.user_id);
    const allowed = row && (
      String(row.buyer_id) === userId ||
      String(row.seller_id) === userId ||
      (await isAdmin(req.user.user_id))
    );
    if (!allowed) return res.status(404).json({ message: 'File not found.' });

    const file = path.basename(row.file_url);
    res.setHeader('Content-Type', MIME_BY_EXT[path.extname(file).toLowerCase()] || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.sendFile(file, { root: UPLOAD_DIR }, err => {
      if (err && !res.headersSent) res.status(404).json({ message: 'File not found.' });
    });
  } catch (err) {
    sendError(res, err);
  }
});

// ---------- My profile: photo, username, email ----------
const AVATAR_DIR = path.join(UPLOAD_DIR, 'avatars');
fs.mkdirSync(AVATAR_DIR, { recursive: true });
const AVATAR_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const AVATAR_MAX_MB = 2;

const avatarUpload = multer({
  storage: multer.diskStorage({
    destination: AVATAR_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + AVATAR_TYPES[file.mimetype]),
  }),
  limits: { fileSize: AVATAR_MAX_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (AVATAR_TYPES[file.mimetype]) return cb(null, true);
    cb(new HttpError(400, 'Choose a JPG, PNG, or WEBP photo.'));
  },
});

// Read the photo (field name "photo") and turn upload problems into clear messages
function uploadAvatar(req, res, next) {
  avatarUpload.single('photo')(req, res, err => {
    if (!err) return next();
    if (err instanceof HttpError) return sendError(res, err);
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ message: 'The photo must be ' + AVATAR_MAX_MB + ' MB or smaller.' });
    }
    console.error(err);
    res.status(400).json({ message: 'Could not read the photo.' });
  });
}

// Make sure the file really is the kind of image it says it is
async function looksLikeImage(filePath, ext) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(12);
    await handle.read(buf, 0, 12, 0);
    if (ext === '.jpg') return buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
    if (ext === '.png') return buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG';
    if (ext === '.webp') return buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
    return false;
  } finally {
    await handle.close();
  }
}

function removeAvatarFile(name) {
  if (!name) return Promise.resolve();
  return fs.promises.unlink(path.join(AVATAR_DIR, path.basename(name))).catch(() => {});
}

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
app.get('/api/profile', auth, async (req, res) => {
  try {
    const u = (await pool.query(
      `SELECT user_id, first_name, last_name, full_name, username, email, role, created_at, avatar_file,
              username_changed_at, verified_at,
              (verified_at IS NOT NULL OR role = 'admin') AS verified
       FROM users WHERE user_id = $1`,
      [req.user.user_id]
    )).rows[0];
    const stats = (await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM transactions
           WHERE status::text = ANY($2) AND (buyer_id = $1 OR seller_id = $1)) AS active_trades,
         (SELECT COUNT(*) FROM transactions
           WHERE status = 'completed' AND (buyer_id = $1 OR seller_id = $1)) AS completed_trades,
         (SELECT ROUND(AVG(score)::numeric, 1) FROM ratings WHERE rated_user_id = $1 AND deleted_at IS NULL) AS avg_rating,
         (SELECT COUNT(*) FROM ratings WHERE rated_user_id = $1 AND deleted_at IS NULL) AS rating_count`,
      [req.user.user_id, PROCESS_STATUSES]
    )).rows[0];

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
      avg_rating: stats.avg_rating === null ? null : Number(stats.avg_rating),
      rating_count: Number(stats.rating_count),
    });
  } catch (err) {
    sendError(res, err);
  }
});

// Upload or replace my profile photo
app.post('/api/profile/avatar', auth, uploadAvatar, async (req, res) => {
  const file = req.file;
  try {
    if (!file) throw new HttpError(400, 'Choose a photo.');
    if (!(await looksLikeImage(file.path, path.extname(file.filename)))) {
      throw new HttpError(400, 'That file is not a valid JPG, PNG, or WEBP image.');
    }
    const old = (await pool.query('SELECT avatar_file FROM users WHERE user_id = $1', [req.user.user_id])).rows[0];
    await pool.query('UPDATE users SET avatar_file = $1 WHERE user_id = $2', [file.filename, req.user.user_id]);
    await removeAvatarFile(old && old.avatar_file);
    await logActivity(pool, req.user.user_id, null, 'avatar_changed', null);
    res.json({ ok: true, avatar_file: file.filename });
  } catch (err) {
    if (file) await removeAvatarFile(file.filename);
    sendError(res, err);
  }
});

// Remove my profile photo
app.delete('/api/profile/avatar', auth, async (req, res) => {
  try {
    const old = (await pool.query('SELECT avatar_file FROM users WHERE user_id = $1', [req.user.user_id])).rows[0];
    await pool.query('UPDATE users SET avatar_file = NULL WHERE user_id = $1', [req.user.user_id]);
    await removeAvatarFile(old && old.avatar_file);
    res.json({ ok: true, avatar_file: null });
  } catch (err) {
    sendError(res, err);
  }
});

// Change my username: once every 30 days, and never while I have trades on process
app.put('/api/profile/username', auth, async (req, res) => {
  const username = String(req.body.username || '').trim();
  if (!USERNAME_RE.test(username)) {
    return res.status(400).json({ message: 'Username must be 3 to 30 letters, numbers, or underscores.' });
  }
  try {
    await withTx(async client => {
      const id = req.user.user_id;
      const me = (await client.query(
        'SELECT username, username_changed_at FROM users WHERE user_id = $1 FOR UPDATE', [id]
      )).rows[0];

      if (me.username === username) throw new HttpError(400, 'That is already your username.');

      if (me.username_changed_at) {
        const ready = new Date(me.username_changed_at).getTime() + USERNAME_COOLDOWN_DAYS * 86400000;
        if (ready > Date.now()) {
          const when = new Date(ready).toLocaleDateString('en-PH', { month: 'long', day: 'numeric', year: 'numeric' });
          throw new HttpError(409, 'You can change your username again on ' + when + '.');
        }
      }

      const active = (await client.query(
        `SELECT COUNT(*) AS n FROM transactions
         WHERE status::text = ANY($2) AND (buyer_id = $1 OR seller_id = $1)`,
        [id, PROCESS_STATUSES]
      )).rows[0];
      if (Number(active.n) > 0) {
        throw new HttpError(409, 'You cannot change your username while you have trades on process.');
      }

      await client.query('UPDATE users SET username = $1, username_changed_at = now() WHERE user_id = $2', [username, id]);
      await logActivity(client, id, null, 'username_changed', '@' + me.username + ' to @' + username);
    });
    res.json({ ok: true, username });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ message: 'That username is taken.' });
    sendError(res, err);
  }
});

// Email PIN for a new email address (saved as a hash, expires in 10 minutes)
async function issueEmailChangePin(userId, newEmail) {
  const last = (await pool.query(
    'SELECT EXTRACT(EPOCH FROM (now() - created_at)) AS age FROM email_changes WHERE user_id = $1', [userId]
  )).rows[0];
  if (last && Number(last.age) < RESEND_SECONDS) {
    throw new HttpError(429, 'Please wait ' + Math.ceil(RESEND_SECONDS - Number(last.age)) + ' seconds before asking for another PIN.');
  }

  const pin = String(crypto.randomInt(100000, 1000000));
  const pin_hash = await bcrypt.hash(pin, 8);
  await pool.query(
    `INSERT INTO email_changes (user_id, new_email, pin_hash, attempts, expires_at, created_at)
     VALUES ($1, $2, $3, 0, now() + interval '${PIN_MINUTES} minutes', now())
     ON CONFLICT (user_id) DO UPDATE
       SET new_email = EXCLUDED.new_email, pin_hash = EXCLUDED.pin_hash, attempts = 0,
           expires_at = EXCLUDED.expires_at, created_at = now()`,
    [userId, newEmail, pin_hash]
  );
  try {
    await sendPinEmail(newEmail, pin, 'email_change');
  } catch (err) {
    await pool.query('DELETE FROM email_changes WHERE user_id = $1', [userId]);
    throw err;
  }
}

// Change my email, step 1: the current password, then a PIN goes to the NEW email
app.post('/api/profile/email/start', auth, async (req, res) => {
  const newEmail = String(req.body.new_email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!EMAIL_RE.test(newEmail)) return res.status(400).json({ message: 'Enter a valid email.' });
  try {
    const me = (await pool.query('SELECT email, password_hash FROM users WHERE user_id = $1', [req.user.user_id])).rows[0];
    if (newEmail === me.email) throw new HttpError(400, 'That is already your email.');
    if (!(await bcrypt.compare(password, me.password_hash))) {
      throw new HttpError(400, 'Your current password is wrong.');
    }
    const taken = await pool.query('SELECT 1 FROM users WHERE email = $1', [newEmail]);
    if (taken.rows[0]) throw new HttpError(409, 'That email is already used by another account.');

    await issueEmailChangePin(req.user.user_id, newEmail);
    res.json({ ok: true, new_email: newEmail });
  } catch (err) {
    sendError(res, err);
  }
});

// Change my email, step 2: the PIN from the new email
app.post('/api/profile/email/verify', auth, async (req, res) => {
  const pin = String(req.body.pin || '').trim();
  try {
    if (!/^\d{6}$/.test(pin)) throw new HttpError(400, 'Enter the 6-digit PIN.');
    const id = req.user.user_id;
    const row = (await pool.query('SELECT * FROM email_changes WHERE user_id = $1', [id])).rows[0];
    if (!row || new Date(row.expires_at) < new Date()) {
      if (row) await pool.query('DELETE FROM email_changes WHERE user_id = $1', [id]);
      throw new HttpError(400, 'Wrong or expired PIN. Please start again.');
    }
    if (!(await bcrypt.compare(pin, row.pin_hash))) {
      const used = row.attempts + 1;
      if (used >= MAX_PIN_TRIES) {
        await pool.query('DELETE FROM email_changes WHERE user_id = $1', [id]);
        throw new HttpError(429, 'Too many wrong tries. Please start again.');
      }
      await pool.query('UPDATE email_changes SET attempts = $1 WHERE user_id = $2', [used, id]);
      throw new HttpError(400, 'Wrong PIN. ' + (MAX_PIN_TRIES - used) + ' tries left.');
    }

    try {
      await pool.query('UPDATE users SET email = $1 WHERE user_id = $2', [row.new_email, id]);
    } catch (err) {
      if (err.code === '23505') {
        await pool.query('DELETE FROM email_changes WHERE user_id = $1', [id]);
        throw new HttpError(409, 'That email was just taken by someone else. Please start again.');
      }
      throw err;
    }
    await pool.query('DELETE FROM email_changes WHERE user_id = $1', [id]);
    await logActivity(pool, id, null, 'email_changed', null);
    res.json({ ok: true, email: row.new_email });
  } catch (err) {
    sendError(res, err);
  }
});

// Change my email: send the PIN again
app.post('/api/profile/email/resend', auth, async (req, res) => {
  try {
    const row = (await pool.query('SELECT new_email FROM email_changes WHERE user_id = $1', [req.user.user_id])).rows[0];
    if (!row) throw new HttpError(404, 'Please start again.');
    await issueEmailChangePin(req.user.user_id, row.new_email);
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

// ---------- Identity verification ----------
// The user shows an ID and a selfie holding the ID next to a code. An admin reviews it.
// The admin also checks that the ID shows the person is 18 or older.
// The pictures are private and are deleted as soon as the admin decides. No ID number is saved.
const VERIF_DIR = path.join(UPLOAD_DIR, 'verifications');
fs.mkdirSync(VERIF_DIR, { recursive: true });
const VERIF_MAX_MB = 5;

const verifUpload = multer({
  storage: multer.diskStorage({
    destination: VERIF_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + AVATAR_TYPES[file.mimetype]),
  }),
  limits: { fileSize: VERIF_MAX_MB * 1024 * 1024, files: 2 },
  fileFilter: (req, file, cb) => {
    if (AVATAR_TYPES[file.mimetype]) return cb(null, true);
    cb(new HttpError(400, 'The pictures must be JPG, PNG, or WEBP.'));
  },
});

function uploadVerification(req, res, next) {
  verifUpload.fields([{ name: 'id_photo', maxCount: 1 }, { name: 'selfie', maxCount: 1 }])(req, res, err => {
    if (!err) return next();
    if (err instanceof HttpError) return sendError(res, err);
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ message: 'Each picture must be ' + VERIF_MAX_MB + ' MB or smaller.' });
    }
    console.error(err);
    res.status(400).json({ message: 'Could not read the pictures.' });
  });
}

function removeVerifFile(name) {
  if (!name) return Promise.resolve();
  return fs.promises.unlink(path.join(VERIF_DIR, path.basename(name))).catch(() => {});
}

// My verification: am I verified, is a request waiting, was one rejected, my current code,
// and who tried to trade with me while I was not verified
app.get('/api/verification', auth, async (req, res) => {
  try {
    const id = req.user.user_id;
    const u = (await pool.query(
      `SELECT first_name, last_name, full_name, verified_at, role, verify_code, verify_code_expires_at
       FROM users WHERE user_id = $1`, [id]
    )).rows[0];
    const latest = (await pool.query(
      `SELECT status, typed_name, typed_first_name, typed_last_name, id_type, reject_reason, submitted_at, decided_at
       FROM verifications WHERE user_id = $1 ORDER BY submitted_at DESC LIMIT 1`, [id]
    )).rows[0];

    const verified = !!u.verified_at || u.role === 'admin';
    let attempts = [];
    if (!verified) {
      attempts = (await pool.query(
        `SELECT us.username, ta.created_at
         FROM trade_attempts ta JOIN users us ON us.user_id = ta.from_user_id
         WHERE ta.target_user_id = $1 AND ta.created_at > now() - interval '14 days'
         ORDER BY ta.created_at DESC LIMIT 5`, [id]
      )).rows;
    }

    const codeActive = u.verify_code && new Date(u.verify_code_expires_at) > new Date();
    res.json({
      verified,
      verified_at: u.verified_at,
      first_name: u.first_name,
      last_name: u.last_name,
      full_name: u.full_name,
      id_types: ID_TYPES,
      pending: latest && latest.status === 'pending' ? latest : null,
      rejected: latest && latest.status === 'rejected' ? latest : null,
      code: codeActive ? u.verify_code : null,
      code_expires_at: codeActive ? u.verify_code_expires_at : null,
      attempts,
    });
  } catch (err) {
    sendError(res, err);
  }
});

// A code to write on paper and hold in the selfie (a new one each time, good for 24 hours)
app.post('/api/verification/code', auth, async (req, res) => {
  try {
    const id = req.user.user_id;
    const u = (await pool.query('SELECT verified_at, role FROM users WHERE user_id = $1', [id])).rows[0];
    if (u.verified_at || u.role === 'admin') throw new HttpError(409, 'You are already verified.');
    const pending = (await pool.query(`SELECT 1 FROM verifications WHERE user_id = $1 AND status = 'pending'`, [id])).rows[0];
    if (pending) throw new HttpError(409, 'Your request is already being reviewed.');

    const code = String(crypto.randomInt(100000, 1000000));
    const r = await pool.query(
      `UPDATE users SET verify_code = $1, verify_code_expires_at = now() + interval '${VERIFY_CODE_HOURS} hours'
       WHERE user_id = $2 RETURNING verify_code_expires_at`,
      [code, id]
    );
    res.json({ ok: true, code, code_expires_at: r.rows[0].verify_code_expires_at });
  } catch (err) {
    sendError(res, err);
  }
});

// Send the ID, the selfie with the code, and the first and last name exactly as written on the ID
app.post('/api/verification/submit', auth, uploadVerification, async (req, res) => {
  const files = req.files ? Object.values(req.files).flat() : [];
  try {
    const first = cleanName(req.body.first_name);
    const last = cleanName(req.body.last_name);
    const idType = String(req.body.id_type || '');
    if (!NAME_PART_RE.test(first) || !NAME_PART_RE.test(last)) {
      throw new HttpError(400, 'Type your first name and last name exactly as they are written on your ID (letters only).');
    }
    const typed = first + ' ' + last;
    if (!ID_TYPES.includes(idType)) throw new HttpError(400, 'Choose the kind of ID you are showing.');
    if (req.body.consent !== 'true') throw new HttpError(400, 'Please agree to the verification terms.');

    const idPhoto = req.files && req.files.id_photo && req.files.id_photo[0];
    const selfie = req.files && req.files.selfie && req.files.selfie[0];
    if (!idPhoto || !selfie) throw new HttpError(400, 'Add a picture of your ID and a selfie holding it.');
    for (const f of [idPhoto, selfie]) {
      if (!(await looksLikeImage(f.path, path.extname(f.filename)))) {
        throw new HttpError(400, 'One of the pictures is not a valid JPG, PNG, or WEBP image.');
      }
    }

    await withTx(async client => {
      const id = req.user.user_id;
      const u = (await client.query(
        'SELECT verified_at, role, verify_code, verify_code_expires_at FROM users WHERE user_id = $1 FOR UPDATE', [id]
      )).rows[0];
      if (u.verified_at || u.role === 'admin') throw new HttpError(409, 'You are already verified.');
      if (!u.verify_code || new Date(u.verify_code_expires_at) < new Date()) {
        throw new HttpError(400, 'Your code expired. Get a new code and take the selfie again.');
      }
      const pending = (await client.query(`SELECT 1 FROM verifications WHERE user_id = $1 AND status = 'pending'`, [id])).rows[0];
      if (pending) throw new HttpError(409, 'Your request is already being reviewed.');

      await client.query(
        `INSERT INTO verifications (user_id, typed_name, typed_first_name, typed_last_name, id_type, code, id_file, selfie_file)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, typed, first, last, idType, u.verify_code, idPhoto.filename, selfie.filename]
      );
      await client.query('UPDATE users SET verify_code = NULL, verify_code_expires_at = NULL WHERE user_id = $1', [id]);
      await logActivity(client, id, null, 'verification_submitted', idType);
    });
    res.status(201).json({ ok: true });
  } catch (err) {
    await removeFiles(files);
    if (err.code === '23505') return res.status(409).json({ message: 'Your request is already being reviewed.' });
    sendError(res, err);
  }
});

// A verification picture. Only its owner and admins can open it, and only while it is being reviewed.
app.get('/api/verifications/:id/:kind', auth, async (req, res) => {
  if (!/^\d+$/.test(req.params.id) || !['id', 'selfie'].includes(req.params.kind)) {
    return res.status(404).json({ message: 'File not found.' });
  }
  try {
    const v = (await pool.query('SELECT user_id, id_file, selfie_file FROM verifications WHERE verification_id = $1', [req.params.id])).rows[0];
    const allowed = v && (String(v.user_id) === String(req.user.user_id) || (await isAdmin(req.user.user_id)));
    const name = v && (req.params.kind === 'id' ? v.id_file : v.selfie_file);
    if (!allowed || !name) return res.status(404).json({ message: 'File not found.' });

    const file = path.basename(name);
    res.setHeader('Content-Type', MIME_BY_EXT[path.extname(file).toLowerCase()] || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(file, { root: VERIF_DIR }, err => {
      if (err && !res.headersSent) res.status(404).json({ message: 'File not found.' });
    });
  } catch (err) {
    sendError(res, err);
  }
});

// ---------- Admin ----------

// Overview numbers
app.get('/api/admin/overview', auth, adminOnly, async (req, res) => {
  try {
    const stats = (await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM disputes WHERE dispute_status <> 'resolved') AS open_disputes,
         (SELECT COALESCE(SUM(amount_held), 0) FROM escrow_payments WHERE payment_status = 'held') AS held,
         (SELECT COUNT(*) FROM transactions WHERE created_at >= date_trunc('month', now())) AS trades_month,
         (SELECT COALESCE(SUM(service_fee), 0) FROM transactions WHERE status = 'completed') AS fees,
         (SELECT COUNT(*) FROM verifications WHERE status = 'pending') AS pending_verifications,
         (SELECT COUNT(DISTINCT user_id) FROM support_messages WHERE NOT from_admin AND read_at IS NULL) AS unread_support,
         (SELECT COUNT(*) FROM review_reports WHERE status = 'open') AS open_reports,
         (SELECT COUNT(*) FROM transactions t
            JOIN users b ON b.user_id = t.buyer_id
            JOIN users s ON s.user_id = t.seller_id
           WHERE t.status::text IN ('paid', 'delivered')
             AND (b.account_status::text <> 'active' OR s.account_status::text <> 'active')) AS needs_admin_trades`
    )).rows[0];
    res.json({
      open_disputes: Number(stats.open_disputes),
      held: Number(stats.held),
      trades_month: Number(stats.trades_month),
      fees: Number(stats.fees),
      pending_verifications: Number(stats.pending_verifications),
      unread_support: Number(stats.unread_support),
      open_reports: Number(stats.open_reports),
      needs_admin_trades: Number(stats.needs_admin_trades),
    });
  } catch (err) {
    sendError(res, err);
  }
});

// Verification requests: ?status=pending (default) or all
app.get('/api/admin/verifications', auth, adminOnly, async (req, res) => {
  const all = String(req.query.status || 'pending') === 'all';
  try {
    const result = await pool.query(
      `SELECT v.verification_id, v.status, v.typed_name, v.id_type, v.submitted_at, v.decided_at, v.reject_reason,
              u.username, u.avatar_file, u.full_name
       FROM verifications v JOIN users u ON u.user_id = v.user_id
       WHERE ($1::boolean OR v.status = 'pending')
       ORDER BY (v.status = 'pending') DESC,
                CASE WHEN v.status = 'pending' THEN v.submitted_at END ASC,
                v.decided_at DESC NULLS LAST
       LIMIT 100`,
      [all]
    );
    res.json(result.rows);
  } catch (err) {
    sendError(res, err);
  }
});

// One request: the names, the code, and what to compare the pictures with
app.get('/api/admin/verifications/:id', auth, adminOnly, async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ message: 'Invalid request.' });
  try {
    const v = (await pool.query(
      `SELECT v.verification_id, v.status, v.typed_name, v.id_type, v.code, v.submitted_at, v.decided_at, v.reject_reason,
              (v.id_file IS NOT NULL AND v.selfie_file IS NOT NULL) AS has_files,
              u.username, u.avatar_file, u.full_name, u.email, u.created_at AS joined
       FROM verifications v JOIN users u ON u.user_id = v.user_id
       WHERE v.verification_id = $1`,
      [req.params.id]
    )).rows[0];
    if (!v) return res.status(404).json({ message: 'Request not found.' });
    res.json(v);
  } catch (err) {
    sendError(res, err);
  }
});

// Approve (the typed first and last name become the user's name) or reject (with a reason).
// The pictures are deleted.
app.post('/api/admin/verifications/:id/decision', auth, adminOnly, async (req, res) => {
  const decision = req.body.decision;
  const reason = String(req.body.reason || '').trim();
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ message: 'Invalid request.' });
  if (!['approve', 'reject'].includes(decision)) return res.status(400).json({ message: 'Choose approve or reject.' });
  if (decision === 'reject' && reason.length < 5) return res.status(400).json({ message: 'Write a short reason for rejecting.' });
  if (reason.length > 300) return res.status(400).json({ message: 'Please keep the reason under 300 characters.' });

  let toDelete = [];
  try {
    const me = (await pool.query('SELECT username FROM users WHERE user_id = $1', [req.user.user_id])).rows[0];
    await withTx(async client => {
      const v = (await client.query('SELECT * FROM verifications WHERE verification_id = $1 FOR UPDATE', [req.params.id])).rows[0];
      if (!v) throw new HttpError(404, 'Request not found.');
      if (v.status !== 'pending') throw new HttpError(409, 'This request was already decided.');
      toDelete = [v.id_file, v.selfie_file];

      if (decision === 'approve') {
        // A request sent before the first/last name change only has the combined name
        const names = v.typed_first_name
          ? { first: v.typed_first_name, last: v.typed_last_name || '' }
          : splitFullName(v.typed_name);
        await client.query(
          `UPDATE users
           SET first_name = $1, last_name = $2, full_name = $3, verified_at = now(),
               verify_code = NULL, verify_code_expires_at = NULL
           WHERE user_id = $4`,
          [names.first, names.last, v.typed_name, v.user_id]
        );
        // The notices about people who wanted to trade with them are no longer needed
        await client.query('DELETE FROM trade_attempts WHERE target_user_id = $1', [v.user_id]);
      }
      await client.query(
        `UPDATE verifications
         SET status = $1, reject_reason = $2, decided_at = now(), decided_by = $3, id_file = NULL, selfie_file = NULL
         WHERE verification_id = $4`,
        [decision === 'approve' ? 'approved' : 'rejected', decision === 'reject' ? reason : null, req.user.user_id, v.verification_id]
      );
      await logActivity(client, v.user_id, null,
        decision === 'approve' ? 'verification_approved' : 'verification_rejected',
        'by @' + me.username + (decision === 'reject' ? ': ' + reason : ''));
    });
    await Promise.all(toDelete.map(removeVerifFile));
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

// ---------- Admin: support chat ----------

// Everyone who has a conversation. The ones with unread messages come first.
app.get('/api/admin/support', auth, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM (
         SELECT u.user_id, u.username, u.avatar_file, u.account_status::text AS account_status,
                (SELECT COUNT(*) FROM support_messages m
                  WHERE m.user_id = u.user_id AND NOT m.from_admin AND m.read_at IS NULL) AS unread,
                lm.content AS last_content, lm.sent_at AS last_at, lm.from_admin AS last_from_admin
         FROM users u
         JOIN LATERAL (
           SELECT content, sent_at, from_admin FROM support_messages
           WHERE user_id = u.user_id
           ORDER BY sent_at DESC, message_id DESC LIMIT 1
         ) lm ON true
       ) x
       ORDER BY (x.unread > 0) DESC, x.last_at DESC
       LIMIT 100`
    );
    res.json(result.rows.map(r => ({ ...r, unread: Number(r.unread) })));
  } catch (err) {
    sendError(res, err);
  }
});

// One conversation. Opening it marks the user's messages as read.
app.get('/api/admin/support/:userId', auth, adminOnly, async (req, res) => {
  if (!/^\d+$/.test(req.params.userId)) return res.status(400).json({ message: 'Invalid user.' });
  try {
    const u = (await pool.query(
      `SELECT user_id, username, avatar_file, account_status::text AS account_status FROM users WHERE user_id = $1`,
      [req.params.userId]
    )).rows[0];
    if (!u) return res.status(404).json({ message: 'User not found.' });

    const messages = (await pool.query(
      `SELECT message_id, from_admin, content, sent_at FROM support_messages
       WHERE user_id = $1 ORDER BY sent_at, message_id LIMIT 300`,
      [u.user_id]
    )).rows;
    await pool.query(
      `UPDATE support_messages SET read_at = now() WHERE user_id = $1 AND NOT from_admin AND read_at IS NULL`,
      [u.user_id]
    );
    res.json({ user: u, messages });
  } catch (err) {
    sendError(res, err);
  }
});

// Write to a user (this can start the conversation)
app.post('/api/admin/support/:userId', auth, adminOnly, async (req, res) => {
  if (!/^\d+$/.test(req.params.userId)) return res.status(400).json({ message: 'Invalid user.' });
  try {
    const content = String(req.body.content || '').trim();
    if (!content || content.length > SUPPORT_MAX) {
      throw new HttpError(400, 'Write a message of 1 to ' + SUPPORT_MAX + ' characters.');
    }
    const target = (await pool.query('SELECT user_id, role FROM users WHERE user_id = $1', [req.params.userId])).rows[0];
    if (!target) throw new HttpError(404, 'User not found.');
    if (target.role === 'admin') throw new HttpError(400, 'You cannot start a support chat with an admin.');

    await pool.query(
      `INSERT INTO support_messages (user_id, sender_id, from_admin, content) VALUES ($1, $2, true, $3)`,
      [target.user_id, req.user.user_id, content]
    );
    res.status(201).json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

// ---------- Admin: reported reviews ----------

// Reports: ?status=open (default) or all. The admin can see who wrote the review.
app.get('/api/admin/reports', auth, adminOnly, async (req, res) => {
  const all = String(req.query.status || 'open') === 'all';
  try {
    const result = await pool.query(
      `SELECT rr.report_id, rr.review_ref, rr.status, rr.reason, rr.created_at,
              r.score, r.feedback, r.rated_at, r.deleted_at, r.transaction_id,
              au.user_id AS author_id, au.username AS author_username,
              su.username AS subject_username, ru.username AS reporter_username
       FROM review_reports rr
       JOIN ratings r ON r.review_ref = rr.review_ref
       JOIN users au ON au.user_id = r.rated_by
       JOIN users su ON su.user_id = r.rated_user_id
       JOIN users ru ON ru.user_id = rr.reported_by
       WHERE ($1::boolean OR rr.status = 'open')
       ORDER BY (rr.status = 'open') DESC, rr.created_at DESC
       LIMIT 100`,
      [all]
    );
    res.json(result.rows);
  } catch (err) {
    sendError(res, err);
  }
});

// Delete a review (it no longer counts in the average, and nobody sees it). A note is needed.
app.post('/api/admin/reviews/:ref/delete', auth, adminOnly, async (req, res) => {
  const note = String(req.body.note || '').trim();
  if (!/^\d+$/.test(req.params.ref)) return res.status(400).json({ message: 'Invalid review.' });
  if (note.length < 5) return res.status(400).json({ message: 'Write a short note that explains why.' });
  if (note.length > 300) return res.status(400).json({ message: 'Please keep the note under 300 characters.' });

  try {
    const me = (await pool.query('SELECT username FROM users WHERE user_id = $1', [req.user.user_id])).rows[0];
    await withTx(async client => {
      const r = (await client.query(
        `UPDATE ratings SET deleted_at = now(), deleted_by = $2
         WHERE review_ref = $1 AND deleted_at IS NULL
         RETURNING rated_by, transaction_id`,
        [req.params.ref, req.user.user_id]
      )).rows[0];
      if (!r) throw new HttpError(404, 'Review not found, or it was already deleted.');
      await client.query(`UPDATE review_reports SET status = 'resolved' WHERE review_ref = $1`, [req.params.ref]);
      await logActivity(client, r.rated_by, r.transaction_id, 'review_deleted', 'by @' + me.username + ': ' + note);
    });
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

// Close a report without deleting the review
app.post('/api/admin/reports/:id/dismiss', auth, adminOnly, async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ message: 'Invalid report.' });
  try {
    const r = await pool.query(
      `UPDATE review_reports SET status = 'dismissed' WHERE report_id = $1 AND status = 'open' RETURNING report_id`,
      [req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ message: 'Report not found, or it was already closed.' });
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

// ---------- Admin: disputes ----------

// All disputes: the ones waiting for a decision first, oldest first
app.get('/api/admin/disputes', auth, adminOnly, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT d.dispute_id, d.dispute_status, d.opened_at, d.replied_at, (d.reply IS NOT NULL) AS has_reply,
              t.transaction_id, t.item_description, t.amount, t.status AS trade_status,
              b.username AS buyer_username, s.username AS seller_username, f.username AS filed_by_username
       FROM disputes d
       JOIN transactions t ON t.transaction_id = d.transaction_id
       JOIN users b ON b.user_id = t.buyer_id
       JOIN users s ON s.user_id = t.seller_id
       JOIN users f ON f.user_id = d.filed_by
       ORDER BY (d.dispute_status = 'resolved'), d.opened_at ASC
       LIMIT 200`
    );
    res.json(result.rows.map(d => ({ ...d, amount: Number(d.amount) })));
  } catch (err) {
    sendError(res, err);
  }
});

// One dispute with everything the admin needs to investigate:
// both sides, their reputation, the evidence, the trade chat, and what each person did
app.get('/api/admin/disputes/:id', auth, adminOnly, async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ message: 'Invalid dispute.' });
  try {
    const found = await pool.query(
      `SELECT d.*, f.username AS filed_by_username,
              t.item_description, t.amount, t.status AS trade_status, t.payout_method, t.payout_number,
              t.buyer_id, t.seller_id, t.created_at AS trade_created_at, t.delivered_at,
              b.username AS buyer_username, s.username AS seller_username
       FROM disputes d
       JOIN users f ON f.user_id = d.filed_by
       JOIN transactions t ON t.transaction_id = d.transaction_id
       JOIN users b ON b.user_id = t.buyer_id
       JOIN users s ON s.user_id = t.seller_id
       WHERE d.dispute_id = $1`,
      [req.params.id]
    );
    const d = found.rows[0];
    if (!d) return res.status(404).json({ message: 'Dispute not found.' });

    const evidence = await pool.query(
      `SELECT e.evidence_id, e.description AS name, u.username AS submitted_by_username
       FROM evidence e JOIN users u ON u.user_id = e.submitted_by
       WHERE e.dispute_id = $1
       ORDER BY e.uploaded_at, e.evidence_id`,
      [d.dispute_id]
    );
    const messages = await pool.query(
      `SELECT u.username, m.content, m.sent_at
       FROM messages m JOIN users u ON u.user_id = m.sender_id
       WHERE m.transaction_id = $1
       ORDER BY m.sent_at, m.message_id`,
      [d.transaction_id]
    );
    const activity = await pool.query(
      `SELECT a.action, a.detail, a.created_at, u.username
       FROM activity_log a LEFT JOIN users u ON u.user_id = a.user_id
       WHERE a.transaction_id = $1
       ORDER BY a.created_at, a.log_id`,
      [d.transaction_id]
    );
    const payment = (await pool.query(
      'SELECT payment_method, payment_status, payer_number FROM escrow_payments WHERE transaction_id = $1',
      [d.transaction_id]
    )).rows[0];

    // How trustworthy each person looks: finished trades, rating, past disputes, and cancellations after payment
    const reputation = await pool.query(
      `SELECT u.user_id, u.username, u.avatar_file, u.created_at, u.account_status,
              (u.verified_at IS NOT NULL OR u.role = 'admin') AS verified,
              (SELECT COUNT(*) FROM transactions x
                WHERE x.status = 'completed' AND (x.buyer_id = u.user_id OR x.seller_id = u.user_id)) AS completed_trades,
              (SELECT ROUND(AVG(r.score)::numeric, 1) FROM ratings r WHERE r.rated_user_id = u.user_id AND r.deleted_at IS NULL) AS rating,
              (SELECT COUNT(*) FROM ratings r WHERE r.rated_user_id = u.user_id AND r.deleted_at IS NULL) AS rating_count,
              (SELECT COUNT(*) FROM disputes dd JOIN transactions x ON x.transaction_id = dd.transaction_id
                WHERE x.buyer_id = u.user_id OR x.seller_id = u.user_id) AS disputes,
              (SELECT COUNT(*) FROM disputes dd WHERE dd.filed_by = u.user_id) AS disputes_filed,
              (SELECT COUNT(*) FROM transactions x
                WHERE x.seller_id = u.user_id AND x.status = 'refunded' AND x.cancelled_by = u.user_id) AS seller_cancels
       FROM users u
       WHERE u.user_id = ANY($1::bigint[])`,
      [[d.buyer_id, d.seller_id]]
    );
    const repOf = id => {
      const u = reputation.rows.find(x => String(x.user_id) === String(id));
      if (!u) return null;
      return {
        username: u.username,
        avatar_file: u.avatar_file,
        verified: u.verified,
        joined: u.created_at,
        account_status: u.account_status,
        completed_trades: Number(u.completed_trades),
        rating: u.rating === null ? null : Number(u.rating),
        rating_count: Number(u.rating_count),
        disputes: Number(u.disputes),
        disputes_filed: Number(u.disputes_filed),
        seller_cancels: Number(u.seller_cancels),
      };
    };

    res.json({
      dispute_id: d.dispute_id,
      transaction_id: d.transaction_id,
      item_description: d.item_description,
      amount: Number(d.amount),
      trade_status: d.trade_status,
      trade_created_at: d.trade_created_at,
      delivered_at: d.delivered_at,
      buyer_username: d.buyer_username,
      seller_username: d.seller_username,
      buyer: repOf(d.buyer_id),
      seller: repOf(d.seller_id),
      filed_by_username: d.filed_by_username,
      reason: d.reason,
      description: d.description,
      requested_outcome: d.requested_outcome,
      reply: d.reply,
      replied_at: d.replied_at,
      dispute_status: d.dispute_status,
      resolution: d.resolution,
      opened_at: d.opened_at,
      can_release: !!d.payout_method,
      payout_masked: d.payout_method ? maskNumber(d.payout_number) : null,
      payout_method: d.payout_method,
      payment: payment
        ? { method: payment.payment_method, status: payment.payment_status, payer_masked: maskNumber(payment.payer_number) }
        : null,
      evidence: evidence.rows,
      messages: messages.rows,
      activity: activity.rows,
    });
  } catch (err) {
    sendError(res, err);
  }
});

// The admin's decision: pay the seller or refund the buyer. It cannot be changed afterwards.
app.post('/api/admin/disputes/:id/resolve', auth, adminOnly, async (req, res) => {
  const decision = req.body.decision;
  const note = String(req.body.note || '').trim();
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ message: 'Invalid dispute.' });
  if (!['release', 'refund'].includes(decision)) return res.status(400).json({ message: 'Choose a decision.' });
  if (note.length < 5) return res.status(400).json({ message: 'Write a short note that explains your decision.' });
  if (note.length > 1000) return res.status(400).json({ message: 'Please keep the note under 1000 characters.' });

  try {
    await withTx(async client => {
      const d = (await client.query('SELECT * FROM disputes WHERE dispute_id = $1 FOR UPDATE', [req.params.id])).rows[0];
      if (!d) throw new HttpError(404, 'Dispute not found.');
      if (d.dispute_status === 'resolved') throw new HttpError(409, 'This dispute was already decided.');

      const t = (await client.query('SELECT * FROM transactions WHERE transaction_id = $1 FOR UPDATE', [d.transaction_id])).rows[0];
      if (!t || t.status !== 'disputed') throw new HttpError(409, 'This trade is not in dispute anymore.');

      const pay = (await client.query(
        'SELECT payment_status FROM escrow_payments WHERE transaction_id = $1 FOR UPDATE',
        [t.transaction_id]
      )).rows[0];
      if (!pay || pay.payment_status !== 'held') throw new HttpError(409, 'There is no payment held for this trade.');

      if (decision === 'release') {
        if (!t.payout_method) {
          throw new HttpError(409, 'The seller never said where to receive the money, because the item was not marked as delivered. You can refund the buyer instead.');
        }
        await releasePayment(client, t.transaction_id);
      } else {
        await client.query(`UPDATE escrow_payments SET payment_status = 'refunded' WHERE transaction_id = $1`, [t.transaction_id]);
        await client.query(`UPDATE transactions SET status = 'refunded' WHERE transaction_id = $1`, [t.transaction_id]);
      }

      const summary = decision === 'release'
        ? 'Decision: the payment was released to the seller.'
        : 'Decision: the buyer was refunded in full.';
      await client.query(
        `UPDATE disputes SET dispute_status = 'resolved', resolved_by = $1, resolution = $2 WHERE dispute_id = $3`,
        [req.user.user_id, summary + ' ' + note, d.dispute_id]
      );
      await logActivity(client, req.user.user_id, t.transaction_id, 'dispute_resolved',
        (decision === 'release' ? 'Paid the seller' : 'Refunded the buyer') + ': ' + note.slice(0, 200));
    });
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

// ---------- Admin: trades ----------

// Every trade, newest first. Filters: ?status=process|all|<one status>, ?search=
// needs_admin = the payment is held and one of the two people is suspended or banned
app.get('/api/admin/transactions', auth, adminOnly, async (req, res) => {
  const status = String(req.query.status || 'process');
  const search = String(req.query.search || '').replace(/^@/, '').replace(/[%_]/g, '').trim();
  const params = [];
  const clauses = [];

  if (status === 'process') {
    params.push(PROCESS_STATUSES);
    clauses.push(`t.status::text = ANY($${params.length})`);
  } else if (ALL_TRADE_STATUSES.includes(status)) {
    params.push(status);
    clauses.push(`t.status::text = $${params.length}`);
  }
  if (search) {
    params.push('%' + search + '%');
    const like = '$' + params.length;
    let text = `(t.item_description ILIKE ${like} OR b.username ILIKE ${like} OR s.username ILIKE ${like}`;
    if (/^\d+$/.test(search)) {
      params.push(search);
      text += ` OR t.transaction_id = $${params.length}`;
    }
    clauses.push(text + ')');
  }

  try {
    const result = await pool.query(
      `SELECT t.transaction_id, t.item_description, t.amount, t.status, t.created_at,
              b.username AS buyer_username, s.username AS seller_username,
              EXISTS (SELECT 1 FROM disputes d WHERE d.transaction_id = t.transaction_id) AS had_dispute,
              (t.status::text IN ('paid', 'delivered')
                AND (b.account_status::text <> 'active' OR s.account_status::text <> 'active')) AS needs_admin
       FROM transactions t
       JOIN users b ON b.user_id = t.buyer_id
       JOIN users s ON s.user_id = t.seller_id
       ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''}
       ORDER BY t.created_at DESC
       LIMIT 200`,
      params
    );
    res.json(result.rows.map(t => ({ ...t, amount: Number(t.amount) })));
  } catch (err) {
    sendError(res, err);
  }
});

// One trade: status, payment, chat, dispute, and what each person did
app.get('/api/admin/transactions/:id', auth, adminOnly, async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ message: 'Invalid trade.' });
  try {
    const found = await pool.query(
      `SELECT t.*, b.username AS buyer_username, s.username AS seller_username,
              b.account_status::text AS buyer_status, s.account_status::text AS seller_status
       FROM transactions t
       JOIN users b ON b.user_id = t.buyer_id
       JOIN users s ON s.user_id = t.seller_id
       WHERE t.transaction_id = $1`,
      [req.params.id]
    );
    const t = found.rows[0];
    if (!t) return res.status(404).json({ message: 'Trade not found.' });

    const payment = (await pool.query(
      'SELECT payment_method, payment_status, payer_number FROM escrow_payments WHERE transaction_id = $1',
      [t.transaction_id]
    )).rows[0];
    const receipt = (await pool.query(
      'SELECT receipt_number FROM receipts WHERE transaction_id = $1',
      [t.transaction_id]
    )).rows[0];
    const dispute = (await pool.query(
      'SELECT dispute_id, dispute_status FROM disputes WHERE transaction_id = $1',
      [t.transaction_id]
    )).rows[0];
    const messages = await pool.query(
      `SELECT u.username, m.content, m.sent_at
       FROM messages m JOIN users u ON u.user_id = m.sender_id
       WHERE m.transaction_id = $1
       ORDER BY m.sent_at, m.message_id`,
      [t.transaction_id]
    );
    const activity = await pool.query(
      `SELECT a.action, a.detail, a.created_at, u.username
       FROM activity_log a LEFT JOIN users u ON u.user_id = a.user_id
       WHERE a.transaction_id = $1
       ORDER BY a.created_at, a.log_id`,
      [t.transaction_id]
    );

    const held = ['paid', 'delivered'].includes(t.status);
    res.json({
      transaction_id: t.transaction_id,
      item_description: t.item_description,
      amount: Number(t.amount),
      service_fee: Number(t.service_fee),
      status: t.status,
      created_at: t.created_at,
      delivered_at: t.delivered_at,
      buyer_username: t.buyer_username,
      seller_username: t.seller_username,
      buyer_status: t.buyer_status,
      seller_status: t.seller_status,
      needs_admin: held && (t.buyer_status !== 'active' || t.seller_status !== 'active'),
      can_refund: held && !!payment && payment.payment_status === 'held' && !dispute,
      cancel_reason: t.cancel_reason,
      payment: payment
        ? { method: payment.payment_method, status: payment.payment_status, payer_masked: maskNumber(payment.payer_number) }
        : null,
      payout_method: t.payout_method,
      payout_masked: maskNumber(t.payout_number),
      receipt_number: receipt ? receipt.receipt_number : null,
      dispute: dispute || null,
      messages: messages.rows,
      activity: activity.rows,
    });
  } catch (err) {
    sendError(res, err);
  }
});

// Refund the buyer in full without a dispute, for a trade whose payment is held
// (for example when the seller was banned). A note is needed, and both people can see it.
app.post('/api/admin/transactions/:id/refund', auth, adminOnly, async (req, res) => {
  const note = String(req.body.note || '').trim();
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ message: 'Invalid trade.' });
  if (note.length < 5) return res.status(400).json({ message: 'Write a short note that explains why.' });
  if (note.length > 300) return res.status(400).json({ message: 'Please keep the note under 300 characters.' });

  try {
    await withTx(async client => {
      const t = (await client.query('SELECT * FROM transactions WHERE transaction_id = $1 FOR UPDATE', [req.params.id])).rows[0];
      if (!t) throw new HttpError(404, 'Trade not found.');
      if (t.status === 'disputed') {
        throw new HttpError(409, 'This trade is in dispute. Decide it from the dispute review.');
      }
      if (!['paid', 'delivered'].includes(t.status)) {
        throw new HttpError(409, 'Only a trade whose payment is held can be refunded.');
      }
      const pay = (await client.query(
        'SELECT payment_status FROM escrow_payments WHERE transaction_id = $1 FOR UPDATE', [t.transaction_id]
      )).rows[0];
      if (!pay || pay.payment_status !== 'held') throw new HttpError(409, 'There is no held payment for this trade.');

      await client.query(`UPDATE escrow_payments SET payment_status = 'refunded' WHERE transaction_id = $1`, [t.transaction_id]);
      await client.query(`UPDATE transactions SET status = 'refunded', cancel_reason = $1 WHERE transaction_id = $2`, [note, t.transaction_id]);
      await logActivity(client, req.user.user_id, t.transaction_id, 'admin_refund', note);
    });
    res.json({ ok: true });
  } catch (err) {
    sendError(res, err);
  }
});

// ---------- Admin: users ----------

// All users. Filters: ?search= (username, name, email), ?status=all|online|active|suspended|banned
app.get('/api/admin/users', auth, adminOnly, async (req, res) => {
  const search = String(req.query.search || '').replace(/^@/, '').replace(/[%_]/g, '').trim();
  const status = String(req.query.status || 'all');
  const params = [];
  const clauses = [];

  if (search) {
    params.push('%' + search + '%');
    const like = '$' + params.length;
    clauses.push(`(u.username ILIKE ${like} OR u.full_name ILIKE ${like} OR u.email ILIKE ${like})`);
  }
  if (['active', 'suspended', 'banned'].includes(status)) {
    params.push(status);
    clauses.push(`u.account_status::text = $${params.length}`);
  }
  if (status === 'online') clauses.push(ONLINE_SQL);

  try {
    const result = await pool.query(
      `SELECT u.user_id, u.username, u.avatar_file, u.full_name, u.email, u.role, u.account_status, u.created_at, u.last_seen,
              ${ONLINE_SQL} AS online,
              (u.verified_at IS NOT NULL OR u.role = 'admin') AS verified,
              (SELECT COUNT(*) FROM transactions t
                WHERE t.status = 'completed' AND (t.buyer_id = u.user_id OR t.seller_id = u.user_id)) AS completed_trades,
              (SELECT COUNT(*) FROM transactions t
                WHERE t.status::text = ANY($${params.length + 1}) AND (t.buyer_id = u.user_id OR t.seller_id = u.user_id)) AS active_trades,
              (SELECT ROUND(AVG(r.score)::numeric, 1) FROM ratings r WHERE r.rated_user_id = u.user_id AND r.deleted_at IS NULL) AS rating
       FROM users u
       ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''}
       ORDER BY u.created_at DESC
       LIMIT 100`,
      [...params, PROCESS_STATUSES]
    );
    res.json(result.rows.map(u => ({
      user_id: u.user_id,
      username: u.username,
      avatar_file: u.avatar_file,
      full_name: u.full_name,
      email: u.email,
      role: u.role,
      account_status: u.account_status,
      created_at: u.created_at,
      last_seen: u.last_seen,
      online: u.online,
      verified: u.verified,
      completed_trades: Number(u.completed_trades),
      active_trades: Number(u.active_trades),
      rating: u.rating === null ? null : Number(u.rating),
    })));
  } catch (err) {
    sendError(res, err);
  }
});

// One user: details, their trades, the reviews about them (the admin sees who wrote them), and what they did
app.get('/api/admin/users/:id', auth, adminOnly, async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ message: 'Invalid user.' });
  try {
    const found = await pool.query(
      `SELECT user_id, username, avatar_file, full_name, email, role, account_status, created_at, last_seen, verified_at,
              (verified_at IS NOT NULL OR role = 'admin') AS verified, ${ONLINE_SQL} AS online
       FROM users WHERE user_id = $1`,
      [req.params.id]
    );
    const u = found.rows[0];
    if (!u) return res.status(404).json({ message: 'User not found.' });

    const stats = (await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM transactions
           WHERE status = 'completed' AND (buyer_id = $1 OR seller_id = $1)) AS completed_trades,
         (SELECT COUNT(*) FROM transactions
           WHERE status::text = ANY($2) AND (buyer_id = $1 OR seller_id = $1)) AS active_trades,
         (SELECT COUNT(*) FROM disputes d JOIN transactions t ON t.transaction_id = d.transaction_id
           WHERE t.buyer_id = $1 OR t.seller_id = $1) AS disputes,
         (SELECT COUNT(*) FROM transactions
           WHERE seller_id = $1 AND status = 'refunded' AND cancelled_by = $1) AS cancels_after_payment,
         (SELECT ROUND(AVG(score)::numeric, 1) FROM ratings WHERE rated_user_id = $1 AND deleted_at IS NULL) AS rating,
         (SELECT COUNT(*) FROM ratings WHERE rated_user_id = $1 AND deleted_at IS NULL) AS rating_count`,
      [u.user_id, PROCESS_STATUSES]
    )).rows[0];

    const trades = await pool.query(
      `SELECT t.transaction_id, t.item_description, t.amount, t.status, t.created_at,
              CASE WHEN t.buyer_id = $1 THEN 'buyer' ELSE 'seller' END AS role,
              CASE WHEN t.buyer_id = $1 THEN s.username ELSE b.username END AS partner_username
       FROM transactions t
       JOIN users b ON b.user_id = t.buyer_id
       JOIN users s ON s.user_id = t.seller_id
       WHERE t.buyer_id = $1 OR t.seller_id = $1
       ORDER BY t.created_at DESC
       LIMIT 20`,
      [u.user_id]
    );
    const reviews = await pool.query(
      `SELECT r.review_ref, r.score, r.feedback, r.rated_at, r.transaction_id, au.username AS author_username
       FROM ratings r JOIN users au ON au.user_id = r.rated_by
       WHERE r.rated_user_id = $1 AND r.deleted_at IS NULL
       ORDER BY r.rated_at DESC
       LIMIT 20`,
      [u.user_id]
    );
    const activity = await pool.query(
      `SELECT action, detail, created_at, transaction_id
       FROM activity_log
       WHERE user_id = $1
       ORDER BY created_at DESC, log_id DESC
       LIMIT 30`,
      [u.user_id]
    );

    res.json({
      user_id: u.user_id,
      username: u.username,
      avatar_file: u.avatar_file,
      full_name: u.full_name,
      email: u.email,
      role: u.role,
      account_status: u.account_status,
      created_at: u.created_at,
      last_seen: u.last_seen,
      online: u.online,
      verified: u.verified,
      verified_at: u.verified_at,
      completed_trades: Number(stats.completed_trades),
      active_trades: Number(stats.active_trades),
      disputes: Number(stats.disputes),
      cancels_after_payment: Number(stats.cancels_after_payment),
      rating: stats.rating === null ? null : Number(stats.rating),
      rating_count: Number(stats.rating_count),
      is_me: String(u.user_id) === String(req.user.user_id),
      can_control: u.role !== 'admin' && String(u.user_id) !== String(req.user.user_id),
      trades: trades.rows.map(t => ({ ...t, amount: Number(t.amount) })),
      reviews: reviews.rows,
      activity: activity.rows,
    });
  } catch (err) {
    sendError(res, err);
  }
});

// Suspend, ban, or reactivate a user. A banned user is signed out on their next click.
// A suspended user can still sign in, but can only use Support.
app.post('/api/admin/users/:id/status', auth, adminOnly, async (req, res) => {
  const status = req.body.status;
  const note = String(req.body.note || '').trim();
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ message: 'Invalid user.' });
  if (!['active', 'suspended', 'banned'].includes(status)) return res.status(400).json({ message: 'Choose a status.' });
  if (status !== 'active' && note.length < 5) {
    return res.status(400).json({ message: 'Write a short note that explains why.' });
  }
  if (note.length > 500) return res.status(400).json({ message: 'Please keep the note under 500 characters.' });

  try {
    const target = (await pool.query('SELECT user_id, role FROM users WHERE user_id = $1', [req.params.id])).rows[0];
    if (!target) return res.status(404).json({ message: 'User not found.' });
    if (target.role === 'admin') return res.status(400).json({ message: 'You cannot change an admin account.' });

    const me = (await pool.query('SELECT username FROM users WHERE user_id = $1', [req.user.user_id])).rows[0];
    await pool.query('UPDATE users SET account_status = $1 WHERE user_id = $2', [status, target.user_id]);
    await logActivity(pool, target.user_id, null, 'account_' + status, 'by @' + me.username + (note ? ': ' + note : ''));
    res.json({ ok: true, account_status: status });
  } catch (err) {
    sendError(res, err);
  }
});

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

// Auto-release: if the buyer does nothing 2 hours after delivery, pay the seller.
// A trade in dispute is not released, and neither is a trade where the buyer or the seller is
// suspended or banned: it waits for an admin to decide.
setInterval(async () => {
  try {
    const due = await pool.query(
      `SELECT t.transaction_id
       FROM transactions t
       JOIN users b ON b.user_id = t.buyer_id
       JOIN users s ON s.user_id = t.seller_id
       WHERE t.status = 'delivered' AND t.delivered_at < now() - interval '2 hours'
         AND b.account_status::text = 'active' AND s.account_status::text = 'active'`
    );
    for (const row of due.rows) {
      await withTx(async client => {
        const r = await client.query(
          `SELECT t.status, b.account_status::text AS buyer_status, s.account_status::text AS seller_status
           FROM transactions t
           JOIN users b ON b.user_id = t.buyer_id
           JOIN users s ON s.user_id = t.seller_id
           WHERE t.transaction_id = $1
           FOR UPDATE OF t`,
          [row.transaction_id]
        );
        const t = r.rows[0];
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SecureTrade API running on http://localhost:${PORT}`));