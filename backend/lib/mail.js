const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { HttpError, pool, queryOne } = require('./core');


// ---------- Email PINs (signup, password reset, and changing the email) ----------
const PIN_MINUTES = 10;       // a PIN works for 10 minutes

const MAX_PIN_TRIES = 5;      // wrong tries before the PIN is cancelled

const RESEND_SECONDS = 60;    // wait before asking for another PIN


function mailConfigured() {
  return process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_KEY && process.env.MAIL_FROM;
}


// Email must work before other people use the site: sign-up PINs and trade updates depend on it
if (!mailConfigured()) {
  if (process.env.NODE_ENV === 'production' && process.env.DEV_LOG_PIN === 'true') {
    throw new Error('DEV_LOG_PIN must be off in production: PINs would only appear in the server log. Set up SMTP_* instead.');
  }
  console.warn('Email is OFF: set SMTP_HOST, SMTP_USER, SMTP_KEY and MAIL_FROM in .env.'
    + (process.env.DEV_LOG_PIN === 'true' ? ' For now, PINs and updates are only printed here (DEV_LOG_PIN).' : ' Nobody can sign up until it is set.'));
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
  // The try is counted in the database first, so guesses sent at the same moment all count
  const claimed = await queryOne(
    pool,
    'UPDATE email_pins SET attempts = attempts + 1 WHERE pin_id = $1 AND attempts < $2 RETURNING attempts',
    [row.pin_id, MAX_PIN_TRIES]
  );
  if (!claimed) return tooManyTries();
  if (!(await bcrypt.compare(String(pin), row.pin_hash))) {
    if (claimed.attempts >= MAX_PIN_TRIES) return tooManyTries();
    throw new HttpError(400, 'Wrong PIN. ' + (MAX_PIN_TRIES - claimed.attempts) + ' tries left.');
  }
  return row;
}


// Tell someone about a change to their account. A problem here never stops the change itself.
async function sendSecurityNotice(to, subject, text) {
  try {
    if (!mailConfigured()) {
      if (process.env.DEV_LOG_PIN === 'true') console.log('[DEV] security notice for ' + to + ': ' + subject);
      return;
    }
    await getTransporter().sendMail({ from: `"SecureTrade" <${process.env.MAIL_FROM}>`, to, subject, text });
  } catch (err) {
    console.error('Security notice failed:', err.message);
  }
}


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
module.exports = { PIN_MINUTES, MAX_PIN_TRIES, RESEND_SECONDS, mailConfigured, transporter, getTransporter, PIN_COPY, sendPinEmail, newSixDigitCode, assertCanResend, deletePins, deletePin, deleteEmailChange, issuePin, checkPin, sendSecurityNotice, issueEmailChangePin };
