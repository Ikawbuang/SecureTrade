const { HttpError, isParty, logActivity, pool, queryAll, queryOne, requireNumeric, sameId } = require('./core');


// The GCash number sent with a payment or a delivery: 11 digits, starting with 09
function readGcashNumber(req, invalidMessage) {
  const number = String(req.body.number || '').replace(/[\s-]/g, '');
  requireNumeric(req.params.id, 'Invalid trade.');
  if (req.body.method && req.body.method !== 'gcash') throw new HttpError(400, 'Only GCash is accepted.');
  if (!/^09\d{9}$/.test(number)) throw new HttpError(400, invalidMessage);
  return number;
}


// Lock one trade and make sure this user may do this step
async function lockTrade(client, id, userId, { role, status }) {
  const t = await queryOne(client, 'SELECT * FROM transactions WHERE transaction_id = $1 FOR UPDATE', [id]);
  if (!t || !isParty(t, userId)) {
    throw new HttpError(404, 'Trade not found.');
  }
  const owner = role === 'buyer' ? t.buyer_id : t.seller_id;
  if (!sameId(owner, userId)) throw new HttpError(403, 'Only the ' + role + ' can do this.');
  if (t.status !== status) throw new HttpError(409, 'This step is not available for the trade\'s current status.');
  return t;
}


// Make sure the money for this trade is really held (and lock the payment row)
async function assertPaymentHeld(client, transactionId, message) {
  const pay = await queryOne(client, 'SELECT payment_status FROM escrow_payments WHERE transaction_id = $1 FOR UPDATE', [transactionId]);
  if (!pay || pay.payment_status !== 'held') throw new HttpError(409, message);
}


function markPaymentRefunded(client, transactionId) {
  return client.query(`UPDATE escrow_payments SET payment_status = 'refunded' WHERE transaction_id = $1`, [transactionId]);
}


// Release the held payment to the seller and issue the receipt
async function releasePayment(client, transactionId) {
  await client.query(
    `UPDATE escrow_payments SET payment_status = 'released', released_at = now() WHERE transaction_id = $1`,
    [transactionId]
  );
  await client.query(`UPDATE transactions SET status = 'completed' WHERE transaction_id = $1`, [transactionId]);
  const number = 'ST-' + String(transactionId).padStart(4, '0');
  await client.query(
    `INSERT INTO receipts (transaction_id, receipt_number) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [transactionId, number]
  );
}


// Hold the buyer's money for this trade
async function markTradePaid(client, trade, payerNumber) {
  await client.query(
    `INSERT INTO escrow_payments (transaction_id, payment_method, payer_number, amount_held, payment_status)
     VALUES ($1, 'gcash', $2, $3, 'held')`,
    [trade.transaction_id, payerNumber, trade.amount]
  );
  await client.query(`UPDATE transactions SET status = 'paid' WHERE transaction_id = $1`, [trade.transaction_id]);
  await logActivity(client, trade.buyer_id, trade.transaction_id, 'paid', 'with GCash, ₱' + Number(trade.amount));
}


function getDeliveryProofs(tradeId) {
  return queryAll(
    pool,
    'SELECT proof_id, description AS name, uploaded_at FROM delivery_proofs WHERE transaction_id = $1 ORDER BY proof_id',
    [tradeId]
  );
}
module.exports = { readGcashNumber, lockTrade, assertPaymentHeld, markPaymentRefunded, releasePayment, markTradePaid, getDeliveryProofs };
