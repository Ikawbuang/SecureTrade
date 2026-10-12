require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Health check
app.get('/api/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT COUNT(*) AS users FROM users');
    res.json({ status: 'ok', users: Number(result.rows[0].users) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Register
app.post('/api/register', async (req, res) => {
  const { full_name, email, password } = req.body;
  if (!full_name || !email || !password || password.length < 8) {
    return res.status(400).json({ message: 'Name, email, and a password of at least 8 characters are required.' });
  }
  try {
    const password_hash = await bcrypt.hash(password, 10);
    const result = await pool.query(
      `INSERT INTO users (full_name, email, password_hash)
       VALUES ($1, $2, $3)
       RETURNING user_id, full_name, email, role`,
      [full_name, email.toLowerCase(), password_hash]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ message: 'That email is already registered.' });
    }
    console.error(err);
    res.status(500).json({ message: 'Server error.' });
  }
});
// Login
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required.' });
  }
  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ message: 'Wrong email or password.' });
    }
    if (user.account_status !== 'active') {
      return res.status(403).json({ message: 'This account is not active.' });
    }
    const token = jwt.sign(
      { user_id: user.user_id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.json({
      token,
      user: { user_id: user.user_id, full_name: user.full_name, email: user.email, role: user.role },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error.' });
  }
});

// Protect routes: checks the login token
function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'Please log in.' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ message: 'Invalid or expired token.' });
  }
}

// Who am I? (needs a valid token)
app.get('/api/me', auth, async (req, res) => {
  const result = await pool.query(
    'SELECT user_id, full_name, email, role FROM users WHERE user_id = $1',
    [req.user.user_id]
  );
  res.json(result.rows[0]);
});

// Create a transaction request (sent to the partner)
app.post('/api/transactions', auth, async (req, res) => {
  const { partner_email, my_role, item_description, amount } = req.body;
  if (!partner_email || !['buyer', 'seller'].includes(my_role) || !item_description || !(Number(amount) > 0)) {
    return res.status(400).json({ message: 'Partner email, your role, item description, and a valid amount are required.' });
  }
  try {
    const partner = await pool.query(
      `SELECT user_id FROM users WHERE email = $1 AND account_status = 'active'`,
      [partner_email.toLowerCase()]
    );
    if (!partner.rows[0]) {
      return res.status(404).json({ message: 'No active user with that email.' });
    }
    const partnerId = partner.rows[0].user_id;
    if (String(partnerId) === String(req.user.user_id)) {
      return res.status(400).json({ message: 'You cannot trade with yourself.' });
    }
    const buyer_id  = my_role === 'buyer'  ? req.user.user_id : partnerId;
    const seller_id = my_role === 'seller' ? req.user.user_id : partnerId;
    const result = await pool.query(
      `INSERT INTO transactions (buyer_id, seller_id, item_description, amount, created_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [buyer_id, seller_id, item_description, amount, req.user.user_id]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error.' });
  }
});

// List my transactions
app.get('/api/transactions', auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT t.*, b.full_name AS buyer_name, s.full_name AS seller_name
       FROM transactions t
       JOIN users b ON b.user_id = t.buyer_id
       JOIN users s ON s.user_id = t.seller_id
       WHERE t.buyer_id = $1 OR t.seller_id = $1
       ORDER BY t.created_at DESC`,
      [req.user.user_id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SecureTrade API running on http://localhost:${PORT}`));