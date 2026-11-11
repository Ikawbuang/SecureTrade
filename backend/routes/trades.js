const path = require('path');
const { auth } = require('../lib/auth');
const { CHAT_MAX_SHOWN, HttpError, ITEM_TYPES, JOIN_BUYER_SELLER, MAX_ITEM_LENGTH, MAX_PENDING_SENT, MAX_TRADE_AMOUNT, assertBothActive, assertVerified, cleanHandle, holdHours, isAdmin, isDbId, isParty, logActivity, maskNumber, pool, queryOne, recordTradeAttempt, requireNumeric, route, sameId, verifiedSql, withTx } = require('../lib/core');
const { assertPaymentHeld, getDeliveryProofs, lockTrade, markPaymentRefunded, readGcashNumber } = require('../lib/escrow');
const { UPLOAD_DIR, assertRealImages, removeFiles, sendPrivateImage, uploadFiles } = require('../lib/uploads');
const { cancelOpenCheckouts, checkoutEnabled, simulatedPayments, syncTradeCheckouts, xenditTestMode } = require('../lib/xendit');



// Adds these routes to the app
function register(app) {

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
    const { my_role, item_type } = req.body;
    const item_description = typeof req.body.item_description === 'string' ? req.body.item_description.trim() : '';
    const amount = Number(req.body.amount);
    const partner_username = cleanHandle(req.body.partner_username);
    if (!partner_username || !['buyer', 'seller'].includes(my_role) || !item_description) throw new HttpError(400, 'Partner username, your role, item description, and a valid amount are required.');
    if (!ITEM_TYPES.includes(item_type)) throw new HttpError(400, 'Choose what is being sold.');
    if (item_description.length > MAX_ITEM_LENGTH) throw new HttpError(400, 'Please keep the item description under ' + MAX_ITEM_LENGTH + ' characters.');
    if (!Number.isFinite(amount) || amount < 1 || amount > MAX_TRADE_AMOUNT || Math.round(amount * 100) / 100 !== amount) {
      throw new HttpError(400, 'Enter a price from ₱1 to ₱' + MAX_TRADE_AMOUNT.toLocaleString('en-PH') + ', with at most 2 decimals.');
    }
    await assertVerified(req.user.user_id, 'Verify your identity first. Open "Edit profile" on your dashboard and complete the verification to start trades.');
    // Admins decide disputes, so they must never be one of the two people in a trade
    if (await isAdmin(req.user.user_id)) throw new HttpError(403, 'Admin accounts cannot trade.');

    const partner = await pool.query(
      `SELECT user_id, verified_at, role FROM users WHERE lower(username) = lower($1) AND account_status = 'active'`,
      [partner_username]
    );
    if (!partner.rows[0] || partner.rows[0].role === 'admin') throw new HttpError(404, 'No active user with that username.');
    const partnerId = partner.rows[0].user_id;
    if (sameId(partnerId, req.user.user_id)) throw new HttpError(400, 'You cannot trade with yourself.');
    if (!partner.rows[0].verified_at && partner.rows[0].role !== 'admin') {
      await recordTradeAttempt(partnerId, req.user.user_id);
      return res.status(400).json({ message: '@' + partner_username + ' is not verified yet, so you cannot trade with them. We told them you tried.' });
    }
    const pending = await queryOne(pool, `SELECT COUNT(*) AS n FROM transactions WHERE created_by = $1 AND status = 'pending'`, [req.user.user_id]);
    if (Number(pending.n) >= MAX_PENDING_SENT) {
      throw new HttpError(429, 'You already have ' + MAX_PENDING_SENT + ' requests waiting for an answer. Wait for a reply or cancel one first.');
    }
    const buyer_id  = my_role === 'buyer'  ? req.user.user_id : partnerId;
    const seller_id = my_role === 'seller' ? req.user.user_id : partnerId;
    const trade = await queryOne(
      pool,
      `INSERT INTO transactions (buyer_id, seller_id, item_description, amount, created_by, item_type)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING transaction_id, buyer_id, seller_id, item_description, amount, service_fee, status, created_at, created_by`,
      [buyer_id, seller_id, item_description, amount, req.user.user_id, item_type]
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
    if (!['accept', 'decline'].includes(action) || !isDbId(req.params.id)) throw new HttpError(400, 'Invalid request.');
    if (action === 'accept') {
      await assertVerified(req.user.user_id, 'Verify your identity first before you accept a trade. Open "Edit profile" on your dashboard.');
      const trade = await queryOne(pool, 'SELECT buyer_id, seller_id FROM transactions WHERE transaction_id = $1', [req.params.id]);
      if (trade && isParty(trade, req.user.user_id)) await assertBothActive(pool, trade);
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
    // The buyer may already have paid while Xendit's message is still on its way
    await syncTradeCheckouts(req.params.id);

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
      `SELECT * FROM (
         SELECT m.message_id, m.sender_id, u.username, u.avatar_file, m.content, m.sent_at
         FROM messages m JOIN users u ON u.user_id = m.sender_id
         WHERE m.transaction_id = $1
         ORDER BY m.sent_at DESC, m.message_id DESC LIMIT ${CHAT_MAX_SHOWN}
       ) newest ORDER BY sent_at, message_id`,
      [req.params.id]
    );

    res.json({
      ...trade,
      checkout_enabled: checkoutEnabled,
      simulated_payments: simulatedPayments,
      qr_test_mode: xenditTestMode,
      auto_release_hours: holdHours(row.item_type),
      release_at: row.delivered_at ? new Date(new Date(row.delivered_at).getTime() + holdHours(row.item_type) * 3600000) : null,
      delivery_proofs: await getDeliveryProofs(req.params.id),
      payout_masked: maskNumber(payout_number),
      payment,
      receipt: receipt.rows[0] || null,
      messages: messages.rows,
    });
  }));


  // Seller marks the item as delivered, with proof, and says which GCash number should receive the money
  app.post('/api/transactions/:id/deliver', auth, uploadFiles, route(async (req, res) => {
    const files = req.files || [];
    try {
      const number = readGcashNumber(req, 'Enter the 11-digit GCash number (it starts with 09) where you want to receive your money.');
      if (files.length === 0) throw new HttpError(400, 'Add at least one screenshot that proves the delivery.');
      await assertRealImages(files, 'One of the files is not a valid JPG, PNG, WEBP, or GIF image.');
      await withTx(async client => {
        const t = await lockTrade(client, req.params.id, req.user.user_id, { role: 'seller', status: 'paid' });
        await assertBothActive(client, t);
        for (const f of files) {
          await client.query(
            'INSERT INTO delivery_proofs (transaction_id, submitted_by, file_url, description) VALUES ($1, $2, $3, $4)',
            [t.transaction_id, req.user.user_id, f.filename, path.basename(String(f.originalname || 'image')).slice(0, 100)]
          );
        }
        await client.query(
          `UPDATE transactions
           SET status = 'delivered', delivered_at = now(), payout_method = 'gcash', payout_number = $1
           WHERE transaction_id = $2`,
          [number, t.transaction_id]
        );
        await logActivity(client, req.user.user_id, t.transaction_id, 'delivered', 'payout to GCash, ' + files.length + ' proof image(s)');
      });
      res.json({ ok: true });
    } catch (err) {
      await removeFiles(files);
      throw err;
    }
  }));


  // One delivery proof image. Only the two traders and admins can open it.
  app.get('/api/delivery-proofs/:id/file', auth, route(async (req, res) => {
    requireNumeric(req.params.id, 'Invalid file.');
    const row = await queryOne(
      pool,
      `SELECT p.file_url, t.buyer_id, t.seller_id
       FROM delivery_proofs p JOIN transactions t ON t.transaction_id = p.transaction_id
       WHERE p.proof_id = $1`,
      [req.params.id]
    );
    const allowed = row && (isParty(row, req.user.user_id) || (await isAdmin(req.user.user_id)));
    if (!allowed) throw new HttpError(404, 'File not found.');
    sendPrivateImage(res, path.basename(row.file_url), UPLOAD_DIR, 'private, max-age=3600');
  }));
}

module.exports = { register };
