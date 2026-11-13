startPage();

const me = getUser() || {};
$('me-first').textContent = me.username || (me.full_name || '').split(' ')[0] || 'there';
if (me.role === 'admin') $('admin-link').hidden = false;

let meVerified = !!me.verified || me.role === 'admin';

// A message at the top of the page. It scrolls up so it is always seen.
function showPageError(msg) {
  setMessage('page-error', msg);
  if (msg) window.scrollTo({ top: 0, behavior: 'smooth' });
}

function presenceTag(online) {
  return el('span', 'presence ' + (online ? 'online' : 'offline'), online ? 'Online' : 'Offline');
}
function lastSeenText(iso) {
  if (!iso) return 'Not seen online yet';
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return 'Last seen just now';
  if (minutes < 60) return 'Last seen ' + minutes + ' min ago';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return 'Last seen ' + hours + ' hr ago';
  const days = Math.floor(hours / 24);
  return 'Last seen ' + days + (days === 1 ? ' day ago' : ' days ago');
}

// The tooltip of a Trade button
function tradeButtonTitle(verified) {
  if (!meVerified) return 'Verify your identity first';
  return verified ? '' : 'This user is not verified yet. Click to see why.';
}

// ---------- My profile and the verification banner ----------
async function loadMe() {
  try {
    const p = await apiFetch('/profile');
    meVerified = p.verified;
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
    renderPeople();
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

// ---------- "You cannot trade yet" notice ----------
const bkDialog = $('block-dialog');

async function showBlock(kind, user) {
  $('bk-ok').hidden = true;
  const isMe = kind === 'me';
  setTexts({
    'bk-title': isMe ? 'Verify your identity first' : '@' + user.username + ' is not verified yet',
    'bk-text': isMe
      ? 'You can start or accept trades only after an admin verifies your identity. It takes a few minutes: an ID and a selfie holding it. Both people in a trade must be verified.'
      : 'Both people must be verified before they can trade. Ask @' + user.username + ' to verify their identity in My profile, then try again.'
  });
  $('bk-verify').hidden = !isMe;
  bkDialog.showModal();

  // Tell the other person that someone wanted to trade with them
  if (kind === 'them') {
    try {
      await postJson('/trade-attempts', { username: user.username });
      setMessage('bk-ok', 'We told @' + user.username + ' that you wanted to trade, so they know to verify.');
    } catch (err) { /* the notice above is enough */ }
  }
}
$('bk-close').addEventListener('click', () => bkDialog.close());
bkDialog.addEventListener('click', e => { if (e.target === bkDialog) bkDialog.close(); });

// The Trade buttons are always clickable. If something is missing, say what.
function tryTrade(user) {
  if (!meVerified) { showBlock('me', user); return; }
  if (!user.verified) { showBlock('them', user); return; }
  openTradeForm(user);
}

// ---------- Find a trade partner ----------
const finder = { status: 'all', limit: 20, users: [], hasMore: false };

function renderPeople() {
  const box = $('people');
  box.innerHTML = '';
  finder.users.forEach(u => {
    const li = el('li', 'person');

    const info = el('div');
    info.appendChild(el('strong', '', '@' + u.username));
    info.appendChild(u.verified ? verifiedBadge() : notVerifiedTag());
    info.appendChild(presenceTag(u.online));
    let line = u.online ? 'Active now' : lastSeenText(u.last_seen);
    if (u.is_favorite && u.note) line = '“' + u.note + '”';
    else if (u.trades_together > 0) line += ' · ' + u.trades_together + (u.trades_together === 1 ? ' trade with you' : ' trades with you');
    info.appendChild(el('small', '', line));

    const lead = el('div', 'lead');
    lead.append(makeAvatar(u.username, u.avatar_file, 42), info);

    const acts = el('div', 'acts');
    acts.appendChild(makeStar(u.username, u.is_favorite, () => { if (finder.status === 'favorites') loadPeople(); }));

    acts.appendChild(makeButton('btn btn-outline', 'Profile', () => openProfile(u.username)));

    const blocked = !meVerified || !u.verified;
    const trade = makeButton('btn btn-primary' + (blocked ? ' dim' : ''), 'Trade', () => tryTrade(u));
    trade.title = tradeButtonTitle(u.verified);
    acts.appendChild(trade);

    li.append(lead, acts);
    box.appendChild(li);
  });

  const none = $('no-people');
  none.hidden = finder.users.length > 0;
  if (finder.users.length === 0) {
    none.textContent = finder.status === 'favorites'
      ? 'No favorites yet. Press the star beside a user to add them.'
      : (finder.status === 'recent' ? 'You have not traded with anyone yet.' : 'No users match your search.');
  }
  $('more').hidden = !finder.hasMore;
}

async function loadPeople() {
  try {
    const q = '?status=' + finder.status + '&limit=' + finder.limit + '&search=' + encodeURIComponent($('people-search').value.trim());
    const data = await apiFetch('/users' + q);
    finder.users = data.users;
    finder.hasMore = data.has_more;
  } catch (err) {
    finder.users = [];
    finder.hasMore = false;
    $('no-people').textContent = 'Could not load users: ' + netError(err);
    $('no-people').hidden = false;
    $('people').innerHTML = '';
    return;
  }
  renderPeople();
}

bindTabs('.seg button', 'aria-pressed', b => {
  finder.status = b.dataset.status;
  finder.limit = 20;
  loadPeople();
});
let searchTimer;
$('people-search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  finder.limit = 20;
  searchTimer = setTimeout(loadPeople, 250);
});
$('more').addEventListener('click', () => { finder.limit += 20; loadPeople(); });

// ---------- Profile card ----------
const pdDialog = $('profile-dialog');
let pdUser = null;

// One anonymous review: stars, buyer or seller, date, comment, and a way to report it
function reviewItem(r) {
  const li = el('li');
  li.appendChild(el('strong', '', '★ ' + r.score));
  li.appendChild(el('span', 'by', ' · from the ' + r.as_role.toLowerCase() + ' · '
    + fmtDate(r.rated_at)));
  if (r.feedback) li.appendChild(el('div', 'text', r.feedback));

  // You cannot report your own review
  if (r.is_mine) {
    li.appendChild(el('div', 'by', 'This is your review.'));
    return li;
  }
  const box = el('div', 'rev-report');
  if (r.reported_by_me) {
    box.appendChild(el('span', 'by', 'You reported this review.'));
  } else {
    box.append(...makeReportControls({
      openText: 'Report',
      panelClass: 'row',
      reviewRef: r.review_ref,
      onStart: () => { setMessage('pd-rev-ok', ''); setMessage('pd-rev-error', ''); },
      onSent: () => {
        box.replaceChildren(el('span', 'by', 'You reported this review.'));
        setMessage('pd-rev-ok', 'Thank you. An admin will look at this review.');
      },
      onError: message => setMessage('pd-rev-error', message)
    }));
  }
  li.appendChild(box);
  return li;
}

async function openProfile(username) {
  try {
    const p = await apiFetch('/users/' + encodeURIComponent(username));
    pdUser = p;

    $('pd-avatar').replaceChildren(makeAvatar(p.username, p.avatar_file, 64));
    $('pd-name').replaceChildren('@' + p.username);
    $('pd-name').appendChild(p.verified ? verifiedBadge() : notVerifiedTag());

    const status = $('pd-status');
    status.replaceChildren(presenceTag(p.online));
    if (!p.online) status.append(' · ' + lastSeenText(p.last_seen));

    $('pd-joined').textContent = 'Member since ' + fmtMonthYear(p.joined);
    $('pd-trades').textContent = p.completed_trades;
    $('pd-rating').textContent = p.avg_rating === null ? '–' : '★ ' + p.avg_rating.toFixed(1) + ' (' + p.rating_count + ')';
    $('pd-together').textContent = p.trades_together;

    // The star, and the private note (only when this person is a favorite)
    $('pd-star').replaceChildren(makeStar(p.username, p.is_favorite, fav => {
      $('pd-note-box').hidden = !fav;
      if (!fav) $('pd-note').value = '';
      loadPeople();
    }));
    $('pd-note-box').hidden = !p.is_favorite;
    $('pd-note').value = p.note || '';
    $('pd-note-ok').hidden = true;

    const list = $('pd-reviews');
    list.innerHTML = '';
    p.reviews.forEach(r => list.appendChild(reviewItem(r)));
    $('pd-no-reviews').hidden = p.reviews.length > 0;
    $('pd-rev-ok').hidden = true;
    $('pd-rev-error').hidden = true;

    // Always clickable: if something is missing, the notice says what
    const trade = $('pd-trade');
    const blocked = !(meVerified && p.verified);
    trade.classList.toggle('dim', blocked);
    trade.title = tradeButtonTitle(p.verified);

    pdDialog.showModal();
  } catch (err) {
    showPageError('Could not load the profile: ' + netError(err));
  }
}

$('pd-note-save').addEventListener('click', async () => {
  $('pd-note-ok').hidden = true;
  try {
    await apiFetch('/favorites/' + encodeURIComponent(pdUser.username), { method: 'PUT', body: JSON.stringify({ note: $('pd-note').value }) });
    $('pd-note-ok').hidden = false;
    loadPeople();
  } catch (err) { showPageError(netError(err)); }
});
$('pd-close').addEventListener('click', () => pdDialog.close());
pdDialog.addEventListener('click', e => { if (e.target === pdDialog) pdDialog.close(); });
$('pd-trade').addEventListener('click', () => {
  pdDialog.close();
  tryTrade(pdUser);
});

// ---------- Trade form (a popup, so no separate page is needed) ----------
const tfDialog = $('trade-dialog');
let tfPartner = null;
$('tf-fee-pct').textContent = (ST.feeRate * 100) + '%';

function updateFee() {
  const price = parseFloat($('tf-price').value) || 0;
  const fee = price * ST.feeRate;
  setTexts({ 'tf-s-price': ST.peso(price), 'tf-s-fee': ST.peso(fee), 'tf-s-net': ST.peso(price - fee) });
}
$('tf-price').addEventListener('input', updateFee);

function openTradeForm(user) {
  tfPartner = user;
  $('trade-form').reset();
  $('tf-avatar').replaceChildren(makeAvatar(user.username, user.avatar_file, 52));
  $('tf-title').replaceChildren('Trade with @' + user.username);
  $('tf-sub').textContent = 'Your request goes to their dashboard. After they accept, you continue on the trade page.';
  $('tf-error').hidden = true;
  $('tf-send').disabled = false;
  updateFee();
  tfDialog.showModal();
}
$('tf-cancel').addEventListener('click', () => tfDialog.close());

$('trade-form').addEventListener('submit', async e => {
  e.preventDefault();
  $('tf-error').hidden = true;
  const role = document.querySelector('input[name="role"]:checked').value;
  const game = $('tf-game').value.trim();
  const item = $('tf-item').value.trim();
  const details = $('tf-details').value.trim();
  const description = game + ' – ' + item + (details ? '. ' + details : '');

  $('tf-send').disabled = true;
  try {
    const trade = await postJson('/transactions', {
      partner_username: tfPartner.username,
      my_role: role,
      item_description: description,
      item_type: $('tf-type').value,
      amount: parseFloat($('tf-price').value)
    });
    // Go straight to the trade page: the process starts there
    window.location.href = 'transaction.html?id=' + trade.transaction_id;
  } catch (err) {
    setMessage('tf-error', netError(err));
    $('tf-send').disabled = false;
  }
});

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
loadPeople();
loadRateReminders();
loadUpdates();
setInterval(load, 30000);
setInterval(loadUpdates, 30000);              // new requests (a request being answered keeps its own error line)
setInterval(loadPeople, 30000);        // online / offline
setInterval(loadMe, 60000);            // verification result and "someone tried to trade with you"
setInterval(loadRateReminders, 60000); // trades waiting for a rating
