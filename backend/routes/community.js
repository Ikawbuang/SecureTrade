const { auth } = require('../lib/auth');
const { AVG_RATING_SQL, HttpError, MAX_FAVORITES, ONLINE_SQL, RATING_COUNT_SQL, cleanHandle, cleanSearch, numberOrNull, pool, queryOne, requireNumeric, route, sameId, verifiedSql } = require('../lib/core');



// Adds these routes to the app
function register(app) {

  // ---------- Find trade partners ----------
  // Usernames only, never emails or real names.
  // ?status=all|recent|online|offline|favorites  ?search=  ?limit=  (admins are not listed)
  app.get('/api/users', auth, route(async (req, res) => {
    const search = cleanSearch(req.query.search);
    const status = String(req.query.status || 'all');
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const me = req.user.user_id;

    const together = `((t.buyer_id = $1 AND t.seller_id = u.user_id) OR (t.seller_id = $1 AND t.buyer_id = u.user_id))`;
    let extra = '';
    if (status === 'online') extra = ` AND ${ONLINE_SQL}`;
    if (status === 'offline') extra = ` AND NOT ${ONLINE_SQL}`;
    if (status === 'favorites') extra = ` AND f.user_id IS NOT NULL`;
    if (status === 'recent') extra = ` AND EXISTS (SELECT 1 FROM transactions t WHERE ${together})`;
    const order = status === 'recent'
      ? 'last_trade_at DESC NULLS LAST, u.username'
      : `${ONLINE_SQL} DESC, u.username`;

    const result = await pool.query(
      `SELECT u.username, u.avatar_file, u.created_at, u.last_seen, ${ONLINE_SQL} AS online,
              ${verifiedSql('u')} AS verified,
              (f.user_id IS NOT NULL) AS is_favorite, f.note,
              (SELECT COUNT(*) FROM transactions t WHERE t.status = 'completed' AND ${together}) AS trades_together,
              (SELECT MAX(t.created_at) FROM transactions t WHERE ${together}) AS last_trade_at
       FROM users u
       LEFT JOIN favorites f ON f.user_id = $1 AND f.favorite_user_id = u.user_id
       WHERE u.account_status = 'active' AND u.role <> 'admin' AND u.user_id <> $1
         AND u.username ILIKE $2${extra}
       ORDER BY ${order}
       LIMIT $3`,
      [me, `%${search}%`, limit + 1]
    );
    const rows = result.rows.slice(0, limit).map(u => ({ ...u, trades_together: Number(u.trades_together) }));
    res.json({ users: rows, has_more: result.rows.length > limit });
  }));


  // View a user's public profile (username only, never email or real name).
  // The reviews are anonymous: they show the stars, the comment, and whether the writer was the buyer or the seller.
  app.get('/api/users/:username', auth, route(async (req, res) => {
    const me = req.user.user_id;
    const found = await pool.query(
      `SELECT u.user_id, u.username, u.avatar_file, u.created_at, u.last_seen, ${ONLINE_SQL} AS online,
              ${verifiedSql('u')} AS verified,
              (f.user_id IS NOT NULL) AS is_favorite, f.note
       FROM users u
       LEFT JOIN favorites f ON f.user_id = $2 AND f.favorite_user_id = u.user_id
       WHERE lower(u.username) = lower($1) AND u.account_status = 'active'`,
      [req.params.username, me]
    );
    const user = found.rows[0];
    if (!user) throw new HttpError(404, 'User not found.');

    const stats = await pool.query(
      `SELECT
         (SELECT COUNT(*) FROM transactions
           WHERE status = 'completed' AND (buyer_id = $1 OR seller_id = $1)) AS completed_trades,
         ${AVG_RATING_SQL} AS avg_rating,
         ${RATING_COUNT_SQL} AS rating_count,
         (SELECT COUNT(*) FROM transactions t WHERE t.status = 'completed'
           AND ((t.buyer_id = $1 AND t.seller_id = $2) OR (t.seller_id = $1 AND t.buyer_id = $2))) AS trades_together`,
      [user.user_id, me]
    );
    const reviews = await pool.query(
      `SELECT r.review_ref, r.score, r.feedback, r.rated_at,
              CASE WHEN t.buyer_id = r.rated_by THEN 'Buyer' ELSE 'Seller' END AS as_role,
              (r.rated_by = $2) AS is_mine,
              EXISTS (SELECT 1 FROM review_reports rr WHERE rr.review_ref = r.review_ref AND rr.reported_by = $2) AS reported_by_me
       FROM ratings r
       JOIN transactions t ON t.transaction_id = r.transaction_id
       WHERE r.rated_user_id = $1 AND r.deleted_at IS NULL
       ORDER BY r.rated_at DESC
       LIMIT 5`,
      [user.user_id, me]
    );

    const s = stats.rows[0];
    res.json({
      username: user.username,
      avatar_file: user.avatar_file,
      verified: user.verified,
      is_favorite: user.is_favorite,
      note: user.note,
      joined: user.created_at,
      online: user.online,
      last_seen: user.last_seen,
      completed_trades: Number(s.completed_trades),
      trades_together: Number(s.trades_together),
      avg_rating: numberOrNull(s.avg_rating),
      rating_count: Number(s.rating_count),
      reviews: reviews.rows,
    });
  }));


  // ---------- Reviews about me, and reporting an abusive review ----------

  // The reviews other people wrote about me (anonymous)
  app.get('/api/reviews/mine', auth, route(async (req, res) => {
    const result = await pool.query(
      `SELECT r.review_ref, r.score, r.feedback, r.rated_at,
              CASE WHEN t.buyer_id = r.rated_by THEN 'Buyer' ELSE 'Seller' END AS as_role,
              EXISTS (SELECT 1 FROM review_reports rr WHERE rr.review_ref = r.review_ref AND rr.reported_by = $1) AS reported_by_me
       FROM ratings r
       JOIN transactions t ON t.transaction_id = r.transaction_id
       WHERE r.rated_user_id = $1 AND r.deleted_at IS NULL
       ORDER BY r.rated_at DESC
       LIMIT 50`,
      [req.user.user_id]
    );
    res.json(result.rows);
  }));


  // Report a review (abusive, false, or it has personal information). An admin looks at it.
  app.post('/api/reviews/:ref/report', auth, route(async (req, res) => {
    requireNumeric(req.params.ref, 'Invalid review.');
    const me = req.user.user_id;
    const reason = String(req.body.reason || '').trim().slice(0, 300);

    const review = await queryOne(pool, 'SELECT rated_by, deleted_at FROM ratings WHERE review_ref = $1', [req.params.ref]);
    if (!review || review.deleted_at) throw new HttpError(404, 'Review not found.');
    if (sameId(review.rated_by, me)) throw new HttpError(400, 'You cannot report your own review.');

    const inserted = await pool.query(
      `INSERT INTO review_reports (review_ref, reported_by, reason) VALUES ($1, $2, $3)
       ON CONFLICT (review_ref, reported_by) DO NOTHING
       RETURNING report_id`,
      [req.params.ref, me, reason || null]
    );
    if (!inserted.rows[0]) throw new HttpError(409, 'You already reported this review.');
    res.status(201).json({ ok: true });
  }));


  // ---------- Favorites (private: the other person is never told) ----------

  // Add a favorite, or change its private note (send { note } only when the note changes)
  app.put('/api/favorites/:username', auth, route(async (req, res) => {
    const username = cleanHandle(req.params.username);
    const hasNote = typeof req.body.note === 'string';
    const note = hasNote ? req.body.note.trim().slice(0, 200) : null;
    const me = req.user.user_id;
    const target = await queryOne(pool, `SELECT user_id FROM users WHERE lower(username) = lower($1) AND account_status = 'active'`, [username]);
    if (!target) throw new HttpError(404, 'User not found.');
    if (sameId(target.user_id, me)) throw new HttpError(400, 'You cannot add yourself to your favorites.');

    const existing = await queryOne(pool, 'SELECT 1 FROM favorites WHERE user_id = $1 AND favorite_user_id = $2', [me, target.user_id]);

    if (existing) {
      if (hasNote) {
        await pool.query('UPDATE favorites SET note = $3 WHERE user_id = $1 AND favorite_user_id = $2',
          [me, target.user_id, note || null]);
      }
    } else {
      const count = Number((await queryOne(pool, 'SELECT COUNT(*) AS n FROM favorites WHERE user_id = $1', [me])).n);
      if (count >= MAX_FAVORITES) throw new HttpError(409, 'You can have up to ' + MAX_FAVORITES + ' favorites. Remove one first.');
      await pool.query('INSERT INTO favorites (user_id, favorite_user_id, note) VALUES ($1, $2, $3)',
        [me, target.user_id, note || null]);
    }
    res.json({ ok: true });
  }));


  app.delete('/api/favorites/:username', auth, route(async (req, res) => {
    const username = cleanHandle(req.params.username);
    await pool.query(
      `DELETE FROM favorites
       WHERE user_id = $1 AND favorite_user_id = (SELECT user_id FROM users WHERE lower(username) = lower($2))`,
      [req.user.user_id, username]
    );
    res.json({ ok: true });
  }));
}

module.exports = { register };
