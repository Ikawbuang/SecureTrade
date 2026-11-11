const { auth } = require('../lib/auth');
const { ACCOUNT_HOLD_HOURS, CHAT_PER_MINUTE, FINISHED_STATUSES, HttpError, PORT, assertBothActive, isDbId, isParty, logActivity, pool, queryOne, requireNumeric, route, sameId, withTx } = require('../lib/core');
const { lockTrade, markTradePaid, readGcashNumber, releasePayment } = require('../lib/escrow');
const QRCode = require('qrcode');
const { PUBLIC_URL, applySessionResult, checkoutEnabled, isValidWebhookToken, simulateQrPayment, simulatedPayments, startCheckout, startQrPayment, syncTradeCheckouts } = require('../lib/xendit');

// The trade, if this user is its buyer
async function findBuyerTrade(id, userId) {
  requireNumeric(id, 'Invalid trade.');
  const t = await queryOne(pool, 'SELECT buyer_id, seller_id, status FROM transactions WHERE transaction_id = $1', [id]);
  if (!t || !isParty(t, userId)) throw new HttpError(404, 'Trade not found.');
  if (!sameId(t.buyer_id, userId)) throw new HttpError(403, 'Only the buyer can do this.');
  return t;
}



// Adds these routes to the app
function register(app) {

  // Xendit reports what happened to a checkout page (it signs in with the webhook token, not a user login)
  app.post('/api/webhooks/xendit', route(async (req, res) => {
    if (!isValidWebhookToken(req.headers['x-callback-token'] || '')) throw new HttpError(401, 'Invalid token.');
    const { event, data } = req.body;
    const finished = event === 'payment_session.completed' || event === 'payment_session.expired';
    const sessionId = data && (data.id || data.payment_session_id);   // Xendit sends "id"; its docs show "payment_session_id"
    if (finished && sessionId) {
      await applySessionResult(sessionId, event === 'payment_session.completed' ? 'COMPLETED' : 'EXPIRED', data);
    }
    // A QR Ph payment was captured (Payment Request API)
    if (event === 'payment.capture' && data && data.payment_request_id) {
      const captured = (data.captures || []).reduce((sum, c) => sum + Number(c.capture_amount || 0), 0);
      await applySessionResult(data.payment_request_id, 'COMPLETED', {
        amount: captured || data.request_amount,
        payment_id: data.payment_id,
      });
    }
    res.json({ ok: true });
  }));


  // After the checkout page, Xendit sends the buyer back here (it only allows https addresses)
  app.get('/api/xendit/return', (req, res) => {
    // Back to the address the buyer started from, so they are still signed in there
    const site = (process.env.FRONTEND_URL || (req.query.to === 'local' || !PUBLIC_URL ? 'http://localhost:' + PORT : PUBLIC_URL)).replace(/\/$/, '');
    res.redirect(/^\d+$/.test(req.query.id) ? site + '/transaction.html?id=' + req.query.id + '&payment=returned' : site + '/dashboard.html');
  });


  // The buyer came back from the checkout page: find out right away whether the payment went through
  app.post('/api/transactions/:id/pay/check', auth, route(async (req, res) => {
    requireNumeric(req.params.id, 'Invalid trade.');
    const t = await queryOne(pool, 'SELECT buyer_id, seller_id FROM transactions WHERE transaction_id = $1', [req.params.id]);
    if (!t || !isParty(t, req.user.user_id)) throw new HttpError(404, 'Trade not found.');
    if (!sameId(t.buyer_id, req.user.user_id)) throw new HttpError(403, 'Only the buyer can do this.');
    await syncTradeCheckouts(req.params.id);
    const fresh = await queryOne(pool, 'SELECT status FROM transactions WHERE transaction_id = $1', [req.params.id]);
    res.json({ status: fresh.status });
  }));


  // Buyer pays by scanning a QR Ph code (GCash, Maya, or a bank app). Answers with the QR picture.
  app.post('/api/transactions/:id/pay-qr', auth, route(async (req, res) => {
    if (!checkoutEnabled) throw new HttpError(503, 'Online payment is not set up on this server yet. Please contact Support.');
    await findBuyerTrade(req.params.id, req.user.user_id);
    await syncTradeCheckouts(req.params.id);
    const t = await findBuyerTrade(req.params.id, req.user.user_id);
    if (t.status === 'paid') return res.json({ paid: true });
    const qr = await startQrPayment(req.params.id, req.user.user_id);
    res.json({
      qr_image: await QRCode.toDataURL(qr.qr_string, { margin: 1, width: 280, errorCorrectionLevel: 'M' }),
      expires_at: qr.expires_at,
    });
  }));

  // Test mode only: pretend the buyer paid the QR code, so the flow can be shown without a phone
  app.post('/api/transactions/:id/pay-qr/simulate', auth, route(async (req, res) => {
    const t = await findBuyerTrade(req.params.id, req.user.user_id);
    if (t.status !== 'accepted') throw new HttpError(409, 'This trade is not waiting for payment.');
    await simulateQrPayment(req.params.id);
    res.json({ ok: true });
  }));

  // Buyer pays into escrow on the Xendit checkout page. Simulated only when that was turned on on purpose.
  app.post('/api/transactions/:id/pay', auth, route(async (req, res) => {
    if (checkoutEnabled) {
      requireNumeric(req.params.id, 'Invalid trade.');
      await syncTradeCheckouts(req.params.id);
      const t = await queryOne(pool, 'SELECT buyer_id, status FROM transactions WHERE transaction_id = $1', [req.params.id]);
      if (t && sameId(t.buyer_id, req.user.user_id) && t.status === 'paid') return res.json({ paid: true });
      const fromThisComputer = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.get('origin') || '');
      return res.json({ checkout_url: await startCheckout(req.params.id, req.user.user_id, fromThisComputer) });
    }
    if (!simulatedPayments) throw new HttpError(503, 'Online payment is not set up on this server yet. Please contact Support.');
    const number = readGcashNumber(req, 'Enter the 11-digit GCash number you are paying from (it starts with 09).');
    await withTx(async client => {
      const t = await lockTrade(client, req.params.id, req.user.user_id, { role: 'buyer', status: 'accepted' });
      await assertBothActive(client, t);
      await markTradePaid(client, t, number);
    });
    res.json({ ok: true });
  }));


  // Buyer confirms receipt: the payment is released to the seller
  app.post('/api/transactions/:id/confirm', auth, route(async (req, res) => {
    requireNumeric(req.params.id, 'Invalid trade.');
    await withTx(async client => {
      const t = await lockTrade(client, req.params.id, req.user.user_id, { role: 'buyer', status: 'delivered' });
      await assertBothActive(client, t);
      if (t.item_type === 'account' && Date.now() < new Date(t.delivered_at).getTime() + ACCOUNT_HOLD_HOURS * 3600000) {
        throw new HttpError(409, 'A game account is protected for 7 days, so the payment is released automatically after that. If something is wrong, open a dispute.');
      }
      await releasePayment(client, t.transaction_id);
      await logActivity(client, req.user.user_id, t.transaction_id, 'confirmed', null);
    });
    res.json({ ok: true });
  }));


  // Chat: send a message in a trade
  app.post('/api/transactions/:id/messages', auth, route(async (req, res) => {
    const content = String(req.body.content || '').trim();
    if (!isDbId(req.params.id) || !content || content.length > 1000) throw new HttpError(400, 'Write a message of 1 to 1000 characters.');
    const mine = await pool.query(
      'SELECT status FROM transactions WHERE transaction_id = $1 AND (buyer_id = $2 OR seller_id = $2)',
      [req.params.id, req.user.user_id]
    );
    if (!mine.rows[0]) throw new HttpError(404, 'Trade not found.');
    if (FINISHED_STATUSES.includes(mine.rows[0].status)) throw new HttpError(409, 'This trade is finished, so the chat is closed.');
    const recent = await queryOne(
      pool,
      `SELECT COUNT(*) AS n FROM messages WHERE sender_id = $1 AND sent_at > now() - interval '1 minute'`,
      [req.user.user_id]
    );
    if (Number(recent.n) >= CHAT_PER_MINUTE) throw new HttpError(429, 'You are sending messages too fast. Please wait a moment.');
    await pool.query(
      'INSERT INTO messages (transaction_id, sender_id, content) VALUES ($1, $2, $3)',
      [req.params.id, req.user.user_id, content]
    );
    res.status(201).json({ ok: true });
  }));
}

module.exports = { register };
