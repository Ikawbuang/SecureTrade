// Tests for the rules that protect money and accounts.
// They run the real routes against a stand-in database and a stand-in Xendit, so nothing real is touched.
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

Object.assign(process.env, {
  DATABASE_URL: 'postgres://test',
  JWT_SECRET: 'test-secret',
  XENDIT_SECRET_KEY: 'xnd_development_test',
  XENDIT_WEBHOOK_TOKEN: 'hook-token',
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
    calls: [], qrOpen: null, prState: { status: 'REQUIRES_ACTION' },
  };
}

function fakeQuery(sql, p = []) {
  if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [] };
  if (/kind = 'qr' AND status = 'ACTIVE'/.test(sql)) return { rows: db.qrOpen ? [db.qrOpen] : [] };
  if (/INSERT INTO xendit_sessions \(session_id, transaction_id, kind/.test(sql)) {
    db.qrOpen = { session_id: p[0], qr_string: p[2], expires_at: new Date(Date.now() + 900000) };
    return { rows: [db.qrOpen] };
  }
  if (/SELECT session_id, kind, expires_at > now\(\) AS open/.test(sql)) return { rows: [] };
  if (/SELECT amount FROM xendit_sessions/.test(sql)) return { rows: [{ amount: '200.00' }] };
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
  await Promise.all(Array.from({ length: 20 }, (_, i) => post('/password/reset', null, { email: 'a@b.co', new_password: 'password1', pin: String(200000 + i) })));
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
