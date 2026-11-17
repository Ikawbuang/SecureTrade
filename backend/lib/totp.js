const crypto = require('crypto');
const { HttpError, logActivity, pool, queryOne, sendError } = require('./core');
const { assertLoginAllowed, clearLoginFailures, recordLoginFailure } = require('./auth');


// ---------- Two-step sign-in for admins (authenticator app codes) ----------
// The standard 6-digit codes (TOTP, RFC 6238): a new code every 30 seconds, made from a secret
// that only the server and the admin's authenticator app know. No extra package is needed.
//
// Needs migration 007. Until it is run, two-step sign-in is simply off (see getTwoFactor).

const STEP_SECONDS = 30;
const DIGITS = 6;
const ISSUER = 'SecureTrade';
const RECOVERY_CODES = 8;

// ----- Base32 (the letters authenticator apps use for the secret) -----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of String(text).toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}


const newSecret = () => base32Encode(crypto.randomBytes(20));

const currentStep = (now = Date.now()) => Math.floor(now / 1000 / STEP_SECONDS);

// The code for one 30-second step
function codeAt(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  const number = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(number).padStart(DIGITS, '0');
}

// Which step a typed code belongs to: now, or one step either side (clocks differ a little).
// A step at or before `lastStep` was already used, so the same code never works twice.
function matchStep(secret, code, lastStep, now = Date.now()) {
  const typed = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(typed)) return null;
  const at = currentStep(now);
  for (const step of [at, at - 1, at + 1]) {
    const expected = codeAt(secret, step);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(typed))) {
      return lastStep !== null && lastStep !== undefined && step <= Number(lastStep) ? 'used' : step;
    }
  }
  return null;
}

// What the QR code holds: the authenticator app reads the secret from it
function otpauthUrl(accountName, secret) {
  const label = encodeURIComponent(ISSUER + ':' + accountName);
  return 'otpauth://totp/' + label + '?secret=' + secret + '&issuer=' + encodeURIComponent(ISSUER)
    + '&algorithm=SHA1&digits=' + DIGITS + '&period=' + STEP_SECONDS;
}


// ----- The secret is saved encrypted (AES-256-GCM), so a copy of the database alone cannot make codes -----
// The key is made from JWT_SECRET. If JWT_SECRET changes, saved secrets can no longer be read:
// each admin then runs scripts/reset-admin-2fa.js and sets it up again.
const encKey = () => crypto.hkdfSync('sha256', process.env.JWT_SECRET, 'securetrade-totp', 'secret-encryption-v1', 32);

function encryptSecret(secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(encKey()), iv);
  const data = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

function decryptSecret(saved) {
  const [version, iv, tag, data] = String(saved || '').split('.');
  if (version !== 'v1' || !iv || !tag || !data) throw new Error('unreadable');
  const decipher = crypto.createDecipheriv('aes-256-gcm', Buffer.from(encKey()), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}


// ----- Recovery codes: 8 codes that each work once, for a lost phone. Only their hashes are saved. -----
const cleanRecovery = code => String(code || '').toUpperCase().replace(/[^A-Z2-7]/g, '');

const hashRecovery = code => crypto.createHash('sha256').update('securetrade-recovery:' + cleanRecovery(code)).digest('hex');

function newRecoveryCodes() {
  return Array.from({ length: RECOVERY_CODES }, () => {
    const raw = base32Encode(crypto.randomBytes(8)).slice(0, 12);   // 60 random bits
    return raw.slice(0, 4) + '-' + raw.slice(4, 8) + '-' + raw.slice(8, 12);
  });
}

const looksLikeRecovery = code => cleanRecovery(code).length === 12 && !/^\d{6}$/.test(String(code || '').trim());


// ----- Reading and checking -----

// This user's two-step settings. `available` is false until migration 007 is run.
async function getTwoFactor(db, userId) {
  try {
    const u = await queryOne(db, 'SELECT role, totp_secret, totp_pending_secret, totp_enabled_at, totp_last_step FROM users WHERE user_id = $1', [userId]);
    if (!u) return { available: true, enabled: false, required: false };
    return {
      available: true,
      enabled: !!(u.totp_enabled_at && u.totp_secret),
      required: u.role === 'admin',
      secret: u.totp_secret,
      pending: u.totp_pending_secret,
      lastStep: u.totp_last_step,
    };
  } catch (err) {
    if (err.code !== '42703') throw err;   // the columns do not exist yet
    return { available: false, enabled: false, required: false };
  }
}


// Check a typed code (6 digits from the app, or a recovery code) for a user whose two-step sign-in is on.
// Wrong codes are counted like wrong passwords: 5 lock it for 15 minutes.
// `messages.wrong` is what the person reads when the code is wrong.
async function checkSecondFactor(userId, code, { wrongStatus = 403, wrongCode = 'CODE_WRONG' } = {}) {
  const key = 'totp|' + userId;
  await assertLoginAllowed(key);
  const fail = async message => {
    await recordLoginFailure(key);
    const err = new HttpError(wrongStatus, message);
    err.code = wrongCode;
    throw err;
  };

  const two = await getTwoFactor(pool, userId);
  if (!two.enabled) throw new HttpError(409, 'Two-step sign-in is not set up for this account.');

  if (looksLikeRecovery(code)) {
    const used = await queryOne(
      pool,
      'UPDATE recovery_codes SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL RETURNING code_id',
      [userId, hashRecovery(code)]
    );
    if (!used) return fail('That recovery code is wrong or was already used.');
    await logActivity(pool, userId, null, 'twofa_recovery_used', null);
    await clearLoginFailures(key);
    return 'recovery';
  }

  let secret;
  try {
    secret = decryptSecret(two.secret);
  } catch {
    throw new HttpError(500, 'Two-step sign-in must be set up again for this account. Ask the site owner to reset it.');
  }
  const step = matchStep(secret, code, two.lastStep);
  if (step === 'used') return fail('That code was already used. Wait for the next code in your app.');
  if (step === null) return fail('Wrong code. Check the 6-digit code in your authenticator app.');

  // Only one request can claim a step, so two requests with the same code cannot both pass
  const claimed = await queryOne(
    pool,
    'UPDATE users SET totp_last_step = $2 WHERE user_id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2) RETURNING user_id',
    [userId, step]
  );
  if (!claimed) return fail('That code was already used. Wait for the next code in your app.');
  await clearLoginFailures(key);
  return 'code';
}


// Money actions by an admin need a fresh code in the request body ({ code: "123456" }).
// Before migration 007 is run there is nothing to check, so the action goes through as before.
async function requireFreshCode(req, res, next) {
  try {
    const two = await getTwoFactor(pool, req.user.user_id);
    if (!two.available) return next();
    const code = req.body && req.body.code;
    if (!code) {
      return res.status(403).json({ code: 'CODE_REQUIRED', message: 'Enter the 6-digit code from your authenticator app to confirm this.' });
    }
    await checkSecondFactor(req.user.user_id, code);
    next();
  } catch (err) {
    sendError(res, err);
  }
}

module.exports = {
  STEP_SECONDS, RECOVERY_CODES, base32Encode, base32Decode, newSecret, currentStep, codeAt, matchStep, otpauthUrl,
  encryptSecret, decryptSecret, cleanRecovery, hashRecovery, newRecoveryCodes, looksLikeRecovery,
  getTwoFactor, checkSecondFactor, requireFreshCode,
};
