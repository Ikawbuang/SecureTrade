const path = require('path');
const { auth } = require('../lib/auth');
const { HttpError, JOIN_BUYER_SELLER, MAX_EVIDENCE_PER_PERSON, PAID_STATUSES, isAdmin, isParty, logActivity, pool, queryOne, requireNumeric, route, sameId, withTx } = require('../lib/core');
const { notify } = require('../lib/notify');
const { UPLOAD_DIR, assertRealImages, removeFiles, saveUploads, sendPrivateImage, uploadFiles } = require('../lib/uploads');


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


// A seller can only ask for the money once the item was marked as delivered
function outcomesFor(role, tradeStatus) {
  return OUTCOMES[role].filter(o => o.value !== 'release' || tradeStatus === 'delivered');
}


async function saveEvidence(client, disputeId, userId, files) {
  for (const f of files) {
    const name = path.basename(String(f.originalname || 'image')).slice(0, 100);
    await client.query(
      'INSERT INTO evidence (dispute_id, submitted_by, file_url, description) VALUES ($1, $2, $3, $4)',
      [disputeId, userId, f.filename, name]
    );
  }
}

// Adds these routes to the app
function register(app) {

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
      outcomes: outcomesFor(role, t.status),
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
      await saveUploads(files);

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
        if (!outcomesFor(role, t.status).some(o => o.value === outcome)) throw new HttpError(400, 'Choose the outcome you want.');

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
        await notify(client, [role === 'buyer' ? t.seller_id : t.buyer_id], t.transaction_id,
          'The ' + role + ' opened a dispute: "' + reason + '". The payment stays held until an admin decides. Reply with your side on the dispute page.');
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
      await saveUploads(files);

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
        const saved = await queryOne(client, 'SELECT COUNT(*) AS n FROM evidence WHERE dispute_id = $1 AND submitted_by = $2', [d.dispute_id, userId]);
        if (Number(saved.n) + files.length > MAX_EVIDENCE_PER_PERSON) {
          throw new HttpError(400, 'You can add up to ' + MAX_EVIDENCE_PER_PERSON + ' images to a dispute.');
        }

        await client.query(
          `UPDATE disputes SET reply = $1, replied_at = now(), dispute_status = 'under_review' WHERE dispute_id = $2`,
          [message, d.dispute_id]
        );
        await saveEvidence(client, d.dispute_id, userId, files);
        await logActivity(client, userId, d.transaction_id, 'dispute_reply', null);
        await notify(client, [d.filed_by], d.transaction_id, 'The other person replied to your dispute. An admin will review both sides.');
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
}

module.exports = { register, REASONS, OUTCOMES, outcomesFor, saveEvidence };
