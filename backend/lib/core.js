require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const crypto = require('crypto');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const path = require('path');
const ROOT = path.join(__dirname, '..');


const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Supabase's certificate proves we are talking to the real database
  ssl: { ca: fs.readFileSync(path.join(ROOT, 'supabase-ca.crt'), 'utf8'), rejectUnauthorized: true },
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

// What is being sold. A game account can be taken back by the seller later, so it is protected for longer.
const ITEM_TYPES = ['account', 'item', 'currency'];

const ACCOUNT_HOLD_HOURS = 168;   // 7 days

const AUTO_RELEASE_HOURS = 24;

const holdHours = itemType => (itemType === 'account' ? ACCOUNT_HOLD_HOURS : AUTO_RELEASE_HOURS);

// Limits on trades, chat, and dispute evidence
const MAX_TRADE_AMOUNT = 100000;

const MAX_ITEM_LENGTH = 1000;

const MAX_PENDING_SENT = 10;

const CHAT_PER_MINUTE = 20;

const CHAT_MAX_SHOWN = 300;

const MAX_EVIDENCE_PER_PERSON = 10;

const FINISHED_STATUSES = ['completed', 'refunded', 'cancelled'];

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
const isDbId = value => /^\d{1,18}$/.test(value);   // longer numbers do not fit in the database

function requireNumeric(value, message) {
  if (!isDbId(value)) throw new HttpError(400, message);
}


// Neither person in this trade may be suspended or banned
async function assertBothActive(db, trade) {
  const inactive = await queryOne(
    db,
    `SELECT COUNT(*) AS n FROM users WHERE user_id = ANY($1::bigint[]) AND account_status::text <> 'active'`,
    [[trade.buyer_id, trade.seller_id]]
  );
  if (Number(inactive.n) > 0) {
    throw new HttpError(409, 'One of the accounts in this trade is not active, so this step is paused. An admin will decide this trade.');
  }
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


const PORT = process.env.PORT || 3000;
module.exports = { pool, ONLINE_SQL, verifiedSql, JOIN_BUYER_SELLER, AVG_RATING_SQL, RATING_COUNT_SQL, PROCESS_STATUSES, ALL_TRADE_STATUSES, PAID_STATUSES, IDLE_MINUTES, REQUEST_EXPIRE_HOURS, ITEM_TYPES, ACCOUNT_HOLD_HOURS, AUTO_RELEASE_HOURS, holdHours, MAX_TRADE_AMOUNT, MAX_ITEM_LENGTH, MAX_PENDING_SENT, CHAT_PER_MINUTE, CHAT_MAX_SHOWN, MAX_EVIDENCE_PER_PERSON, FINISHED_STATUSES, ID_TYPES, VERIFY_CODE_HOURS, MAX_FAVORITES, SUPPORT_MAX, SUPPORT_PER_MINUTE, HttpError, sendError, route, queryOne, queryAll, isDbId, requireNumeric, assertBothActive, requireNote, numberOrNull, sameId, isParty, cleanEmail, cleanHandle, cleanSearch, ADMIN_PAGE_SIZE, ADMIN_MAX_PAGE, pageOffset, pageResult, findUsername, withTx, maskNumber, NAME_PART_RE, cleanName, splitFullName, isAdmin, assertVerified, recordTradeAttempt, logActivity, signToken, startSession, EMAIL_RE, USERNAME_RE, USERNAME_COOLDOWN_DAYS, PORT };
