startPage();

const me = getUser() || {};
const tradeId = new URLSearchParams(location.search).get('id');
const peso = ST.peso;

const view = $('trade-view');
const tracker = $('tracker');
const moneyBox = $('money');
const notice = $('notice');
const actions = $('actions');
const box = $('messages');
const rateCard = $('rate-card');

let data = null;
let lastSignature = '';
let lastMessageSignature = '';
let pendingPaymentNote = '';   // shown once after coming back from the checkout page

// Rating state
let myScore = null;         // my rating for this trade, once I have rated
let rateLoaded = false;     // did we already check whether I rated?
let rateSkipped = false;    // "Skip for now" hides the box until the page is reloaded
let rateDrawnKey = '';      // what the rating box is showing now, so typing is not reset

const showPageError = msg => setMessage('page-error', msg);
const showActionError = msg => setMessage('action-error', msg);

// "GCash 09••••••123"
function methodWithNumber(method, masked) {
  return ST.methodLabel(method || 'gcash', masked);
}

function badgeFor(d, role) {
  const pick = key => ST.status[key];
  const map = {
    pending:   ['badge-pending', 'Waiting for partner'],
    accepted:  role === 'buyer' ? pick('await_pay') : pick('await_buyer_pay'),
    paid:      role === 'buyer' ? pick('waiting_seller') : ['badge-held', 'Your turn: deliver the item'],
    delivered: role === 'buyer' ? pick('confirm') : ['badge-pending', 'Waiting for buyer'],
    disputed:  pick('dispute'),
    completed: pick('completed'),
    refunded:  pick('refunded'),
    cancelled: pick('cancelled')
  };
  return map[d.status] || ['badge-pending', d.status];
}

function noticeFor(d, role, partner, net) {
  const hours = ST.autoReleaseHours;
  const price = peso(Number(d.amount));
  const iCancelled = d.cancelled_by && String(d.cancelled_by) === String(me.user_id);
  switch (d.status) {
    case 'pending':
      return d.created_by_me
        ? { text: 'Waiting for @' + partner + ' to accept your request. It is cancelled automatically if nobody answers in 12 hours, or you can cancel it yourself.' }
        : { text: '@' + partner + ' sent you this request. Accept or decline it on your dashboard. It is cancelled automatically if nobody answers in 12 hours.' };
    case 'accepted':
      return role === 'buyer'
        ? { text: (d.simulated_payments ? 'Enter the GCash number you are paying from. ' : 'Pay with GCash on the secure checkout page. ')
            + 'The money goes to SecureTrade, not to the seller, and stays there until you confirm the item arrived.'
            + (d.simulated_payments ? ' Payments are simulated for now.' : ' After you pay, this page updates by itself.') }
        : { text: 'Waiting for the buyer to pay into escrow. Do not hand over the item until the payment is held.' };
    case 'paid':
      return role === 'buyer'
        ? { text: 'Your payment of ' + price + ' is safe in escrow. You can confirm once the seller marks the item as delivered. If the seller cancels, you are refunded in full.' }
        : { text: 'The payment is safe in escrow. Hand over the item in-game. When you mark it as delivered, enter the GCash number where you want to receive your money. If you cannot deliver, you can cancel and the buyer is refunded in full.' };
    case 'delivered':
      return role === 'buyer'
        ? { text: 'Check your game account first. If you do nothing, payment releases to the seller automatically ' + hours + ' hours after delivery.' }
        : { text: '@' + partner + ' has ' + hours + ' hours to confirm. If they do not respond, ' + peso(net) + ' releases to you automatically.' };
    case 'completed':
      return {
        ok: true,
        text: (role === 'buyer'
          ? 'Trade complete. ' + peso(net) + ' was sent to @' + partner + '.'
          : 'Trade complete. ' + peso(net) + ' was sent to your GCash.')
          + (d.receipt ? ' Receipt ' + d.receipt.receipt_number + '.' : '')
      };
    case 'disputed':
      return { text: 'This trade is in dispute. An admin will review it.' };
    case 'refunded':
      if (d.cancelled_by_username) {
        return {
          text: (iCancelled ? 'You cancelled this trade. ' : 'The seller cancelled this trade. ')
            + (role === 'buyer' ? 'Your payment of ' + price + ' was refunded in full.' : 'The buyer was refunded in full.')
            + (d.cancel_reason ? ' Reason: ' + d.cancel_reason : '')
        };
      }
      if (d.cancel_reason) {
        return {
          text: 'An admin refunded this trade. '
            + (role === 'buyer' ? 'Your payment of ' + price + ' was returned in full.' : 'The buyer was refunded in full.')
            + ' Reason: ' + d.cancel_reason
        };
      }
      return { text: 'This trade was refunded by an admin after a dispute.' };
    case 'cancelled':
      if (d.cancelled_by_username) {
        return {
          text: (iCancelled ? 'You cancelled this trade.' : '@' + d.cancelled_by_username + ' cancelled this trade.')
            + (d.cancel_reason ? ' Reason: ' + d.cancel_reason : '')
        };
      }
      return { text: 'This request expired because nobody answered in 12 hours, or it was cancelled.' };
    default:
      return { text: '' };
  }
}

// Run one step (pay, deliver, confirm, cancel), then reload the trade
async function act(path, body, button) {
  showActionError('');
  button.disabled = true;
  try {
    await postJson('/transactions/' + tradeId + path, body || {});
    await load();
  } catch (err) {
    showActionError(err.message);
    button.disabled = false;
  }
}

function addButton(text, onClick) {
  const b = makeButton('btn btn-primary', text, onClick);
  actions.appendChild(b);
  return b;
}

function addLink(text, href) {
  const link = el('a', 'btn btn-outline', text);
  link.href = href;
  actions.appendChild(link);
}

// Buyer pays -> SecureTrade escrow -> Seller payout (GCash only)
function renderMoney(d, role, price, net) {
  // 0 = nothing yet, 1 = waiting for the buyer's payment, 2 = held in escrow, 3 = paid out
  const stage = { accepted: 1, paid: 2, delivered: 2, disputed: 2, completed: 3 }[d.status] || 0;

  const buyerLine = d.payment
    ? methodWithNumber(d.payment.payment_method, d.payment.payer_masked) + ' · ' + peso(price)
    : 'GCash · ' + peso(price);
  const sellerLine = d.payout_method
    ? methodWithNumber(d.payout_method, d.payout_masked)
    : (role === 'seller'
        ? 'You enter your GCash number when you mark the item as delivered'
        : 'The seller adds their GCash number when delivering the item');

  const boxes = [
    {
      cls: stage >= 2 ? 'done' : (stage === 1 ? 'active' : ''),
      title: role === 'buyer' ? 'You pay' : 'Buyer pays',
      lines: [buyerLine]
    },
    {
      cls: stage === 3 ? 'done' : (stage === 2 ? 'active' : ''),
      title: 'SecureTrade escrow',
      lines: [stage === 3 ? 'Released' : (stage === 2 ? 'Holding ' + peso(price) : 'Holds the payment until the buyer confirms')]
    },
    {
      cls: stage === 3 ? 'done' : '',
      title: role === 'seller' ? 'You get paid' : 'Seller gets paid',
      lines: [sellerLine, peso(net) + ' after the ' + (ST.feeRate * 100) + '% fee']
    }
  ];

  moneyBox.innerHTML = '';
  boxes.forEach((b, i) => {
    if (i > 0) moneyBox.appendChild(el('div', 'arrow', '→'));
    const div = el('div', 'box ' + b.cls);
    div.appendChild(el('strong', '', b.title));
    b.lines.forEach(text => div.appendChild(el('div', '', text)));
    moneyBox.appendChild(div);
  });
}

// The box where a person types a GCash number
function addGcashInput(placeholder, label) {
  const number = el('input');
  number.type = 'tel';
  number.inputMode = 'numeric';
  number.maxLength = 11;
  number.placeholder = placeholder;
  number.setAttribute('aria-label', label);
  actions.appendChild(number);
  return number;
}

// Buyer: type the GCash number to pay from
function addPayControls(price) {
  if (!data.simulated_payments) {
    addButton('Pay ' + peso(price) + ' with GCash', goToCheckout);
    return;
  }
  const number = addGcashInput('GCash number 09XXXXXXXXX', 'GCash number you are paying from');
  addButton('Pay ' + peso(price) + ' with GCash', btn =>
    act('/pay', { method: 'gcash', number: number.value }, btn));
}

// Buyer: open the Xendit checkout page
async function goToCheckout(button) {
  showActionError('');
  button.disabled = true;
  try {
    const reply = await postJson('/transactions/' + tradeId + '/pay');
    if (reply.checkout_url) window.location.href = reply.checkout_url;
    else await load();   // the payment had already gone through
  } catch (err) {
    showActionError(netError(err));
    button.disabled = false;
  }
}

// Back from the checkout page: ask whether the payment went through (it can take a moment to appear)
async function checkReturnedPayment() {
  if (new URLSearchParams(location.search).get('payment') !== 'returned') return;
  history.replaceState(null, '', 'transaction.html?id=' + tradeId);
  try {
    for (let tries = 0; tries < 3; tries++) {
      const { status } = await postJson('/transactions/' + tradeId + '/pay/check');
      if (status !== 'accepted') return;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    pendingPaymentNote = 'No payment has been confirmed yet. If you paid, this page updates by itself within a minute or two. Please do not pay again.';
  } catch (err) {
    pendingPaymentNote = netError(err);
  }
}

// Seller: type the GCash number to receive the money, then mark the item as delivered
function addDeliverControls() {
  const number = addGcashInput('Your GCash number to receive the money', 'GCash number to receive your money');
  addButton('I delivered the item', btn =>
    act('/deliver', { method: 'gcash', number: number.value }, btn));
}

// Cancel: the request (by the sender), the trade before payment (either person),
// or after payment (the seller only, with a reason, and the buyer is refunded)
function addCancelControls(d, role) {
  if (d.status === 'pending' && d.created_by_me) {
    const b = addButton('Cancel request', btn => {
      if (window.confirm('Cancel this request?')) act('/cancel', {}, btn);
    });
    b.className = 'btn btn-outline';
  }

  if (d.status === 'accepted') {
    const b = addButton('Cancel trade', btn => {
      if (window.confirm('Cancel this trade? Nothing was paid yet.')) act('/cancel', {}, btn);
    });
    b.className = 'btn btn-outline';
  }

  if (d.status === 'paid' && role === 'seller') {
    const reason = el('input', 'wide');
    reason.type = 'text';
    reason.maxLength = 300;
    reason.placeholder = 'Reason for cancelling (required)';
    reason.setAttribute('aria-label', 'Reason for cancelling');
    actions.appendChild(reason);

    const b = addButton('Cancel and refund the buyer', btn => {
      const text = reason.value.trim();
      if (text.length < 5) { showActionError('Write a short reason for cancelling.'); return; }
      if (!window.confirm('Cancel this trade and refund the buyer in full? This cannot be undone.')) return;
      act('/cancel', { reason: text }, btn);
    });
    b.className = 'btn btn-danger';
  }
}

function renderView() {
  const d = data;
  const role = d.my_role;
  const partner = role === 'buyer' ? d.seller_username : d.buyer_username;
  const partnerAvatar = role === 'buyer' ? d.seller_avatar : d.buyer_avatar;
  const partnerVerified = role === 'buyer' ? d.seller_verified : d.buyer_verified;
  const price = Number(d.amount);
  const fee = Number(d.service_fee);
  const net = price - fee;
  const info = ST.splitDescription(d.item_description);

  // Header
  setTexts({ title: info.title, subtitle: 'Trade #' + d.transaction_id + ' · You are the ' + role });
  const badge = $('status-badge');
  const b = badgeFor(d, role);
  badge.className = 'badge ' + b[0];
  badge.textContent = b[1];

  // Tracker
  const doneCount = { pending: 0, accepted: 0, paid: 1, delivered: 2, completed: 4, disputed: 1, refunded: 1, cancelled: 0 }[d.status] || 0;
  const inProgress = ['accepted', 'paid', 'delivered'].includes(d.status);
  const steps = [
    ['Buyer pays', role === 'buyer' ? 'Pay into escrow.' : 'Waiting for the buyer to pay.'],
    ['Seller delivers', role === 'seller' ? 'Hand over the item in-game.' : 'Waiting for @' + d.seller_username + ' to hand over the item.'],
    ['Buyer checks', role === 'buyer' ? 'Confirm you received it.' : 'Buyer confirms receipt.'],
    ['Seller is paid', role === 'seller' ? peso(net) + ' is sent to you.' : 'Funds are sent to the seller.']
  ];
  tracker.innerHTML = '';
  steps.forEach((s, i) => {
    const li = el('li', i < doneCount ? 'done' : (inProgress && i === doneCount ? 'current' : ''));
    li.dataset.n = i + 1;
    li.append(el('strong', '', s[0]), s[1]);
    tracker.appendChild(li);
  });

  // Where the money goes
  renderMoney(d, role, price, net);

  // Notice
  const n = noticeFor(d, role, partner, net);
  notice.className = 'notice' + (n.ok ? ' ok' : '');
  notice.textContent = n.text + (['completed', 'refunded'].includes(d.status) ? ' ' + ST.testModeNote : '');
  $('chat-form').hidden = ['completed', 'refunded', 'cancelled'].includes(d.status);

  // Actions
  actions.innerHTML = '';
  showActionError('');
  if (role === 'buyer' && d.status === 'accepted') addPayControls(price);
  if (role === 'seller' && d.status === 'paid') addDeliverControls();
  if (role === 'buyer' && d.status === 'delivered') {
    addButton('I received the item', btn => act('/confirm', {}, btn));
  }
  addCancelControls(d, role);
  if (['paid', 'delivered'].includes(d.status)) {
    addLink('Something is wrong', 'dispute.html?id=' + d.transaction_id);
  }
  addLink('Back to dashboard', 'dashboard.html');

  // Details (the partner row shows their photo, a Verified badge, and a star)
  const partnerCell = el('span', 'person-cell');
  partnerCell.append(makeAvatar(partner, partnerAvatar, 28), '@' + partner);
  partnerCell.appendChild(partnerVerified ? verifiedBadge() : notVerifiedTag());
  partnerCell.appendChild(makeStar(partner, d.partner_is_favorite));

  const rows = [];
  if (info.game) rows.push(['Game', info.game]);
  if (info.details) rows.push(['Item details', info.details]);
  rows.push([role === 'buyer' ? 'Seller' : 'Buyer', partnerCell]);
  rows.push(['Price', peso(price)]);
  rows.push(['Service fee (' + (ST.feeRate * 100) + '%)', peso(fee)]);
  rows.push([role === 'seller' ? 'You receive' : 'Seller receives', peso(net)]);
  if (d.payout_method) {
    rows.push([role === 'seller' ? 'Paid out to' : 'Seller paid out to', methodWithNumber(d.payout_method, d.payout_masked)]);
  }
  if (d.payment) {
    rows.push([
      role === 'buyer' ? 'You paid with' : 'Buyer paid with',
      methodWithNumber(d.payment.payment_method, d.payment.payer_masked)
    ]);
    rows.push(['Payment status', d.payment.payment_status]);
  }
  if (d.receipt) rows.push(['Receipt', d.receipt.receipt_number]);
  rows.push(['Started', fmtDate(d.created_at)]);

  const dl = $('details');
  dl.innerHTML = '';
  rows.forEach(([label, value]) => {
    const dd = el('dd');
    dd.append(value);
    const line = el('div', 'line');
    line.append(el('dt', '', label), dd);
    dl.appendChild(line);
  });

  $('chat-title').replaceChildren(makeAvatar(partner, partnerAvatar, 30), 'Chat with @' + partner);
}

// ---------- Rating box: shown only after the trade is completed ----------
// Find out whether I already rated this trade (the history list holds my rating)
async function loadRating() {
  if (!data || data.status !== 'completed') {
    rateCard.hidden = true;
    rateDrawnKey = '';
    return;
  }
  if (!rateLoaded) {
    try {
      const list = await apiFetch('/history');
      const mine = list.find(h => String(h.transaction_id) === String(tradeId));
      myScore = mine && mine.my_score ? Number(mine.my_score) : null;
      rateLoaded = true;
    } catch (err) {
      return;   // try again on the next refresh
    }
  }
  drawRating();
}

function drawRating() {
  const d = data;
  const partner = d.my_role === 'buyer' ? d.seller_username : d.buyer_username;
  const key = myScore ? 'rated:' + myScore : (rateSkipped ? 'skipped' : 'form');
  if (key === rateDrawnKey) return;     // nothing changed, so typed feedback is not lost
  rateDrawnKey = key;

  rateCard.innerHTML = '';
  rateCard.hidden = key === 'skipped';
  if (key === 'skipped') return;

  if (myScore) {
    rateCard.appendChild(el('p', 'rated-line', 'You rated @' + partner + ' ★ ' + myScore + '. Thank you!'));
    return;
  }

  const heading = el('h2', '', 'Rate @' + partner);
  const hint = el('p', 'hint', 'How was the trade? Your rating helps other gamers. You can rate once, and it cannot be changed. '
    + 'Your name is hidden from the public, but admins can see it. Do not write personal information.');

  const starsBox = el('div', 'stars');
  starsBox.setAttribute('role', 'radiogroup');
  starsBox.setAttribute('aria-label', 'Your rating');
  const stars = makeStarRating(starsBox);

  const label = el('label', '', 'Feedback (optional)');
  label.setAttribute('for', 'rate-feedback');
  const text = el('textarea');
  text.id = 'rate-feedback';
  text.rows = 3;
  text.maxLength = 500;
  text.placeholder = 'Example: fast delivery, easy to trade with';

  const error = el('p', 'form-error');
  error.setAttribute('role', 'alert');
  error.hidden = true;
  const showError = msg => { error.textContent = msg; error.hidden = !msg; };

  const save = makeButton('btn btn-primary', 'Save rating', async () => {
    showError('');
    if (!stars.value) { showError('Choose 1 to 5 stars.'); return; }
    save.disabled = true;
    try {
      await postJson('/transactions/' + tradeId + '/rating', { score: stars.value, feedback: text.value });
      myScore = stars.value;
      drawRating();
    } catch (err) {
      showError(netError(err));
      save.disabled = false;
    }
  });
  const skip = makeButton('btn btn-outline', 'Skip for now', () => { rateSkipped = true; drawRating(); });

  const row = el('div', 'rate-actions');
  row.append(save, skip);
  rateCard.append(heading, hint, starsBox, label, text, error, row);
}

function renderMessages() {
  box.innerHTML = '';
  if (data.messages.length === 0) {
    box.appendChild(el('p', 'no-msgs', 'No messages yet. Say hello to start the chat.'));
    return;
  }
  data.messages.forEach(m => {
    const mine = String(m.sender_id) === String(me.user_id);

    const time = new Date(m.sent_at).toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' });
    const msg = el('div', 'msg' + (mine ? ' me' : ''));
    msg.append(el('small', '', (mine ? 'You' : '@' + m.username) + ' · ' + time), m.content);

    const row = el('div', 'msgrow' + (mine ? ' me' : ''));
    row.append(makeAvatar(m.username, m.avatar_file, 30), msg);
    box.appendChild(row);
  });
  box.scrollTop = box.scrollHeight;
}

async function load() {
  try {
    data = await apiFetch('/transactions/' + tradeId);
  } catch (err) {
    if (!data) {
      showPageError(netError(err));
    }
    return;
  }
  showPageError('');
  view.hidden = false;

  // Only redraw what changed, so typed numbers are not reset
  const signature = [
    data.status,
    data.payment ? data.payment.payment_status + (data.payment.payer_masked || '') : '',
    data.receipt ? 'r' : '',
    data.payout_method || '',
    data.payout_masked || '',
    data.cancelled_by || '',
    data.cancel_reason || '',
    data.buyer_username, data.seller_username,
    data.buyer_avatar || '', data.seller_avatar || '',
    data.buyer_verified, data.seller_verified
  ].join(':');
  if (signature !== lastSignature) {
    lastSignature = signature;
    renderView();
  }
  if (pendingPaymentNote) {
    showActionError(pendingPaymentNote);
    pendingPaymentNote = '';
  }

  const messageSignature = data.messages.map(m => m.message_id + (m.avatar_file || '') + m.username).join('|');
  if (messageSignature !== lastMessageSignature) {
    lastMessageSignature = messageSignature;
    renderMessages();
  }

  await loadRating();
}

// Chat
const input = $('chat-input');
$('chat-form').addEventListener('submit', async e => {
  e.preventDefault();
  const content = input.value.trim();
  if (!content) return;
  input.value = '';
  try {
    await postJson('/transactions/' + tradeId + '/messages', { content });
    await load();
  } catch (err) {
    input.value = content;
    showActionError(err.message);
  }
});

if (!/^\d+$/.test(String(tradeId))) {
  showPageError('No trade selected. Open a trade from your dashboard.');
} else {
  checkReturnedPayment().finally(() => {
    load();
    setInterval(load, 5000);   // pick up new messages and status changes
  });
}
