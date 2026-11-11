const jwt = require('jsonwebtoken');
const { HttpError, IDLE_MINUTES, isAdmin, logActivity, pool, queryOne, sendError } = require('./core');
const { getTransporter, mailConfigured } = require('./mail');


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
module.exports = { LOGIN_LIMIT_MINUTES, MAX_FAILS_PER_ACCOUNT, loginFailures, currentLoginFailure, addLoginFailure, assertLoginAllowed, warnAboutBlockedLogin, sendLoginWarningEmail, SUSPENDED_ALLOWED, suspendedMayUse, auth, adminOnly };
