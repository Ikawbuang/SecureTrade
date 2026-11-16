startPage();

const me = getUser() || {};
$('me-first').textContent = me.username || (me.full_name || '').split(' ')[0] || 'there';
if (me.role === 'admin') $('admin-link').hidden = false;

// A message at the top of the page. It scrolls up so it is always seen.
function showPageError(msg) {
  setMessage('page-error', msg);
  if (msg) window.scrollTo({ top: 0, behavior: 'smooth' });
}


// ---------- My profile and the verification banner ----------
async function loadMe() {
  try {
    const p = await apiFetch('/profile');
    rememberProfile(p);

    $('me-first').textContent = p.username;
    $('me-avatar').replaceChildren(makeAvatar(p.username, p.avatar_file, 72));
    $('me-username').replaceChildren('@' + p.username);
    if (p.verified) $('me-username').appendChild(verifiedBadge());
    $('me-full').textContent = p.full_name;
    $('me-email').textContent = p.email;
    $('me-joined').textContent = 'Member since ' + fmtMonthYear(p.created_at);
    $('me-completed').textContent = p.completed_trades;
    $('me-rating').textContent = p.avg_rating === null ? '–' : '★ ' + p.avg_rating.toFixed(1);
    $('me-rating-cap').textContent = p.rating_count
      ? p.rating_count + (p.rating_count === 1 ? ' rating' : ' ratings')
      : 'Rating';
    $('me-active').textContent = p.active_trades;

    const banner = $('verify-banner');
    banner.className = 'banner';
    if (p.verified) {
      banner.hidden = true;
    } else {
      const v = await apiFetch('/verification');
      banner.hidden = false;

      // People who pressed Trade on me while I was not verified
      const names = (v.attempts || []).map(a => '@' + a.username);
      const tried = names.length
        ? ' ' + names.join(', ') + ' tried to trade with you. Verify to receive trade requests.'
        : '';

      if (v.pending) {
        $('verify-text').replaceChildren(el('strong', '', 'Your verification is being reviewed'), 'You can start or accept trades once an admin approves it.' + tried);
        $('verify-link').textContent = 'View status';
      } else if (v.rejected) {
        banner.classList.add('bad');
        $('verify-text').replaceChildren(el('strong', '', 'Your verification was rejected'), (v.rejected.reject_reason || '') + ' Send a new request.' + tried);
        $('verify-link').textContent = 'Try again';
      } else {
        $('verify-text').replaceChildren(el('strong', '', 'Verify your identity to start or accept trades'), 'It takes a few minutes: an ID and a selfie holding it. You must be 18 or older.' + tried);
        $('verify-link').textContent = 'Verify now';
      }
    }
  } catch (err) { /* connection problems show in the main error line */ }
}

// ---------- Reminder: finished trades I have not rated yet (last 7 days) ----------
// "Rate later" is saved in the database, so the reminder does not come back on any device.
// The trade can still be rated from History or from the trade page.
async function loadRateReminders() {
  try {
    const list = await apiFetch('/history');
    const week = 7 * 24 * 60 * 60 * 1000;
    const todo = list
      .filter(h => h.status === 'completed' && !h.my_score && !h.rate_later && (Date.now() - new Date(h.date).getTime()) < week)
      .slice(0, 3);

    const box = $('rate-remind');
    box.innerHTML = '';
    todo.forEach(h => {
      const row = el('div', 'remind-row');
      const text = el('p');
      text.append('Rate your recent trade with @' + h.partner_username + ' ');
      text.appendChild(el('small', '', '(' + h.item_description + ')'));

      const btns = el('div', 'remind-btns');
      const now = el('a', 'btn btn-primary btn-small', 'Rate now');
      now.href = 'transaction.html?id=' + h.transaction_id;

      const later = makeButton('btn btn-outline btn-small', 'Rate later', async () => {
        later.disabled = true;
        try {
          await postJson('/transactions/' + h.transaction_id + '/rate-later');
          row.remove();
          if (!box.querySelector('.remind-row')) box.hidden = true;
        } catch (err) {
          later.disabled = false;
          showPageError(netError(err));
        }
      });

      btns.append(now, later);
      row.append(text, btns);
      box.appendChild(row);
    });
    box.hidden = todo.length === 0;
  } catch (err) { /* the reminder is optional */ }
}

// ---------- My trades and requests ----------
const body = $('trade-rows');
const reqList = $('request-list');

let trades = [];      // my trades in progress and the newest finished ones, from the database
let completedCount = 0;   // all my completed trades (the list above only has the newest)
let requests = [];    // requests other users sent me
let filter = 'all';

const HELD = ['paid', 'delivered', 'disputed'];             // money is in escrow
const ACTIVE = ['pending', 'accepted', 'paid', 'delivered', 'disputed'];

// Turn a database status into the badge shown on the page
function badgeFor(t) {
  if (t.status === 'pending') {
    return el('span', 'badge badge-pending', 'Waiting for partner');
  }
  const keys = {
    accepted:  t.role === 'buyer' ? 'await_pay' : 'await_buyer_pay',
    paid:      t.role === 'buyer' ? 'waiting_seller' : 'held',
    delivered: t.role === 'buyer' ? 'confirm' : 'held',
    disputed:  'dispute',
    completed: 'completed',
    refunded:  'refunded',
    cancelled: 'cancelled'
  };
  return ST.badge(keys[t.status] || t.status);
}

function tradeLink(t) {
  return t.status === 'disputed'
    ? 'dispute.html?id=' + t.id
    : 'transaction.html?id=' + t.id;
}

function tradeRow(t) {
  const open = el('a', '', 'Open');
  open.href = tradeLink(t);
  return tableRow([
    t.item, el('td', 'role', t.role === 'buyer' ? 'Buyer' : 'Seller'), t.partner,
    ST.pesoShort(t.amount), badgeFor(t), open
  ]);
}

// Summary numbers + the trades table
function renderTrades() {
  const active = trades.filter(t => ACTIVE.includes(t.status));
  const shown = active.filter(t => filter === 'all' || t.role === filter);
  body.replaceChildren(...shown.map(tradeRow));
  $('empty').hidden = shown.length > 0;

  const held = trades.filter(t => HELD.includes(t.status)).reduce((sum, t) => sum + t.amount, 0);
  $('held-amount').textContent = ST.pesoShort(held);
  $('active-count').textContent = active.length;
  $('open-disputes').textContent = trades.filter(t => t.status === 'disputed').length;
  $('completed-count').textContent = completedCount;
}

// Incoming requests. Accept goes straight to the trade page; Decline just removes the request.
// A problem is shown right beside the request, with a link to verify when that is the reason.
async function answer(id, action, buttons, errLine) {
  buttons.forEach(b => b.disabled = true);
  showPageError('');
  errLine.hidden = true;
  try {
    await postJson('/transactions/' + id + '/respond', { action });
    if (action === 'accept') { window.location.href = 'transaction.html?id=' + id; return; }
    await load();
  } catch (err) {
    errLine.textContent = netError(err);
    if (/verify/i.test(err.message)) {
      const link = el('a', '', 'Verify now');
      link.href = 'profile.html';
      errLine.append(' ', link);
    }
    errLine.hidden = false;
    buttons.forEach(b => b.disabled = false);
  }
}

function renderRequests() {
  reqList.innerHTML = '';
  requests.forEach(r => {
    const row = el('div', 'request');

    // One line: "@juan wants to buy from you | Game | Item name | ₱amount | You would be the seller"
    const who = r.my_role === 'seller'
      ? '@' + r.from_username + ' wants to buy from you'
      : '@' + r.from_username + ' wants to sell to you';
    const parts = ST.splitDescription(r.item_description);
    // The type comes first, so nobody accepts a game account thinking it is a plain item
    const rest = [ST.itemTypeText(r.item_type), parts.game, parts.title].filter(Boolean).join(' | ')
      + ' | ' + ST.pesoShort(Number(r.amount)) + ' | You would be the ' + r.my_role;

    const line = el('p', 'line');
    line.append(el('strong', '', who), el('span', 'rest', ' | ' + rest));
    line.title = who + ' | ' + rest;   // the full text on hover, when the line is cut short

    const errLine = el('p', 'form-error');
    errLine.hidden = true;

    const btns = el('div', 'btns');
    const accept = makeButton('btn btn-primary btn-small', 'Accept', () => answer(r.transaction_id, 'accept', [accept, decline], errLine));
    const decline = makeButton('btn btn-outline btn-small', 'Decline', () => answer(r.transaction_id, 'decline', [accept, decline], errLine));
    btns.append(accept, decline);

    row.append(line, btns, errLine);
    reqList.appendChild(row);
  });

  // No requests: the whole card is hidden
  $('requests').hidden = requests.length === 0;
  $('req-badge').textContent = requests.length + ' new';
  if (window.setNavRequestCount) window.setNavRequestCount(requests.length);
}

// Load everything from the backend
async function load() {
  try {
    const [t, r] = await Promise.all([apiFetch('/transactions'), apiFetch('/requests')]);
    const myId = String((getUser() || {}).user_id);
    completedCount = t.completed_count;
    trades = t.rows.map(x => {
      const iAmBuyer = String(x.buyer_id) === myId;
      return {
        id: x.transaction_id,
        item: x.item_description,
        role: iAmBuyer ? 'buyer' : 'seller',
        partner: '@' + (iAmBuyer ? x.seller_username : x.buyer_username),
        amount: Number(x.amount),
        status: x.status
      };
    });
    // Requests that other users sent me appear in the box at the top, not in the table
    const incoming = new Set(r.map(x => x.transaction_id));
    trades = trades.filter(x => !incoming.has(x.id));
    requests = r;
    showPageError('');
  } catch (err) {
    showPageError(netError(err));
    return;
  }
  renderRequests();
  renderTrades();
}

// ---------- 🔔 Updates ----------
// Messages that start with "Trade #12:" link to that trade
async function loadUpdates() {
  let data;
  try {
    data = await apiFetch('/notifications');
  } catch (err) { return; }   // the trades above still work without it
  const list = $('update-list');
  list.innerHTML = '';
  data.rows.forEach(n => {
    const li = el('li', n.is_read ? '' : 'unread');
    // The link and the message stay together in the first column, the time in the second
    const msg = el('span', 'msg');
    const m = /^Trade #(\d+): ([\s\S]*)$/.exec(n.message);
    if (m) {
      const link = el('a', '', 'Trade #' + m[1]);
      link.href = 'transaction.html?id=' + m[1];
      msg.append(link, ' ' + m[2]);
    } else {
      msg.append(n.message);
    }
    li.append(msg, el('time', '', fmtTime(n.sent_at)));
    list.appendChild(li);
  });
  $('upd-empty').hidden = data.rows.length > 0;
  $('upd-badge').hidden = !data.unread;
  $('upd-badge').textContent = data.unread + ' new';
  $('upd-read').hidden = !data.unread;
  if (window.setNavUpdatesCount) window.setNavUpdatesCount(data.unread);
}

$('upd-read').addEventListener('click', async () => {
  $('upd-read').disabled = true;
  try {
    await postJson('/notifications/read');
    await loadUpdates();
  } catch (err) {
    showPageError(netError(err));
  }
  $('upd-read').disabled = false;
});

// Buying / Selling / All tabs
bindTabs('[data-filter]', 'aria-selected', btn => {
  filter = btn.dataset.filter;
  renderTrades();
});

loadMe();
load();
loadRateReminders();
loadUpdates();
setInterval(load, 30000);
setInterval(loadUpdates, 30000);              // new requests (a request being answered keeps its own error line)
setInterval(loadMe, 60000);            // verification result and "someone tried to trade with you"
setInterval(loadRateReminders, 60000); // trades waiting for a rating
