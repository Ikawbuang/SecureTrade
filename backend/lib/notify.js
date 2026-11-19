const { PORT, TEST_MODE, pool, queryAll, rememberError } = require('./core');
const { getTransporter, mailConfigured } = require('./mail');


// ---------- Trade notifications ----------
// Each one is saved for the 🔔 Updates list and emailed. They are sent only after the trade
// change is saved, and a problem here never undoes or blocks the trade step itself.

const SITE = (process.env.PUBLIC_URL || 'http://localhost:' + PORT).replace(/\/$/, '');

// Dates in messages use Philippine time: "Nov 12, 2026, 3:00 PM"
function manilaTime(date) {
  return new Date(date).toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' });
}

const peso = n => '₱' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });


const TEST_LINE = 'TEST MODE: no real money moved. Payments, refunds and payouts on SecureTrade are only practice for now.';

// The subject and text of one trade email
function tradeEmail(tradeId, message) {
  const link = tradeId ? SITE + '/transaction.html?id=' + tradeId : SITE + '/dashboard.html';
  return {
    subject: (TEST_MODE ? '[TEST] ' : '') + 'SecureTrade: ' + (tradeId ? 'update on trade #' + tradeId : 'account update'),
    text: (TEST_MODE ? TEST_LINE + '\n\n' : '') + message
      + '\n\nOpen SecureTrade: ' + link + '\n\nYou get these emails because you have a trade on SecureTrade.',
  };
}

// A failed email is tried once more a minute later. If that fails too, the admin overview shows it
// (with the trade number only: no email address is kept in the error).
const RETRY_MS = 60 * 1000;

const cleanReason = err => String((err && err.message) || err).replace(/\S+@\S+/g, '[email]').slice(0, 80);

async function deliverEmail(mail, tradeId, { send = m => getTransporter().sendMail(m), retryMs = RETRY_MS } = {}) {
  try {
    await send(mail);
  } catch (first) {
    console.error('Notification email failed, trying again in a minute:', cleanReason(first));
    const timer = setTimeout(async () => {
      try {
        await send(mail);
      } catch (err) {
        console.error('Notification email failed again:', cleanReason(err));
        rememberError((tradeId ? 'Trade #' + tradeId + ': ' : '') + 'an update email could not be sent (' + cleanReason(err) + ')');
      }
    }, retryMs);
    if (timer.unref) timer.unref();
  }
}

async function emailUsers(userIds, tradeId, message) {
  const users = await queryAll(pool, 'SELECT email FROM users WHERE user_id = ANY($1::bigint[])', [userIds]);
  for (const { email } of users) {
    if (!mailConfigured()) {
      if (process.env.DEV_LOG_PIN === 'true') console.log('[DEV] update for ' + email + ': ' + message);
      continue;
    }
    await deliverEmail({ from: `"SecureTrade" <${process.env.MAIL_FROM}>`, to: email, ...tradeEmail(tradeId, message) }, tradeId);
  }
}


// Tell these users about something that happened in a trade. Inside withTx, pass the client:
// the message then waits until the change is saved (and is dropped if it is rolled back).
async function notify(db, userIds, tradeId, text) {
  const ids = [...new Set(userIds.filter(Boolean).map(String))];
  if (!ids.length) return;
  const message = (tradeId ? 'Trade #' + tradeId + ': ' : '') + text;
  const run = async () => {
    try {
      for (const id of ids) {
        await pool.query('INSERT INTO notifications (user_id, message) VALUES ($1, $2)', [id, message]);
      }
    } catch (err) {
      console.error('Saving a notification failed:', err.message);
    }
    emailUsers(ids, tradeId, message).catch(err => console.error('Notification email failed:', err.message));
  };
  if (db && db.afterCommit) db.afterCommit.push(run);
  else await run();
}

module.exports = { notify, manilaTime, peso, tradeEmail, deliverEmail, TEST_LINE };
