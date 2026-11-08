startPage();


let pastTrades = [];

// ---------- The table ----------
function matches(h) {
  const q = $('search').value.trim().toLowerCase().replace(/^@/, '');
  const text = (h.item_description + ' ' + h.partner_username + ' ' + (h.receipt_number || '') + ' ' + h.transaction_id).toLowerCase();
  return (
    ($('status').value === 'all' || h.status === $('status').value) &&
    ($('role').value === 'all' || h.my_role === $('role').value) &&
    text.includes(q)
  );
}

function actionsCell(h) {
  const box = el('div', 'row-actions');

  const details = el('a', '', h.had_dispute ? 'View dispute' : 'Details');
  details.href = (h.had_dispute ? 'dispute.html?id=' : 'transaction.html?id=') + h.transaction_id;
  box.appendChild(details);

  if (h.status === 'completed') {
    box.appendChild(makeButton('link-btn', 'Receipt', () => showReceipt(h)));
    box.appendChild(h.my_score
      ? el('span', 'rated', 'Rated ★ ' + h.my_score)
      : makeButton('link-btn', 'Rate', () => openRate(h)));
  }
  return box;
}

function tradeRow(h) {
  // The partner, with a star to save them as a favorite
  const partner = el('span', 'partner-cell');
  partner.append('@' + h.partner_username, makeStar(h.partner_username, h.partner_is_favorite));

  // Status badge, and a small tag if the trade went through a dispute
  const status = el('div');
  status.appendChild(ST.badge(h.status));
  if (h.had_dispute) status.appendChild(el('span', 'dispute-tag', 'Had a dispute'));

  return tableRow([
    fmtDate(h.date),
    h.item_description,
    el('td', 'role', h.my_role === 'buyer' ? 'Buyer' : 'Seller'),
    partner,
    ST.pesoShort(h.amount),
    status,
    actionsCell(h)
  ]);
}

function render() {
  const shown = pastTrades.filter(matches);
  $('rows').replaceChildren(...shown.map(tradeRow));

  const empty = $('empty');
  empty.hidden = shown.length > 0;
  empty.textContent = pastTrades.length === 0
    ? 'No finished trades yet. Completed, refunded, and cancelled trades will show up here.'
    : 'No trades match your search. Try a different word or status.';
}

$('search').addEventListener('input', render);
$('status').addEventListener('change', render);
$('role').addEventListener('change', render);

async function load() {
  try {
    pastTrades = await apiFetch('/history');
    setMessage('page-error', '');
    render();
  } catch (err) {
    setMessage('page-error', netError(err));
  }
}

// ---------- Receipt ----------
function showReceipt(h) {
  const paymentText = (method, masked) => method ? ST.methodLabel(method, masked) : '–';
  setTexts({
    'r-number': h.receipt_number || '–',
    'r-id': '#' + h.transaction_id,
    'r-date': fmtDate(h.date),
    'r-item': h.item_description,
    'r-buyer': '@' + h.buyer_username + (h.my_role === 'buyer' ? ' (you)' : ''),
    'r-seller': '@' + h.seller_username + (h.my_role === 'seller' ? ' (you)' : ''),
    'r-paid': paymentText(h.payment_method, h.payer_masked),
    'r-payout': paymentText(h.payout_method, h.payout_masked),
    'r-price': ST.peso(h.amount),
    'r-fee': ST.peso(h.service_fee),
    'r-net': ST.peso(h.amount - h.service_fee)
  });
  $('receipt').showModal();
}
$('r-close').addEventListener('click', () => $('receipt').close());
$('r-print').addEventListener('click', () => window.print());

// ---------- Rating ----------
const stars = makeStarRating($('stars'));
let rateTrade = null;

function openRate(h) {
  rateTrade = h;
  stars.set(0);
  $('rate-title').textContent = 'Rate @' + h.partner_username;
  $('rate-sub').textContent = 'Trade #' + h.transaction_id + ' · ' + h.item_description;
  $('rate-feedback').value = '';
  setMessage('rate-error', '');
  $('rate-save').disabled = false;
  $('rate').showModal();
}

$('rate-cancel').addEventListener('click', () => $('rate').close());

$('rate-form').addEventListener('submit', async e => {
  e.preventDefault();
  setMessage('rate-error', '');
  if (!stars.value) { setMessage('rate-error', 'Choose 1 to 5 stars.'); return; }
  $('rate-save').disabled = true;
  try {
    await postJson('/transactions/' + rateTrade.transaction_id + '/rating', { score: stars.value, feedback: $('rate-feedback').value });
    $('rate').close();
    await load();
  } catch (err) {
    setMessage('rate-error', netError(err));
    $('rate-save').disabled = false;
  }
});

load();
