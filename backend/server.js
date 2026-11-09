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
// Set CORS_ORIGINS in .env (comma-separated) to allow only your own site. Empty means open, for local development.
const allowedOrigins = (process.env.CORS_ORIGINS || '').split(',').map(origin => origin.trim()).filter(Boolean);
app.use(cors(allowedOrigins.length ? { origin: allowedOrigins } : undefined));
app.use(express.json());
// The website itself, so Xendit can send buyers back to a real address
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// A request with no JSON body gets an empty one, so the checks answer "required" instead of crashing
app.use((req, res, next) => {
  req.body = req.body || {};
  next();
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Supabase's certificate proves we are talking to the real database
  ssl: { ca: fs.readFileSync(path.join(__dirname, 'supabase-ca.crt'), 'utf8'), rejectUnauthorized: true },
});

// A user counts as online if we heard from them in the last 2 minutes
const ONLINE_SQL = `(last_seen IS NOT NULL AND last_seen > now() - interval '2 minutes')`;

// Reusable pieces of SQL
const verifiedSql = (alias = '') => {
  const prefix = alias ? alias + '.' : '';
  return `(${prefix}verified_at IS NOT NULL OR ${prefix}role = 'admin')`;
};
const JOIN_BUYER_SELLER = `JOIN users b ON b.user_id = t.buyer_id
       JOIN users s ON s.user_id = t.seller_id`;
const AVG_RATING_SQL = '(SELECT ROUND(AVG(score)::numeric, 1) FROM ratings WHERE rated_user_id = $1 AND deleted_at IS NULL)';
const RATING_COUNT_SQL = '(SELECT COUNT(*) FROM ratings WHERE rated_user_id = $1 AND deleted_at IS NULL)';

// Trades that are still moving (not finished)
const PROCESS_STATUSES = ['pending', 'accepted', 'paid', 'delivered', 'disputed'];
const ALL_TRADE_STATUSES = [...PROCESS_STATUSES, 'completed', 'refunded', 'cancelled'];
// The payment is held for these (a dispute also holds it, but an admin decides those)
const PAID_STATUSES = ['paid', 'delivered'];

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

// Wrap a route handler: anything it throws becomes a clear JSON error
function route(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      sendError(res, err);
    }
  };
}

// Run a query and give back the first row, or all the rows
async function queryOne(db, sql, params) {
  return (await db.query(sql, params)).rows[0];
}

async function queryAll(db, sql, params) {
  return (await db.query(sql, params)).rows;
}

// A database id or review reference from the address must be digits only
function requireNumeric(value, message) {
  if (!/^\d+$/.test(value)) throw new HttpError(400, message);
}

// A note an admin must write: at least 5 characters, and not too long
function requireNote(note, max, tooShortMessage) {
  if (note.length < 5) throw new HttpError(400, tooShortMessage);
  if (note.length > max) throw new HttpError(400, 'Please keep the note under ' + max + ' characters.');
}

// A saved database number stays null when it has no value
function numberOrNull(value) {
  return value === null ? null : Number(value);
}

// Database ids can arrive as numbers or as text, so compare them as text
function sameId(a, b) {
  return String(a) === String(b);
}

// Is this user the buyer or the seller of the trade?
function isParty(trade, userId) {
  return sameId(trade.buyer_id, userId) || sameId(trade.seller_id, userId);
}

function cleanEmail(value) {
  return String(value || '').trim().toLowerCase();
}

// A username typed with or without the @
function cleanHandle(value) {
  return String(value || '').trim().replace(/^@/, '');
}

// Search text that is safe to put between % signs in ILIKE
function cleanSearch(value) {
  return String(value || '').replace(/^@/, '').replace(/[%_]/g, '').trim();
}

// Admin lists come one page at a time: ?page=1, 2, 3...
const ADMIN_PAGE_SIZE = 20;
const ADMIN_MAX_PAGE = 100000;
function pageOffset(value) {
  const page = Math.min(Math.max(parseInt(value, 10) || 1, 1), ADMIN_MAX_PAGE);
  return (page - 1) * ADMIN_PAGE_SIZE;
}
// Rows selected with COUNT(*) OVER() AS total_count become { total, rows }
function pageResult(rows, toRow = row => row) {
  return {
    total: rows.length ? Number(rows[0].total_count) : 0,
    rows: rows.map(({ total_count, ...row }) => toRow(row)),
  };
}

// The username of a user (used in "by @admin" log lines)
function findUsername(userId) {
  return queryOne(pool, 'SELECT username FROM users WHERE user_id = $1', [userId]);
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
  const u = await queryOne(pool, 'SELECT verified_at, role FROM users WHERE user_id = $1', [userId]);
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

// A login token that lasts 7 days
function signToken(user, sid) {
  return jwt.sign({ user_id: user.user_id, role: user.role, sid }, process.env.JWT_SECRET, { expiresIn: '7d' });
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

function newSixDigitCode() {
  return String(crypto.randomInt(100000, 1000000));
}

// Asking for another PIN too soon is refused. `last` is the previous PIN's row (with its age in seconds).
function assertCanResend(last) {
  if (last && Number(last.age) < RESEND_SECONDS) {
    const wait = Math.ceil(RESEND_SECONDS - Number(last.age));
    throw new HttpError(429, 'Please wait ' + wait + ' seconds before asking for another PIN.');
  }
}

function deletePins(email, purpose) {
  return pool.query('DELETE FROM email_pins WHERE email = $1 AND purpose = $2', [email, purpose]);
}

function deletePin(pinId) {
  return pool.query('DELETE FROM email_pins WHERE pin_id = $1', [pinId]);
}

function deleteEmailChange(userId) {
  return pool.query('DELETE FROM email_changes WHERE user_id = $1', [userId]);
}

// Make a new 6-digit PIN, save only its hash, and email it
async function issuePin(email, purpose, signupData) {
  assertCanResend(await queryOne(
    pool,
    `SELECT EXTRACT(EPOCH FROM (now() - created_at)) AS age
     FROM email_pins WHERE email = $1 AND purpose = $2
     ORDER BY created_at DESC LIMIT 1`,
    [email, purpose]
  ));

  const pin = newSixDigitCode();
  const pin_hash = await bcrypt.hash(pin, 8);

  await deletePins(email, purpose);
  const inserted = await pool.query(
    `INSERT INTO email_pins (purpose, email, pin_hash, signup_data, expires_at)
     VALUES ($1, $2, $3, $4, now() + interval '${PIN_MINUTES} minutes')
     RETURNING pin_id`,
    [purpose, email, pin_hash, signupData ? JSON.stringify(signupData) : null]
  );

  try {
    await sendPinEmail(email, pin, purpose);
  } catch (err) {
    await deletePin(inserted.rows[0].pin_id);
    throw err;
  }
}

// Check the PIN the user typed. Returns the saved row, or throws a clear error.
async function checkPin(email, purpose, pin) {
  if (!/^\d{6}$/.test(String(pin || ''))) throw new HttpError(400, 'Enter the 6-digit PIN.');

  const row = await queryOne(
    pool,
    `SELECT * FROM email_pins WHERE email = $1 AND purpose = $2 ORDER BY created_at DESC LIMIT 1`,
    [email, purpose]
  );
  if (!row || new Date(row.expires_at) < new Date()) {
    if (row) await deletePin(row.pin_id);
    throw new HttpError(400, 'Wrong or expired PIN. Please request a new one.');
  }
  const tooManyTries = async () => {
    await deletePin(row.pin_id);
    throw new HttpError(429, 'Too many wrong tries. Please request a new PIN.');
  };
  if (row.attempts >= MAX_PIN_TRIES) return tooManyTries();
  if (!(await bcrypt.compare(String(pin), row.pin_hash))) {
    const used = row.attempts + 1;
    if (used >= MAX_PIN_TRIES) return tooManyTries();
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
app.post('/api/register/start', route(async (req, res) => {
  const first_name = cleanName(req.body.first_name);
  const last_name = cleanName(req.body.last_name);
  const username = String(req.body.username || '').trim();
  const email = cleanEmail(req.body.email);
  const password = String(req.body.password || '');
  const adult = req.body.is_adult === true || req.body.is_adult === 'true';

  if (!first_name || !last_name || !username || !EMAIL_RE.test(email) || password.length < 8) throw new HttpError(400, 'First name, last name, username, a valid email, and a password of at least 8 characters are required.');
  if (!adult) throw new HttpError(400, 'SecureTrade is for users 18 and older. Please confirm that you are 18 years old or older.');
  if (!NAME_PART_RE.test(first_name) || !NAME_PART_RE.test(last_name)) throw new HttpError(400, 'Names can have letters, spaces, dots, apostrophes, and hyphens only (up to 45 characters each).');
  if (!USERNAME_RE.test(username)) throw new HttpError(400, 'Username must be 3 to 30 letters, numbers, or underscores.');
  const taken = await pool.query(
    'SELECT email, username FROM users WHERE email = $1 OR lower(username) = lower($2)',
    [email, username]
  );
  if (taken.rows.some(u => u.email === email)) throw new HttpError(409, 'That email is already registered.');
  if (taken.rows.length > 0) throw new HttpError(409, 'That username is taken.');

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

// ---------- Limit on wrong passwords ----------
// Failures are counted per computer + email, so nobody can lock another person out from elsewhere.
// The counts reset when the server restarts.
const LOGIN_LIMIT_MINUTES = 15;
const MAX_FAILS_PER_ACCOUNT = 5;
const loginFailures = new Map();   // key -> { count, resetAt }

function currentLoginFailure(key) {
  const entry = loginFailures.get(key);
  return entry && entry.resetAt > Date.now() ? entry : null;
}

function addLoginFailure(key) {
  const entry = currentLoginFailure(key) || { count: 0, resetAt: Date.now() + LOGIN_LIMIT_MINUTES * 60000 };
  entry.count++;
  loginFailures.set(key, entry);
  return entry.count;
}

function assertLoginAllowed(accountKey) {
  const account = currentLoginFailure(accountKey);
  if (account && account.count >= MAX_FAILS_PER_ACCOUNT) {
    throw new HttpError(429, 'Too many wrong tries. Please wait ' + LOGIN_LIMIT_MINUTES + ' minutes, or reset your password.');
  }
}

// An account just reached the limit: record it for the admins and warn the owner by email.
// At most once an hour per account, so nobody can flood the owner's inbox.
// Nothing here is awaited by the login, so the answer does not reveal whether the account exists.
async function warnAboutBlockedLogin(user, ip) {
  try {
    const recent = await queryOne(
      pool,
      `SELECT 1 FROM activity_log
       WHERE user_id = $1 AND action = 'login_blocked' AND created_at > now() - interval '1 hour'`,
      [user.user_id]
    );
    if (recent) return;
    await logActivity(pool, user.user_id, null, 'login_blocked', 'from ' + ip);
    await sendLoginWarningEmail(user.email);
  } catch (err) {
    console.error('Sign-in warning failed:', err.message);
  }
}

async function sendLoginWarningEmail(to) {
  if (!mailConfigured()) {
    if (process.env.DEV_LOG_PIN === 'true') console.log('[DEV] sign-in warning for ' + to);
    return;
  }
  await getTransporter().sendMail({
    from: `"SecureTrade" <${process.env.MAIL_FROM}>`,
    to,
    subject: 'Someone tried to sign in to your SecureTrade account',
    text: `We blocked sign-in attempts on your account after ${MAX_FAILS_PER_ACCOUNT} wrong passwords.\n\n` +
      'If this was you, wait ' + LOGIN_LIMIT_MINUTES + ' minutes and try again, or reset your password.\n' +
      'If this was not you, reset your password now. Your account was not suspended.',
  });
}

// Forget old counts so the list does not keep growing
setInterval(() => {
  for (const key of loginFailures.keys()) {
    if (!currentLoginFailure(key)) loginFailures.delete(key);
  }
}, LOGIN_LIMIT_MINUTES * 60000);

// ---------- Login ----------
// A new login replaces the old session, so the account is open on one device at a time.
// If another device is active right now, the person is warned first (they send force: true to continue).
// Banned accounts cannot sign in. Suspended accounts can, but they can only use Support.
app.post('/api/login', route(async (req, res) => {
  const { email, password } = req.body;
  const force = req.body.force === true;
  if (!email || !password) throw new HttpError(400, 'Email and password are required.');
  const accountKey = req.ip + '|' + String(email).toLowerCase();
  assertLoginAllowed(accountKey);

  const user = await queryOne(pool, 'SELECT * FROM users WHERE email = $1', [String(email).toLowerCase()]);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
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
    const u = await queryOne(
      pool,
      'SELECT account_status, role, last_seen, session_id, last_activity_at FROM users WHERE user_id = $1',
      [req.user.user_id]
    );
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

// ---------- Support chat (a user and the admins) ----------
// A suspended account can use this to ask for help.

// My conversation with the admins. Opening it marks the admin's messages as read.
app.get('/api/support', auth, route(async (req, res) => {
  const me = req.user.user_id;
  const messages = await queryAll(
    pool,
    `SELECT message_id, from_admin, content, sent_at
     FROM support_messages WHERE user_id = $1
     ORDER BY sent_at, message_id LIMIT 300`,
    [me]
  );
  await pool.query(
    `UPDATE support_messages SET read_at = now() WHERE user_id = $1 AND from_admin AND read_at IS NULL`,
    [me]
  );

  // Why the account is suspended (the note the admin wrote, without the admin's name)
  let reason = null;
  if (req.user.account_status === 'suspended') {
    const log = await queryOne(
      pool,
      `SELECT detail FROM activity_log
       WHERE user_id = $1 AND action = 'account_suspended'
       ORDER BY created_at DESC, log_id DESC LIMIT 1`,
      [me]
    );
    if (log && log.detail) {
      const i = log.detail.indexOf(': ');
      reason = i >= 0 ? log.detail.slice(i + 2) : null;
    }
  }
  res.json({ account_status: req.user.account_status, suspension_reason: reason, messages });
}));

// How many admin messages I have not read yet (the menu shows this number)
app.get('/api/support/unread', auth, route(async (req, res) => {
  const r = await pool.query(
    `SELECT COUNT(*) AS n FROM support_messages WHERE user_id = $1 AND from_admin AND read_at IS NULL`,
    [req.user.user_id]
  );
  res.json({ unread: Number(r.rows[0].n) });
}));

// Write to the admins
app.post('/api/support', auth, route(async (req, res) => {
  const me = req.user.user_id;
  const content = String(req.body.content || '').trim();
  if (!content || content.length > SUPPORT_MAX) {
    throw new HttpError(400, 'Write a message of 1 to ' + SUPPORT_MAX + ' characters.');
  }
  const recent = Number((await queryOne(
    pool,
    `SELECT COUNT(*) AS n FROM support_messages
     WHERE sender_id = $1 AND sent_at > now() - interval '1 minute'`,
    [me]
  )).n);
  if (recent >= SUPPORT_PER_MINUTE) {
    throw new HttpError(429, 'You are sending messages too fast. Please wait a moment.');
  }
  await pool.query(
    `INSERT INTO support_messages (user_id, sender_id, from_admin, content) VALUES ($1, $1, false, $2)`,
    [me, content]
  );
  res.status(201).json({ ok: true });
}));

// ---------- Find trade partners ----------
// Usernames only, never emails or real names.
// ?status=all|recent|online|offline|favorites  ?search=  ?limit=  (admins are not listed)
app.get('/api/users', auth, route(async (req, res) => {
  const search = cleanSearch(req.query.search);
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

  const result = await pool.query(
    `SELECT u.username, u.avatar_file, u.created_at, u.last_seen, ${ONLINE_SQL} AS online,
            ${verifiedSql('u')} AS verified,
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
}));

// View a user's public profile (username only, never email or real name).
// The reviews are anonymous: they show the stars, the comment, and whether the writer was the buyer or the seller.
app.get('/api/users/:username', auth, route(async (req, res) => {
  const me = req.user.user_id;
  const found = await pool.query(
    `SELECT u.user_id, u.username, u.avatar_file, u.created_at, u.last_seen, ${ONLINE_SQL} AS online,
            ${verifiedSql('u')} AS verified,
            (f.user_id IS NOT NULL) AS is_favorite, f.note
     FROM users u
     LEFT JOIN favorites f ON f.user_id = $2 AND f.favorite_user_id = u.user_id
     WHERE lower(u.username) = lower($1) AND u.account_status = 'active'`,
    [req.params.username, me]
  );
  const user = found.rows[0];
  if (!user) throw new HttpError(404, 'User not found.');

  const stats = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM transactions
         WHERE status = 'completed' AND (buyer_id = $1 OR seller_id = $1)) AS completed_trades,
       ${AVG_RATING_SQL} AS avg_rating,
       ${RATING_COUNT_SQL} AS rating_count,
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
    avg_rating: numberOrNull(s.avg_rating),
    rating_count: Number(s.rating_count),
    reviews: reviews.rows,
  });
}));

// ---------- Reviews about me, and reporting an abusive review ----------

// The reviews other people wrote about me (anonymous)
app.get('/api/reviews/mine', auth, route(async (req, res) => {
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
}));

// Report a review (abusive, false, or it has personal information). An admin looks at it.
app.post('/api/reviews/:ref/report', auth, route(async (req, res) => {
  requireNumeric(req.params.ref, 'Invalid review.');
  const me = req.user.user_id;
  const reason = String(req.body.reason || '').trim().slice(0, 300);

  const review = await queryOne(pool, 'SELECT rated_by, deleted_at FROM ratings WHERE review_ref = $1', [req.params.ref]);
  if (!review || review.deleted_at) throw new HttpError(404, 'Review not found.');
  if (sameId(review.rated_by, me)) throw new HttpError(400, 'You cannot report your own review.');

  const inserted = await pool.query(
    `INSERT INTO review_reports (review_ref, reported_by, reason) VALUES ($1, $2, $3)
     ON CONFLICT (review_ref, reported_by) DO NOTHING
     RETURNING report_id`,
    [req.params.ref, me, reason || null]
  );
  if (!inserted.rows[0]) throw new HttpError(409, 'You already reported this review.');
  res.status(201).json({ ok: true });
}));

// ---------- Favorites (private: the other person is never told) ----------

// Add a favorite, or change its private note (send { note } only when the note changes)
app.put('/api/favorites/:username', auth, route(async (req, res) => {
  const username = cleanHandle(req.params.username);
  const hasNote = typeof req.body.note === 'string';
  const note = hasNote ? req.body.note.trim().slice(0, 200) : null;
  const me = req.user.user_id;
  const target = await queryOne(pool, `SELECT user_id FROM users WHERE lower(username) = lower($1) AND account_status = 'active'`, [username]);
  if (!target) throw new HttpError(404, 'User not found.');
  if (sameId(target.user_id, me)) throw new HttpError(400, 'You cannot add yourself to your favorites.');

  const existing = await queryOne(pool, 'SELECT 1 FROM favorites WHERE user_id = $1 AND favorite_user_id = $2', [me, target.user_id]);

  if (existing) {
    if (hasNote) {
      await pool.query('UPDATE favorites SET note = $3 WHERE user_id = $1 AND favorite_user_id = $2',
        [me, target.user_id, note || null]);
    }
  } else {
    const count = Number((await queryOne(pool, 'SELECT COUNT(*) AS n FROM favorites WHERE user_id = $1', [me])).n);
    if (count >= MAX_FAVORITES) throw new HttpError(409, 'You can have up to ' + MAX_FAVORITES + ' favorites. Remove one first.');
    await pool.query('INSERT INTO favorites (user_id, favorite_user_id, note) VALUES ($1, $2, $3)',
      [me, target.user_id, note || null]);
  }
  res.json({ ok: true });
}));

app.delete('/api/favorites/:username', auth, route(async (req, res) => {
  const username = cleanHandle(req.params.username);
  await pool.query(
    `DELETE FROM favorites
     WHERE user_id = $1 AND favorite_user_id = (SELECT user_id FROM users WHERE lower(username) = lower($2))`,
    [req.user.user_id, username]
  );
  res.json({ ok: true });
}));

// ---------- Trades ----------

// A verified user pressed "Trade" on someone who is not verified yet.
// We remember it, and that person sees it on their dashboard.
app.post('/api/trade-attempts', auth, route(async (req, res) => {
  const username = cleanHandle(req.body.username);
  await assertVerified(req.user.user_id, 'Verify your identity first.');
  const target = await queryOne(
    pool,
    `SELECT user_id, verified_at, role FROM users WHERE lower(username) = lower($1) AND account_status = 'active'`,
    [username]
  );
  if (!target) throw new HttpError(404, 'User not found.');
  if (sameId(target.user_id, req.user.user_id)) throw new HttpError(400, 'You cannot trade with yourself.');
  if (target.verified_at || target.role === 'admin') throw new HttpError(400, 'That user is already verified.');

  await recordTradeAttempt(target.user_id, req.user.user_id);
  res.json({ ok: true });
}));

// Create a transaction request (sent to the partner). Both people must be verified.
app.post('/api/transactions', auth, route(async (req, res) => {
  const { my_role, item_description, amount } = req.body;
  const partner_username = cleanHandle(req.body.partner_username);
  if (!partner_username || !['buyer', 'seller'].includes(my_role) || !item_description || !(Number(amount) > 0)) throw new HttpError(400, 'Partner username, your role, item description, and a valid amount are required.');
  await assertVerified(req.user.user_id, 'Verify your identity first. Open "Edit profile" on your dashboard and complete the verification to start trades.');

  const partner = await pool.query(
    `SELECT user_id, verified_at, role FROM users WHERE lower(username) = lower($1) AND account_status = 'active'`,
    [partner_username]
  );
  if (!partner.rows[0]) throw new HttpError(404, 'No active user with that username.');
  const partnerId = partner.rows[0].user_id;
  if (sameId(partnerId, req.user.user_id)) throw new HttpError(400, 'You cannot trade with yourself.');
  if (!partner.rows[0].verified_at && partner.rows[0].role !== 'admin') {
    await recordTradeAttempt(partnerId, req.user.user_id);
    return res.status(400).json({ message: '@' + partner_username + ' is not verified yet, so you cannot trade with them. We told them you tried.' });
  }
  const buyer_id  = my_role === 'buyer'  ? req.user.user_id : partnerId;
  const seller_id = my_role === 'seller' ? req.user.user_id : partnerId;
  const trade = await queryOne(
    pool,
    `INSERT INTO transactions (buyer_id, seller_id, item_description, amount, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING transaction_id, buyer_id, seller_id, item_description, amount, service_fee, status, created_at, created_by`,
    [buyer_id, seller_id, item_description, amount, req.user.user_id]
  );
  await logActivity(pool, req.user.user_id, trade.transaction_id, 'trade_created', 'as the ' + my_role + ', ₱' + Number(amount));
  res.status(201).json(trade);
}));

// List my transactions
app.get('/api/transactions', auth, route(async (req, res) => {
  const result = await pool.query(
    `SELECT t.transaction_id, t.buyer_id, t.seller_id, t.item_description, t.amount, t.service_fee,
            t.status, t.created_at, t.created_by,
            b.username AS buyer_username, s.username AS seller_username
     FROM transactions t
     ${JOIN_BUYER_SELLER}
     WHERE t.buyer_id = $1 OR t.seller_id = $1
     ORDER BY t.created_at DESC`,
    [req.user.user_id]
  );
  res.json(result.rows);
}));

// Requests that other users sent me (waiting for my answer)
app.get('/api/requests', auth, route(async (req, res) => {
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
}));

// Accept or decline a request (only the partner who received it can answer). Accepting needs verification.
app.post('/api/transactions/:id/respond', auth, route(async (req, res) => {
  const { action } = req.body;
  if (!['accept', 'decline'].includes(action) || !/^\d+$/.test(req.params.id)) throw new HttpError(400, 'Invalid request.');
  if (action === 'accept') {
    await assertVerified(req.user.user_id, 'Verify your identity first before you accept a trade. Open "Edit profile" on your dashboard.');
  }
  const newValues = action === 'accept' ? `status = 'accepted'` : `status = 'cancelled', cancelled_by = $2`;
  const result = await pool.query(
    `UPDATE transactions SET ${newValues}
     WHERE transaction_id = $1 AND status = 'pending'
       AND created_by <> $2 AND (buyer_id = $2 OR seller_id = $2)
     RETURNING transaction_id, status`,
    [req.params.id, req.user.user_id]
  );
  if (!result.rows[0]) throw new HttpError(404, 'Request not found, or it was already answered.');
  await logActivity(pool, req.user.user_id, result.rows[0].transaction_id,
    action === 'accept' ? 'trade_accepted' : 'trade_declined', null);
  res.json(result.rows[0]);
}));

// Cancel a trade. What is allowed depends on where the trade is:
//   pending   : only the person who sent the request
//   accepted  : either person (nothing was paid yet)
//   paid      : only the seller, with a reason, and the buyer is refunded in full
// After delivery or during a dispute the trade cannot be cancelled here.
app.post('/api/transactions/:id/cancel', auth, route(async (req, res) => {
  const reason = String(req.body.reason || '').trim();
  requireNumeric(req.params.id, 'Invalid trade.');
  if (reason.length > 300) throw new HttpError(400, 'Please keep the reason under 300 characters.');

  let outcome;
  await withTx(async client => {
    const userId = req.user.user_id;
    const t = await queryOne(client, 'SELECT * FROM transactions WHERE transaction_id = $1 FOR UPDATE', [req.params.id]);
    if (!t || !isParty(t, userId)) {
      throw new HttpError(404, 'Trade not found.');
    }
    const isSeller = sameId(t.seller_id, userId);

      if (t.status === 'pending' || t.status === 'accepted') {
      if (t.status === 'pending' && !sameId(t.created_by, userId)) {
        throw new HttpError(403, 'Only the person who sent the request can cancel it. You can decline it from your dashboard.');
      }
      await client.query(`UPDATE transactions SET status = 'cancelled', cancelled_by = $1, cancel_reason = $2 WHERE transaction_id = $3`,
        [userId, reason || null, t.transaction_id]);
      const what = t.status === 'pending' ? 'cancelled the request' : 'cancelled before payment';
      await logActivity(client, userId, t.transaction_id, 'trade_cancelled', what + (reason ? ': ' + reason : ''));
      outcome = 'cancelled';

    } else if (t.status === 'paid') {
      if (!isSeller) {
        throw new HttpError(403, 'Only the seller can cancel after payment. If something is wrong, open a dispute.');
      }
      if (reason.length < 5) throw new HttpError(400, 'Write a short reason for cancelling.');
      await assertPaymentHeld(client, t.transaction_id, 'There is no held payment for this trade.');

      await markPaymentRefunded(client, t.transaction_id);
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
  if (outcome === 'cancelled') await cancelOpenCheckouts(req.params.id);
  res.json({ ok: true, status: outcome });
}));

// The GCash number sent with a payment or a delivery: 11 digits, starting with 09
function readGcashNumber(req, invalidMessage) {
  const number = String(req.body.number || '').replace(/[\s-]/g, '');
  requireNumeric(req.params.id, 'Invalid trade.');
  if (req.body.method && req.body.method !== 'gcash') throw new HttpError(400, 'Only GCash is accepted.');
  if (!/^09\d{9}$/.test(number)) throw new HttpError(400, invalidMessage);
  return number;
}

// Lock one trade and make sure this user may do this step
async function lockTrade(client, id, userId, { role, status }) {
  const t = await queryOne(client, 'SELECT * FROM transactions WHERE transaction_id = $1 FOR UPDATE', [id]);
  if (!t || !isParty(t, userId)) {
    throw new HttpError(404, 'Trade not found.');
  }
  const owner = role === 'buyer' ? t.buyer_id : t.seller_id;
  if (!sameId(owner, userId)) throw new HttpError(403, 'Only the ' + role + ' can do this.');
  if (t.status !== status) throw new HttpError(409, 'This step is not available for the trade\'s current status.');
  return t;
}

// Make sure the money for this trade is really held (and lock the payment row)
async function assertPaymentHeld(client, transactionId, message) {
  const pay = await queryOne(client, 'SELECT payment_status FROM escrow_payments WHERE transaction_id = $1 FOR UPDATE', [transactionId]);
  if (!pay || pay.payment_status !== 'held') throw new HttpError(409, message);
}

function markPaymentRefunded(client, transactionId) {
  return client.query(`UPDATE escrow_payments SET payment_status = 'refunded' WHERE transaction_id = $1`, [transactionId]);
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
app.get('/api/transactions/:id', auth, route(async (req, res) => {
  requireNumeric(req.params.id, 'Invalid trade.');
  const found = await pool.query(
    `SELECT t.*, b.username AS buyer_username, s.username AS seller_username,
            b.avatar_file AS buyer_avatar, s.avatar_file AS seller_avatar,
            ${verifiedSql('b')} AS buyer_verified,
            ${verifiedSql('s')} AS seller_verified,
            c.username AS cancelled_by_username,
            EXISTS (SELECT 1 FROM favorites fv WHERE fv.user_id = $2
                    AND fv.favorite_user_id = (CASE WHEN t.buyer_id = $2 THEN t.seller_id ELSE t.buyer_id END)) AS partner_is_favorite,
            CASE WHEN t.buyer_id = $2 THEN 'buyer' ELSE 'seller' END AS my_role,
            (t.created_by = $2) AS created_by_me
     FROM transactions t
     ${JOIN_BUYER_SELLER}
     LEFT JOIN users c ON c.user_id = t.cancelled_by
     WHERE t.transaction_id = $1 AND (t.buyer_id = $2 OR t.seller_id = $2)`,
    [req.params.id, req.user.user_id]
  );
  const row = found.rows[0];
  if (!row) throw new HttpError(404, 'Trade not found.');
  const { payout_number, ...trade } = row;

  const p = await queryOne(
    pool,
    'SELECT payment_method, payment_status, released_at, payer_number FROM escrow_payments WHERE transaction_id = $1',
    [req.params.id]
  );
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
    checkout_enabled: checkoutEnabled,
    payout_masked: maskNumber(payout_number),
    payment,
    receipt: receipt.rows[0] || null,
    messages: messages.rows,
  });
}));

// ---------- Xendit (online GCash payment) ----------
// It turns on when all three settings are in .env. Otherwise the simulated payment is used.
const XENDIT_KEY = process.env.XENDIT_SECRET_KEY || '';
const XENDIT_WEBHOOK_TOKEN = process.env.XENDIT_WEBHOOK_TOKEN || '';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
const checkoutEnabled = !!(XENDIT_KEY && XENDIT_WEBHOOK_TOKEN && PUBLIC_URL);

if (XENDIT_KEY && !XENDIT_KEY.startsWith('xnd_development_') && process.env.XENDIT_ALLOW_LIVE !== 'true') {
  throw new Error('XENDIT_SECRET_KEY must be a test key (xnd_development_...). Real money is turned off.');
}

async function xenditPost(apiPath, body) {
  const res = await fetch('https://api.xendit.co' + apiPath, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(XENDIT_KEY + ':').toString('base64'),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Xendit error:', res.status, data.error_code, data.message);
    throw new HttpError(502, 'The payment service is not available right now. Please try again.');
  }
  return data;
}

// Hold the buyer's money for this trade
async function markTradePaid(client, trade, payerNumber) {
  await client.query(
    `INSERT INTO escrow_payments (transaction_id, payment_method, payer_number, amount_held, payment_status)
     VALUES ($1, 'gcash', $2, $3, 'held')`,
    [trade.transaction_id, payerNumber, trade.amount]
  );
  await client.query(`UPDATE transactions SET status = 'paid' WHERE transaction_id = $1`, [trade.transaction_id]);
  await logActivity(client, trade.buyer_id, trade.transaction_id, 'paid', 'with GCash, ₱' + Number(trade.amount));
}

// Give the buyer a Xendit checkout page. A page that is still open is reused, so a trade is never charged twice.
function startCheckout(tradeId, buyerId) {
  return withTx(async client => {
    const t = await lockTrade(client, tradeId, buyerId, { role: 'buyer', status: 'accepted' });
    const open = await queryOne(
      client,
      `SELECT payment_link_url FROM xendit_sessions
       WHERE transaction_id = $1 AND status = 'ACTIVE' AND expires_at > now()`,
      [t.transaction_id]
    );
    if (open) return open.payment_link_url;

    await client.query(`UPDATE xendit_sessions SET status = 'EXPIRED' WHERE transaction_id = $1 AND status = 'ACTIVE'`, [t.transaction_id]);
    const returnUrl = PUBLIC_URL + '/api/xendit/return?id=' + t.transaction_id;
    const session = await xenditPost('/sessions', {
      reference_id: 'trade-' + t.transaction_id + '-' + Date.now(),
      session_type: 'PAY',
      mode: 'PAYMENT_LINK',
      amount: Number(t.amount),
      currency: 'PHP',
      country: 'PH',
      allowed_payment_channels: ['GCASH'],
      description: String(t.item_description).slice(0, 1000),
      success_return_url: returnUrl,
      cancel_return_url: returnUrl,
    });
    await client.query(
      `INSERT INTO xendit_sessions (session_id, transaction_id, payment_link_url, amount, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [session.payment_session_id, t.transaction_id, session.payment_link_url, t.amount, session.expires_at]
    );
    return session.payment_link_url;
  });
}

// The trade was cancelled, so close any checkout page that is still open
async function cancelOpenCheckouts(tradeId) {
  if (!checkoutEnabled) return;
  const open = await queryAll(pool, `SELECT session_id FROM xendit_sessions WHERE transaction_id = $1 AND status = 'ACTIVE'`, [tradeId]);
  for (const { session_id: sessionId } of open) {
    try {
      await xenditPost('/sessions/' + sessionId + '/cancel', {});
      await pool.query(`UPDATE xendit_sessions SET status = 'CANCELED' WHERE session_id = $1 AND status = 'ACTIVE'`, [sessionId]);
    } catch (err) {
      console.error('Could not close checkout', sessionId, err.message);
    }
  }
}

function isValidWebhookToken(received) {
  const hash = value => crypto.createHash('sha256').update(String(value)).digest();
  return !!XENDIT_WEBHOOK_TOKEN && crypto.timingSafeEqual(hash(received), hash(XENDIT_WEBHOOK_TOKEN));
}

// Xendit says a checkout was paid. Xendit can send this more than once, so a repeat does nothing.
async function completeCheckout(client, session, data) {
  await client.query(`UPDATE xendit_sessions SET status = 'COMPLETED', payment_id = $1 WHERE session_id = $2`, [data.payment_id || data.payment_request_id || null, session.session_id]);
  const t = await queryOne(client, 'SELECT * FROM transactions WHERE transaction_id = $1 FOR UPDATE', [session.transaction_id]);
  const amountMatches = data.amount === undefined || Number(data.amount) === Number(session.amount);

  if (t.status === 'accepted' && amountMatches) return markTradePaid(client, t, null);
  // Money arrived that the trade cannot accept, so an admin must look at it
  await logActivity(client, t.buyer_id, t.transaction_id, 'payment_needs_review',
    'Xendit payment ' + (data.payment_id || session.session_id) + (amountMatches ? ' arrived while the trade was ' + t.status : ' had the wrong amount'));
}

// Xendit reports what happened to a checkout page (it signs in with the webhook token, not a user login)
app.post('/api/webhooks/xendit', route(async (req, res) => {
  if (!isValidWebhookToken(req.headers['x-callback-token'] || '')) throw new HttpError(401, 'Invalid token.');
  const { event, data } = req.body;
  const finished = event === 'payment_session.completed' || event === 'payment_session.expired';
  const sessionId = data && (data.id || data.payment_session_id);   // Xendit sends "id"; its docs show "payment_session_id"
  if (finished && sessionId) {
    await withTx(async client => {
      const session = await queryOne(client, 'SELECT * FROM xendit_sessions WHERE session_id = $1 FOR UPDATE', [sessionId]);
      if (!session || session.status === 'COMPLETED') return;
      if (event === 'payment_session.completed') await completeCheckout(client, session, data);
      else await client.query(`UPDATE xendit_sessions SET status = 'EXPIRED' WHERE session_id = $1`, [session.session_id]);
    });
  }
  res.json({ ok: true });
}));

// After the checkout page, Xendit sends the buyer back here (it only allows https addresses)
app.get('/api/xendit/return', (req, res) => {
  const site = (process.env.FRONTEND_URL || 'http://localhost:' + PORT).replace(/\/$/, '');
  res.redirect(/^\d+$/.test(req.query.id) ? site + '/transaction.html?id=' + req.query.id : site + '/dashboard.html');
});

// Buyer pays into escrow. With Xendit the buyer gets a checkout page; otherwise the payment is simulated.
app.post('/api/transactions/:id/pay', auth, route(async (req, res) => {
  if (checkoutEnabled) {
    requireNumeric(req.params.id, 'Invalid trade.');
    return res.json({ checkout_url: await startCheckout(req.params.id, req.user.user_id) });
  }
  const number = readGcashNumber(req, 'Enter the 11-digit GCash number you are paying from (it starts with 09).');
  await withTx(async client => {
    const t = await lockTrade(client, req.params.id, req.user.user_id, { role: 'buyer', status: 'accepted' });
    await markTradePaid(client, t, number);
  });
  res.json({ ok: true });
}));

// Seller says the item was delivered, and says which GCash number should receive the money
app.post('/api/transactions/:id/deliver', auth, route(async (req, res) => {
  const number = readGcashNumber(req, 'Enter the 11-digit GCash number (it starts with 09) where you want to receive your money.');
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
}));

// Buyer confirms receipt: the payment is released to the seller
app.post('/api/transactions/:id/confirm', auth, route(async (req, res) => {
  requireNumeric(req.params.id, 'Invalid trade.');
  await withTx(async client => {
    const t = await lockTrade(client, req.params.id, req.user.user_id, { role: 'buyer', status: 'delivered' });
    await releasePayment(client, t.transaction_id);
    await logActivity(client, req.user.user_id, t.transaction_id, 'confirmed', null);
  });
  res.json({ ok: true });
}));

// Chat: send a message in a trade
app.post('/api/transactions/:id/messages', auth, route(async (req, res) => {
  const content = String(req.body.content || '').trim();
  if (!/^\d+$/.test(req.params.id) || !content || content.length > 1000) throw new HttpError(400, 'Write a message of 1 to 1000 characters.');
  const mine = await pool.query(
    'SELECT 1 FROM transactions WHERE transaction_id = $1 AND (buyer_id = $2 OR seller_id = $2)',
    [req.params.id, req.user.user_id]
  );
  if (!mine.rows[0]) throw new HttpError(404, 'Trade not found.');
  await pool.query(
    'INSERT INTO messages (transaction_id, sender_id, content) VALUES ($1, $2, $3)',
    [req.params.id, req.user.user_id, content]
  );
  res.status(201).json({ ok: true });
}));

// ---------- History and ratings ----------

// My finished trades (completed, refunded, cancelled) with the details a receipt needs.
// Mobile numbers are only sent masked. rate_later tells the dashboard to stop reminding me.
app.get('/api/history', auth, route(async (req, res) => {
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
     ${JOIN_BUYER_SELLER}
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
}));

// A completed trade that this user took part in (only those can be rated)
async function findTradeToRate(tradeId, me, notCompletedMessage) {
  const t = await queryOne(pool, 'SELECT buyer_id, seller_id, status FROM transactions WHERE transaction_id = $1', [tradeId]);
  if (!t || !isParty(t, me)) throw new HttpError(404, 'Trade not found.');
  if (t.status !== 'completed') throw new HttpError(409, notCompletedMessage);
  return t;
}

// Rate the other person in a completed trade. Optional, once per person, and it cannot be changed.
// The public only sees the stars and the comment, not who wrote it. Admins can see who.
app.post('/api/transactions/:id/rating', auth, route(async (req, res) => {
  const score = Number(req.body.score);
  const feedback = String(req.body.feedback || '').trim();
  requireNumeric(req.params.id, 'Invalid trade.');
  if (!Number.isInteger(score) || score < 1 || score > 5) throw new HttpError(400, 'Choose 1 to 5 stars.');
  if (feedback.length > 500) throw new HttpError(400, 'Please keep the feedback under 500 characters.');
  try {
    const me = req.user.user_id;
    const t = await findTradeToRate(req.params.id, me, 'You can only rate a trade after it is completed.');
    const other = sameId(t.buyer_id, me) ? t.seller_id : t.buyer_id;
    await pool.query(
      `INSERT INTO ratings (transaction_id, rated_by, rated_user_id, score, feedback)
       VALUES ($1, $2, $3, $4, $5)`,
      [req.params.id, req.user.user_id, other, score, feedback || null]
    );
    await logActivity(pool, req.user.user_id, Number(req.params.id), 'rated', score + ' of 5 stars');
    res.status(201).json({ ok: true });
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, 'You already rated this trade.');
    throw err;
  }
}));

// "Rate later": stop reminding me about this trade on the dashboard.
// I can still rate it from History or the trade page.
app.post('/api/transactions/:id/rate-later', auth, route(async (req, res) => {
  requireNumeric(req.params.id, 'Invalid trade.');
  await findTradeToRate(req.params.id, req.user.user_id, 'Only a completed trade can be rated.');
  await pool.query(
    `INSERT INTO rate_dismissals (user_id, transaction_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [req.user.user_id, req.params.id]
  );
  res.json({ ok: true });
}));

// ---------- Disputes ----------
const UPLOAD_DIR = path.join(__dirname, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const IMAGE_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
const MIME_BY_EXT = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
const MAX_FILES = 5;
const MAX_FILE_MB = 5;

// Make a multer setup that saves images with a random name
function imageUploader({ dir, types, maxMb, maxFiles, wrongTypeMessage }) {
  return multer({
    storage: multer.diskStorage({
      destination: dir,
      filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + types[file.mimetype]),
    }),
    limits: { fileSize: maxMb * 1024 * 1024, files: maxFiles },
    fileFilter: (req, file, cb) => {
      if (types[file.mimetype]) return cb(null, true);
      cb(new HttpError(400, wrongTypeMessage));
    },
  });
}

// Run a multer step and turn upload problems into clear messages
function readUpload(multerStep, { tooBigMessage, tooManyMessage, failStatus, failMessage }) {
  return (req, res, next) => multerStep(req, res, err => {
    if (!err) return next();
    if (err instanceof HttpError) return sendError(res, err);
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ message: tooBigMessage });
    if (tooManyMessage && (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE')) {
      return res.status(400).json({ message: tooManyMessage });
    }
    console.error(err);
    res.status(failStatus).json({ message: failMessage });
  });
}

// Send a private picture from one of the upload folders
function sendPrivateImage(res, file, root, cacheControl) {
  res.setHeader('Content-Type', MIME_BY_EXT[path.extname(file).toLowerCase()] || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', cacheControl);
  res.sendFile(file, { root }, err => {
    if (err && !res.headersSent) res.status(404).json({ message: 'File not found.' });
  });
}

// The dispute screenshots (field name "files")
const uploadFiles = readUpload(
  imageUploader({
    dir: UPLOAD_DIR,
    types: IMAGE_TYPES,
    maxMb: MAX_FILE_MB,
    maxFiles: MAX_FILES,
    wrongTypeMessage: 'Only image files (JPG, PNG, WEBP, or GIF) are allowed.',
  }).array('files', MAX_FILES),
  {
    tooBigMessage: 'Each image must be ' + MAX_FILE_MB + ' MB or smaller.',
    tooManyMessage: 'You can upload up to ' + MAX_FILES + ' images.',
    failStatus: 500,
    failMessage: 'Could not read the upload.',
  }
);

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
app.get('/api/disputes', auth, route(async (req, res) => {
  const result = await pool.query(
    `SELECT d.dispute_id, d.dispute_status, d.opened_at, d.filed_by, d.reply,
            t.transaction_id, t.item_description, t.amount, t.status AS trade_status,
            CASE WHEN t.buyer_id = $1 THEN 'buyer' ELSE 'seller' END AS my_role,
            CASE WHEN t.buyer_id = $1 THEN s.username ELSE b.username END AS partner_username,
            f.username AS filed_by_username
     FROM disputes d
     JOIN transactions t ON t.transaction_id = d.transaction_id
     ${JOIN_BUYER_SELLER}
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
    filed_by_me: sameId(d.filed_by, req.user.user_id),
    needs_my_reply: d.dispute_status !== 'resolved' && !sameId(d.filed_by, req.user.user_id) && !d.reply,
  })));
}));

// The dispute page: the trade, whether I can open a dispute, and the dispute itself (if any)
app.get('/api/transactions/:id/dispute', auth, route(async (req, res) => {
  requireNumeric(req.params.id, 'Invalid trade.');
  const userId = req.user.user_id;
  const found = await pool.query(
    `SELECT t.transaction_id, t.item_description, t.amount, t.status, t.buyer_id,
            b.username AS buyer_username, s.username AS seller_username
     FROM transactions t
     ${JOIN_BUYER_SELLER}
     WHERE t.transaction_id = $1 AND (t.buyer_id = $2 OR t.seller_id = $2)`,
    [req.params.id, userId]
  );
  const t = found.rows[0];
  if (!t) throw new HttpError(404, 'Trade not found.');
  const role = sameId(t.buyer_id, userId) ? 'buyer' : 'seller';

  const d = await queryOne(
    pool,
    `SELECT d.*, f.username AS filed_by_username
     FROM disputes d JOIN users f ON f.user_id = d.filed_by
     WHERE d.transaction_id = $1`,
    [req.params.id]
  );

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
    const filedByMe = sameId(d.filed_by, userId);
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
    can_file: !d && PAID_STATUSES.includes(t.status),
    reasons: REASONS[role],
    outcomes: OUTCOMES[role],
    dispute,
  });
}));

// Open a dispute (with up to 5 screenshots). The payment stays in escrow.
app.post('/api/transactions/:id/dispute', auth, uploadFiles, route(async (req, res) => {
  const files = req.files || [];
  try {
    requireNumeric(req.params.id, 'Invalid trade.');
    const reason = String(req.body.reason || '').trim();
    const description = String(req.body.description || '').trim();
    const outcome = String(req.body.outcome || '').trim();
    if (!description) throw new HttpError(400, 'Tell us what happened.');
    if (description.length > 2000) throw new HttpError(400, 'Please keep the description under 2000 characters.');
    await assertRealImages(files, 'One of the files is not a valid JPG, PNG, WEBP, or GIF image.');

    await withTx(async client => {
      const t = await queryOne(client, 'SELECT * FROM transactions WHERE transaction_id = $1 FOR UPDATE', [req.params.id]);
      const userId = req.user.user_id;
      if (!t || !isParty(t, userId)) {
        throw new HttpError(404, 'Trade not found.');
      }
      const role = sameId(t.buyer_id, userId) ? 'buyer' : 'seller';

      if (!PAID_STATUSES.includes(t.status)) {
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
    throw err;
  }
}));

// The other person replies to a dispute and can add their own screenshots
app.post('/api/transactions/:id/dispute/reply', auth, uploadFiles, route(async (req, res) => {
  const files = req.files || [];
  try {
    requireNumeric(req.params.id, 'Invalid trade.');
    const message = String(req.body.message || '').trim();
    if (!message) throw new HttpError(400, 'Write your reply.');
    if (message.length > 2000) throw new HttpError(400, 'Please keep the reply under 2000 characters.');
    await assertRealImages(files, 'One of the files is not a valid JPG, PNG, WEBP, or GIF image.');

    await withTx(async client => {
      const userId = req.user.user_id;
      const d = await queryOne(
        client,
        `SELECT d.dispute_id, d.filed_by, d.dispute_status, t.transaction_id, t.buyer_id, t.seller_id
         FROM disputes d JOIN transactions t ON t.transaction_id = d.transaction_id
         WHERE d.transaction_id = $1
         FOR UPDATE OF d`,
        [req.params.id]
      );
      if (!d || !isParty(d, userId)) {
        throw new HttpError(404, 'Dispute not found.');
      }
      if (sameId(d.filed_by, userId)) {
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
    throw err;
  }
}));

// One evidence image. Only the two traders (and admins) can open it.
app.get('/api/evidence/:id/file', auth, route(async (req, res) => {
  requireNumeric(req.params.id, 'Invalid file.');
  const row = await queryOne(
    pool,
    `SELECT e.file_url, t.buyer_id, t.seller_id
     FROM evidence e
     JOIN disputes d ON d.dispute_id = e.dispute_id
     JOIN transactions t ON t.transaction_id = d.transaction_id
     WHERE e.evidence_id = $1`,
    [req.params.id]
  );
  const userId = String(req.user.user_id);
  const allowed = row && (
    String(row.buyer_id) === userId ||
    String(row.seller_id) === userId ||
    (await isAdmin(req.user.user_id))
  );
  if (!allowed) throw new HttpError(404, 'File not found.');

  sendPrivateImage(res, path.basename(row.file_url), UPLOAD_DIR, 'private, max-age=3600');
}));

// ---------- My profile: photo, username, email ----------
const AVATAR_DIR = path.join(UPLOAD_DIR, 'avatars');
fs.mkdirSync(AVATAR_DIR, { recursive: true });
const AVATAR_TYPES = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const AVATAR_MAX_MB = 2;

// The profile photo (field name "photo")
const uploadAvatar = readUpload(
  imageUploader({
    dir: AVATAR_DIR,
    types: AVATAR_TYPES,
    maxMb: AVATAR_MAX_MB,
    maxFiles: 1,
    wrongTypeMessage: 'Choose a JPG, PNG, or WEBP photo.',
  }).single('photo'),
  { tooBigMessage: 'The photo must be ' + AVATAR_MAX_MB + ' MB or smaller.', failStatus: 400, failMessage: 'Could not read the photo.' }
);

// Make sure the file really is the kind of image it says it is
async function looksLikeImage(filePath, ext) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(12);
    await handle.read(buf, 0, 12, 0);
    if (ext === '.jpg') return buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
    if (ext === '.png') return buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG';
    if (ext === '.webp') return buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
    if (ext === '.gif') return ['GIF87a', 'GIF89a'].includes(buf.toString('ascii', 0, 6));
    return false;
  } finally {
    await handle.close();
  }
}

// Every uploaded file must really be the kind of image it says it is
async function assertRealImages(files, message) {
  for (const file of files) {
    if (!(await looksLikeImage(file.path, path.extname(file.filename)))) throw new HttpError(400, message);
  }
}

// Delete one saved file by name (a missing file is fine)
function removeSavedFile(dir, name) {
  if (!name) return Promise.resolve();
  return fs.promises.unlink(path.join(dir, path.basename(name))).catch(() => {});
}

const removeAvatarFile = name => removeSavedFile(AVATAR_DIR, name);
const removeVerifFile = name => removeSavedFile(VERIF_DIR, name);

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

// Email PIN for a new email address (saved as a hash, expires in 10 minutes)
async function issueEmailChangePin(userId, newEmail) {
  assertCanResend(await queryOne(
    pool, 'SELECT EXTRACT(EPOCH FROM (now() - created_at)) AS age FROM email_changes WHERE user_id = $1', [userId]
  ));

  const pin = newSixDigitCode();
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
    await deleteEmailChange(userId);
    throw err;
  }
}

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
  if (!(await bcrypt.compare(pin, row.pin_hash))) {
    const used = row.attempts + 1;
    if (used >= MAX_PIN_TRIES) {
      await deleteEmailChange(id);
      throw new HttpError(429, 'Too many wrong tries. Please start again.');
    }
    await pool.query('UPDATE email_changes SET attempts = $1 WHERE user_id = $2', [used, id]);
    throw new HttpError(400, 'Wrong PIN. ' + (MAX_PIN_TRIES - used) + ' tries left.');
  }

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
  res.json({ ok: true, email: row.new_email });
}));

// Change my email: send the PIN again
app.post('/api/profile/email/resend', auth, route(async (req, res) => {
  const row = await queryOne(pool, 'SELECT new_email FROM email_changes WHERE user_id = $1', [req.user.user_id]);
  if (!row) throw new HttpError(404, 'Please start again.');
  await issueEmailChangePin(req.user.user_id, row.new_email);
  res.json({ ok: true });
}));

// ---------- Identity verification ----------
// The user shows an ID and a selfie holding the ID next to a code. An admin reviews it.
// The admin also checks that the ID shows the person is 18 or older.
// The pictures are private and are deleted as soon as the admin decides. No ID number is saved.
const VERIF_DIR = path.join(UPLOAD_DIR, 'verifications');
fs.mkdirSync(VERIF_DIR, { recursive: true });
const VERIF_MAX_MB = 5;

// The ID picture and the selfie
const uploadVerification = readUpload(
  imageUploader({
    dir: VERIF_DIR,
    types: AVATAR_TYPES,
    maxMb: VERIF_MAX_MB,
    maxFiles: 2,
    wrongTypeMessage: 'The pictures must be JPG, PNG, or WEBP.',
  }).fields([{ name: 'id_photo', maxCount: 1 }, { name: 'selfie', maxCount: 1 }]),
  { tooBigMessage: 'Each picture must be ' + VERIF_MAX_MB + ' MB or smaller.', failStatus: 400, failMessage: 'Could not read the pictures.' }
);

// My verification: am I verified, is a request waiting, was one rejected, my current code,
// and who tried to trade with me while I was not verified
app.get('/api/verification', auth, route(async (req, res) => {
  const id = req.user.user_id;
  const u = await queryOne(
    pool,
    `SELECT first_name, last_name, full_name, verified_at, role, verify_code, verify_code_expires_at
     FROM users WHERE user_id = $1`,
    [id]
  );
  const latest = await queryOne(
    pool,
    `SELECT status, typed_name, typed_first_name, typed_last_name, id_type, reject_reason, submitted_at, decided_at
     FROM verifications WHERE user_id = $1 ORDER BY submitted_at DESC LIMIT 1`,
    [id]
  );

  const verified = !!u.verified_at || u.role === 'admin';
  let attempts = [];
  if (!verified) {
    attempts = await queryAll(
      pool,
      `SELECT us.username, ta.created_at
       FROM trade_attempts ta JOIN users us ON us.user_id = ta.from_user_id
       WHERE ta.target_user_id = $1 AND ta.created_at > now() - interval '14 days'
       ORDER BY ta.created_at DESC LIMIT 5`,
      [id]
    );
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
}));

// A code to write on paper and hold in the selfie (a new one each time, good for 24 hours)
app.post('/api/verification/code', auth, route(async (req, res) => {
  const id = req.user.user_id;
  const u = await queryOne(pool, 'SELECT verified_at, role FROM users WHERE user_id = $1', [id]);
  if (u.verified_at || u.role === 'admin') throw new HttpError(409, 'You are already verified.');
  const pending = await queryOne(pool, `SELECT 1 FROM verifications WHERE user_id = $1 AND status = 'pending'`, [id]);
  if (pending) throw new HttpError(409, 'Your request is already being reviewed.');

  const code = newSixDigitCode();
  const r = await pool.query(
    `UPDATE users SET verify_code = $1, verify_code_expires_at = now() + interval '${VERIFY_CODE_HOURS} hours'
     WHERE user_id = $2 RETURNING verify_code_expires_at`,
    [code, id]
  );
  res.json({ ok: true, code, code_expires_at: r.rows[0].verify_code_expires_at });
}));

// Send the ID, the selfie with the code, and the first and last name exactly as written on the ID
app.post('/api/verification/submit', auth, uploadVerification, route(async (req, res) => {
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
    await assertRealImages([idPhoto, selfie], 'One of the pictures is not a valid JPG, PNG, or WEBP image.');

    await withTx(async client => {
      const id = req.user.user_id;
      const u = await queryOne(client, 'SELECT verified_at, role, verify_code, verify_code_expires_at FROM users WHERE user_id = $1 FOR UPDATE', [id]);
      if (u.verified_at || u.role === 'admin') throw new HttpError(409, 'You are already verified.');
      if (!u.verify_code || new Date(u.verify_code_expires_at) < new Date()) {
        throw new HttpError(400, 'Your code expired. Get a new code and take the selfie again.');
      }
      const pending = await queryOne(client, `SELECT 1 FROM verifications WHERE user_id = $1 AND status = 'pending'`, [id]);
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
    if (err.code === '23505') throw new HttpError(409, 'Your request is already being reviewed.');
    throw err;
  }
}));

// A verification picture. Only its owner and admins can open it, and only while it is being reviewed.
app.get('/api/verifications/:id/:kind', auth, route(async (req, res) => {
  if (!/^\d+$/.test(req.params.id) || !['id', 'selfie'].includes(req.params.kind)) throw new HttpError(404, 'File not found.');
  const v = await queryOne(pool, 'SELECT user_id, id_file, selfie_file FROM verifications WHERE verification_id = $1', [req.params.id]);
  const allowed = v && (sameId(v.user_id, req.user.user_id) || (await isAdmin(req.user.user_id)));
  const name = v && (req.params.kind === 'id' ? v.id_file : v.selfie_file);
  if (!allowed || !name) throw new HttpError(404, 'File not found.');

  sendPrivateImage(res, path.basename(name), VERIF_DIR, 'no-store');
}));

// ---------- Admin ----------

function getTradeChat(transactionId) {
  return queryAll(
    pool,
    `SELECT u.username, m.content, m.sent_at
     FROM messages m JOIN users u ON u.user_id = m.sender_id
     WHERE m.transaction_id = $1
     ORDER BY m.sent_at, m.message_id`,
    [transactionId]
  );
}

function getTradeActivity(transactionId) {
  return queryAll(
    pool,
    `SELECT a.action, a.detail, a.created_at, u.username
     FROM activity_log a LEFT JOIN users u ON u.user_id = a.user_id
     WHERE a.transaction_id = $1
     ORDER BY a.created_at, a.log_id`,
    [transactionId]
  );
}

async function getAdminPayment(transactionId) {
  const p = await queryOne(pool, 'SELECT payment_method, payment_status, payer_number FROM escrow_payments WHERE transaction_id = $1', [transactionId]);
  return p ? { method: p.payment_method, status: p.payment_status, payer_masked: maskNumber(p.payer_number) } : null;
}

// Overview numbers
app.get('/api/admin/overview', auth, adminOnly, route(async (req, res) => {
  const stats = await queryOne(
    pool,
    `SELECT
       (SELECT COUNT(*) FROM disputes WHERE dispute_status <> 'resolved') AS open_disputes,
       (SELECT COALESCE(SUM(amount_held), 0) FROM escrow_payments WHERE payment_status = 'held') AS held,
       (SELECT COUNT(*) FROM transactions WHERE created_at >= date_trunc('month', now())) AS trades_month,
       (SELECT COALESCE(SUM(service_fee), 0) FROM transactions WHERE status = 'completed') AS fees,
       (SELECT COUNT(*) FROM verifications WHERE status = 'pending') AS pending_verifications,
       (SELECT COUNT(DISTINCT user_id) FROM support_messages WHERE NOT from_admin AND read_at IS NULL) AS unread_support,
       (SELECT COUNT(*) FROM review_reports WHERE status = 'open') AS open_reports,
       (SELECT COUNT(*) FROM activity_log WHERE action = 'login_blocked' AND created_at > now() - interval '7 days') AS login_alerts,
       (SELECT COUNT(*) FROM transactions t
          ${JOIN_BUYER_SELLER}
         WHERE t.status::text IN ('paid', 'delivered')
           AND (b.account_status::text <> 'active' OR s.account_status::text <> 'active')) AS needs_admin_trades`
  );
  res.json({
    open_disputes: Number(stats.open_disputes),
    held: Number(stats.held),
    trades_month: Number(stats.trades_month),
    fees: Number(stats.fees),
    pending_verifications: Number(stats.pending_verifications),
    unread_support: Number(stats.unread_support),
    open_reports: Number(stats.open_reports),
    login_alerts: Number(stats.login_alerts),
    needs_admin_trades: Number(stats.needs_admin_trades),
  });
}));

// Verification requests: ?status=pending (default) or all
app.get('/api/admin/verifications', auth, adminOnly, route(async (req, res) => {
  const all = String(req.query.status || 'pending') === 'all';
  const result = await pool.query(
    `SELECT v.verification_id, v.status, v.typed_name, v.id_type, v.submitted_at, v.decided_at, v.reject_reason,
            u.username, u.avatar_file, u.full_name, COUNT(*) OVER() AS total_count
     FROM verifications v JOIN users u ON u.user_id = v.user_id
     WHERE ($1::boolean OR v.status = 'pending')
     ORDER BY (v.status = 'pending') DESC,
              CASE WHEN v.status = 'pending' THEN v.submitted_at END ASC,
              v.decided_at DESC NULLS LAST,
              v.verification_id DESC
     LIMIT ${ADMIN_PAGE_SIZE} OFFSET ${pageOffset(req.query.page)}`,
    [all]
  );
  res.json(pageResult(result.rows));
}));

// One request: the names, the code, and what to compare the pictures with
app.get('/api/admin/verifications/:id', auth, adminOnly, route(async (req, res) => {
  requireNumeric(req.params.id, 'Invalid request.');
  const v = await queryOne(
    pool,
    `SELECT v.verification_id, v.status, v.typed_name, v.id_type, v.code, v.submitted_at, v.decided_at, v.reject_reason,
            (v.id_file IS NOT NULL AND v.selfie_file IS NOT NULL) AS has_files,
            u.username, u.avatar_file, u.full_name, u.email, u.created_at AS joined
     FROM verifications v JOIN users u ON u.user_id = v.user_id
     WHERE v.verification_id = $1`,
    [req.params.id]
  );
  if (!v) throw new HttpError(404, 'Request not found.');
  res.json(v);
}));

// Approve (the typed first and last name become the user's name) or reject (with a reason).
// The pictures are deleted.
app.post('/api/admin/verifications/:id/decision', auth, adminOnly, route(async (req, res) => {
  const decision = req.body.decision;
  const reason = String(req.body.reason || '').trim();
  requireNumeric(req.params.id, 'Invalid request.');
  if (!['approve', 'reject'].includes(decision)) throw new HttpError(400, 'Choose approve or reject.');
  if (decision === 'reject' && reason.length < 5) throw new HttpError(400, 'Write a short reason for rejecting.');
  if (reason.length > 300) throw new HttpError(400, 'Please keep the reason under 300 characters.');

  let toDelete = [];
  const me = await findUsername(req.user.user_id);
  await withTx(async client => {
    const v = await queryOne(client, 'SELECT * FROM verifications WHERE verification_id = $1 FOR UPDATE', [req.params.id]);
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
}));

// ---------- Admin: sign-in alerts ----------

// Accounts that reached the wrong-password limit in the last 7 days. An admin decides whether to act.
app.get('/api/admin/login-alerts', auth, adminOnly, route(async (req, res) => {
  res.json(await queryAll(
    pool,
    `SELECT a.log_id, a.detail, a.created_at,
            u.user_id, u.username, u.avatar_file, u.account_status::text AS account_status
     FROM activity_log a JOIN users u ON u.user_id = a.user_id
     WHERE a.action = 'login_blocked' AND a.created_at > now() - interval '7 days'
     ORDER BY a.created_at DESC
     LIMIT 200`
  ));
}));

// ---------- Admin: support chat ----------

// Everyone who has a conversation. The ones with unread messages come first.
app.get('/api/admin/support', auth, adminOnly, route(async (req, res) => {
  const result = await pool.query(
    `SELECT *, COUNT(*) OVER() AS total_count FROM (
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
     ORDER BY (x.unread > 0) DESC, x.last_at DESC, x.user_id DESC
     LIMIT ${ADMIN_PAGE_SIZE} OFFSET ${pageOffset(req.query.page)}`
  );
  res.json(pageResult(result.rows, r => ({ ...r, unread: Number(r.unread) })));
}));

// One conversation. Opening it marks the user's messages as read.
app.get('/api/admin/support/:userId', auth, adminOnly, route(async (req, res) => {
  requireNumeric(req.params.userId, 'Invalid user.');
  const u = await queryOne(
    pool,
    `SELECT user_id, username, avatar_file, account_status::text AS account_status FROM users WHERE user_id = $1`,
    [req.params.userId]
  );
  if (!u) throw new HttpError(404, 'User not found.');

  const messages = await queryAll(
    pool,
    `SELECT message_id, from_admin, content, sent_at FROM support_messages
     WHERE user_id = $1 ORDER BY sent_at, message_id LIMIT 300`,
    [u.user_id]
  );
  await pool.query(
    `UPDATE support_messages SET read_at = now() WHERE user_id = $1 AND NOT from_admin AND read_at IS NULL`,
    [u.user_id]
  );
  res.json({ user: u, messages });
}));

// Write to a user (this can start the conversation)
app.post('/api/admin/support/:userId', auth, adminOnly, route(async (req, res) => {
  requireNumeric(req.params.userId, 'Invalid user.');
  const content = String(req.body.content || '').trim();
  if (!content || content.length > SUPPORT_MAX) {
    throw new HttpError(400, 'Write a message of 1 to ' + SUPPORT_MAX + ' characters.');
  }
  const target = await queryOne(pool, 'SELECT user_id, role FROM users WHERE user_id = $1', [req.params.userId]);
  if (!target) throw new HttpError(404, 'User not found.');
  if (target.role === 'admin') throw new HttpError(400, 'You cannot start a support chat with an admin.');

  await pool.query(
    `INSERT INTO support_messages (user_id, sender_id, from_admin, content) VALUES ($1, $2, true, $3)`,
    [target.user_id, req.user.user_id, content]
  );
  res.status(201).json({ ok: true });
}));

// ---------- Admin: reported reviews ----------

// Reports: ?status=open (default) or all. The admin can see who wrote the review.
app.get('/api/admin/reports', auth, adminOnly, route(async (req, res) => {
  const all = String(req.query.status || 'open') === 'all';
  const result = await pool.query(
    `SELECT rr.report_id, rr.review_ref, rr.status, rr.reason, rr.created_at,
            r.score, r.feedback, r.rated_at, r.deleted_at, r.transaction_id,
            au.user_id AS author_id, au.username AS author_username,
            su.username AS subject_username, ru.username AS reporter_username,
            COUNT(*) OVER() AS total_count
     FROM review_reports rr
     JOIN ratings r ON r.review_ref = rr.review_ref
     JOIN users au ON au.user_id = r.rated_by
     JOIN users su ON su.user_id = r.rated_user_id
     JOIN users ru ON ru.user_id = rr.reported_by
     WHERE ($1::boolean OR rr.status = 'open')
     ORDER BY (rr.status = 'open') DESC, rr.created_at DESC, rr.report_id DESC
     LIMIT ${ADMIN_PAGE_SIZE} OFFSET ${pageOffset(req.query.page)}`,
    [all]
  );
  res.json(pageResult(result.rows));
}));

// Delete a review (it no longer counts in the average, and nobody sees it). A note is needed.
app.post('/api/admin/reviews/:ref/delete', auth, adminOnly, route(async (req, res) => {
  const note = String(req.body.note || '').trim();
  requireNumeric(req.params.ref, 'Invalid review.');
  requireNote(note, 300, 'Write a short note that explains why.');

  const me = await findUsername(req.user.user_id);
  await withTx(async client => {
    const r = await queryOne(
      client,
      `UPDATE ratings SET deleted_at = now(), deleted_by = $2
       WHERE review_ref = $1 AND deleted_at IS NULL
       RETURNING rated_by, transaction_id`,
      [req.params.ref, req.user.user_id]
    );
    if (!r) throw new HttpError(404, 'Review not found, or it was already deleted.');
    await client.query(`UPDATE review_reports SET status = 'resolved' WHERE review_ref = $1`, [req.params.ref]);
    await logActivity(client, r.rated_by, r.transaction_id, 'review_deleted', 'by @' + me.username + ': ' + note);
  });
  res.json({ ok: true });
}));

// Close a report without deleting the review
app.post('/api/admin/reports/:id/dismiss', auth, adminOnly, route(async (req, res) => {
  requireNumeric(req.params.id, 'Invalid report.');
  const r = await pool.query(
    `UPDATE review_reports SET status = 'dismissed' WHERE report_id = $1 AND status = 'open' RETURNING report_id`,
    [req.params.id]
  );
  if (!r.rows[0]) throw new HttpError(404, 'Report not found, or it was already closed.');
  res.json({ ok: true });
}));

// ---------- Admin: disputes ----------

// All disputes: the ones waiting for a decision first, oldest first
app.get('/api/admin/disputes', auth, adminOnly, route(async (req, res) => {
  const result = await pool.query(
    `SELECT d.dispute_id, d.dispute_status, d.opened_at, d.replied_at, (d.reply IS NOT NULL) AS has_reply,
            t.transaction_id, t.item_description, t.amount, t.status AS trade_status,
            b.username AS buyer_username, s.username AS seller_username, f.username AS filed_by_username
     FROM disputes d
     JOIN transactions t ON t.transaction_id = d.transaction_id
     ${JOIN_BUYER_SELLER}
     JOIN users f ON f.user_id = d.filed_by
     ORDER BY (d.dispute_status = 'resolved'), d.opened_at ASC
     LIMIT 200`
  );
  res.json(result.rows.map(d => ({ ...d, amount: Number(d.amount) })));
}));

// One dispute with everything the admin needs to investigate:
// both sides, their reputation, the evidence, the trade chat, and what each person did
app.get('/api/admin/disputes/:id', auth, adminOnly, route(async (req, res) => {
  requireNumeric(req.params.id, 'Invalid dispute.');
  const found = await pool.query(
    `SELECT d.*, f.username AS filed_by_username,
            t.item_description, t.amount, t.status AS trade_status, t.payout_method, t.payout_number,
            t.buyer_id, t.seller_id, t.created_at AS trade_created_at, t.delivered_at,
            b.username AS buyer_username, s.username AS seller_username
     FROM disputes d
     JOIN users f ON f.user_id = d.filed_by
     JOIN transactions t ON t.transaction_id = d.transaction_id
     ${JOIN_BUYER_SELLER}
     WHERE d.dispute_id = $1`,
    [req.params.id]
  );
  const d = found.rows[0];
  if (!d) throw new HttpError(404, 'Dispute not found.');

  const evidence = await pool.query(
    `SELECT e.evidence_id, e.description AS name, u.username AS submitted_by_username
     FROM evidence e JOIN users u ON u.user_id = e.submitted_by
     WHERE e.dispute_id = $1
     ORDER BY e.uploaded_at, e.evidence_id`,
    [d.dispute_id]
  );
  const messages = await getTradeChat(d.transaction_id);
  const activity = await getTradeActivity(d.transaction_id);
  const payment = await getAdminPayment(d.transaction_id);

  // How trustworthy each person looks: finished trades, rating, past disputes, and cancellations after payment
  const reputation = await pool.query(
    `SELECT u.user_id, u.username, u.avatar_file, u.created_at, u.account_status,
            ${verifiedSql('u')} AS verified,
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
    const u = reputation.rows.find(x => sameId(x.user_id, id));
    if (!u) return null;
    return {
      username: u.username,
      avatar_file: u.avatar_file,
      verified: u.verified,
      joined: u.created_at,
      account_status: u.account_status,
      completed_trades: Number(u.completed_trades),
      rating: numberOrNull(u.rating),
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
    payment,
    evidence: evidence.rows,
    messages,
    activity,
  });
}));

// The admin's decision: pay the seller or refund the buyer. It cannot be changed afterwards.
app.post('/api/admin/disputes/:id/resolve', auth, adminOnly, route(async (req, res) => {
  const decision = req.body.decision;
  const note = String(req.body.note || '').trim();
  requireNumeric(req.params.id, 'Invalid dispute.');
  if (!['release', 'refund'].includes(decision)) throw new HttpError(400, 'Choose a decision.');
  requireNote(note, 1000, 'Write a short note that explains your decision.');

  await withTx(async client => {
    const d = await queryOne(client, 'SELECT * FROM disputes WHERE dispute_id = $1 FOR UPDATE', [req.params.id]);
    if (!d) throw new HttpError(404, 'Dispute not found.');
    if (d.dispute_status === 'resolved') throw new HttpError(409, 'This dispute was already decided.');

    const t = await queryOne(client, 'SELECT * FROM transactions WHERE transaction_id = $1 FOR UPDATE', [d.transaction_id]);
    if (!t || t.status !== 'disputed') throw new HttpError(409, 'This trade is not in dispute anymore.');

    await assertPaymentHeld(client, t.transaction_id, 'There is no payment held for this trade.');

    if (decision === 'release') {
      if (!t.payout_method) {
        throw new HttpError(409, 'The seller never said where to receive the money, because the item was not marked as delivered. You can refund the buyer instead.');
      }
      await releasePayment(client, t.transaction_id);
    } else {
      await markPaymentRefunded(client, t.transaction_id);
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
}));

// ---------- Admin: trades ----------

// needs_admin = the payment is held and one of the two people is suspended or banned
const NEEDS_ADMIN_SQL = `(t.status::text IN ('paid', 'delivered')
              AND (b.account_status::text <> 'active' OR s.account_status::text <> 'active'))`;

// Every trade, newest first. Filters: ?status=process|needs_admin|all|<one status>, ?search=
app.get('/api/admin/transactions', auth, adminOnly, route(async (req, res) => {
  const status = String(req.query.status || 'process');
  const search = cleanSearch(req.query.search);
  const params = [];
  const clauses = [];

  if (status === 'process') {
    params.push(PROCESS_STATUSES);
    clauses.push(`t.status::text = ANY($${params.length})`);
  } else if (status === 'needs_admin') {
    clauses.push(NEEDS_ADMIN_SQL);
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

  const result = await pool.query(
    `SELECT t.transaction_id, t.item_description, t.amount, t.status, t.created_at,
            b.username AS buyer_username, s.username AS seller_username,
            EXISTS (SELECT 1 FROM disputes d WHERE d.transaction_id = t.transaction_id) AS had_dispute,
            ${NEEDS_ADMIN_SQL} AS needs_admin,
            COUNT(*) OVER() AS total_count
     FROM transactions t
     ${JOIN_BUYER_SELLER}
     ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''}
     ORDER BY t.created_at DESC, t.transaction_id DESC
     LIMIT ${ADMIN_PAGE_SIZE} OFFSET ${pageOffset(req.query.page)}`,
    params
  );
  res.json(pageResult(result.rows, t => ({ ...t, amount: Number(t.amount) })));
}));

// One trade: status, payment, chat, dispute, and what each person did
app.get('/api/admin/transactions/:id', auth, adminOnly, route(async (req, res) => {
  requireNumeric(req.params.id, 'Invalid trade.');
  const found = await pool.query(
    `SELECT t.*, b.username AS buyer_username, s.username AS seller_username,
            b.account_status::text AS buyer_status, s.account_status::text AS seller_status
     FROM transactions t
     ${JOIN_BUYER_SELLER}
     WHERE t.transaction_id = $1`,
    [req.params.id]
  );
  const t = found.rows[0];
  if (!t) throw new HttpError(404, 'Trade not found.');

  const payment = await getAdminPayment(t.transaction_id);
  const receipt = await queryOne(
    pool,
    'SELECT receipt_number FROM receipts WHERE transaction_id = $1',
    [t.transaction_id]
  );
  const dispute = await queryOne(
    pool,
    'SELECT dispute_id, dispute_status FROM disputes WHERE transaction_id = $1',
    [t.transaction_id]
  );
  const messages = await getTradeChat(t.transaction_id);
  const activity = await getTradeActivity(t.transaction_id);

  const held = PAID_STATUSES.includes(t.status);
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
    can_refund: held && !!payment && payment.status === 'held' && !dispute,
    cancel_reason: t.cancel_reason,
    payment,
    payout_method: t.payout_method,
    payout_masked: maskNumber(t.payout_number),
    receipt_number: receipt ? receipt.receipt_number : null,
    dispute: dispute || null,
    messages,
    activity,
  });
}));

// Refund the buyer in full without a dispute, for a trade whose payment is held
// (for example when the seller was banned). A note is needed, and both people can see it.
app.post('/api/admin/transactions/:id/refund', auth, adminOnly, route(async (req, res) => {
  const note = String(req.body.note || '').trim();
  requireNumeric(req.params.id, 'Invalid trade.');
  requireNote(note, 300, 'Write a short note that explains why.');

  await withTx(async client => {
    const t = await queryOne(client, 'SELECT * FROM transactions WHERE transaction_id = $1 FOR UPDATE', [req.params.id]);
    if (!t) throw new HttpError(404, 'Trade not found.');
    if (t.status === 'disputed') {
      throw new HttpError(409, 'This trade is in dispute. Decide it from the dispute review.');
    }
    if (!PAID_STATUSES.includes(t.status)) {
      throw new HttpError(409, 'Only a trade whose payment is held can be refunded.');
    }
    await assertPaymentHeld(client, t.transaction_id, 'There is no held payment for this trade.');

    await markPaymentRefunded(client, t.transaction_id);
    await client.query(`UPDATE transactions SET status = 'refunded', cancel_reason = $1 WHERE transaction_id = $2`, [note, t.transaction_id]);
    await logActivity(client, req.user.user_id, t.transaction_id, 'admin_refund', note);
  });
  res.json({ ok: true });
}));

// ---------- Admin: users ----------

// All users. Filters: ?search= (username, name, email), ?status=all|online|active|suspended|banned
app.get('/api/admin/users', auth, adminOnly, route(async (req, res) => {
  const search = cleanSearch(req.query.search);
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

  const result = await pool.query(
    `SELECT u.user_id, u.username, u.avatar_file, u.full_name, u.email, u.role, u.account_status, u.created_at, u.last_seen,
            ${ONLINE_SQL} AS online,
            ${verifiedSql('u')} AS verified,
            (SELECT COUNT(*) FROM transactions t
              WHERE t.status = 'completed' AND (t.buyer_id = u.user_id OR t.seller_id = u.user_id)) AS completed_trades,
            (SELECT COUNT(*) FROM transactions t
              WHERE t.status::text = ANY($${params.length + 1}) AND (t.buyer_id = u.user_id OR t.seller_id = u.user_id)) AS active_trades,
            (SELECT ROUND(AVG(r.score)::numeric, 1) FROM ratings r WHERE r.rated_user_id = u.user_id AND r.deleted_at IS NULL) AS rating,
            COUNT(*) OVER() AS total_count
     FROM users u
     ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''}
     ORDER BY u.created_at DESC, u.user_id DESC
     LIMIT ${ADMIN_PAGE_SIZE} OFFSET ${pageOffset(req.query.page)}`,
    [...params, PROCESS_STATUSES]
  );
  res.json(pageResult(result.rows, u => ({
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
    rating: numberOrNull(u.rating),
  })));
}));

// The lists in the admin's user window, 20 at a time ($1 is the user)
const USER_LIST_SIZE = 20;
const USER_LISTS = {
  trades: {
    sql: `SELECT t.transaction_id, t.item_description, t.amount, t.status, t.created_at,
            CASE WHEN t.buyer_id = $1 THEN 'buyer' ELSE 'seller' END AS role,
            CASE WHEN t.buyer_id = $1 THEN s.username ELSE b.username END AS partner_username
     FROM transactions t
     ${JOIN_BUYER_SELLER}
     WHERE t.buyer_id = $1 OR t.seller_id = $1
     ORDER BY t.created_at DESC, t.transaction_id DESC`,
    toRow: t => ({ ...t, amount: Number(t.amount) }),
  },
  reviews: {
    sql: `SELECT r.review_ref, r.score, r.feedback, r.rated_at, r.transaction_id, au.username AS author_username
     FROM ratings r JOIN users au ON au.user_id = r.rated_by
     WHERE r.rated_user_id = $1 AND r.deleted_at IS NULL
     ORDER BY r.rated_at DESC, r.review_ref DESC`,
  },
  activity: {
    sql: `SELECT action, detail, created_at, transaction_id
     FROM activity_log
     WHERE user_id = $1
     ORDER BY created_at DESC, log_id DESC`,
  },
};

// One more row than needed is read, to know whether there are more
async function userListPage(kind, userId, offset) {
  const { sql, toRow = row => row } = USER_LISTS[kind];
  const rows = await queryAll(pool, `${sql} LIMIT ${USER_LIST_SIZE + 1} OFFSET ${offset}`, [userId]);
  return { rows: rows.slice(0, USER_LIST_SIZE).map(toRow), has_more: rows.length > USER_LIST_SIZE };
}

// "Show more" in the user window: ?offset= is how many rows are already showing
app.get('/api/admin/users/:id/list/:kind', auth, adminOnly, route(async (req, res) => {
  requireNumeric(req.params.id, 'Invalid user.');
  if (!Object.hasOwn(USER_LISTS, req.params.kind)) throw new HttpError(404, 'List not found.');
  const offset = Math.min(Math.max(parseInt(req.query.offset, 10) || 0, 0), ADMIN_PAGE_SIZE * ADMIN_MAX_PAGE);
  res.json(await userListPage(req.params.kind, req.params.id, offset));
}));

// One user: details, their trades, the reviews about them (the admin sees who wrote them), and what they did
app.get('/api/admin/users/:id', auth, adminOnly, route(async (req, res) => {
  requireNumeric(req.params.id, 'Invalid user.');
  const found = await pool.query(
    `SELECT user_id, username, avatar_file, full_name, email, role, account_status, created_at, last_seen, verified_at,
            ${verifiedSql()} AS verified, ${ONLINE_SQL} AS online
     FROM users WHERE user_id = $1`,
    [req.params.id]
  );
  const u = found.rows[0];
  if (!u) throw new HttpError(404, 'User not found.');

  const stats = await queryOne(
    pool,
    `SELECT
       (SELECT COUNT(*) FROM transactions
         WHERE status = 'completed' AND (buyer_id = $1 OR seller_id = $1)) AS completed_trades,
       (SELECT COUNT(*) FROM transactions
         WHERE status::text = ANY($2) AND (buyer_id = $1 OR seller_id = $1)) AS active_trades,
       (SELECT COUNT(*) FROM disputes d JOIN transactions t ON t.transaction_id = d.transaction_id
         WHERE t.buyer_id = $1 OR t.seller_id = $1) AS disputes,
       (SELECT COUNT(*) FROM transactions
         WHERE seller_id = $1 AND status = 'refunded' AND cancelled_by = $1) AS cancels_after_payment,
       ${AVG_RATING_SQL} AS rating,
       ${RATING_COUNT_SQL} AS rating_count`,
    [u.user_id, PROCESS_STATUSES]
  );

  const trades = await userListPage('trades', u.user_id, 0);
  const reviews = await userListPage('reviews', u.user_id, 0);
  const activity = await userListPage('activity', u.user_id, 0);

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
    rating: numberOrNull(stats.rating),
    rating_count: Number(stats.rating_count),
    is_me: sameId(u.user_id, req.user.user_id),
    can_control: u.role !== 'admin' && !sameId(u.user_id, req.user.user_id),
    trades: trades.rows,
    trades_more: trades.has_more,
    reviews: reviews.rows,
    reviews_more: reviews.has_more,
    activity: activity.rows,
    activity_more: activity.has_more,
  });
}));

// Suspend, ban, or reactivate a user. A banned user is signed out on their next click.
// A suspended user can still sign in, but can only use Support.
app.post('/api/admin/users/:id/status', auth, adminOnly, route(async (req, res) => {
  const status = req.body.status;
  const note = String(req.body.note || '').trim();
  requireNumeric(req.params.id, 'Invalid user.');
  if (!['active', 'suspended', 'banned'].includes(status)) throw new HttpError(400, 'Choose a status.');
  if (status !== 'active' && note.length < 5) throw new HttpError(400, 'Write a short note that explains why.');
  if (note.length > 500) throw new HttpError(400, 'Please keep the note under 500 characters.');

  const target = await queryOne(pool, 'SELECT user_id, role FROM users WHERE user_id = $1', [req.params.id]);
  if (!target) throw new HttpError(404, 'User not found.');
  if (target.role === 'admin') throw new HttpError(400, 'You cannot change an admin account.');

  const me = await findUsername(req.user.user_id);
  await pool.query('UPDATE users SET account_status = $1 WHERE user_id = $2', [status, target.user_id]);
  await logActivity(pool, target.user_id, null, 'account_' + status, 'by @' + me.username + (note ? ': ' + note : ''));
  res.json({ ok: true, account_status: status });
}));

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
       ${JOIN_BUYER_SELLER}
       WHERE t.status = 'delivered' AND t.delivered_at < now() - interval '2 hours'
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

// Anything no route handled (for example broken JSON) still gets a JSON answer
app.use((err, req, res, next) => {
  if (err.status && err.status < 500) return res.status(err.status).json({ message: 'That request could not be read.' });
  sendError(res, err);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SecureTrade API running on http://localhost:${PORT}`));