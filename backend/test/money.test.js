// Tests for the rules that protect money and accounts.
// They run the real routes against a stand-in database and a stand-in Xendit, so nothing real is touched.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

Object.assign(process.env, {
  DATABASE_URL: 'postgres://test',
  JWT_SECRET: 'test-secret-that-is-at-least-32-characters-long',
  XENDIT_SECRET_KEY: 'xnd_development_test',
  XENDIT_WEBHOOK_TOKEN: 'hook-token',
  QR_PAYMENTS: 'on',
  PUBLIC_URL: 'https://example.test',
});

// The real server needs the database certificate, which is not in Git
const realRead = fs.readFileSync;
fs.readFileSync = (file, ...rest) => (String(file).endsWith('supabase-ca.crt') ? 'test-cert' : realRead(file, ...rest));

const BUYER = '1', SELLER = '2', STRANGER = '3', ADMIN = '9';
let db;

function reset(status = 'accepted', extra = {}) {
  db = {
    trade: { transaction_id: '7', buyer_id: BUYER, seller_id: SELLER, status, amount: '200.00', item_description: 'x', item_type: 'item', delivered_at: null, created_by: BUYER, ...extra },
    session: { session_id: 'ps-1', transaction_id: '7', amount: '200.00', status: 'ACTIVE', payment_id: null },
    escrow: [], logs: [], proofs: [], inactive: 0, created: 0, released: false, pin: null, xenditSession: { status: 'ACTIVE' },
    twofa: null, recovery: [], loginUser: null, passwordHash: null,
    fails: {}, noFailTable: false, resetUser: null, resetAsked: 0, pinsIssued: 0,
    calls: [], qrOpen: null, prState: { status: 'REQUIRES_ACTION' }, pendingFiles: [], refundSql: null, notes: [], failNotes: false, paidAt: new Date(), existingEmail: null,
  };
}

function fakeQuery(sql, p = []) {
  if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] };
  if (/login_failures/.test(sql)) {
    if (db.noFailTable) throw Object.assign(new Error('relation "login_failures" does not exist'), { code: '42P01' });
    if (/^SELECT count/.test(sql)) return { rows: db.fails[p[0]] ? [{ count: db.fails[p[0]] }] : [] };
    if (/^INSERT INTO login_failures/.test(sql)) { db.fails[p[0]] = (db.fails[p[0]] || 0) + 1; return { rows: [{ count: db.fails[p[0]] }] }; }
    if (/^DELETE FROM login_failures WHERE key/.test(sql)) { delete db.fails[p[0]]; return { rows: [] }; }
    return { rows: [] };
  }
  if (/AS open_disputes/.test(sql)) return { rows: [{ open_disputes: 0, held: 0 }] };   // the admin overview numbers
  // Two-step sign-in. db.twofa = null means migration 007 was not run (the columns do not exist).
  if (/totp_secret, totp_pending_secret, totp_enabled_at/.test(sql)) {
    if (!db.twofa) throw Object.assign(new Error('column "totp_secret" does not exist'), { code: '42703' });
    return { rows: [{ role: String(p[0]) === ADMIN ? 'admin' : 'user', totp_secret: db.twofa.secret, totp_pending_secret: db.twofa.pending,
      totp_enabled_at: db.twofa.secret ? new Date() : null, totp_last_step: db.twofa.lastStep }] };
  }
  if (/UPDATE users SET totp_last_step/.test(sql)) {
    if (db.twofa.lastStep === null || db.twofa.lastStep < p[1]) { db.twofa.lastStep = p[1]; return { rows: [{ user_id: p[0] }] }; }
    return { rows: [] };
  }
  if (/UPDATE users SET totp_pending_secret/.test(sql)) { db.twofa.pending = p[0]; return { rows: [] }; }
  if (/SET totp_secret = totp_pending_secret/.test(sql)) { db.twofa.secret = db.twofa.pending; db.twofa.pending = null; db.twofa.lastStep = p[1]; return { rows: [] }; }
  if (/UPDATE recovery_codes SET used_at/.test(sql)) {
    const i = db.recovery.indexOf(p[1]);
    if (i < 0) return { rows: [] };
    db.recovery.splice(i, 1);
    return { rows: [{ code_id: 1 }] };
  }
  if (/DELETE FROM recovery_codes/.test(sql)) { db.recovery = []; return { rows: [] }; }
  if (/INSERT INTO recovery_codes/.test(sql)) { db.recovery.push(p[1]); return { rows: [] }; }
  if (/FROM recovery_codes/.test(sql)) return { rows: [{ n: db.recovery.length }] };
  if (/SELECT username, email, password_hash FROM users/.test(sql)) return { rows: [{ username: 'boss', email: 'boss@example.com', password_hash: db.passwordHash }] };
  if (/^SELECT email FROM users WHERE user_id/.test(sql)) return { rows: [{ email: 'boss@example.com' }] };
  if (/SELECT \* FROM users WHERE (email|user_id)/.test(sql)) return { rows: db.loginUser ? [{ ...db.loginUser }] : [] };
  if (/SELECT user_id FROM users WHERE email = \$1 AND account_status/.test(sql)) return { rows: db.resetUser ? [{ user_id: db.resetUser }] : [] };
  if (/action = 'reset_requested'/.test(sql)) return { rows: [{ n: db.resetAsked }] };
  if (/INSERT INTO email_pins/.test(sql)) { db.pinsIssued++; return { rows: [{ pin_id: 1 }] }; }
  if (/kind = 'qr' AND status = 'ACTIVE'/.test(sql)) return { rows: db.qrOpen ? [db.qrOpen] : [] };
  if (/INSERT INTO xendit_sessions \(session_id, transaction_id, kind/.test(sql)) {
    db.qrOpen = { session_id: p[0], qr_string: p[2], expires_at: new Date(Date.now() + 900000) };
    return { rows: [db.qrOpen] };
  }
  if (/SELECT session_id, kind, expires_at > now\(\) AS open/.test(sql)) return { rows: [] };
  if (/SELECT amount FROM xendit_sessions/.test(sql)) return { rows: [{ amount: '200.00' }] };
  if (/INSERT INTO notifications/.test(sql)) { if (db.failNotes) throw new Error('db down'); db.notes.push({ user: String(p[0]), text: p[1] }); return { rows: [] }; }
  if (/AS paid_at FROM transactions t WHERE/.test(sql)) return { rows: [{ paid_at: db.paidAt }] };
  if (/s.username AS seller/.test(sql)) return { rows: db.logs.includes('reminder_release') ? [] : [{ transaction_id: '7', buyer_id: BUYER, amount: '200.00', seller: 'seller', release_at: new Date() }] };
  if (/SELECT email, username FROM users WHERE email/.test(sql)) return { rows: db.existingEmail ? [{ email: db.existingEmail, username: 'someoneelse' }] : [] };
  if (/UNION ALL/.test(sql) && /t.status::text = ANY/.test(sql)) return { rows: [{ ...db.trade, buyer_username: 'b', seller_username: 's' }] };
  if (/FILTER \(WHERE status = 'completed'\)/.test(sql)) return { rows: [{ completed: '4' }] };
  if (/SELECT username FROM users WHERE user_id/.test(sql)) return { rows: [{ username: 'user' + p[0] }] };
  if (/FROM verifications WHERE status = 'pending'/.test(sql)) return { rows: db.pendingFiles };
  if (/JOIN users c ON c.user_id = t.created_by/.test(sql)) return { rows: [{ transaction_id: '7', item_description: 'x', amount: '200.00', item_type: db.trade.item_type, my_role: 'buyer', from_username: 'seller' }] };
  if (/SELECT payment_status FROM escrow_payments/.test(sql)) return { rows: [{ payment_status: 'held' }] };
  if (/UPDATE escrow_payments SET payment_status = 'refunded'/.test(sql)) { db.refundSql = sql; return { rows: [] }; }
  if (/WHERE t.status = 'accepted'/.test(sql)) return { rows: db.trade.status === 'accepted' ? [{ transaction_id: '7' }] : [] };
  if (/SELECT 1 FROM xendit_sessions/.test(sql)) return { rows: db.session.status === 'ACTIVE' ? [{}] : [] };
  if (/SELECT account_status, role, last_seen, session_id/.test(sql)) return { rows: [{ account_status: 'active', role: String(p[0]) === ADMIN ? 'admin' : 'user', last_seen: new Date(), session_id: 's', last_activity_at: new Date() }] };
  if (/UPDATE users SET (last_activity_at|last_seen)/.test(sql)) return { rows: [] };
  if (/UPDATE email_pins SET attempts = attempts \+ 1/.test(sql)) {
    if (db.pin && db.pin.attempts < p[1]) { db.pin.attempts++; return { rows: [{ attempts: db.pin.attempts }] }; }
    return { rows: [] };
  }
  if (/SELECT \* FROM email_pins/.test(sql)) return { rows: db.pin ? [{ ...db.pin }] : [] };
  if (/DELETE FROM email_pins/.test(sql)) { db.pin = null; return { rows: [] }; }
  if (/UPDATE users SET password_hash/.test(sql)) return { rows: [{ user_id: 1 }] };
  if (/SELECT role FROM users/.test(sql)) return { rows: [{ role: String(p[0]) === ADMIN ? 'admin' : 'user' }] };
  if (/SELECT verified_at, role FROM users/.test(sql)) return { rows: [{ verified_at: new Date(), role: String(p[0]) === ADMIN ? 'admin' : 'user' }] };
  if (/SELECT user_id, verified_at, role FROM users WHERE lower/.test(sql)) return { rows: [{ user_id: p[0] === 'boss' ? ADMIN : SELLER, verified_at: new Date(), role: p[0] === 'boss' ? 'admin' : 'user' }] };
  if (/AND account_status::text <> 'active'/.test(sql)) return { rows: [{ n: db.inactive }] };
  if (/created_by = \$1 AND status = 'pending'/.test(sql)) return { rows: [{ n: 0 }] };
  if (/INSERT INTO transactions/.test(sql)) { db.created++; db.createdType = p[5]; return { rows: [{ transaction_id: 5 }] }; }
  if (/INSERT INTO delivery_proofs/.test(sql)) { db.proofs.push(p[2]); return { rows: [] }; }
  if (/FROM delivery_proofs p JOIN transactions/.test(sql)) return { rows: [{ file_url: 'none.png', buyer_id: BUYER, seller_id: SELLER }] };
  if (/FROM delivery_proofs/.test(sql)) return { rows: [] };
  if (/SET status = 'delivered'/.test(sql)) { db.trade.status = 'delivered'; return { rows: [] }; }
  if (/UPDATE escrow_payments SET payment_status = 'released'/.test(sql)) { db.released = true; return { rows: [] }; }
  if (/UPDATE transactions SET status = 'completed'/.test(sql)) { db.trade.status = 'completed'; return { rows: [] }; }
  if (/UPDATE transactions SET status = 'paid'/.test(sql)) { db.trade.status = 'paid'; return { rows: [] }; }
  if (/UPDATE transactions SET status = 'cancelled'/.test(sql)) { db.trade.status = 'cancelled'; return { rows: [] }; }
  if (/SELECT status FROM transactions/.test(sql)) return { rows: [{ status: db.trade.status }] };
  if (/SELECT buyer_id, status FROM transactions/.test(sql)) return { rows: [db.trade] };
  if (/SELECT buyer_id, seller_id FROM transactions/.test(sql)) return { rows: [db.trade] };
  if (/FROM transactions WHERE transaction_id/.test(sql)) return { rows: [{ ...db.trade }] };
  if (/SELECT session_id FROM xendit_sessions WHERE transaction_id/.test(sql)) return { rows: db.session.status === 'ACTIVE' ? [db.session] : [] };
  if (/SELECT \* FROM xendit_sessions WHERE session_id/.test(sql)) return { rows: [{ ...db.session }] };
  if (/UPDATE xendit_sessions SET status = 'COMPLETED'/.test(sql)) { db.session.status = 'COMPLETED'; return { rows: [] }; }
  if (/INSERT INTO escrow_payments/.test(sql)) { db.escrow.push(p); return { rows: [] }; }
  if (/INSERT INTO activity_log/.test(sql)) { db.logs.push(p[2]); return { rows: [] }; }
  return { rows: [] };
}

const pg = require('pg');
pg.Pool.prototype.query = async (sql, p) => fakeQuery(sql, p);
pg.Pool.prototype.connect = async () => ({ query: async (sql, p) => fakeQuery(sql, p), release() {} });

const realFetch = global.fetch;
global.fetch = async (url, options) => {
  if (!String(url).startsWith('https://api.xendit.co')) return realFetch(url, options);
  const apiPath = String(url).replace('https://api.xendit.co', '');
  db.calls.push({ method: options.method, path: apiPath, body: options.body && JSON.parse(options.body), headers: options.headers });
  const reply = body => ({ ok: true, status: 200, json: async () => body });
  if (apiPath === '/v3/payment_requests') {
    return reply({ payment_request_id: 'pr-new', status: 'REQUIRES_ACTION', actions: [{ type: 'PRESENT_TO_CUSTOMER', descriptor: 'QR_STRING', value: '00020101021228QRPHTEST' }] });
  }
  if (/\/v3\/payment_requests\/[^/]+\/(simulate|cancel)$/.test(apiPath)) return reply({ status: 'PENDING' });
  if (apiPath.startsWith('/v3/payment_requests/')) return reply(db.prState);
  return reply(db.xenditSession);
};

// The server's background timers are not needed here
const realSetInterval = global.setInterval;
global.setInterval = () => 0;
const app = require('../server');
const { cancelUnpaidTrades, cleanupVerificationFiles, sendReminders } = require('../lib/jobs');
const { notify } = require('../lib/notify');
const { withTx } = require('../lib/core');
const os = require('os');
global.setInterval = realSetInterval;

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const UPLOADS = path.join(__dirname, '..', 'uploads');
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const PAID = { status: 'COMPLETED', amount: 200, payment_id: 'py-1' };
let server, base;

before(async () => {
  await new Promise(resolve => { server = app.listen(0, resolve); });
  base = 'http://127.0.0.1:' + server.address().port + '/api';
});
after(() => new Promise(resolve => server.close(resolve)));
beforeEach(() => reset());

const headers = user => (user ? { Authorization: 'Bearer ' + jwt.sign({ user_id: user, role: 'user', sid: 's' }, process.env.JWT_SECRET) } : {});
async function post(url, user, body = {}, extra = {}) {
  const res = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers(user), ...extra }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function get(url, user) {
  const res = await fetch(base + url, { headers: headers(user) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
async function deliver(user, files) {
  const form = new FormData();
  form.append('number', '09171234567');
  files.forEach(f => form.append('files', new Blob([f.data], { type: f.type }), f.name));
  const res = await fetch(base + '/transactions/7/deliver', { method: 'POST', headers: headers(user), body: form });
  const body = await res.json().catch(() => ({}));
  db.proofs.forEach(name => fs.rmSync(path.join(UPLOADS, name), { force: true }));
  return { status: res.status, body };
}
const hook = (data, token = 'hook-token') => post('/webhooks/xendit', null, { event: 'payment_session.completed', data }, { 'x-callback-token': token });
const daysAgo = n => new Date(Date.now() - n * 86400000).toISOString();

test('20 PIN guesses at once are limited to 5 tries', async () => {
  const pin_hash = await bcrypt.hash('123456', 4);
  db.pin = { pin_id: 1, attempts: 0, pin_hash, expires_at: new Date(Date.now() + 600000) };
  let compared = 0;
  const original = bcrypt.compare;
  bcrypt.compare = async (...args) => { compared++; return original(...args); };
  await Promise.all(Array.from({ length: 20 }, (_, i) => post('/password/reset', null, { email: 'a@b.co', new_password: 'blue-mango-42', pin: String(200000 + i) })));
  bcrypt.compare = original;
  assert.equal(compared, 5);
});

test('a payment confirmed by Xendit is held in escrow', async () => {
  db.xenditSession = PAID;
  const r = await post('/transactions/7/pay/check', BUYER);
  assert.equal(r.body.status, 'paid');
  assert.equal(db.escrow.length, 1);
});

test('a repeated webhook does not record a second payment', async () => {
  await hook({ id: 'ps-1', amount: 200, payment_id: 'py-1' });
  await hook({ id: 'ps-1', amount: 200, payment_id: 'py-1' });
  assert.equal(db.escrow.length, 1);
});

test('a webhook with the wrong token is refused', async () => {
  const r = await hook({ id: 'ps-1', amount: 200 }, 'wrong');
  assert.equal(r.status, 401);
  assert.equal(db.escrow.length, 0);
});

test('the wrong amount is not held and goes to admin review', async () => {
  await hook({ id: 'ps-1', amount: 100, payment_id: 'py-1' });
  assert.equal(db.trade.status, 'accepted');
  assert.deepEqual(db.logs, ['payment_needs_review']);
});

test('a trade already paid at Xendit cannot be cancelled by the buyer', async () => {
  db.xenditSession = PAID;
  const r = await post('/transactions/7/cancel', BUYER);
  assert.equal(r.status, 403);
  assert.equal(db.trade.status, 'paid');
});

test('only the buyer can check the payment', async () => {
  assert.equal((await post('/transactions/7/pay/check', SELLER)).status, 403);
  assert.equal((await post('/transactions/7/pay/check', STRANGER)).status, 404);
});

test('a request without a login is refused', async () => {
  assert.equal((await post('/transactions/7/confirm', null)).status, 401);
});

const newTrade = (over = {}) => ({ my_role: 'buyer', item_description: 'x', item_type: 'item', amount: 100, partner_username: 'sam', ...over });

test('trade input is validated', async () => {
  for (const amount of [0.5, 0.001, 100.555, 100001, 'abc', 'Infinity']) {
    assert.equal((await post('/transactions', BUYER, newTrade({ amount }))).status, 400, 'amount ' + amount);
  }
  assert.equal((await post('/transactions', BUYER, newTrade({ item_type: 'car' }))).status, 400);
  assert.equal(db.created, 0);
  assert.equal((await post('/transactions', BUYER, newTrade({ item_type: 'account' }))).status, 201);
  assert.equal(db.createdType, 'account');
});

test('admins cannot take part in trades', async () => {
  assert.equal((await post('/transactions', BUYER, newTrade({ partner_username: 'boss' }))).status, 404);
  assert.equal((await post('/transactions', ADMIN, newTrade())).status, 403);
  assert.equal(db.created, 0);
});

test('an admin cannot refund their own trade', async () => {
  reset('paid', { buyer_id: ADMIN });
  assert.equal((await post('/admin/transactions/7/refund', ADMIN, { note: 'give it back' })).status, 403);
});

test('delivery needs proof', async () => {
  reset('paid');
  const r = await deliver(SELLER, []);
  assert.equal(r.status, 400);
  assert.equal(db.trade.status, 'paid');
});

test('a file that is not really an image is refused', async () => {
  reset('paid');
  const r = await deliver(SELLER, [{ name: 'a.png', type: 'image/png', data: Buffer.from('not an image at all') }]);
  assert.equal(r.status, 400);
  assert.equal(db.trade.status, 'paid');
});

test('delivery with proof is saved', async () => {
  reset('paid');
  const r = await deliver(SELLER, [{ name: 'a.png', type: 'image/png', data: PNG }]);
  assert.equal(r.status, 200);
  assert.equal(db.trade.status, 'delivered');
  assert.equal(db.proofs.length, 1);
});

test('only the seller can mark delivery', async () => {
  reset('paid');
  assert.equal((await deliver(BUYER, [{ name: 'a.png', type: 'image/png', data: PNG }])).status, 403);
});

test('a game account cannot be released early', async () => {
  reset('delivered', { item_type: 'account', delivered_at: daysAgo(3) });
  assert.equal((await post('/transactions/7/confirm', BUYER)).status, 409);
  assert.equal(db.released, false);
});

test('a game account can be released after 7 days', async () => {
  reset('delivered', { item_type: 'account', delivered_at: daysAgo(8) });
  assert.equal((await post('/transactions/7/confirm', BUYER)).status, 200);
  assert.equal(db.released, true);
});

test('an in-game item can be confirmed straight away', async () => {
  reset('delivered', { delivered_at: daysAgo(0) });
  assert.equal((await post('/transactions/7/confirm', BUYER)).status, 200);
  assert.equal(db.released, true);
});

test('payment is not released when an account is banned', async () => {
  reset('delivered', { delivered_at: daysAgo(0) });
  db.inactive = 1;
  assert.equal((await post('/transactions/7/confirm', BUYER)).status, 409);
  assert.equal(db.released, false);
});

test('a stranger cannot open a delivery proof', async () => {
  const res = await fetch(base + '/delivery-proofs/1/file', { headers: headers(STRANGER) });
  assert.equal(res.status, 404);
});

test('the buyer gets a QR Ph code for the exact amount', async () => {
  const r = await post('/transactions/7/pay-qr', BUYER);
  assert.equal(r.status, 200);
  assert.match(r.body.qr_image, /^data:image\/png;base64,/);
  const created = db.calls.find(c => c.path === '/v3/payment_requests');
  assert.equal(created.body.channel_code, 'QRPH');
  assert.equal(created.body.request_amount, 200);
  assert.equal(created.headers['api-version'], '2024-11-11');
  assert.equal(db.qrOpen.session_id, 'pr-new');
});

test('an open QR code is reused instead of making a new one', async () => {
  db.qrOpen = { session_id: 'pr-old', qr_string: '00020101OLD', expires_at: new Date(Date.now() + 600000) };
  const r = await post('/transactions/7/pay-qr', BUYER);
  assert.equal(r.status, 200);
  assert.equal(db.calls.filter(c => c.path === '/v3/payment_requests').length, 0);
});

test('a QR payment found by the status check is held in escrow', async () => {
  db.session = { session_id: 'pr-1', transaction_id: '7', amount: '200.00', status: 'ACTIVE', kind: 'qr', payment_id: null };
  db.prState = { status: 'SUCCEEDED', request_amount: 200, latest_payment_id: 'py-9' };
  const r = await post('/transactions/7/pay/check', BUYER);
  assert.equal(r.body.status, 'paid');
  assert.equal(db.escrow.length, 1);
});

test('a QR payment reported by the Xendit webhook is held in escrow', async () => {
  const r = await post('/webhooks/xendit', null, { event: 'payment.capture', data: { payment_request_id: 'ps-1', payment_id: 'py-9', request_amount: 200, captures: [{ capture_amount: 200 }] } }, { 'x-callback-token': 'hook-token' });
  assert.equal(r.status, 200);
  assert.equal(db.escrow.length, 1);
});

test('a QR payment for less than the price is not held', async () => {
  await post('/webhooks/xendit', null, { event: 'payment.capture', data: { payment_request_id: 'ps-1', payment_id: 'py-9', request_amount: 200, captures: [{ capture_amount: 50 }] } }, { 'x-callback-token': 'hook-token' });
  assert.equal(db.escrow.length, 0);
  assert.deepEqual(db.logs, ['payment_needs_review']);
});

test('QR Ph is refused above 50,000 pesos', async () => {
  reset('accepted', { amount: '60000.00' });
  const r = await post('/transactions/7/pay-qr', BUYER);
  assert.equal(r.status, 409);
  assert.equal(db.calls.filter(c => c.path === '/v3/payment_requests').length, 0);
});

test('only the buyer can get or simulate the QR payment', async () => {
  assert.equal((await post('/transactions/7/pay-qr', SELLER)).status, 403);
  assert.equal((await post('/transactions/7/pay-qr/simulate', SELLER)).status, 403);
  assert.equal((await post('/transactions/7/pay-qr', STRANGER)).status, 404);
});

test('the buyer can simulate a QR payment in test mode', async () => {
  db.qrOpen = { session_id: 'pr-open', qr_string: 'x', expires_at: new Date(Date.now() + 600000) };
  const r = await post('/transactions/7/pay-qr/simulate', BUYER);
  assert.equal(r.status, 200);
  assert.ok(db.calls.some(c => c.path === '/v3/payment_requests/pr-open/simulate' && c.body.amount === 200));
});

test('an accepted trade not paid within 24 hours is cancelled', async () => {
  db.session.status = 'EXPIRED';
  await cancelUnpaidTrades();
  assert.equal(db.trade.status, 'cancelled');
  assert.deepEqual(db.logs, ['payment_expired']);
});

test('an unpaid trade is not cancelled while its checkout page is still open', async () => {
  await cancelUnpaidTrades();
  assert.equal(db.trade.status, 'accepted');
  assert.deepEqual(db.logs, []);
});

test('a payment found at Xendit just before the deadline keeps the trade', async () => {
  db.xenditSession = PAID;
  await cancelUnpaidTrades();
  assert.equal(db.trade.status, 'paid');
  assert.equal(db.escrow.length, 1);
  assert.ok(!db.logs.includes('payment_expired'));
});

test('the person accepting a request sees what is being sold', async () => {
  reset('pending', { item_type: 'account' });
  const r = await get('/requests', BUYER);
  assert.equal(r.status, 200);
  assert.equal(r.body[0].item_type, 'account');
});

test('a refund saves when the money left escrow', async () => {
  reset('paid');
  const r = await post('/transactions/7/cancel', SELLER, { reason: 'Out of stock' });
  assert.equal(r.status, 200);
  assert.match(db.refundSql, /released_at = now\(\)/);
});

// The cleanup runs on a temporary folder, never on the real uploads
function verifFolder(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-verif-'));
  const old = new Date(Date.now() - 2 * 3600000);
  for (const [name, isOld] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), 'x');
    if (isOld) fs.utimesSync(path.join(dir, name), old, old);
  }
  return dir;
}

test('an ID picture no pending request needs is deleted', async () => {
  const dir = verifFolder({ 'left.png': true });
  await cleanupVerificationFiles(dir);
  assert.deepEqual(fs.readdirSync(dir), []);
  fs.rmSync(dir, { recursive: true });
});

test('the pictures of a pending request are kept', async () => {
  db.pendingFiles = [{ id_file: 'id.png', selfie_file: 'selfie.png' }];
  const dir = verifFolder({ 'id.png': true, 'selfie.png': true });
  await cleanupVerificationFiles(dir);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['id.png', 'selfie.png']);
  fs.rmSync(dir, { recursive: true });
});

test('a picture still being submitted is kept', async () => {
  const dir = verifFolder({ 'new.png': false });
  await cleanupVerificationFiles(dir);
  assert.deepEqual(fs.readdirSync(dir), ['new.png']);
  fs.rmSync(dir, { recursive: true });
});

test('a dropped database connection does not stop the server', () => {
  const { pool } = require('../lib/core');
  const lost = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
  assert.ok(pool.listenerCount('error') > 0);
  assert.doesNotThrow(() => pool.emit('error', lost));
});

// ---------- Step 2: notifications, delivery deadline, sign-in ----------
const PNG_FILE = { name: 'proof.png', type: 'image/png', data: PNG };

test('the buyer is told when the item is delivered, with the release time', async () => {
  reset('paid');
  const r = await deliver(SELLER, [PNG_FILE]);
  assert.equal(r.status, 200);
  const note = db.notes.find(n => n.user === BUYER);
  assert.ok(note, 'buyer notified');
  assert.match(note.text, /^Trade #7: .*marked the item as delivered.*releases to the seller on/);
  assert.ok(!db.notes.some(n => n.user === STRANGER));
});

test('the seller is told when the payment is held', async () => {
  await hook({ id: 'ps-1', ...PAID });
  assert.ok(db.notes.some(n => n.user === SELLER && /held safely in escrow/.test(n.text)));
});

test('a notification is dropped when the trade change is rolled back', async () => {
  await assert.rejects(withTx(async client => {
    await notify(client, [BUYER], 7, 'should never be saved');
    throw new Error('step failed');
  }));
  assert.deepEqual(db.notes, []);
});

test('a notification problem does not stop the trade step', async () => {
  reset('paid');
  db.failNotes = true;
  const r = await deliver(SELLER, [PNG_FILE]);
  assert.equal(r.status, 200);
  assert.equal(db.trade.status, 'delivered');
});

test('the buyer cannot cancel a paid trade before the delivery deadline', async () => {
  reset('paid');
  db.paidAt = new Date(Date.now() - 47 * 3600000);
  const r = await post('/transactions/7/cancel', BUYER, {});
  assert.equal(r.status, 403);
  assert.equal(db.refundSql, null);
});

test('the buyer can cancel for a full refund after 48 hours without delivery', async () => {
  reset('paid');
  db.paidAt = new Date(Date.now() - 49 * 3600000);
  const r = await post('/transactions/7/cancel', BUYER, {});
  assert.equal(r.status, 200);
  assert.equal(r.body.status, 'refunded');
  assert.ok(db.logs.includes('buyer_cancelled_late'));
  assert.ok(db.notes.some(n => n.user === SELLER && /not delivered within 48 hours/.test(n.text)));
  assert.ok(db.notes.some(n => n.user === BUYER && /refunded in full/.test(n.text)));
});

test('a delivered trade cannot be cancelled by the buyer, even late', async () => {
  reset('delivered');
  db.paidAt = new Date(Date.now() - 100 * 3600000);
  const r = await post('/transactions/7/cancel', BUYER, {});
  assert.equal(r.status, 409);
});

test('a release reminder is sent only once', async () => {
  await sendReminders();
  await sendReminders();
  assert.equal(db.notes.filter(n => n.user === BUYER && /^Trade #7: Reminder/.test(n.text)).length, 1);
});

test('signing up with a registered email looks the same as a new one', async () => {
  db.existingEmail = 'taken@example.com';
  const r = await post('/register/start', null, { first_name: 'Ana', last_name: 'Cruz', username: 'ana_new', email: 'taken@example.com', password: 'longpassword', is_adult: true });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.equal(db.pin, null);
});

test('a password longer than 72 bytes is refused at sign-up', async () => {
  const r = await post('/register/start', null, { first_name: 'Ana', last_name: 'Cruz', username: 'ana_new', email: 'new@example.com', password: 'x'.repeat(73), is_adult: true });
  assert.equal(r.status, 400);
});

test('sign-in answers an unknown email like a wrong password, and bad input cleanly', async () => {
  const unknown = await post('/login', null, { email: 'nobody@example.com', password: 'whatever1' });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.body.message, 'Wrong email or password.');
  const weird = await post('/login', null, { email: 'a@b.co', password: { $gt: '' } });
  assert.equal(weird.status, 400);
});

test('a completed payment without an amount is checked with Xendit first', async () => {
  db.xenditSession = PAID;
  await hook({ id: 'ps-1' });
  assert.ok(db.calls.some(c => c.method === 'GET' && c.path === '/sessions/ps-1'));
  assert.equal(db.escrow.length, 1);
});

// ---------- Step 3: uploads in a Supabase Storage bucket (with a fake Supabase, nothing leaves this computer) ----------
const { makeStorage } = require('../lib/storage');
function fakeSupabase(key = 'aaa.bbb.ccc') {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET', body: options.body, headers: options.headers });
    if (url.includes('/list/')) return new Response(JSON.stringify([{ id: 'a', name: 'old.png', created_at: '2026-01-01T00:00:00Z' }, { id: null, name: 'subfolder' }]));
    if (url.includes('/authenticated/')) return url.endsWith('missing.png') ? new Response('', { status: 400 }) : new Response('PICTURE');
    return new Response('{}');
  };
  return { calls, store: makeStorage({ url: 'https://proj.supabase.co', key, bucket: 'uploads', dirs: {}, fetchImpl }) };
}

test('a checked upload is moved into the private bucket', async () => {
  const { calls, store } = fakeSupabase();
  const tmp = path.join(os.tmpdir(), 'st-up-' + Date.now() + '.png');
  fs.writeFileSync(tmp, 'png');
  await store.put('files', { path: tmp, filename: 'abc.png', mimetype: 'image/png' });
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'https://proj.supabase.co/storage/v1/object/uploads/files/abc.png');
  assert.equal(calls[0].headers.Authorization, 'Bearer aaa.bbb.ccc');
  assert.equal(fs.existsSync(tmp), false, 'the disk copy is removed');
});

test('the storage key is sent in both headers, with stray quotes and spaces removed', async () => {
  const { calls, store } = fakeSupabase(' "sb_secret_abc123" ');
  await store.remove('files', 'x.png');
  assert.equal(calls[0].headers.Authorization, 'Bearer sb_secret_abc123');
  assert.equal(calls[0].headers.apikey, 'sb_secret_abc123');
});

test('a picture is sent from the bucket, and a missing one answers 404', async () => {
  const { store } = fakeSupabase();
  const reply = () => {
    const chunks = [];
    const res = new (require('stream').Writable)({ write(c, e, cb) { chunks.push(c); cb(); } });
    res.headers = {}; res.setHeader = (k, v) => { res.headers[k] = v; };
    res.status = code => { res.code = code; return res; }; res.json = () => res;
    res.text = () => Buffer.concat(chunks).toString();
    return res;
  };
  const ok = reply();
  await store.send(ok, 'files', 'abc.png', { contentType: 'image/png', cacheControl: 'private' });
  await new Promise(r => ok.on('finish', r));
  assert.equal(ok.text(), 'PICTURE');
  assert.equal(ok.headers['X-Content-Type-Options'], 'nosniff');
  const missing = reply();
  await store.send(missing, 'files', 'missing.png', { contentType: 'image/png', cacheControl: 'private' });
  assert.equal(missing.code, 404);
});

test('bucket files can be deleted and listed', async () => {
  const { calls, store } = fakeSupabase();
  await store.remove('verifications', '../../etc/passwd');
  assert.equal(calls[0].method, 'DELETE');
  assert.deepEqual(JSON.parse(calls[0].body), { prefixes: ['verifications/passwd'] });
  const files = await store.list('verifications');
  assert.deepEqual(files.map(f => f.name), ['old.png']);
});

// ---------- Step 3: proxy setting, error log, trade list ----------
test('the visitor IP setting is read from TRUST_PROXY', () => {
  const { trustProxySetting } = require('../app');
  assert.equal(trustProxySetting(undefined), 'loopback');
  assert.equal(trustProxySetting('1'), 1);
  assert.equal(trustProxySetting('true'), true);
  assert.equal(trustProxySetting('loopback, 10.0.0.0/8'), 'loopback, 10.0.0.0/8');
});

test('a server error is remembered for the admin, without its details', () => {
  const { recentErrors, rememberError } = require('../lib/core');
  rememberError(Object.assign(new Error('connect failed to secret-host'), { code: 'ECONNREFUSED' }));
  assert.equal(recentErrors[0].message, 'ECONNREFUSED');
  for (let i = 0; i < 30; i++) rememberError(new Error('e' + i));
  assert.equal(recentErrors.length, 20);
});

test('my trade list has the trades and the full completed count', async () => {
  const r = await get('/transactions', BUYER);
  assert.equal(r.status, 200);
  assert.equal(r.body.rows.length, 1);
  assert.equal(r.body.completed_count, 4);
});

// ---------- Email through Brevo's web API (for hosts that block SMTP) ----------
test('an email goes to Brevo over HTTPS with the key in a header', async () => {
  const { makeBrevoApiSender, BREVO_API_URL } = require('../lib/mail');
  const calls = [];
  const sender = makeBrevoApiSender('xkeysib-test', async (url, options) => { calls.push({ url, options }); return new Response('{"messageId":"1"}', { status: 201 }); });
  process.env.MAIL_FROM = 'noreply@example.test';
  await sender.sendMail({ to: 'buyer@example.test', subject: 'Your code', text: '123456', html: '<p>123456</p>' });
  assert.equal(calls[0].url, BREVO_API_URL);
  assert.equal(calls[0].options.headers['api-key'], 'xkeysib-test');
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(body.to, [{ email: 'buyer@example.test' }]);
  assert.equal(body.sender.email, 'noreply@example.test');
  assert.equal(body.textContent, '123456');
  assert.equal(body.htmlContent, '<p>123456</p>');
});

test('a refused email gives an error with the status only, never the key', async () => {
  const { makeBrevoApiSender } = require('../lib/mail');
  const sender = makeBrevoApiSender('xkeysib-secret', async () => new Response('{"code":"unauthorized","message":"Key not found"}', { status: 401 }));
  await assert.rejects(sender.sendMail({ to: 'a@example.test', subject: 's', text: 't' }), err => {
    assert.match(err.message, /401 unauthorized/);
    assert.doesNotMatch(err.message, /xkeysib/);
    return true;
  });
});

// ---------- Quick security set (audit items M1, M5, M7, L1, L2, L6, L7) ----------
const { settingProblems, assertGoodPassword } = require('../lib/core');
const { loginFailures } = require('../lib/auth');

test('the server refuses a short login secret and simulated payments in production', () => {
  const good = { JWT_SECRET: 'x'.repeat(32) };
  assert.deepEqual(settingProblems(good), []);
  assert.equal(settingProblems({ JWT_SECRET: 'short' }).length, 1);
  assert.equal(settingProblems({}).length, 1);
  assert.equal(settingProblems({ ...good, NODE_ENV: 'production', ALLOW_SIMULATED_PAYMENTS: 'true' }).length, 1);
  assert.deepEqual(settingProblems({ ...good, ALLOW_SIMULATED_PAYMENTS: 'true' }), [], 'allowed on a developer computer');
});

test('a password that is guessed first is refused everywhere a password is chosen', async () => {
  for (const weak of ['12345678', 'Password123', 'aaaaaaaa', 'QWERTYUIOP']) assert.throws(() => assertGoodPassword(weak), /too easy to guess/);
  assert.doesNotThrow(() => assertGoodPassword('blue-mango-42'));
  const signUp = await post('/register/start', null, { first_name: 'Ana', last_name: 'Cruz', username: 'ana_new', email: 'new@example.com', password: '12345678', is_adult: true });
  assert.equal(signUp.status, 400);
  assert.match(signUp.body.message, /too easy to guess/);
  const resetTry = await post('/password/reset', null, { email: 'a@b.co', new_password: 'password', pin: '123456' });
  assert.equal(resetTry.status, 400);
  const change = await post('/profile/password', BUYER, { current_password: 'whatever-it-was', new_password: 'iloveyou' });
  assert.equal(change.status, 400);
  assert.match(change.body.message, /too easy to guess/);
});

test('sign-in checks a password even when the email is unknown', async () => {
  const realCompare = bcrypt.compare;
  let compared = 0;
  bcrypt.compare = (...args) => { compared++; return realCompare(...args); };
  try {
    const r = await post('/login', null, { email: 'nobody@example.com', password: 'whatever1' });
    assert.equal(r.status, 401);
    assert.equal(compared, 1, 'the slow password check ran, so the answer takes as long as for a real account');
  } finally {
    bcrypt.compare = realCompare;
  }
});

test('wrong passwords are counted in the database and lock after 5', async () => {
  const tries = [];
  for (let i = 0; i < 6; i++) tries.push((await post('/login', null, { email: 'lock@example.com', password: 'wrong-one' })).status);
  assert.deepEqual(tries, [401, 401, 401, 401, 401, 429]);
  const keys = Object.keys(db.fails);
  assert.equal(keys.length, 1);
  assert.equal(db.fails[keys[0]], 5);
  assert.match(keys[0], /^[a-f0-9]{64}$/, 'only a fingerprint is saved, not the email');
  assert.equal(loginFailures.size, 0, 'nothing is kept in memory, so a restart does not forget the count');
});

test('one account gets at most 5 reset PINs a day, and the answer never changes', async () => {
  process.env.DEV_LOG_PIN = 'true';
  const realLog = console.log;
  console.log = () => {};   // the test PIN is not printed
  try {
    db.resetUser = 1;
    db.resetAsked = 4;
    const allowed = await post('/password/forgot', null, { email: 'owner@example.com' });
    assert.deepEqual(allowed.body, { ok: true });
    assert.equal(db.pinsIssued, 1);
    assert.ok(db.logs.includes('reset_requested'));

    db.resetAsked = 5;
    const capped = await post('/password/forgot', null, { email: 'owner@example.com' });
    assert.deepEqual(capped.body, { ok: true }, 'same answer, so the limit does not reveal that the account exists');
    assert.equal(db.pinsIssued, 1, 'no new PIN was made');
  } finally {
    console.log = realLog;
    delete process.env.DEV_LOG_PIN;
  }
});

test('a password reset is written in the log', async () => {
  db.pin = { pin_id: 1, pin_hash: bcrypt.hashSync('123456', 4), attempts: 0, expires_at: new Date(Date.now() + 60000) };
  const r = await post('/password/reset', null, { email: 'owner@example.com', new_password: 'blue-mango-42', pin: '123456' });
  assert.equal(r.status, 200);
  assert.ok(db.logs.includes('password_changed'));
});

test('the return link never sends anyone to localhost on a live site', async () => {
  const go = async () => (await fetch(base + '/xendit/return?id=7&to=local', { redirect: 'manual' })).headers.get('location');
  assert.match(await go(), /^http:\/\/localhost:/, 'allowed on a developer computer');
  process.env.NODE_ENV = 'production';
  try {
    assert.equal(await go(), 'https://example.test/transaction.html?id=7&payment=returned');
  } finally {
    delete process.env.NODE_ENV;
  }
});


// ---------- Two-step sign-in for admins (audit item H4) ----------
const totp = require('../lib/totp');
const SECRET = totp.base32Encode(Buffer.from('12345678901234567890'));   // the secret of the standard's own examples
const codeNow = () => totp.codeAt(SECRET, totp.currentStep());
const twoFactorOn = () => { db.twofa = { secret: totp.encryptSecret(SECRET), pending: null, lastStep: null }; };

test('the 6-digit codes match the published examples of the standard', () => {
  assert.equal(totp.codeAt(SECRET, Math.floor(59 / 30)), '287082');            // RFC 6238: 94287082 at 59 seconds
  assert.equal(totp.codeAt(SECRET, Math.floor(1111111109 / 30)), '081804');    // 07081804
  assert.equal(totp.codeAt(SECRET, Math.floor(20000000000 / 30)), '353130');   // 65353130
  assert.equal(totp.base32Decode(totp.base32Encode(Buffer.from('hello world'))).toString(), 'hello world');
});

test('a code works one step early or late, and never twice', () => {
  const now = 1700000000000;
  const step = totp.currentStep(now);
  assert.equal(totp.matchStep(SECRET, totp.codeAt(SECRET, step), null, now), step);
  assert.equal(totp.matchStep(SECRET, totp.codeAt(SECRET, step - 1), null, now), step - 1);
  assert.equal(totp.matchStep(SECRET, totp.codeAt(SECRET, step + 1), null, now), step + 1);
  assert.equal(totp.matchStep(SECRET, totp.codeAt(SECRET, step - 2), null, now), null, 'two steps old is too old');
  assert.equal(totp.matchStep(SECRET, totp.codeAt(SECRET, step), step, now), 'used');
  assert.equal(totp.matchStep(SECRET, 'abcdef', null, now), null);
  assert.equal(totp.matchStep(SECRET, '', null, now), null);
});

test('the authenticator secret is saved encrypted, and a changed copy is refused', () => {
  const saved = totp.encryptSecret(SECRET);
  assert.ok(!saved.includes(SECRET));
  assert.notEqual(saved, totp.encryptSecret(SECRET), 'a fresh random start each time');
  assert.equal(totp.decryptSecret(saved), SECRET);
  const parts = saved.split('.');
  parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith('AA') ? 'BB' : 'AA');
  assert.throws(() => totp.decryptSecret(parts.join('.')));
});

test('an admin with two-step sign-in gets a ticket after the password, and signs in with the code', async () => {
  twoFactorOn();
  db.loginUser = { user_id: ADMIN, email: 'boss@example.com', username: 'boss', role: 'admin', account_status: 'active', password_hash: bcrypt.hashSync('right-password-1', 4), session_id: null };
  const first = await post('/login', null, { email: 'boss@example.com', password: 'right-password-1' });
  assert.equal(first.status, 200);
  assert.equal(first.body.code, 'CODE_NEEDED');
  assert.equal(first.body.token, undefined, 'the password alone gives no login');

  const res = await fetch(base + '/me', { headers: { Authorization: 'Bearer ' + first.body.ticket } });
  assert.equal(res.status, 401, 'the ticket cannot be used as a login');

  const second = await post('/login/2fa', null, { ticket: first.body.ticket, code: codeNow() });
  assert.equal(second.status, 200);
  assert.ok(second.body.token);
  assert.equal(second.body.user.role, 'admin');

  const bad = await post('/login/2fa', null, { ticket: 'not-a-ticket', code: codeNow() });
  assert.equal(bad.status, 401);
});

test('a wrong code, a used code and a used recovery code are refused; 5 wrong codes lock', async () => {
  twoFactorOn();
  assert.equal(await totp.checkSecondFactor(ADMIN, codeNow()), 'code');
  await assert.rejects(totp.checkSecondFactor(ADMIN, codeNow()), /already used/);

  const [recovery] = totp.newRecoveryCodes();
  db.recovery = [totp.hashRecovery(recovery)];
  assert.match(recovery, /^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
  assert.equal(await totp.checkSecondFactor(ADMIN, recovery.toLowerCase()), 'recovery', 'small letters and dashes do not matter');
  await assert.rejects(totp.checkSecondFactor(ADMIN, recovery), /wrong or was already used/);
  assert.ok(db.logs.includes('twofa_recovery_used'));

  db.fails = {};
  for (let i = 0; i < 5; i++) await assert.rejects(totp.checkSecondFactor(ADMIN, '000000'), err => err.status === 403 && err.code === 'CODE_WRONG');
  await assert.rejects(totp.checkSecondFactor(ADMIN, '000000'), err => err.status === 429);
});

test('the admin panel stays locked until two-step sign-in is set up', async () => {
  db.twofa = { secret: null, pending: null, lastStep: null };
  const locked = await get('/admin/overview', ADMIN);
  assert.equal(locked.status, 403);
  assert.equal(locked.body.code, 'TOTP_SETUP_REQUIRED');
  twoFactorOn();
  assert.equal((await get('/admin/overview', ADMIN)).status, 200);
  assert.equal((await get('/admin/overview', BUYER)).status, 403, 'still admins only');
});

test('an admin refund needs a fresh code', async () => {
  reset('paid');
  twoFactorOn();
  const none = await post('/admin/transactions/7/refund', ADMIN, { note: 'seller was banned' });
  assert.equal(none.status, 403);
  assert.equal(none.body.code, 'CODE_REQUIRED');
  const wrong = await post('/admin/transactions/7/refund', ADMIN, { note: 'seller was banned', code: '000000' });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.code, 'CODE_WRONG');
  assert.equal(db.refundSql, null, 'nothing was refunded');
  const right = await post('/admin/transactions/7/refund', ADMIN, { note: 'seller was banned', code: codeNow() });
  assert.equal(right.status, 200);
  assert.ok(db.refundSql);
});

test('setting it up: password, scan, one code, then 8 recovery codes', async () => {
  db.twofa = { secret: null, pending: null, lastStep: null };
  db.passwordHash = bcrypt.hashSync('right-password-1', 4);
  assert.equal((await post('/2fa/setup', BUYER, { password: 'right-password-1' })).status, 403, 'admin accounts only, for now');
  assert.equal((await post('/2fa/setup', ADMIN, { password: 'wrong' })).status, 400);

  const setup = await post('/2fa/setup', ADMIN, { password: 'right-password-1' });
  assert.equal(setup.status, 200);
  assert.match(setup.body.secret, /^[A-Z2-7]{32}$/);
  assert.match(setup.body.qr_image, /^data:image\/png;base64,/);
  assert.equal(db.twofa.secret, null, 'not on until a code proves the scan worked');

  assert.equal((await post('/2fa/enable', ADMIN, { code: '000000' })).status, 400);
  const on = await post('/2fa/enable', ADMIN, { code: totp.codeAt(setup.body.secret, totp.currentStep()) });
  assert.equal(on.status, 200);
  assert.equal(on.body.recovery_codes.length, 8);
  assert.equal(db.recovery.length, 8);
  assert.ok(!db.recovery.includes(on.body.recovery_codes[0]), 'only hashes are saved');
  assert.equal(totp.decryptSecret(db.twofa.secret), setup.body.secret);
  assert.ok(db.logs.includes('twofa_enabled'));

  const status = await get('/2fa', ADMIN);
  assert.deepEqual(status.body, { available: true, enabled: true, required: true, recovery_codes_left: 8 });
});

test('before migration 007 is run, nothing about sign-in or the admin panel changes', async () => {
  assert.equal(db.twofa, null);
  assert.deepEqual((await get('/2fa', ADMIN)).body, { available: false, enabled: false, required: false, recovery_codes_left: 0 });
  assert.equal((await get('/admin/overview', ADMIN)).status, 200);
  assert.equal((await post('/2fa/setup', ADMIN, { password: 'x' })).status, 503);
});

// Keep this one last: after it, the server stays on the in-memory count for the rest of the run
test('before migration 005 is run, wrong passwords are still counted (in memory)', async () => {
  db.noFailTable = true;
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    const tries = [];
    for (let i = 0; i < 6; i++) { db.noFailTable = true; tries.push((await post('/login', null, { email: 'old@example.com', password: 'wrong-one' })).status); }
    assert.deepEqual(tries, [401, 401, 401, 401, 401, 429]);
  } finally {
    console.warn = realWarn;
  }
});
