const { auth } = require('../lib/auth');
const { HttpError, JOIN_BUYER_SELLER, isParty, logActivity, maskNumber, pool, queryOne, requireNumeric, route, sameId } = require('../lib/core');


// A completed trade that this user took part in (only those can be rated)
async function findTradeToRate(tradeId, me, notCompletedMessage) {
  const t = await queryOne(pool, 'SELECT buyer_id, seller_id, status FROM transactions WHERE transaction_id = $1', [tradeId]);
  if (!t || !isParty(t, me)) throw new HttpError(404, 'Trade not found.');
  if (t.status !== 'completed') throw new HttpError(409, notCompletedMessage);
  return t;
}

// Adds these routes to the app
function register(app) {

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
}

module.exports = { register, findTradeToRate };
