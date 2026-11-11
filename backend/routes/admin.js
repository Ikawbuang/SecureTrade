const { adminOnly, auth } = require('../lib/auth');
const { ADMIN_MAX_PAGE, ADMIN_PAGE_SIZE, ALL_TRADE_STATUSES, AVG_RATING_SQL, HttpError, JOIN_BUYER_SELLER, ONLINE_SQL, PAID_STATUSES, PROCESS_STATUSES, RATING_COUNT_SQL, SUPPORT_MAX, cleanSearch, findUsername, isParty, logActivity, maskNumber, numberOrNull, pageOffset, pageResult, pool, queryAll, queryOne, requireNote, requireNumeric, route, sameId, splitFullName, verifiedSql, withTx } = require('../lib/core');
const { assertPaymentHeld, getDeliveryProofs, markPaymentRefunded, releasePayment } = require('../lib/escrow');
const { removeVerifFile } = require('../lib/uploads');
const { checkoutEnabled, xenditRequest } = require('../lib/xendit');


// ---------- Admin ----------

// An admin who is one of the two people in a trade must not decide it
function assertNotOwnTrade(trade, adminId) {
  if (isParty(trade, adminId)) throw new HttpError(403, 'You are part of this trade, so another admin must decide it.');
}


// Payments that arrived for a trade that could not accept them, and that no admin has handled yet
const OPEN_PAYMENT_REVIEWS_SQL = `activity_log a
     WHERE a.action = 'payment_needs_review'
       AND NOT EXISTS (
         SELECT 1 FROM activity_log done
         WHERE done.action IN ('payment_review_refunded', 'payment_review_closed')
           AND done.transaction_id = a.transaction_id
           AND done.detail LIKE 'Review #' || a.log_id || ':%'
       )`;


function getTradeChat(transactionId) {
  return queryAll(
    pool,
    `SELECT u.username, m.content, m.sent_at
     FROM messages m JOIN users u ON u.user_id = m.sender_id
     WHERE m.transaction_id = $1
     ORDER BY m.sent_at, m.message_id`,
    [transactionId]
  );
}


function getTradeActivity(transactionId) {
  return queryAll(
    pool,
    `SELECT a.action, a.detail, a.created_at, u.username
     FROM activity_log a LEFT JOIN users u ON u.user_id = a.user_id
     WHERE a.transaction_id = $1
     ORDER BY a.created_at, a.log_id`,
    [transactionId]
  );
}


async function getAdminPayment(transactionId) {
  const p = await queryOne(pool, 'SELECT payment_method, payment_status, payer_number FROM escrow_payments WHERE transaction_id = $1', [transactionId]);
  return p ? { method: p.payment_method, status: p.payment_status, payer_masked: maskNumber(p.payer_number) } : null;
}


// The Xendit payment a review is about, as it was written in the log
async function findReviewPaymentId(client, detail) {
  const match = /^Xendit payment (\S+)/.exec(detail || '');
  if (!match) return null;
  if (match[1].startsWith('py-')) return match[1];
  const session = await queryOne(client, 'SELECT payment_id FROM xendit_sessions WHERE session_id = $1', [match[1]]);
  return session && session.payment_id;
}


// ---------- Admin: trades ----------

// needs_admin = the payment is held and one of the two people is suspended or banned
const NEEDS_ADMIN_SQL = `(t.status::text IN ('paid', 'delivered')
              AND (b.account_status::text <> 'active' OR s.account_status::text <> 'active'))`;


// The lists in the admin's user window, 20 at a time ($1 is the user)
const USER_LIST_SIZE = 20;

const USER_LISTS = {
  trades: {
    sql: `SELECT t.transaction_id, t.item_description, t.amount, t.status, t.created_at,
            CASE WHEN t.buyer_id = $1 THEN 'buyer' ELSE 'seller' END AS role,
            CASE WHEN t.buyer_id = $1 THEN s.username ELSE b.username END AS partner_username
     FROM transactions t
     ${JOIN_BUYER_SELLER}
     WHERE t.buyer_id = $1 OR t.seller_id = $1
     ORDER BY t.created_at DESC, t.transaction_id DESC`,
    toRow: t => ({ ...t, amount: Number(t.amount) }),
  },
  reviews: {
    sql: `SELECT r.review_ref, r.score, r.feedback, r.rated_at, r.transaction_id, au.username AS author_username
     FROM ratings r JOIN users au ON au.user_id = r.rated_by
     WHERE r.rated_user_id = $1 AND r.deleted_at IS NULL
     ORDER BY r.rated_at DESC, r.review_ref DESC`,
  },
  activity: {
    sql: `SELECT action, detail, created_at, transaction_id
     FROM activity_log
     WHERE user_id = $1
     ORDER BY created_at DESC, log_id DESC`,
  },
};


// One more row than needed is read, to know whether there are more
async function userListPage(kind, userId, offset) {
  const { sql, toRow = row => row } = USER_LISTS[kind];
  const rows = await queryAll(pool, `${sql} LIMIT ${USER_LIST_SIZE + 1} OFFSET ${offset}`, [userId]);
  return { rows: rows.slice(0, USER_LIST_SIZE).map(toRow), has_more: rows.length > USER_LIST_SIZE };
}

// Adds these routes to the app
function register(app) {

  // Overview numbers
  app.get('/api/admin/overview', auth, adminOnly, route(async (req, res) => {
    const stats = await queryOne(
      pool,
      `SELECT
         (SELECT COUNT(*) FROM disputes WHERE dispute_status <> 'resolved') AS open_disputes,
         (SELECT COALESCE(SUM(amount_held), 0) FROM escrow_payments WHERE payment_status = 'held') AS held,
         (SELECT COUNT(*) FROM transactions WHERE created_at >= date_trunc('month', now())) AS trades_month,
         (SELECT COALESCE(SUM(service_fee), 0) FROM transactions WHERE status = 'completed') AS fees,
         (SELECT COUNT(*) FROM verifications WHERE status = 'pending') AS pending_verifications,
         (SELECT COUNT(DISTINCT user_id) FROM support_messages WHERE NOT from_admin AND read_at IS NULL) AS unread_support,
         (SELECT COUNT(*) FROM review_reports WHERE status = 'open') AS open_reports,
         (SELECT COUNT(*) FROM activity_log WHERE action = 'login_blocked' AND created_at > now() - interval '7 days') AS login_alerts,
         (SELECT COUNT(*) FROM ${OPEN_PAYMENT_REVIEWS_SQL}) AS payment_reviews,
         (SELECT COUNT(*) FROM transactions t
            ${JOIN_BUYER_SELLER}
           WHERE t.status::text IN ('paid', 'delivered')
             AND (b.account_status::text <> 'active' OR s.account_status::text <> 'active')) AS needs_admin_trades`
    );
    res.json({
      open_disputes: Number(stats.open_disputes),
      held: Number(stats.held),
      trades_month: Number(stats.trades_month),
      fees: Number(stats.fees),
      pending_verifications: Number(stats.pending_verifications),
      unread_support: Number(stats.unread_support),
      open_reports: Number(stats.open_reports),
      login_alerts: Number(stats.login_alerts),
      payment_reviews: Number(stats.payment_reviews),
      needs_admin_trades: Number(stats.needs_admin_trades),
    });
  }));


  // ---------- Admin: payments to review ----------

  app.get('/api/admin/payment-reviews', auth, adminOnly, route(async (req, res) => {
    const rows = await queryAll(
      pool,
      `SELECT r.log_id, r.transaction_id, r.detail, r.created_at, r.total_count,
              t.item_description, t.amount, t.status::text AS trade_status,
              b.username AS buyer_username, s.username AS seller_username
       FROM (SELECT a.*, COUNT(*) OVER() AS total_count FROM ${OPEN_PAYMENT_REVIEWS_SQL}
             ORDER BY a.created_at, a.log_id
             LIMIT ${ADMIN_PAGE_SIZE} OFFSET ${pageOffset(req.query.page)}) r
       JOIN transactions t ON t.transaction_id = r.transaction_id
       ${JOIN_BUYER_SELLER}
       ORDER BY r.created_at, r.log_id`
    );
    res.json(pageResult(rows, r => ({ ...r, amount: Number(r.amount) })));
  }));


  // Refund the buyer through Xendit, or close the review because it was handled another way.
  // The trade stays locked during the refund, so two admins can never refund the same payment.
  app.post('/api/admin/payment-reviews/:id/resolve', auth, adminOnly, route(async (req, res) => {
    const action = req.body.action;
    const note = String(req.body.note || '').trim();
    requireNumeric(req.params.id, 'Invalid review.');
    if (!['refund', 'close'].includes(action)) throw new HttpError(400, 'Choose refund or close.');
    requireNote(note, 300, 'Write a short note that explains why.');

    const me = await findUsername(req.user.user_id);
    await withTx(async client => {
      const review = await queryOne(client, `SELECT * FROM activity_log WHERE log_id = $1 AND action = 'payment_needs_review'`, [req.params.id]);
      if (!review) throw new HttpError(404, 'Review not found.');
      const t = await queryOne(client, 'SELECT * FROM transactions WHERE transaction_id = $1 FOR UPDATE', [review.transaction_id]);
      assertNotOwnTrade(t, req.user.user_id);

      const handled = await queryOne(
        client,
        `SELECT 1 FROM activity_log
         WHERE action IN ('payment_review_refunded', 'payment_review_closed') AND transaction_id = $1 AND detail LIKE $2`,
        [review.transaction_id, 'Review #' + review.log_id + ':%']
      );
      if (handled) throw new HttpError(409, 'This payment was already handled.');

      let done = 'closed';
      if (action === 'refund') {
        if (!checkoutEnabled) throw new HttpError(503, 'Online payment is not set up on this server.');
        const paymentId = await findReviewPaymentId(client, review.detail);
        if (!paymentId) throw new HttpError(409, 'The Xendit payment ID is missing. Refund it in the Xendit dashboard, then close this review.');
        const refund = await xenditRequest('POST', '/v3/refunds', {
          reference_id: 'review-' + review.log_id,
          payment_id: paymentId,
          reason: 'CANCELLATION',
        }, {
          headers: { 'api-version': '2024-11-11' },
          failMessage: 'Xendit did not accept this refund. Check the server log, or refund it in the Xendit dashboard and then close this review.',
        });
        if (refund.status === 'FAILED') throw new HttpError(502, 'Xendit could not complete this refund (' + (refund.failure_code || 'no reason given') + ').');
        done = 'refund ' + refund.refund_id + ' is ' + refund.status;
      }
      await logActivity(client, req.user.user_id, t.transaction_id,
        action === 'refund' ? 'payment_review_refunded' : 'payment_review_closed',
        'Review #' + review.log_id + ': ' + done + ', by @' + me.username + ': ' + note);
    });
    res.json({ ok: true });
  }));


  // Verification requests: ?status=pending (default) or all
  app.get('/api/admin/verifications', auth, adminOnly, route(async (req, res) => {
    const all = String(req.query.status || 'pending') === 'all';
    const result = await pool.query(
      `SELECT v.verification_id, v.status, v.typed_name, v.id_type, v.submitted_at, v.decided_at, v.reject_reason,
              u.username, u.avatar_file, u.full_name, COUNT(*) OVER() AS total_count
       FROM verifications v JOIN users u ON u.user_id = v.user_id
       WHERE ($1::boolean OR v.status = 'pending')
       ORDER BY (v.status = 'pending') DESC,
                CASE WHEN v.status = 'pending' THEN v.submitted_at END ASC,
                v.decided_at DESC NULLS LAST,
                v.verification_id DESC
       LIMIT ${ADMIN_PAGE_SIZE} OFFSET ${pageOffset(req.query.page)}`,
      [all]
    );
    res.json(pageResult(result.rows));
  }));


  // One request: the names, the code, and what to compare the pictures with
  app.get('/api/admin/verifications/:id', auth, adminOnly, route(async (req, res) => {
    requireNumeric(req.params.id, 'Invalid request.');
    const v = await queryOne(
      pool,
      `SELECT v.verification_id, v.status, v.typed_name, v.id_type, v.code, v.submitted_at, v.decided_at, v.reject_reason,
              (v.id_file IS NOT NULL AND v.selfie_file IS NOT NULL) AS has_files,
              u.username, u.avatar_file, u.full_name, u.email, u.created_at AS joined
       FROM verifications v JOIN users u ON u.user_id = v.user_id
       WHERE v.verification_id = $1`,
      [req.params.id]
    );
    if (!v) throw new HttpError(404, 'Request not found.');
    res.json(v);
  }));


  // Approve (the typed first and last name become the user's name) or reject (with a reason).
  // The pictures are deleted.
  app.post('/api/admin/verifications/:id/decision', auth, adminOnly, route(async (req, res) => {
    const decision = req.body.decision;
    const reason = String(req.body.reason || '').trim();
    requireNumeric(req.params.id, 'Invalid request.');
    if (!['approve', 'reject'].includes(decision)) throw new HttpError(400, 'Choose approve or reject.');
    if (decision === 'reject' && reason.length < 5) throw new HttpError(400, 'Write a short reason for rejecting.');
    if (reason.length > 300) throw new HttpError(400, 'Please keep the reason under 300 characters.');

    let toDelete = [];
    const me = await findUsername(req.user.user_id);
    await withTx(async client => {
      const v = await queryOne(client, 'SELECT * FROM verifications WHERE verification_id = $1 FOR UPDATE', [req.params.id]);
      if (!v) throw new HttpError(404, 'Request not found.');
      if (v.status !== 'pending') throw new HttpError(409, 'This request was already decided.');
      toDelete = [v.id_file, v.selfie_file];

      if (decision === 'approve') {
        // A request sent before the first/last name change only has the combined name
        const names = v.typed_first_name
          ? { first: v.typed_first_name, last: v.typed_last_name || '' }
          : splitFullName(v.typed_name);
        await client.query(
          `UPDATE users
           SET first_name = $1, last_name = $2, full_name = $3, verified_at = now(),
               verify_code = NULL, verify_code_expires_at = NULL
           WHERE user_id = $4`,
          [names.first, names.last, v.typed_name, v.user_id]
        );
        // The notices about people who wanted to trade with them are no longer needed
        await client.query('DELETE FROM trade_attempts WHERE target_user_id = $1', [v.user_id]);
      }
      await client.query(
        `UPDATE verifications
         SET status = $1, reject_reason = $2, decided_at = now(), decided_by = $3, id_file = NULL, selfie_file = NULL
         WHERE verification_id = $4`,
        [decision === 'approve' ? 'approved' : 'rejected', decision === 'reject' ? reason : null, req.user.user_id, v.verification_id]
      );
      await logActivity(client, v.user_id, null,
        decision === 'approve' ? 'verification_approved' : 'verification_rejected',
        'by @' + me.username + (decision === 'reject' ? ': ' + reason : ''));
    });
    await Promise.all(toDelete.map(removeVerifFile));
    res.json({ ok: true });
  }));


  // ---------- Admin: sign-in alerts ----------

  // Accounts that reached the wrong-password limit in the last 7 days. An admin decides whether to act.
  app.get('/api/admin/login-alerts', auth, adminOnly, route(async (req, res) => {
    res.json(await queryAll(
      pool,
      `SELECT a.log_id, a.detail, a.created_at,
              u.user_id, u.username, u.avatar_file, u.account_status::text AS account_status
       FROM activity_log a JOIN users u ON u.user_id = a.user_id
       WHERE a.action = 'login_blocked' AND a.created_at > now() - interval '7 days'
       ORDER BY a.created_at DESC
       LIMIT 200`
    ));
  }));


  // ---------- Admin: support chat ----------

  // Everyone who has a conversation. The ones with unread messages come first.
  app.get('/api/admin/support', auth, adminOnly, route(async (req, res) => {
    const result = await pool.query(
      `SELECT *, COUNT(*) OVER() AS total_count FROM (
         SELECT u.user_id, u.username, u.avatar_file, u.account_status::text AS account_status,
                (SELECT COUNT(*) FROM support_messages m
                  WHERE m.user_id = u.user_id AND NOT m.from_admin AND m.read_at IS NULL) AS unread,
                lm.content AS last_content, lm.sent_at AS last_at, lm.from_admin AS last_from_admin
         FROM users u
         JOIN LATERAL (
           SELECT content, sent_at, from_admin FROM support_messages
           WHERE user_id = u.user_id
           ORDER BY sent_at DESC, message_id DESC LIMIT 1
         ) lm ON true
       ) x
       ORDER BY (x.unread > 0) DESC, x.last_at DESC, x.user_id DESC
       LIMIT ${ADMIN_PAGE_SIZE} OFFSET ${pageOffset(req.query.page)}`
    );
    res.json(pageResult(result.rows, r => ({ ...r, unread: Number(r.unread) })));
  }));


  // One conversation. Opening it marks the user's messages as read.
  app.get('/api/admin/support/:userId', auth, adminOnly, route(async (req, res) => {
    requireNumeric(req.params.userId, 'Invalid user.');
    const u = await queryOne(
      pool,
      `SELECT user_id, username, avatar_file, account_status::text AS account_status FROM users WHERE user_id = $1`,
      [req.params.userId]
    );
    if (!u) throw new HttpError(404, 'User not found.');

    const messages = await queryAll(
      pool,
      `SELECT * FROM (
         SELECT message_id, from_admin, content, sent_at FROM support_messages
         WHERE user_id = $1 ORDER BY sent_at DESC, message_id DESC LIMIT 300
       ) newest ORDER BY sent_at, message_id`,
      [u.user_id]
    );
    await pool.query(
      `UPDATE support_messages SET read_at = now() WHERE user_id = $1 AND NOT from_admin AND read_at IS NULL`,
      [u.user_id]
    );
    res.json({ user: u, messages });
  }));


  // Write to a user (this can start the conversation)
  app.post('/api/admin/support/:userId', auth, adminOnly, route(async (req, res) => {
    requireNumeric(req.params.userId, 'Invalid user.');
    const content = String(req.body.content || '').trim();
    if (!content || content.length > SUPPORT_MAX) {
      throw new HttpError(400, 'Write a message of 1 to ' + SUPPORT_MAX + ' characters.');
    }
    const target = await queryOne(pool, 'SELECT user_id, role FROM users WHERE user_id = $1', [req.params.userId]);
    if (!target) throw new HttpError(404, 'User not found.');
    if (target.role === 'admin') throw new HttpError(400, 'You cannot start a support chat with an admin.');

    await pool.query(
      `INSERT INTO support_messages (user_id, sender_id, from_admin, content) VALUES ($1, $2, true, $3)`,
      [target.user_id, req.user.user_id, content]
    );
    res.status(201).json({ ok: true });
  }));


  // ---------- Admin: reported reviews ----------

  // Reports: ?status=open (default) or all. The admin can see who wrote the review.
  app.get('/api/admin/reports', auth, adminOnly, route(async (req, res) => {
    const all = String(req.query.status || 'open') === 'all';
    const result = await pool.query(
      `SELECT rr.report_id, rr.review_ref, rr.status, rr.reason, rr.created_at,
              r.score, r.feedback, r.rated_at, r.deleted_at, r.transaction_id,
              au.user_id AS author_id, au.username AS author_username,
              su.username AS subject_username, ru.username AS reporter_username,
              COUNT(*) OVER() AS total_count
       FROM review_reports rr
       JOIN ratings r ON r.review_ref = rr.review_ref
       JOIN users au ON au.user_id = r.rated_by
       JOIN users su ON su.user_id = r.rated_user_id
       JOIN users ru ON ru.user_id = rr.reported_by
       WHERE ($1::boolean OR rr.status = 'open')
       ORDER BY (rr.status = 'open') DESC, rr.created_at DESC, rr.report_id DESC
       LIMIT ${ADMIN_PAGE_SIZE} OFFSET ${pageOffset(req.query.page)}`,
      [all]
    );
    res.json(pageResult(result.rows));
  }));


  // Delete a review (it no longer counts in the average, and nobody sees it). A note is needed.
  app.post('/api/admin/reviews/:ref/delete', auth, adminOnly, route(async (req, res) => {
    const note = String(req.body.note || '').trim();
    requireNumeric(req.params.ref, 'Invalid review.');
    requireNote(note, 300, 'Write a short note that explains why.');

    const me = await findUsername(req.user.user_id);
    await withTx(async client => {
      const r = await queryOne(
        client,
        `UPDATE ratings SET deleted_at = now(), deleted_by = $2
         WHERE review_ref = $1 AND deleted_at IS NULL
         RETURNING rated_by, transaction_id`,
        [req.params.ref, req.user.user_id]
      );
      if (!r) throw new HttpError(404, 'Review not found, or it was already deleted.');
      await client.query(`UPDATE review_reports SET status = 'resolved' WHERE review_ref = $1`, [req.params.ref]);
      await logActivity(client, r.rated_by, r.transaction_id, 'review_deleted', 'by @' + me.username + ': ' + note);
    });
    res.json({ ok: true });
  }));


  // Close a report without deleting the review
  app.post('/api/admin/reports/:id/dismiss', auth, adminOnly, route(async (req, res) => {
    requireNumeric(req.params.id, 'Invalid report.');
    const r = await pool.query(
      `UPDATE review_reports SET status = 'dismissed' WHERE report_id = $1 AND status = 'open' RETURNING report_id`,
      [req.params.id]
    );
    if (!r.rows[0]) throw new HttpError(404, 'Report not found, or it was already closed.');
    res.json({ ok: true });
  }));


  // ---------- Admin: disputes ----------

  // All disputes: the ones waiting for a decision first, oldest first
  app.get('/api/admin/disputes', auth, adminOnly, route(async (req, res) => {
    const result = await pool.query(
      `SELECT d.dispute_id, d.dispute_status, d.opened_at, d.replied_at, (d.reply IS NOT NULL) AS has_reply,
              t.transaction_id, t.item_description, t.amount, t.status AS trade_status,
              b.username AS buyer_username, s.username AS seller_username, f.username AS filed_by_username
       FROM disputes d
       JOIN transactions t ON t.transaction_id = d.transaction_id
       ${JOIN_BUYER_SELLER}
       JOIN users f ON f.user_id = d.filed_by
       ORDER BY (d.dispute_status = 'resolved'), d.opened_at ASC
       LIMIT 200`
    );
    res.json(result.rows.map(d => ({ ...d, amount: Number(d.amount) })));
  }));


  // One dispute with everything the admin needs to investigate:
  // both sides, their reputation, the evidence, the trade chat, and what each person did
  app.get('/api/admin/disputes/:id', auth, adminOnly, route(async (req, res) => {
    requireNumeric(req.params.id, 'Invalid dispute.');
    const found = await pool.query(
      `SELECT d.*, f.username AS filed_by_username,
              t.item_description, t.amount, t.status AS trade_status, t.payout_method, t.payout_number,
              t.buyer_id, t.seller_id, t.created_at AS trade_created_at, t.delivered_at,
              b.username AS buyer_username, s.username AS seller_username
       FROM disputes d
       JOIN users f ON f.user_id = d.filed_by
       JOIN transactions t ON t.transaction_id = d.transaction_id
       ${JOIN_BUYER_SELLER}
       WHERE d.dispute_id = $1`,
      [req.params.id]
    );
    const d = found.rows[0];
    if (!d) throw new HttpError(404, 'Dispute not found.');

    const evidence = await pool.query(
      `SELECT e.evidence_id, e.description AS name, u.username AS submitted_by_username
       FROM evidence e JOIN users u ON u.user_id = e.submitted_by
       WHERE e.dispute_id = $1
       ORDER BY e.uploaded_at, e.evidence_id`,
      [d.dispute_id]
    );
    const messages = await getTradeChat(d.transaction_id);
    const activity = await getTradeActivity(d.transaction_id);
    const payment = await getAdminPayment(d.transaction_id);

    // How trustworthy each person looks: finished trades, rating, past disputes, and cancellations after payment
    const reputation = await pool.query(
      `SELECT u.user_id, u.username, u.avatar_file, u.created_at, u.account_status,
              ${verifiedSql('u')} AS verified,
              (SELECT COUNT(*) FROM transactions x
                WHERE x.status = 'completed' AND (x.buyer_id = u.user_id OR x.seller_id = u.user_id)) AS completed_trades,
              (SELECT ROUND(AVG(r.score)::numeric, 1) FROM ratings r WHERE r.rated_user_id = u.user_id AND r.deleted_at IS NULL) AS rating,
              (SELECT COUNT(*) FROM ratings r WHERE r.rated_user_id = u.user_id AND r.deleted_at IS NULL) AS rating_count,
              (SELECT COUNT(*) FROM disputes dd JOIN transactions x ON x.transaction_id = dd.transaction_id
                WHERE x.buyer_id = u.user_id OR x.seller_id = u.user_id) AS disputes,
              (SELECT COUNT(*) FROM disputes dd WHERE dd.filed_by = u.user_id) AS disputes_filed,
              (SELECT COUNT(*) FROM transactions x
                WHERE x.seller_id = u.user_id AND x.status = 'refunded' AND x.cancelled_by = u.user_id) AS seller_cancels
       FROM users u
       WHERE u.user_id = ANY($1::bigint[])`,
      [[d.buyer_id, d.seller_id]]
    );
    const repOf = id => {
      const u = reputation.rows.find(x => sameId(x.user_id, id));
      if (!u) return null;
      return {
        username: u.username,
        avatar_file: u.avatar_file,
        verified: u.verified,
        joined: u.created_at,
        account_status: u.account_status,
        completed_trades: Number(u.completed_trades),
        rating: numberOrNull(u.rating),
        rating_count: Number(u.rating_count),
        disputes: Number(u.disputes),
        disputes_filed: Number(u.disputes_filed),
        seller_cancels: Number(u.seller_cancels),
      };
    };

    res.json({
      dispute_id: d.dispute_id,
      transaction_id: d.transaction_id,
      item_description: d.item_description,
      amount: Number(d.amount),
      trade_status: d.trade_status,
      trade_created_at: d.trade_created_at,
      delivered_at: d.delivered_at,
      buyer_username: d.buyer_username,
      seller_username: d.seller_username,
      buyer: repOf(d.buyer_id),
      seller: repOf(d.seller_id),
      filed_by_username: d.filed_by_username,
      reason: d.reason,
      description: d.description,
      requested_outcome: d.requested_outcome,
      reply: d.reply,
      replied_at: d.replied_at,
      dispute_status: d.dispute_status,
      resolution: d.resolution,
      opened_at: d.opened_at,
      can_release: !!d.payout_method,
      payout_masked: d.payout_method ? maskNumber(d.payout_number) : null,
      payout_method: d.payout_method,
      payment,
      evidence: evidence.rows,
      delivery_proofs: await getDeliveryProofs(d.transaction_id),
      messages,
      activity,
    });
  }));


  // The admin's decision: pay the seller or refund the buyer. It cannot be changed afterwards.
  app.post('/api/admin/disputes/:id/resolve', auth, adminOnly, route(async (req, res) => {
    const decision = req.body.decision;
    const note = String(req.body.note || '').trim();
    requireNumeric(req.params.id, 'Invalid dispute.');
    if (!['release', 'refund'].includes(decision)) throw new HttpError(400, 'Choose a decision.');
    requireNote(note, 1000, 'Write a short note that explains your decision.');

    await withTx(async client => {
      const d = await queryOne(client, 'SELECT * FROM disputes WHERE dispute_id = $1 FOR UPDATE', [req.params.id]);
      if (!d) throw new HttpError(404, 'Dispute not found.');
      if (d.dispute_status === 'resolved') throw new HttpError(409, 'This dispute was already decided.');

      const t = await queryOne(client, 'SELECT * FROM transactions WHERE transaction_id = $1 FOR UPDATE', [d.transaction_id]);
      if (!t || t.status !== 'disputed') throw new HttpError(409, 'This trade is not in dispute anymore.');
      assertNotOwnTrade(t, req.user.user_id);

      await assertPaymentHeld(client, t.transaction_id, 'There is no payment held for this trade.');

      if (decision === 'release') {
        if (!t.payout_method) {
          throw new HttpError(409, 'The seller never said where to receive the money, because the item was not marked as delivered. You can refund the buyer instead.');
        }
        await releasePayment(client, t.transaction_id);
      } else {
        await markPaymentRefunded(client, t.transaction_id);
        await client.query(`UPDATE transactions SET status = 'refunded' WHERE transaction_id = $1`, [t.transaction_id]);
      }

      const summary = decision === 'release'
        ? 'Decision: the payment was released to the seller.'
        : 'Decision: the buyer was refunded in full.';
      await client.query(
        `UPDATE disputes SET dispute_status = 'resolved', resolved_by = $1, resolution = $2 WHERE dispute_id = $3`,
        [req.user.user_id, summary + ' ' + note, d.dispute_id]
      );
      await logActivity(client, req.user.user_id, t.transaction_id, 'dispute_resolved',
        (decision === 'release' ? 'Paid the seller' : 'Refunded the buyer') + ': ' + note.slice(0, 200));
    });
    res.json({ ok: true });
  }));


  // Every trade, newest first. Filters: ?status=process|needs_admin|all|<one status>, ?search=
  app.get('/api/admin/transactions', auth, adminOnly, route(async (req, res) => {
    const status = String(req.query.status || 'process');
    const search = cleanSearch(req.query.search);
    const params = [];
    const clauses = [];

    if (status === 'process') {
      params.push(PROCESS_STATUSES);
      clauses.push(`t.status::text = ANY($${params.length})`);
    } else if (status === 'needs_admin') {
      clauses.push(NEEDS_ADMIN_SQL);
    } else if (ALL_TRADE_STATUSES.includes(status)) {
      params.push(status);
      clauses.push(`t.status::text = $${params.length}`);
    }
    if (search) {
      params.push('%' + search + '%');
      const like = '$' + params.length;
      let text = `(t.item_description ILIKE ${like} OR b.username ILIKE ${like} OR s.username ILIKE ${like}`;
      if (/^\d+$/.test(search)) {
        params.push(search);
        text += ` OR t.transaction_id = $${params.length}`;
      }
      clauses.push(text + ')');
    }

    const result = await pool.query(
      `SELECT t.transaction_id, t.item_description, t.amount, t.status, t.created_at,
              b.username AS buyer_username, s.username AS seller_username,
              EXISTS (SELECT 1 FROM disputes d WHERE d.transaction_id = t.transaction_id) AS had_dispute,
              ${NEEDS_ADMIN_SQL} AS needs_admin,
              COUNT(*) OVER() AS total_count
       FROM transactions t
       ${JOIN_BUYER_SELLER}
       ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''}
       ORDER BY t.created_at DESC, t.transaction_id DESC
       LIMIT ${ADMIN_PAGE_SIZE} OFFSET ${pageOffset(req.query.page)}`,
      params
    );
    res.json(pageResult(result.rows, t => ({ ...t, amount: Number(t.amount) })));
  }));


  // One trade: status, payment, chat, dispute, and what each person did
  app.get('/api/admin/transactions/:id', auth, adminOnly, route(async (req, res) => {
    requireNumeric(req.params.id, 'Invalid trade.');
    const found = await pool.query(
      `SELECT t.*, b.username AS buyer_username, s.username AS seller_username,
              b.account_status::text AS buyer_status, s.account_status::text AS seller_status
       FROM transactions t
       ${JOIN_BUYER_SELLER}
       WHERE t.transaction_id = $1`,
      [req.params.id]
    );
    const t = found.rows[0];
    if (!t) throw new HttpError(404, 'Trade not found.');

    const payment = await getAdminPayment(t.transaction_id);
    const receipt = await queryOne(
      pool,
      'SELECT receipt_number FROM receipts WHERE transaction_id = $1',
      [t.transaction_id]
    );
    const dispute = await queryOne(
      pool,
      'SELECT dispute_id, dispute_status FROM disputes WHERE transaction_id = $1',
      [t.transaction_id]
    );
    const messages = await getTradeChat(t.transaction_id);
    const activity = await getTradeActivity(t.transaction_id);

    const held = PAID_STATUSES.includes(t.status);
    res.json({
      transaction_id: t.transaction_id,
      item_description: t.item_description,
      amount: Number(t.amount),
      service_fee: Number(t.service_fee),
      status: t.status,
      created_at: t.created_at,
      delivered_at: t.delivered_at,
      buyer_username: t.buyer_username,
      seller_username: t.seller_username,
      buyer_status: t.buyer_status,
      seller_status: t.seller_status,
      needs_admin: held && (t.buyer_status !== 'active' || t.seller_status !== 'active'),
      can_refund: held && !!payment && payment.status === 'held' && !dispute,
      can_release: t.status === 'delivered' && !!payment && payment.status === 'held' && !dispute
        && (t.buyer_status !== 'active' || t.seller_status !== 'active'),
      cancel_reason: t.cancel_reason,
      payment,
      payout_method: t.payout_method,
      payout_masked: maskNumber(t.payout_number),
      receipt_number: receipt ? receipt.receipt_number : null,
      dispute: dispute || null,
      item_type: t.item_type,
      delivery_proofs: await getDeliveryProofs(t.transaction_id),
      messages,
      activity,
    });
  }));


  // Refund the buyer in full without a dispute, for a trade whose payment is held
  // (for example when the seller was banned). A note is needed, and both people can see it.
  app.post('/api/admin/transactions/:id/refund', auth, adminOnly, route(async (req, res) => {
    const note = String(req.body.note || '').trim();
    requireNumeric(req.params.id, 'Invalid trade.');
    requireNote(note, 300, 'Write a short note that explains why.');

    await withTx(async client => {
      const t = await queryOne(client, 'SELECT * FROM transactions WHERE transaction_id = $1 FOR UPDATE', [req.params.id]);
      if (!t) throw new HttpError(404, 'Trade not found.');
      assertNotOwnTrade(t, req.user.user_id);
      if (t.status === 'disputed') {
        throw new HttpError(409, 'This trade is in dispute. Decide it from the dispute review.');
      }
      if (!PAID_STATUSES.includes(t.status)) {
        throw new HttpError(409, 'Only a trade whose payment is held can be refunded.');
      }
      await assertPaymentHeld(client, t.transaction_id, 'There is no held payment for this trade.');

      await markPaymentRefunded(client, t.transaction_id);
      await client.query(`UPDATE transactions SET status = 'refunded', cancel_reason = $1 WHERE transaction_id = $2`, [note, t.transaction_id]);
      await logActivity(client, req.user.user_id, t.transaction_id, 'admin_refund', note);
    });
    res.json({ ok: true });
  }));


  // Pay the seller when the item was delivered but one of the two accounts is suspended or banned,
  // so the trade cannot finish by itself. A note is needed.
  app.post('/api/admin/transactions/:id/release', auth, adminOnly, route(async (req, res) => {
    const note = String(req.body.note || '').trim();
    requireNumeric(req.params.id, 'Invalid trade.');
    requireNote(note, 300, 'Write a short note that explains why.');

    await withTx(async client => {
      const t = await queryOne(
        client,
        `SELECT t.*, b.account_status::text AS buyer_status, s.account_status::text AS seller_status
         FROM transactions t ${JOIN_BUYER_SELLER}
         WHERE t.transaction_id = $1 FOR UPDATE OF t`,
        [req.params.id]
      );
      if (!t) throw new HttpError(404, 'Trade not found.');
      assertNotOwnTrade(t, req.user.user_id);
      if (t.status !== 'delivered') throw new HttpError(409, 'Only a delivered trade can be released this way.');
      if (t.buyer_status === 'active' && t.seller_status === 'active') {
        throw new HttpError(409, 'Both accounts are active, so this trade finishes by itself.');
      }
      await assertPaymentHeld(client, t.transaction_id, 'There is no held payment for this trade.');
      await releasePayment(client, t.transaction_id);
      await logActivity(client, req.user.user_id, t.transaction_id, 'admin_release', note);
    });
    res.json({ ok: true });
  }));


  // ---------- Admin: users ----------

  // All users. Filters: ?search= (username, name, email), ?status=all|online|active|suspended|banned
  app.get('/api/admin/users', auth, adminOnly, route(async (req, res) => {
    const search = cleanSearch(req.query.search);
    const status = String(req.query.status || 'all');
    const params = [];
    const clauses = [];

    if (search) {
      params.push('%' + search + '%');
      const like = '$' + params.length;
      clauses.push(`(u.username ILIKE ${like} OR u.full_name ILIKE ${like} OR u.email ILIKE ${like})`);
    }
    if (['active', 'suspended', 'banned'].includes(status)) {
      params.push(status);
      clauses.push(`u.account_status::text = $${params.length}`);
    }
    if (status === 'online') clauses.push(ONLINE_SQL);

    const result = await pool.query(
      `SELECT u.user_id, u.username, u.avatar_file, u.full_name, u.email, u.role, u.account_status, u.created_at, u.last_seen,
              ${ONLINE_SQL} AS online,
              ${verifiedSql('u')} AS verified,
              (SELECT COUNT(*) FROM transactions t
                WHERE t.status = 'completed' AND (t.buyer_id = u.user_id OR t.seller_id = u.user_id)) AS completed_trades,
              (SELECT COUNT(*) FROM transactions t
                WHERE t.status::text = ANY($${params.length + 1}) AND (t.buyer_id = u.user_id OR t.seller_id = u.user_id)) AS active_trades,
              (SELECT ROUND(AVG(r.score)::numeric, 1) FROM ratings r WHERE r.rated_user_id = u.user_id AND r.deleted_at IS NULL) AS rating,
              COUNT(*) OVER() AS total_count
       FROM users u
       ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''}
       ORDER BY u.created_at DESC, u.user_id DESC
       LIMIT ${ADMIN_PAGE_SIZE} OFFSET ${pageOffset(req.query.page)}`,
      [...params, PROCESS_STATUSES]
    );
    res.json(pageResult(result.rows, u => ({
      user_id: u.user_id,
      username: u.username,
      avatar_file: u.avatar_file,
      full_name: u.full_name,
      email: u.email,
      role: u.role,
      account_status: u.account_status,
      created_at: u.created_at,
      last_seen: u.last_seen,
      online: u.online,
      verified: u.verified,
      completed_trades: Number(u.completed_trades),
      active_trades: Number(u.active_trades),
      rating: numberOrNull(u.rating),
    })));
  }));


  // "Show more" in the user window: ?offset= is how many rows are already showing
  app.get('/api/admin/users/:id/list/:kind', auth, adminOnly, route(async (req, res) => {
    requireNumeric(req.params.id, 'Invalid user.');
    if (!Object.hasOwn(USER_LISTS, req.params.kind)) throw new HttpError(404, 'List not found.');
    const offset = Math.min(Math.max(parseInt(req.query.offset, 10) || 0, 0), ADMIN_PAGE_SIZE * ADMIN_MAX_PAGE);
    res.json(await userListPage(req.params.kind, req.params.id, offset));
  }));


  // One user: details, their trades, the reviews about them (the admin sees who wrote them), and what they did
  app.get('/api/admin/users/:id', auth, adminOnly, route(async (req, res) => {
    requireNumeric(req.params.id, 'Invalid user.');
    const found = await pool.query(
      `SELECT user_id, username, avatar_file, full_name, email, role, account_status, created_at, last_seen, verified_at,
              ${verifiedSql()} AS verified, ${ONLINE_SQL} AS online
       FROM users WHERE user_id = $1`,
      [req.params.id]
    );
    const u = found.rows[0];
    if (!u) throw new HttpError(404, 'User not found.');

    const stats = await queryOne(
      pool,
      `SELECT
         (SELECT COUNT(*) FROM transactions
           WHERE status = 'completed' AND (buyer_id = $1 OR seller_id = $1)) AS completed_trades,
         (SELECT COUNT(*) FROM transactions
           WHERE status::text = ANY($2) AND (buyer_id = $1 OR seller_id = $1)) AS active_trades,
         (SELECT COUNT(*) FROM disputes d JOIN transactions t ON t.transaction_id = d.transaction_id
           WHERE t.buyer_id = $1 OR t.seller_id = $1) AS disputes,
         (SELECT COUNT(*) FROM transactions
           WHERE seller_id = $1 AND status = 'refunded' AND cancelled_by = $1) AS cancels_after_payment,
         ${AVG_RATING_SQL} AS rating,
         ${RATING_COUNT_SQL} AS rating_count`,
      [u.user_id, PROCESS_STATUSES]
    );

    const trades = await userListPage('trades', u.user_id, 0);
    const reviews = await userListPage('reviews', u.user_id, 0);
    const activity = await userListPage('activity', u.user_id, 0);

    res.json({
      user_id: u.user_id,
      username: u.username,
      avatar_file: u.avatar_file,
      full_name: u.full_name,
      email: u.email,
      role: u.role,
      account_status: u.account_status,
      created_at: u.created_at,
      last_seen: u.last_seen,
      online: u.online,
      verified: u.verified,
      verified_at: u.verified_at,
      completed_trades: Number(stats.completed_trades),
      active_trades: Number(stats.active_trades),
      disputes: Number(stats.disputes),
      cancels_after_payment: Number(stats.cancels_after_payment),
      rating: numberOrNull(stats.rating),
      rating_count: Number(stats.rating_count),
      is_me: sameId(u.user_id, req.user.user_id),
      can_control: u.role !== 'admin' && !sameId(u.user_id, req.user.user_id),
      trades: trades.rows,
      trades_more: trades.has_more,
      reviews: reviews.rows,
      reviews_more: reviews.has_more,
      activity: activity.rows,
      activity_more: activity.has_more,
    });
  }));


  // Suspend, ban, or reactivate a user. A banned user is signed out on their next click.
  // A suspended user can still sign in, but can only use Support.
  app.post('/api/admin/users/:id/status', auth, adminOnly, route(async (req, res) => {
    const status = req.body.status;
    const note = String(req.body.note || '').trim();
    requireNumeric(req.params.id, 'Invalid user.');
    if (!['active', 'suspended', 'banned'].includes(status)) throw new HttpError(400, 'Choose a status.');
    if (status !== 'active' && note.length < 5) throw new HttpError(400, 'Write a short note that explains why.');
    if (note.length > 500) throw new HttpError(400, 'Please keep the note under 500 characters.');

    const target = await queryOne(pool, 'SELECT user_id, role FROM users WHERE user_id = $1', [req.params.id]);
    if (!target) throw new HttpError(404, 'User not found.');
    if (target.role === 'admin') throw new HttpError(400, 'You cannot change an admin account.');

    const me = await findUsername(req.user.user_id);
    await pool.query('UPDATE users SET account_status = $1 WHERE user_id = $2', [status, target.user_id]);
    await logActivity(pool, target.user_id, null, 'account_' + status, 'by @' + me.username + (note ? ': ' + note : ''));
    res.json({ ok: true, account_status: status });
  }));
}

module.exports = { register, assertNotOwnTrade, OPEN_PAYMENT_REVIEWS_SQL, getTradeChat, getTradeActivity, getAdminPayment, findReviewPaymentId, NEEDS_ADMIN_SQL, USER_LIST_SIZE, USER_LISTS, userListPage };
