const { auth } = require('../lib/auth');
const { HttpError, SUPPORT_MAX, SUPPORT_PER_MINUTE, pool, queryAll, queryOne, route } = require('../lib/core');



// Adds these routes to the app
function register(app) {

  // ---------- Support chat (a user and the admins) ----------
  // A suspended account can use this to ask for help.

  // My conversation with the admins. Opening it marks the admin's messages as read.
  app.get('/api/support', auth, route(async (req, res) => {
    const me = req.user.user_id;
    const messages = await queryAll(
      pool,
      `SELECT * FROM (
         SELECT message_id, from_admin, content, sent_at
         FROM support_messages WHERE user_id = $1
         ORDER BY sent_at DESC, message_id DESC LIMIT 300
       ) newest ORDER BY sent_at, message_id`,
      [me]
    );
    await pool.query(
      `UPDATE support_messages SET read_at = now() WHERE user_id = $1 AND from_admin AND read_at IS NULL`,
      [me]
    );

    // Why the account is suspended (the note the admin wrote, without the admin's name)
    let reason = null;
    if (req.user.account_status === 'suspended') {
      const log = await queryOne(
        pool,
        `SELECT detail FROM activity_log
         WHERE user_id = $1 AND action = 'account_suspended'
         ORDER BY created_at DESC, log_id DESC LIMIT 1`,
        [me]
      );
      if (log && log.detail) {
        const i = log.detail.indexOf(': ');
        reason = i >= 0 ? log.detail.slice(i + 2) : null;
      }
    }
    res.json({ account_status: req.user.account_status, suspension_reason: reason, messages });
  }));


  // How many admin messages I have not read yet (the menu shows this number)
  app.get('/api/support/unread', auth, route(async (req, res) => {
    const r = await pool.query(
      `SELECT COUNT(*) AS n FROM support_messages WHERE user_id = $1 AND from_admin AND read_at IS NULL`,
      [req.user.user_id]
    );
    res.json({ unread: Number(r.rows[0].n) });
  }));


  // Write to the admins
  app.post('/api/support', auth, route(async (req, res) => {
    const me = req.user.user_id;
    const content = String(req.body.content || '').trim();
    if (!content || content.length > SUPPORT_MAX) {
      throw new HttpError(400, 'Write a message of 1 to ' + SUPPORT_MAX + ' characters.');
    }
    const recent = Number((await queryOne(
      pool,
      `SELECT COUNT(*) AS n FROM support_messages
       WHERE sender_id = $1 AND sent_at > now() - interval '1 minute'`,
      [me]
    )).n);
    if (recent >= SUPPORT_PER_MINUTE) {
      throw new HttpError(429, 'You are sending messages too fast. Please wait a moment.');
    }
    await pool.query(
      `INSERT INTO support_messages (user_id, sender_id, from_admin, content) VALUES ($1, $1, false, $2)`,
      [me, content]
    );
    res.status(201).json({ ok: true });
  }));
}

module.exports = { register };
