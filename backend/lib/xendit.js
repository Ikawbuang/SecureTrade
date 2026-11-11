const crypto = require('crypto');
const { HttpError, MAX_ITEM_LENGTH, assertBothActive, logActivity, pool, queryAll, queryOne, withTx } = require('./core');
const { lockTrade, markTradePaid } = require('./escrow');


// ---------- Xendit (online GCash payment) ----------
// It turns on when all three settings are in .env. Without them nobody can pay,
// unless ALLOW_SIMULATED_PAYMENTS=true is set on purpose for local testing.
const XENDIT_KEY = process.env.XENDIT_SECRET_KEY || '';

const XENDIT_WEBHOOK_TOKEN = process.env.XENDIT_WEBHOOK_TOKEN || '';

const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');

const checkoutEnabled = !!(XENDIT_KEY && XENDIT_WEBHOOK_TOKEN && PUBLIC_URL);

const simulatedPayments = !checkoutEnabled && process.env.ALLOW_SIMULATED_PAYMENTS === 'true';

const CHECKOUT_FAILED = 'The payment service is not available right now. Please try again.';

// Test keys can simulate a payment, so a QR code can be demonstrated without paying from a phone
const xenditTestMode = checkoutEnabled && XENDIT_KEY.startsWith('xnd_development_');

// QR Ph: one QR code that GCash, Maya, and bank apps can scan (Xendit's Payment Request API)
const PAYMENT_REQUEST_HEADERS = { 'api-version': '2024-11-11' };
const QR_MINUTES = 15;            // a QR code is shown for 15 minutes, then a new one is made
const QR_MAX_AMOUNT = 50000;      // QR Ph does not accept more than this


if (XENDIT_KEY && !XENDIT_KEY.startsWith('xnd_development_') && process.env.XENDIT_ALLOW_LIVE !== 'true') {
  throw new Error('XENDIT_SECRET_KEY must be a test key (xnd_development_...). Real money is turned off.');
}

if (!checkoutEnabled && !simulatedPayments) {
  console.warn('Payments are OFF: set XENDIT_SECRET_KEY, XENDIT_WEBHOOK_TOKEN and PUBLIC_URL in .env.');
}


async function xenditRequest(method, apiPath, body, { headers = {}, failMessage = CHECKOUT_FAILED } = {}) {
  let res;
  try {
    res = await fetch('https://api.xendit.co' + apiPath, {
      method,
      headers: {
        Authorization: 'Basic ' + Buffer.from(XENDIT_KEY + ':').toString('base64'),
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    console.error('Xendit could not be reached:', err.message);
    throw new HttpError(502, CHECKOUT_FAILED);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('Xendit error:', res.status, data.error_code, data.message);
    throw new HttpError(502, failMessage);
  }
  return data;
}


const xenditPost = (apiPath, body) => xenditRequest('POST', apiPath, body);


const OPEN_CHECKOUT_SQL = `SELECT payment_link_url FROM xendit_sessions
       WHERE transaction_id = $1 AND kind = 'session' AND status = 'ACTIVE' AND expires_at > now()`;

const OPEN_QR_SQL = `SELECT session_id, qr_string, expires_at FROM xendit_sessions
       WHERE transaction_id = $1 AND kind = 'qr' AND status = 'ACTIVE' AND expires_at > now()`;

// Close one checkout page or QR code at Xendit, so it can no longer be paid.
// If that fails, it may already be paid, so its status is checked instead.
async function closeAtXendit(row) {
  try {
    if (row.kind === 'qr') {
      await xenditRequest('POST', '/v3/payment_requests/' + row.session_id + '/cancel', {}, { headers: PAYMENT_REQUEST_HEADERS });
    } else {
      await xenditPost('/sessions/' + row.session_id + '/cancel', {});
    }
    await pool.query(`UPDATE xendit_sessions SET status = 'CANCELED' WHERE session_id = $1 AND status = 'ACTIVE'`, [row.session_id]);
  } catch (err) {
    console.error('Could not close', row.session_id, err.message);
    await syncSessionSafely(row.session_id);
  }
}

// Only one way to pay may be open at a time, so the buyer can never pay twice
async function closeOpenPayments(tradeId, { keepOpenQr = false, keepOpenSession = false } = {}) {
  const rows = await queryAll(
    pool,
    `SELECT session_id, kind, expires_at > now() AS open FROM xendit_sessions WHERE transaction_id = $1 AND status = 'ACTIVE'`,
    [tradeId]
  );
  for (const row of rows) {
    if (row.open && ((row.kind === 'qr' && keepOpenQr) || (row.kind === 'session' && keepOpenSession))) continue;
    await closeAtXendit(row);
  }
}


// Give the buyer a Xendit checkout page. A page that is still open is reused, so a trade is never charged twice.
// No database lock is held while waiting for Xendit, so a slow answer cannot freeze the site.
async function startCheckout(tradeId, buyerId, fromThisComputer) {
  await closeOpenPayments(tradeId, { keepOpenSession: true });
  const first = await withTx(async client => {
    const t = await lockTrade(client, tradeId, buyerId, { role: 'buyer', status: 'accepted' });
    await assertBothActive(client, t);
    const open = await queryOne(client, OPEN_CHECKOUT_SQL, [t.transaction_id]);
    if (open) return { url: open.payment_link_url };
    await client.query(`UPDATE xendit_sessions SET status = 'EXPIRED' WHERE transaction_id = $1 AND kind = 'session' AND status = 'ACTIVE'`, [t.transaction_id]);
    return { trade: t };
  });
  if (first.url) return first.url;

  const t = first.trade;
  const returnUrl = PUBLIC_URL + '/api/xendit/return?id=' + t.transaction_id + (fromThisComputer ? '&to=local' : '');
  const session = await xenditPost('/sessions', {
    reference_id: 'trade-' + t.transaction_id + '-' + Date.now(),
    session_type: 'PAY',
    mode: 'PAYMENT_LINK',
    amount: Number(t.amount),
    currency: 'PHP',
    country: 'PH',
    allowed_payment_channels: ['GCASH'],
    description: String(t.item_description).slice(0, MAX_ITEM_LENGTH),
    success_return_url: returnUrl,
    cancel_return_url: returnUrl,
  });

  // While waiting, the trade may have been cancelled, or a second click may have made another page
  let unused = false;
  try {
    return await withTx(async client => {
      const now = await lockTrade(client, tradeId, buyerId, { role: 'buyer', status: 'accepted' });
      const open = await queryOne(client, OPEN_CHECKOUT_SQL, [now.transaction_id]);
      if (open) {
        unused = true;
        return open.payment_link_url;
      }
      await client.query(
        `INSERT INTO xendit_sessions (session_id, transaction_id, payment_link_url, amount, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [session.payment_session_id, now.transaction_id, session.payment_link_url, now.amount, session.expires_at]
      );
      return session.payment_link_url;
    });
  } catch (err) {
    unused = true;
    throw err;
  } finally {
    if (unused) {
      await xenditPost('/sessions/' + session.payment_session_id + '/cancel', {}).catch(cancelErr => {
        console.error('Could not close checkout', session.payment_session_id, cancelErr.message);
      });
    }
  }
}


// Give the buyer a QR Ph code to scan. A QR code that is still open is reused.
// The amount is fixed in the code, and the code is tied to this trade only.
async function startQrPayment(tradeId, buyerId) {
  await closeOpenPayments(tradeId, { keepOpenQr: true });
  const first = await withTx(async client => {
    const t = await lockTrade(client, tradeId, buyerId, { role: 'buyer', status: 'accepted' });
    await assertBothActive(client, t);
    if (Number(t.amount) > QR_MAX_AMOUNT) {
      throw new HttpError(409, 'QR Ph payments can be up to ₱' + QR_MAX_AMOUNT.toLocaleString('en-PH') + '. Use the GCash checkout page instead.');
    }
    const open = await queryOne(client, OPEN_QR_SQL, [t.transaction_id]);
    return open ? { open } : { trade: t };
  });
  if (first.open) return first.open;

  const t = first.trade;
  const request = await xenditRequest('POST', '/v3/payment_requests', {
    reference_id: 'trade-' + t.transaction_id + '-qr-' + Date.now(),
    type: 'PAY',
    country: 'PH',
    currency: 'PHP',
    request_amount: Number(t.amount),
    capture_method: 'AUTOMATIC',
    channel_code: 'QRPH',
    description: String(t.item_description).slice(0, 255),
  }, { headers: PAYMENT_REQUEST_HEADERS });
  const action = (request.actions || []).find(a => a.descriptor === 'QR_STRING');
  const row = { session_id: request.payment_request_id, kind: 'qr' };
  if (!action) {
    await closeAtXendit(row);
    throw new HttpError(502, CHECKOUT_FAILED);
  }

  // While waiting, the trade may have been cancelled, or a second click may have made another QR code
  let unused = false;
  try {
    return await withTx(async client => {
      const now = await lockTrade(client, tradeId, buyerId, { role: 'buyer', status: 'accepted' });
      const open = await queryOne(client, OPEN_QR_SQL, [now.transaction_id]);
      if (open) {
        unused = true;
        return open;
      }
      const saved = await queryOne(
        client,
        `INSERT INTO xendit_sessions (session_id, transaction_id, kind, qr_string, amount, expires_at)
         VALUES ($1, $2, 'qr', $3, $4, now() + interval '${QR_MINUTES} minutes')
         RETURNING session_id, qr_string, expires_at`,
        [request.payment_request_id, now.transaction_id, action.value, now.amount]
      );
      return saved;
    });
  } catch (err) {
    unused = true;
    throw err;
  } finally {
    if (unused) await closeAtXendit(row);
  }
}

// Test mode only: pretend the buyer scanned and paid the QR code
async function simulateQrPayment(tradeId) {
  if (!xenditTestMode) throw new HttpError(403, 'Simulated payments only work with a Xendit test key.');
  const open = await queryOne(pool, OPEN_QR_SQL, [tradeId]);
  if (!open) throw new HttpError(409, 'Show the QR code first.');
  const row = await queryOne(pool, 'SELECT amount FROM xendit_sessions WHERE session_id = $1', [open.session_id]);
  await xenditRequest('POST', '/v3/payment_requests/' + open.session_id + '/simulate', { amount: Number(row.amount) }, { headers: PAYMENT_REQUEST_HEADERS });
}

// The trade was cancelled, so close any checkout page or QR code that is still open
async function cancelOpenCheckouts(tradeId) {
  if (!checkoutEnabled) return;
  await closeOpenPayments(tradeId);
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


// Save how a checkout page ended. Both the webhook and the status check come through here.
function applySessionResult(sessionId, result, data) {
  return withTx(async client => {
    const session = await queryOne(client, 'SELECT * FROM xendit_sessions WHERE session_id = $1 FOR UPDATE', [sessionId]);
    if (!session || session.status === 'COMPLETED') return;
    if (result === 'COMPLETED') await completeCheckout(client, session, data);
    else await client.query('UPDATE xendit_sessions SET status = $1 WHERE session_id = $2', [result, session.session_id]);
  });
}


// Ask Xendit how a checkout page ended, in case its webhook did not reach us (for example ngrok was off)
async function syncSession(sessionId) {
  if (sessionId.startsWith('pr-')) {
    const request = await xenditRequest('GET', '/v3/payment_requests/' + sessionId, null, { headers: PAYMENT_REQUEST_HEADERS });
    const result = { SUCCEEDED: 'COMPLETED', CANCELED: 'CANCELED', EXPIRED: 'EXPIRED', FAILED: 'EXPIRED' }[request.status];
    if (result) {
      await applySessionResult(sessionId, result, {
        amount: request.request_amount,
        payment_id: request.latest_payment_id || request.payment_request_id,
      });
    }
    return;
  }
  const session = await xenditRequest('GET', '/sessions/' + sessionId);
  if (['COMPLETED', 'EXPIRED', 'CANCELED'].includes(session.status)) {
    await applySessionResult(sessionId, session.status, session);
  }
}


// A problem here is only logged: the next check, or the webhook, tries again
async function syncSessionSafely(sessionId) {
  try {
    await syncSession(sessionId);
  } catch (err) {
    console.error('Could not check checkout', sessionId, err.message);
  }
}


async function syncTradeCheckouts(tradeId) {
  if (!checkoutEnabled) return;
  const open = await queryAll(pool, `SELECT session_id FROM xendit_sessions WHERE transaction_id = $1 AND status = 'ACTIVE'`, [tradeId]);
  for (const { session_id: sessionId } of open) await syncSessionSafely(sessionId);
}
module.exports = { xenditTestMode, QR_MAX_AMOUNT, startQrPayment, simulateQrPayment, XENDIT_KEY, XENDIT_WEBHOOK_TOKEN, PUBLIC_URL, checkoutEnabled, simulatedPayments, CHECKOUT_FAILED, xenditRequest, xenditPost, OPEN_CHECKOUT_SQL, startCheckout, cancelOpenCheckouts, isValidWebhookToken, completeCheckout, applySessionResult, syncSession, syncSessionSafely, syncTradeCheckouts };
