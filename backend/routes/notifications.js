const { auth } = require('../lib/auth');
const { pool, queryOne, route } = require('../lib/core');


// Adds these routes to the app
function register(app) {

  // ---------- 🔔 Updates ----------

  // My newest updates (20) and how many are unread
  app.get('/api/notifications', auth, route(async (req, res) => {
    const rows = await pool.query(
      `SELECT notification_id, message, is_read, sent_at FROM notifications
       WHERE user_id = $1 ORDER BY sent_at DESC, notification_id DESC LIMIT 20`,
      [req.user.user_id]
    );
    const unread = await queryOne(pool, 'SELECT COUNT(*) AS n FROM notifications WHERE user_id = $1 AND NOT is_read', [req.user.user_id]);
    res.json({ unread: Number(unread.n), rows: rows.rows });
  }));


  // Only the number, for the menu (asked every 30 seconds)
  app.get('/api/notifications/unread', auth, route(async (req, res) => {
    const unread = await queryOne(pool, 'SELECT COUNT(*) AS n FROM notifications WHERE user_id = $1 AND NOT is_read', [req.user.user_id]);
    res.json({ unread: Number(unread.n) });
  }));


  // Mark all my updates as read
  app.post('/api/notifications/read', auth, route(async (req, res) => {
    await pool.query('UPDATE notifications SET is_read = true WHERE user_id = $1 AND NOT is_read', [req.user.user_id]);
    res.json({ ok: true });
  }));
}

module.exports = { register };
