/* ==========================================================
   data.js – shared names, settings, and small helpers.
   Edit a name here and every page updates.
   Load this file before each page's own script:
     <script src="data.js"></script>
   The real data (users, trades, messages) comes from the database.
   ========================================================== */

const API = 'http://localhost:3000/api';

const ST = {

  /* ---------- Branding ---------- */
  brand: { first: 'Secure', second: 'Trade' },   // shown as SecureTrade (second part is gold)

  /* ---------- Rules (shown on the pages; the server applies the real 3%) ---------- */
  feeRate: 0.03,            // 3% service fee
  autoReleaseHours: 2,      // payment releases this many hours after delivery

  /* ---------- Status key -> [badge class, label] ---------- */
  status: {
    held:             ['badge-held',     'Payment held'],
    waiting_seller:   ['badge-pending',  'Waiting for seller'],
    confirm:          ['badge-released', 'Confirm receipt'],
    dispute:          ['badge-dispute',  'In dispute'],
    await_pay:        ['badge-pending',  'Waiting for your payment'],
    await_buyer_pay:  ['badge-pending',  "Waiting for buyer's payment"],
    completed:        ['badge-released', 'Completed'],
    refunded:         ['badge-dispute',  'Refunded'],
    cancelled:        ['badge-pending',  'Cancelled']
  },

  /* ---------- What a person can ask for in a dispute ---------- */
  outcomeLabels: {
    refund:  'Refund the buyer',
    release: 'Release the payment to the seller',
    fix:     'Ask the other person to fix it'
  },

  methodNames: { gcash: 'GCash', maya: 'Maya', card: 'Card' }
};

/* ==========================================================
   Small helpers for the page
   ========================================================== */

const $ = id => document.getElementById(id);

// Make an element with a class and text
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// Make a button that is safe inside a form
function makeButton(cls, text, onClick) {
  const b = el('button', cls, text);
  b.type = 'button';
  if (onClick) b.addEventListener('click', () => onClick(b));
  return b;
}

// Show a message in the element with this id, or hide it when the message is empty
function setMessage(id, msg) {
  const box = $(id);
  box.textContent = msg;
  box.hidden = !msg;
}

// Put a text value in many elements: setTexts({ 'some-id': 'value' })
function setTexts(values) {
  Object.keys(values).forEach(id => { $(id).textContent = values[id]; });
}

function setDisabled(ids, disabled) {
  ids.forEach(id => { $(id).disabled = disabled; });
}

// A clear message when the server cannot be reached
function netError(err) {
  return err instanceof TypeError ? 'Cannot reach the server. Is the backend running?' : err.message;
}

// A short tab group: one button is selected at a time
function bindTabs(selector, attribute, onPick) {
  const buttons = document.querySelectorAll(selector);
  buttons.forEach(btn => btn.addEventListener('click', () => {
    buttons.forEach(b => b.setAttribute(attribute, b === btn));
    onPick(btn);
  }));
}

// "Resend PIN" waits between sends
const cooldownTimers = new Map();

function stopCooldown(button) {
  clearInterval(cooldownTimers.get(button));
}

function startCooldown(button, seconds) {
  stopCooldown(button);
  let left = seconds;
  const paint = () => { button.textContent = 'Resend PIN (' + left + 's)'; };
  button.disabled = true;
  paint();
  cooldownTimers.set(button, setInterval(() => {
    left--;
    if (left > 0) return paint();
    stopCooldown(button);
    button.disabled = false;
    button.textContent = 'Resend PIN';
  }, 1000));
}

/* ==========================================================
   Formatting
   ========================================================== */

// ₱1,500.00
ST.peso = n => '₱' + n.toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// ₱1,500
ST.pesoShort = n => '₱' + n.toLocaleString('en-PH');

// "Oct 18, 2026"
function fmtDate(iso) {
  return new Date(iso).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
}

// "Oct 18, 3:05 PM"
function fmtTime(iso) {
  return new Date(iso).toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// "October 2026"
function fmtMonthYear(iso) {
  return new Date(iso).toLocaleDateString('en-PH', { month: 'long', year: 'numeric' });
}

// "GCash 09••••••123"
ST.methodLabel = (method, masked) => (ST.methodNames[method] || method) + (masked ? ' ' + masked : '');

// The game, item and details are saved together as: "Game – Item. Details"
ST.splitDescription = desc => {
  const text = String(desc || '');
  const i = text.indexOf(' – ');
  if (i < 0) return { game: '', title: text, details: '' };
  const game = text.slice(0, i);
  const rest = text.slice(i + 3);
  const j = rest.indexOf('. ');
  return j < 0
    ? { game, title: rest, details: '' }
    : { game, title: rest.slice(0, j), details: rest.slice(j + 2) };
};

/* ==========================================================
   Badges and branding
   ========================================================== */

// A coloured status badge element
ST.badge = key => {
  const s = ST.status[key] || ['badge-pending', key];
  return el('span', 'badge ' + s[0], s[1]);
};

// The badge for a dispute: open, under review, or how it ended
ST.disputeBadge = d => {
  if (d.dispute_status === 'resolved') {
    return d.trade_status === 'refunded'
      ? el('span', 'badge badge-pending', 'Refunded to buyer')
      : el('span', 'badge badge-released', 'Paid to seller');
  }
  return d.dispute_status === 'under_review'
    ? el('span', 'badge badge-held', 'Under review')
    : el('span', 'badge badge-dispute', 'Open');
};

// Fill every .brand element and the page title with the brand name
ST.applyBrand = () => {
  document.querySelectorAll('.brand').forEach(brand => {
    brand.textContent = ST.brand.first;
    brand.appendChild(el('span', '', ST.brand.second));
  });
  document.title = document.title.replace('SecureTrade', ST.brand.first + ST.brand.second);
};
