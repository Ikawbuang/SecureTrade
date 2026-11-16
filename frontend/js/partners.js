startPage();

const me = getUser() || {};
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

// Am I verified? (decides what the Trade buttons do)
async function loadMe() {
  try {
    const p = await apiFetch('/profile');
    meVerified = p.verified;
    rememberProfile(p);
    $('verify-banner').hidden = p.verified;
    renderPeople();
  } catch (err) { /* the list still works; the Trade button re-checks */ }
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
  tfPartner = user;   // what was typed before stays, so closing the form by mistake loses nothing
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
    UI.forget($('trade-form'));
    // Go straight to the trade page: the process starts there
    window.location.href = 'transaction.html?id=' + trade.transaction_id;
  } catch (err) {
    setMessage('tf-error', netError(err));
    $('tf-send').disabled = false;
  }
});

// Open someone's profile straight away: partners.html?user=juan
const wanted = new URLSearchParams(location.search).get('user');
if (wanted) openProfile(wanted);

loadMe();
loadPeople();
setInterval(loadPeople, 30000);   // online / offline
setInterval(loadMe, 60000);       // verification result

// "Clear form" empties the trade form and its saved text
$('trade-form').addEventListener('reset', () => setTimeout(updateFee));
