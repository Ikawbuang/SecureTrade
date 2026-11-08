startPage();

const peso = n => ST.pesoShort(Number(n));
function setText(id, value) { $(id).textContent = value; }
function linkButton(text, onClick) { return makeButton('link-btn', text, onClick); }

// A table body filled from a list, with its "nothing here" line
function renderRows(bodyId, emptyId, list, toCells) {
  $(bodyId).replaceChildren(...list.map(item => tableRow(toCells(item))));
  $(emptyId).hidden = list.length > 0;
}

// ---------- Pages for the long lists ----------
// One page from the server. If that page no longer exists (rows were removed), step back.
async function fetchPage(pager, path) {
  const data = await apiFetch(path + (path.includes('?') ? '&' : '?') + 'page=' + pager.page);
  if (!data.rows.length && pager.page > 1) {
    pager.page--;
    return fetchPage(pager, path);
  }
  pager.show(data.total, data.rows.length);
  return data.rows;
}

const adminPager = (sectionId, reload) => createPager(sectionId, reload, showError);
const pagers = {
  verifications: adminPager('verifications', () => loadVerifications()),
  messages: adminPager('messages', () => loadSupport()),
  disputes: adminPager('disputes', async () => renderDisputes()),
  reports: adminPager('reports', () => loadReports()),
  alerts: adminPager('alerts', () => loadAlerts()),
  transactions: adminPager('transactions', () => loadTrades()),
  users: adminPager('users', () => loadUsers())
};

// A list inside a dialog, with its "nothing here" line
function fillList(listId, noneId, items, toItem) {
  $(listId).replaceChildren(...items.map(toItem));
  $(noneId).hidden = items.length > 0;
  $(listId).hidden = items.length === 0;
}

// A person's picture and name in a table
function whoCell(username, avatarFile, content) {
  const cell = el('div', 'who-cell');
  cell.append(makeAvatar(username, avatarFile, 32), content);
  return cell;
}

// A badge with an optional small line under it
function badgeWithTag(badge, tagClass, tagText) {
  const box = el('div');
  box.appendChild(badge);
  if (tagText) box.appendChild(el('span', 'reply-tag ' + tagClass, tagText));
  return box;
}

function timeSince(iso) { return duration(Date.now() - new Date(iso).getTime()); }
// "5 min", "3 hr", "2 days"
function duration(ms) {
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return minutes + ' min';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + ' hr';
  const days = Math.floor(hours / 24);
  return days + (days === 1 ? ' day' : ' days');
}
function seenText(u) {
  if (u.online) return 'Online now';
  if (!u.last_seen) return 'Never';
  return timeSince(u.last_seen) + ' ago';
}
// A short one-line version of a longer text
function short(text, n) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}
function statusLabel(s) {
  return s === 'active' ? 'Active' : (s === 'banned' ? 'Banned' : 'Suspended');
}
function anyDialogOpen() {
  return ['review', 'trade-dialog', 'user-dialog', 'verif-dialog', 'chat-dialog', 'report-dialog']
    .some(id => $(id).open);
}
// Open a dialog only if it is not open already
function openDialog(id) {
  if (!$(id).open) $(id).showModal();
}

// Close buttons for a dialog
function bindClose(dialogId, buttonIds) {
  buttonIds.forEach(id => $(id).addEventListener('click', () => $(dialogId).close()));
}

// Load what a dialog shows. A problem appears at the top of the page and gives null.
async function fetchForDialog(path) {
  try {
    return await apiFetch(path);
  } catch (err) {
    showError(err);
    return null;
  }
}

// Send a decision from a dialog. The buttons stay locked until the server answers.
async function submitDecision({ path, body, errorId, buttonIds, dialogId, onDone }) {
  setDisabled(buttonIds, true);
  try {
    await postJson(path, body);
    $(dialogId).close();
    onDone();
    await load();
  } catch (err) {
    setMessage(errorId, netError(err));
    setDisabled(buttonIds, false);
  }
}

function revokeAll(urls) { urls.splice(0).forEach(u => URL.revokeObjectURL(u)); }

const accountNote = (username, status) => '@' + username + (status !== 'active' ? ' (' + statusLabel(status).toLowerCase() + ')' : '');
const paymentText = payment => ST.methodLabel(payment.method, payment.payer_masked) + ' · ' + payment.status;

// ---------- Labels ----------
const TRADE_STATUS = {
  pending:   ['badge-pending',  'Waiting for partner'],
  accepted:  ['badge-pending',  'Waiting for payment'],
  paid:      ['badge-held',     'Payment held'],
  delivered: ['badge-held',     'Delivered'],
  disputed:  ['badge-dispute',  'In dispute'],
  completed: ['badge-released', 'Completed'],
  refunded:  ['badge-dispute',  'Refunded'],
  cancelled: ['badge-pending',  'Cancelled']
};
function tradeBadge(status) {
  const s = TRADE_STATUS[status] || ['badge-pending', status];
  return el('span', 'badge ' + s[0], s[1]);
}
function accountBadge(status) {
  return status === 'active'
    ? el('span', 'badge badge-active', 'Active')
    : el('span', 'badge badge-flag', status === 'banned' ? 'Banned' : 'Suspended');
}
function verifBadge(status) {
  if (status === 'approved') return el('span', 'badge badge-released', 'Approved');
  if (status === 'rejected') return el('span', 'badge badge-flag', 'Rejected');
  return el('span', 'badge badge-held', 'Waiting');
}
function reportBadge(r) {
  if (r.deleted_at) return el('span', 'badge badge-flag', 'Review deleted');
  if (r.status === 'resolved') return el('span', 'badge badge-released', 'Resolved');
  if (r.status === 'dismissed') return el('span', 'badge badge-pending', 'Dismissed');
  return el('span', 'badge badge-held', 'Open');
}

// What a line in the activity log means
function describe(a) {
  const detail = a.detail ? a.detail : '';
  switch (a.action) {
    case 'trade_created':          return 'created the trade request' + (detail ? ' (' + detail + ')' : '');
    case 'trade_accepted':         return 'accepted the request';
    case 'trade_declined':         return 'declined the request';
    case 'trade_cancelled':        return detail ? detail : 'cancelled the trade';
    case 'seller_cancelled':       return 'cancelled after payment, so the buyer was refunded' + (detail ? ': ' + detail : '');
    case 'paid':                   return 'paid into escrow' + (detail ? ' ' + detail : '');
    case 'delivered':              return 'marked the item as delivered' + (detail ? ' (' + detail + ')' : '');
    case 'confirmed':              return 'confirmed receipt, so the payment was released';
    case 'dispute_opened':         return 'opened a dispute' + (detail ? ': ' + detail : '');
    case 'dispute_reply':          return 'replied to the dispute';
    case 'rated':                  return 'rated the other person ' + detail;
    case 'username_changed':       return 'changed the username ' + detail;
    case 'email_changed':          return 'changed the email address';
    case 'avatar_changed':         return 'changed the profile photo';
    case 'verification_submitted': return 'sent an ID for verification' + (detail ? ' (' + detail + ')' : '');
    case 'verification_approved':  return 'was verified ' + detail;
    case 'verification_rejected':  return 'verification rejected ' + detail;
    case 'login_blocked':          return 'had sign-in blocked after too many wrong passwords ' + detail;
    case 'account_active':         return 'account reactivated ' + detail;
    case 'account_suspended':      return 'account suspended ' + detail;
    case 'account_banned':         return 'account banned ' + detail;
    default:                       return a.action + (detail ? ': ' + detail : '');
  }
}
function activityText(a, showWho) {
  const who = a.username ? '@' + a.username : 'System';
  if (a.action === 'auto_released') return 'The payment was released automatically';
  if (a.action === 'request_expired') return 'The request expired: ' + (a.detail || 'nobody answered');
  if (a.action === 'dispute_resolved') return (showWho ? who + ' decided: ' : 'Admin decided: ') + (a.detail || '');
  if (a.action === 'admin_refund') return (showWho ? who : 'Admin') + ' refunded the buyer in full: ' + (a.detail || '');
  if (a.action === 'review_deleted') {
    return showWho
      ? 'A review written by ' + who + ' was deleted ' + (a.detail || '')
      : 'A review they wrote was deleted ' + (a.detail || '');
  }
  const text = describe(a);
  return showWho ? who + ' ' + text : text.charAt(0).toUpperCase() + text.slice(1);
}

function showError(err) {
  if (/admins only/i.test(err.message)) {
    $('content').hidden = true;
    $('page-error').innerHTML = '';
    $('page-error').append('This page is for admins only. ');
    const back = el('a', '', 'Back to your dashboard');
    back.href = 'dashboard.html';
    $('page-error').appendChild(back);
    $('page-error').hidden = false;
  } else {
    setMessage('page-error', netError(err));
  }
}

// ---------- Load the page ----------
let current = null;       // the dispute open in the review window
let allDisputes = [];
let disputeTab = 'needs';
const blobUrls = [];

function navCount(id, n) {
  const e = $(id);
  e.hidden = !n;
  e.textContent = n;
}

function renderOverview(o) {
  setText('open-count', o.open_disputes);
  setText('held', peso(o.held));
  setText('month', o.trades_month);
  setText('fees', peso(o.fees));
  setText('st-verif', o.pending_verifications);
  setText('st-msgs', o.unread_support);
  setText('st-reports', o.open_reports);
  setText('st-needs', o.needs_admin_trades);
  navCount('nav-verif-count', o.pending_verifications);
  navCount('nav-msg-count', o.unread_support);
  navCount('nav-report-count', o.open_reports);
}

// ---------- Verification requests ----------
function renderVerifications(list) {
  renderRows('v-rows', 'v-empty', list, v => [
    whoCell(v.username, v.avatar_file, '@' + v.username),
    v.full_name, v.typed_name, v.id_type, fmtTime(v.submitted_at), verifBadge(v.status),
    linkButton(v.status === 'pending' ? 'Review' : 'View', () => openVerification(v.verification_id))
  ]);
}

async function loadVerifications() {
  renderVerifications(await fetchPage(pagers.verifications, '/admin/verifications?status=' + encodeURIComponent($('v-status').value)));
}

// ---------- Support messages ----------
function renderSupport(list) {
  renderRows('m-rows', 'm-empty', list, c => {
    const name = el('span');
    name.append('@' + c.username);
    if (c.unread) name.appendChild(el('span', 'chip', c.unread + ' new'));
    return [
      whoCell(c.username, c.avatar_file, name),
      accountBadge(c.account_status),
      (c.last_from_admin ? 'Admin: ' : '') + short(c.last_content, 80),
      fmtTime(c.last_at),
      linkButton('Open', () => openChat(c.user_id))
    ];
  });
}

async function loadSupport() {
  renderSupport(await fetchPage(pagers.messages, '/admin/support'));
}

// ---------- Reported reviews ----------
async function loadReports() {
  const list = await fetchPage(pagers.reports, '/admin/reports?status=' + encodeURIComponent($('r-status').value));
  renderRows('r-rows', 'r-empty', list, r => [
    '★ ' + r.score + (r.feedback ? ' ' + short(r.feedback, 50) : ''),
    '@' + r.subject_username,
    '@' + r.author_username,
    '@' + r.reporter_username,
    short(r.reason, 50) || '–',
    fmtTime(r.created_at),
    reportBadge(r),
    linkButton(r.status === 'open' && !r.deleted_at ? 'Review' : 'View', () => openReport(r))
  ]);
}

// ---------- Sign-in alerts ----------
// The menu number counts only alerts newer than the ones this admin already opened (remembered in this browser)
const ALERTS_SEEN_KEY = 'adminAlertsSeenAt';
let alertTimes = [];

function alertsSeenAt() {
  try { return Number(localStorage.getItem(ALERTS_SEEN_KEY)) || 0; } catch { return 0; }
}

function showAlertCount() {
  const seenAt = alertsSeenAt();
  navCount('nav-alert-count', alertTimes.filter(t => t > seenAt).length);
}

function markAlertsSeen() {
  if (!alertTimes.length) return;
  try { localStorage.setItem(ALERTS_SEEN_KEY, String(Math.max(alertsSeenAt(), ...alertTimes))); } catch { /* storage is blocked */ }
  navCount('nav-alert-count', 0);
}

async function loadAlerts() {
  const list = await apiFetch('/admin/login-alerts');
  alertTimes = list.map(a => new Date(a.created_at).getTime());
  showAlertCount();
  renderRows('a-rows', 'a-empty', slicePage(pagers.alerts, list), a => [
    whoCell(a.username, a.avatar_file, '@' + a.username),
    accountBadge(a.account_status),
    'Too many wrong passwords ' + (a.detail || ''),
    fmtTime(a.created_at),
    linkButton('Open', () => openUser(a.user_id))
  ]);
}

// ---------- The dispute list: tabs, search, waiting time ----------
const isOpen = d => d.dispute_status !== 'resolved';

function renderDisputes() {
  const needs = allDisputes.filter(isOpen);
  const noReply = needs.filter(d => !d.has_reply);
  const resolved = allDisputes.filter(d => !isOpen(d));
  setTexts({ 'c-needs': needs.length, 'c-noreply': noReply.length, 'c-resolved': resolved.length });

  let list = disputeTab === 'needs' ? needs : (disputeTab === 'noreply' ? noReply : resolved);
  const q = $('d-search').value.trim().toLowerCase().replace(/^@/, '').replace(/^#/, '');
  if (q) {
    list = list.filter(d => (
      String(d.dispute_id) === q ||
      String(d.transaction_id) === q ||
      [d.item_description, d.buyer_username, d.seller_username].join(' ').toLowerCase().includes(q)
    ));
  }
  // Waiting longest first; resolved ones newest first
  list = [...list].sort((a, b) => disputeTab === 'resolved'
    ? new Date(b.opened_at) - new Date(a.opened_at)
    : new Date(a.opened_at) - new Date(b.opened_at));

  renderRows('d-rows', 'd-empty', slicePage(pagers.disputes, list), d => [
    '#' + d.dispute_id, d.item_description, '@' + d.buyer_username, '@' + d.seller_username, peso(d.amount),
    badgeWithTag(ST.disputeBadge(d), d.has_reply ? 'ok' : 'none', !isOpen(d) ? '' : (d.has_reply ? 'Reply received' : 'No reply yet')),
    isOpen(d) ? timeSince(d.opened_at) : '–',
    linkButton('Review', () => openReview(d.dispute_id))
  ]);
}

bindTabs('[data-dtab]', 'aria-selected', btn => {
  disputeTab = btn.dataset.dtab;
  pagers.disputes.page = 1;
  renderDisputes();
});
$('d-search').addEventListener('input', () => {
  pagers.disputes.page = 1;
  renderDisputes();
});

function renderTrades(list) {
  renderRows('t-rows', 't-empty', list, t => [
    '#' + t.transaction_id, t.item_description, '@' + t.buyer_username, '@' + t.seller_username, peso(t.amount),
    badgeWithTag(tradeBadge(t.status), 'none', t.needs_admin ? 'Needs your decision' : ''),
    fmtDate(t.created_at),
    linkButton('Open', () => openTrade(t.transaction_id))
  ]);
}

function renderUsers(list) {
  renderRows('u-rows', 'u-empty', list, u => {
    const name = el('span');
    name.appendChild(el('span', 'dot' + (u.online ? ' on' : '')));
    name.append('@' + u.username, u.verified ? verifiedBadge() : notVerifiedTag());
    name.appendChild(el('span', 'sub', u.full_name + (u.role === 'admin' ? ' · admin' : '')));
    return [
      whoCell(u.username, u.avatar_file, name),
      u.email, fmtDate(u.created_at), accountBadge(u.account_status),
      u.completed_trades + ' done, ' + u.active_trades + ' on process',
      u.rating === null ? '–' : '★ ' + u.rating,
      linkButton('Open', () => openUser(u.user_id))
    ];
  });
}

async function loadTrades() {
  const q = '?status=' + encodeURIComponent($('t-status').value) + '&search=' + encodeURIComponent($('t-search').value.trim());
  renderTrades(await fetchPage(pagers.transactions, '/admin/transactions' + q));
}
async function loadUsers() {
  const q = '?status=' + encodeURIComponent($('u-status').value) + '&search=' + encodeURIComponent($('u-search').value.trim());
  renderUsers(await fetchPage(pagers.users, '/admin/users' + q));
}

let scrolledToHash = false;
async function load() {
  try {
    const [overview, disputes] = await Promise.all([apiFetch('/admin/overview'), apiFetch('/admin/disputes')]);
    setMessage('page-error', '');
    $('content').hidden = false;
    renderOverview(overview);
    allDisputes = disputes;
    renderDisputes();
    await Promise.all([loadVerifications(), loadSupport(), loadReports(), loadAlerts(), loadTrades(), loadUsers()]);

    // Opened from a link such as admin-dashboard.html#messages
    if (!scrolledToHash) {
      scrolledToHash = true;
      if (location.hash) {
        const target = document.getElementById(location.hash.slice(1));
        if (target) target.scrollIntoView();
        if (location.hash === '#alerts') markAlertsSeen();
      }
    }
  } catch (err) {
    showError(err);
  }
}

// Filters: reload when the choice or the search text changes
let filterTimer;
function onFilter(pager, fn) {
  pager.page = 1;
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => fn().catch(showError), 250);
}
$('v-status').addEventListener('change', () => onFilter(pagers.verifications, loadVerifications));
$('r-status').addEventListener('change', () => onFilter(pagers.reports, loadReports));
$('t-search').addEventListener('input', () => onFilter(pagers.transactions, loadTrades));
$('t-status').addEventListener('change', () => onFilter(pagers.transactions, loadTrades));
$('u-search').addEventListener('input', () => onFilter(pagers.users, loadUsers));
$('u-status').addEventListener('change', () => onFilter(pagers.users, loadUsers));

// The "Trades needing your decision" number opens that filter
$('st-needs').closest('a').addEventListener('click', () => {
  $('t-status').value = 'needs_admin';
  onFilter(pagers.transactions, loadTrades);
});

// ---------- Shared pieces ----------
function fillChat(listId, noneId, messages) {
  fillList(listId, noneId, messages, m => {
    const li = el('li');
    li.append(el('b', '', '@' + m.username), el('small', '', fmtTime(m.sent_at)), el('div', '', m.content));
    return li;
  });
}

function activityItem(a, showWho) {
  const trade = !showWho && a.transaction_id ? ' (trade #' + a.transaction_id + ')' : '';
  const li = el('li');
  li.append(activityText(a, showWho) + trade, el('small', '', fmtTime(a.created_at)));
  return li;
}

function fillTimeline(listId, noneId, items, showWho) {
  fillList(listId, noneId, items, a => activityItem(a, showWho));
}

// ---------- Support chat with one user ----------
let chatUser = null;
let chatSig = '';

function drawChat(messages) {
  const sig = messages.map(m => m.message_id).join('|');
  if (sig === chatSig) return;
  chatSig = sig;
  const log = $('cd-log');
  log.innerHTML = '';
  messages.forEach(m => {
    const li = el('li', m.from_admin ? 'admin' : '');
    li.appendChild(el('small', '', (m.from_admin ? 'Admin' : '@' + chatUser.username) + ' · ' + fmtTime(m.sent_at)));
    li.appendChild(document.createTextNode(m.content));
    log.appendChild(li);
  });
  $('cd-none').hidden = messages.length > 0;
  log.hidden = messages.length === 0;
  log.scrollTop = log.scrollHeight;
}

async function openChat(userId) {
  const d = await fetchForDialog('/admin/support/' + userId);
  if (!d) return;
  chatUser = d.user;
  chatSig = '';
  $('cd-avatar').replaceChildren(makeAvatar(d.user.username, d.user.avatar_file, 48));
  setText('cd-title', '@' + d.user.username);
  setText('cd-sub', 'Account: ' + statusLabel(d.user.account_status));

  const warnings = {
    suspended: 'This account is suspended. The person can only use Support, so this is where they can appeal.',
    banned: 'This account is banned. The person cannot sign in, so they cannot read your messages.'
  };
  setMessage('cd-warn', warnings[d.user.account_status] || '');

  $('cd-input').value = '';
  setMessage('cd-error', '');
  drawChat(d.messages);
  openDialog('chat-dialog');
  $('cd-input').focus();

  // Opening the chat marks the user's messages as read, so the numbers change
  load();
}

async function refreshChat() {
  if (!chatUser) return;
  try {
    const d = await apiFetch('/admin/support/' + chatUser.user_id);
    drawChat(d.messages);
  } catch (err) { /* try again next time */ }
}

$('cd-form').addEventListener('submit', async e => {
  e.preventDefault();
  if (!chatUser) return;
  setMessage('cd-error', '');
  const content = $('cd-input').value.trim();
  if (!content) return;
  $('cd-send').disabled = true;
  try {
    await postJson('/admin/support/' + chatUser.user_id, { content });
    $('cd-input').value = '';
    await refreshChat();
    loadSupport().catch(() => {});
  } catch (err) {
    setMessage('cd-error', netError(err));
  }
  $('cd-send').disabled = false;
});
$('cd-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    $('cd-form').requestSubmit();
  }
});
$('cd-user').addEventListener('click', () => {
  if (!chatUser) return;
  const id = chatUser.user_id;
  $('chat-dialog').close();
  openUser(id);
});
bindClose('chat-dialog', ['cd-close']);
$('chat-dialog').addEventListener('close', () => { chatUser = null; load(); });

// New messages appear while the chat is open
setInterval(() => { if ($('chat-dialog').open && !document.hidden) refreshChat(); }, 5000);

// ---------- Reported review ----------
let currentReport = null;
const REPORT_BUTTONS = ['rp-delete', 'rp-dismiss'];

// Delete the review or dismiss the report
function closeReport(path, body) {
  submitDecision({
    path, body,
    errorId: 'rp-error',
    buttonIds: REPORT_BUTTONS,
    dialogId: 'report-dialog',
    onDone: () => { currentReport = null; }
  });
}

function openReport(r) {
  currentReport = r;
  setTexts({
    'rp-sub': 'About @' + r.subject_username + ' · trade #' + r.transaction_id,
    'rp-score': '★ ' + r.score,
    'rp-subject': '@' + r.subject_username,
    'rp-author': '@' + r.author_username,
    'rp-reporter': '@' + r.reporter_username,
    'rp-written': fmtTime(r.rated_at),
    'rp-reported': fmtTime(r.created_at),
    'rp-comment': r.feedback || '(no comment, only stars)',
    'rp-reason': r.reason || '(no reason was given)'
  });

  const open = r.status === 'open' && !r.deleted_at;
  $('rp-decision').hidden = !open;
  $('rp-delete').hidden = !open;
  $('rp-dismiss').hidden = !open;
  $('rp-closed').hidden = open;
  if (!open) {
    setText('rp-closed-text', r.deleted_at
      ? 'This review was deleted. It no longer shows on the profile or in the average.'
      : (r.status === 'dismissed' ? 'This report was dismissed. The review stays.' : 'This report is closed.'));
  }
  $('rp-note').value = '';
  setMessage('rp-error', '');
  setDisabled(REPORT_BUTTONS, false);
  openDialog('report-dialog');
}

$('rp-delete').addEventListener('click', () => {
  if (!currentReport) return;
  setMessage('rp-error', '');
  const note = $('rp-note').value.trim();
  if (note.length < 5) { setMessage('rp-error', 'Write a short note that explains why.'); return; }
  if (!window.confirm('Delete this review? It stops counting in the average and cannot be restored.')) return;
  closeReport('/admin/reviews/' + currentReport.review_ref + '/delete', { note });
});

$('rp-dismiss').addEventListener('click', () => {
  if (!currentReport) return;
  setMessage('rp-error', '');
  closeReport('/admin/reports/' + currentReport.report_id + '/dismiss', {});
});

$('rp-author-btn').addEventListener('click', () => {
  if (!currentReport) return;
  const id = currentReport.author_id;
  $('report-dialog').close();
  openUser(id);
});
bindClose('report-dialog', ['rp-close']);

// ---------- Verification review ----------
let currentVerif = null;
const verifUrls = [];
const VERIF_BUTTONS = ['vd-approve', 'vd-reject'];

function normName(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }

function showVerifPicture(boxId, path, has) {
  const box = $(boxId);
  const showNote = text => box.replaceChildren(el('div', 'missing', text));
  if (!has) { showNote('The picture was deleted after the decision.'); return; }
  showNote('Loading…');
  fetchPrivateImage(path)
    .then(url => {
      verifUrls.push(url);
      const img = el('img');
      img.alt = '';
      img.src = url;
      img.title = 'Click to open it bigger';
      img.addEventListener('click', () => window.open(url, '_blank'));
      box.replaceChildren(img);
    })
    .catch(() => showNote('Could not load the picture.'));
}

async function openVerification(id) {
  const v = await fetchForDialog('/admin/verifications/' + id);
  if (!v) return;
  currentVerif = v;
  revokeAll(verifUrls);

  $('vd-avatar').replaceChildren(makeAvatar(v.username, v.avatar_file, 52));
  setText('vd-title', '@' + v.username);
  setText('vd-sub', v.email + ' · member since ' + fmtDate(v.joined));
  setText('vd-code', v.code);
  setText('vd-idtype', v.id_type);
  setText('vd-sent', fmtTime(v.submitted_at));

  const same = normName(v.typed_name) === normName(v.full_name);
  const typed = $('vd-typed');
  typed.replaceChildren(v.typed_name);
  typed.appendChild(el('span', 'match ' + (same ? 'same' : 'diff'), same ? 'Same as sign-up' : 'Different from sign-up'));
  setText('vd-signup', v.full_name);

  const pending = v.status === 'pending';
  showVerifPicture('vd-id', '/verifications/' + v.verification_id + '/id', pending && v.has_files);
  showVerifPicture('vd-selfie', '/verifications/' + v.verification_id + '/selfie', pending && v.has_files);

  $('vd-decision').hidden = !pending;
  $('vd-decided').hidden = pending;
  if (pending) {
    $('vd-reason').value = '';
    setMessage('vd-error', '');
    setDisabled(VERIF_BUTTONS, false);
  } else {
    setText('vd-decided-text', v.status === 'approved'
      ? 'Approved ' + fmtTime(v.decided_at) + '. The pictures were deleted.'
      : 'Rejected ' + fmtTime(v.decided_at) + '. Reason: ' + (v.reject_reason || '–') + ' The pictures were deleted.');
  }
  openDialog('verif-dialog');
}

$('vd-under18').addEventListener('click', () => {
  $('vd-reason').value = 'The ID shows that you are under 18. SecureTrade is for users 18 and older.';
});

function decideVerification(decision) {
  if (!currentVerif) return;
  setMessage('vd-error', '');
  const reason = $('vd-reason').value.trim();
  if (decision === 'reject' && reason.length < 5) {
    setMessage('vd-error', 'Write a short reason for rejecting.');
    return;
  }
  const question = decision === 'approve'
    ? 'Approve @' + currentVerif.username + '? You confirm the ID shows they are 18 or older. Their name becomes "' + currentVerif.typed_name + '" and the pictures are deleted.'
    : 'Reject @' + currentVerif.username + '? The pictures are deleted.';
  if (!window.confirm(question)) return;

  submitDecision({
    path: '/admin/verifications/' + currentVerif.verification_id + '/decision',
    body: { decision, reason },
    errorId: 'vd-error',
    buttonIds: VERIF_BUTTONS,
    dialogId: 'verif-dialog',
    onDone: () => { currentVerif = null; }
  });
}

$('vd-approve').addEventListener('click', () => decideVerification('approve'));
$('vd-reject').addEventListener('click', () => decideVerification('reject'));
bindClose('verif-dialog', ['vd-close', 'vd-close2']);
$('verif-dialog').addEventListener('close', () => revokeAll(verifUrls));

// ---------- Dispute review: summary, two sides, one timeline ----------
function addFact(dl, label, value) {
  const box = el('div', 'fact');
  box.appendChild(el('dt', '', label));
  const dd = el('dd');
  if (value instanceof Node) dd.appendChild(value); else dd.textContent = value;
  box.appendChild(dd);
  dl.appendChild(box);
}

function buildSummary(d) {
  const dl = $('rv-summary');
  dl.innerHTML = '';
  const open = d.dispute_status !== 'resolved';
  const other = d.filed_by_username === d.buyer_username ? d.seller_username : d.buyer_username;
  const filerRole = d.filed_by_username === d.buyer_username ? 'buyer' : 'seller';
  const otherRole = filerRole === 'buyer' ? 'Seller' : 'Buyer';

  addFact(dl, 'Amount held', peso(d.amount));
  addFact(dl, 'Status', ST.disputeBadge(d));
  addFact(dl, 'Reason', d.reason);
  addFact(dl, 'Opened by', '@' + d.filed_by_username + ' (' + filerRole + ')');
  addFact(dl, 'Outcome they want', ST.outcomeLabels[d.requested_outcome] || '–');
  addFact(dl, open ? 'Waiting for you' : 'Opened', open
    ? timeSince(d.opened_at)
    : fmtTime(d.opened_at));
  addFact(dl, otherRole + ' replied', d.reply
    ? 'Yes, ' + fmtTime(d.replied_at)
    : (open ? 'Not yet (@' + other + ')' : 'Never'));

  let gap = 'Item not delivered yet';
  if (d.delivered_at) {
    const ms = new Date(d.opened_at).getTime() - new Date(d.delivered_at).getTime();
    gap = ms >= 0 ? duration(ms) + ' after delivery' : 'Filed before delivery';
  }
  addFact(dl, 'Delivery to dispute', gap);
}

function repLine(p) {
  const parts = [
    p.completed_trades + ' completed',
    p.rating === null ? 'no ratings' : '★ ' + p.rating + ' (' + p.rating_count + ')',
    p.disputes + (p.disputes === 1 ? ' dispute' : ' disputes') + ' (' + p.disputes_filed + ' filed)'
  ];
  if (p.seller_cancels > 0) {
    parts.push(p.seller_cancels + (p.seller_cancels === 1 ? ' cancellation' : ' cancellations') + ' after payment');
  }
  return parts.join(' · ') + ' · joined ' + fmtDate(p.joined);
}

function renderParty(container, label, p, d, moneyLine) {
  container.innerHTML = '';

  const top = el('div', 'party-top');
  const head = el('h3', '', label + ' @' + p.username);
  head.appendChild(p.verified ? verifiedBadge() : notVerifiedTag());
  if (p.account_status !== 'active') {
    head.append(' ');
    head.appendChild(accountBadge(p.account_status));
  }
  top.append(makeAvatar(p.username, p.avatar_file, 42), head);
  container.appendChild(top);

  container.appendChild(el('p', 'rep', repLine(p)));
  container.appendChild(el('p', 'line', moneyLine));

  // The person who opened the dispute wrote the report; the other person writes the reply
  const filer = d.filed_by_username === p.username;
  container.appendChild(el('p', 'stmt-title', filer ? 'Report' : 'Reply'));
  container.appendChild(el('p', 'stmt', filer ? (d.description || '') : (d.reply || 'No reply yet.')));

  container.appendChild(el('p', 'ev-title', 'Evidence'));
  const items = d.evidence.filter(e => e.submitted_by_username === p.username);
  const ul = el('ul', 'thumbs');
  container.appendChild(ul);
  addEvidenceThumbs(ul, items, blobUrls, item => item.name + ' (from @' + item.submitted_by_username + ')');
  if (items.length === 0) container.appendChild(el('p', 'hint', 'No screenshots from @' + p.username + '.'));
}

// Trade steps, chat messages, and dispute events in one list, oldest first
function buildTimeline(d) {
  const events = [];
  const has = a => d.activity.some(x => x.action === a);
  const other = d.filed_by_username === d.buyer_username ? d.seller_username : d.buyer_username;

  d.activity.forEach(a => events.push({
    time: a.created_at,
    kind: a.action.indexOf('dispute') === 0 ? 'dispute' : 'trade',
    text: activityText(a, true)
  }));

  // Older trades have no activity log: fill the gaps from the dates saved in the database
  if (!has('trade_created')) events.push({ time: d.trade_created_at, kind: 'trade', text: 'The trade was started' });
  if (!has('delivered') && d.delivered_at) {
    events.push({ time: d.delivered_at, kind: 'trade', text: '@' + d.seller_username + ' marked the item as delivered' });
  }
  if (!has('dispute_opened')) {
    events.push({ time: d.opened_at, kind: 'dispute', text: '@' + d.filed_by_username + ' opened a dispute: ' + d.reason });
  }
  if (d.replied_at && !has('dispute_reply')) {
    events.push({ time: d.replied_at, kind: 'dispute', text: '@' + other + ' replied to the dispute' });
  }

  d.messages.forEach(m => events.push({ time: m.sent_at, kind: 'chat', text: '@' + m.username + ': ' + m.content }));

  events.sort((a, b) => new Date(a.time) - new Date(b.time));

  const KIND_LABEL = { trade: 'Trade', chat: 'Chat', dispute: 'Dispute' };
  fillList('rv-timeline', 'rv-timeline-none', events, ev => {
    const left = el('div');
    left.append(el('span', 'kind kind-' + ev.kind, KIND_LABEL[ev.kind]), el('span', 'when', fmtTime(ev.time)));
    const li = el('li');
    li.append(left, el('div', 'text', ev.text));
    return li;
  });
}

async function openReview(id) {
  const d = await fetchForDialog('/admin/disputes/' + id);
  if (!d) return;
  current = d;
  revokeAll(blobUrls);

  setText('rv-title', 'Dispute #' + d.dispute_id);
  setText('rv-sub', d.item_description + ' · Trade #' + d.transaction_id);

  buildSummary(d);

  const paidWith = d.payment
    ? 'Paid with ' + paymentText(d.payment)
    : 'Has not paid yet';
  const payout = d.payout_method
    ? 'Payout account: ' + ST.methodLabel(d.payout_method, d.payout_masked)
    : 'Payout account: not given yet (not delivered)';
  renderParty($('rv-buyer-card'), 'Buyer', d.buyer, d, paidWith);
  renderParty($('rv-seller-card'), 'Seller', d.seller, d, payout);

  buildTimeline(d);

  const resolved = d.dispute_status === 'resolved';
  $('decision').hidden = resolved;
  $('decided').hidden = !resolved;
  if (resolved) {
    setText('rv-resolution', d.resolution || 'The admin made a decision.');
  } else {
    $('rv-note').value = '';
    setMessage('rv-error', '');
    setDisabled(DISPUTE_BUTTONS, false);
    const hint = $('rv-release-hint');
    hint.hidden = d.can_release;
    if (!d.can_release) {
      hint.textContent = 'Paying the seller is not possible yet: the seller has not said where to receive the money (the item was not marked as delivered). You can refund the buyer.';
    }
  }
  openDialog('review');
}

const DISPUTE_BUTTONS = ['refund', 'release'];

function decide(decision) {
  if (!current) return;
  setMessage('rv-error', '');
  const note = $('rv-note').value.trim();
  if (note.length < 5) {
    setMessage('rv-error', 'Write a short note that explains your decision.');
    return;
  }
  const question = decision === 'refund'
    ? 'Refund ' + peso(current.amount) + ' to @' + current.buyer_username + '? This cannot be undone.'
    : 'Pay @' + current.seller_username + ' for this trade? This cannot be undone.';
  if (!window.confirm(question)) return;

  submitDecision({
    path: '/admin/disputes/' + current.dispute_id + '/resolve',
    body: { decision, note },
    errorId: 'rv-error',
    buttonIds: DISPUTE_BUTTONS,
    dialogId: 'review',
    onDone: () => { current = null; }
  });
}

$('refund').addEventListener('click', () => decide('refund'));
$('release').addEventListener('click', () => decide('release'));
bindClose('review', ['rv-close', 'rv-close2']);

// ---------- One trade ----------
let openTradeDisputeId = null;
let currentTrade = null;

async function openTrade(id) {
  const t = await fetchForDialog('/admin/transactions/' + id);
  if (!t) return;
  currentTrade = t;
  setTexts({
    'td-title': 'Trade #' + t.transaction_id,
    'td-sub': t.item_description,
    'td-buyer': accountNote(t.buyer_username, t.buyer_status),
    'td-seller': accountNote(t.seller_username, t.seller_status),
    'td-amount': peso(t.amount) + ' (fee ' + peso(t.service_fee) + ')',
    'td-status': (TRADE_STATUS[t.status] || [0, t.status])[1],
    'td-paid': t.payment ? paymentText(t.payment) : 'Not paid yet',
    'td-payout': t.payout_method ? ST.methodLabel(t.payout_method, t.payout_masked) : 'Not given yet',
    'td-started': fmtTime(t.created_at),
    'td-receipt': t.receipt_number || '–'
  });

  // A person is suspended or banned while the payment is held
  const who = [];
  if (t.buyer_status !== 'active') who.push('@' + t.buyer_username + ' (the buyer) is ' + t.buyer_status);
  if (t.seller_status !== 'active') who.push('@' + t.seller_username + ' (the seller) is ' + t.seller_status);
  setMessage('td-warn', who.length === 0 ? '' : who.join(' and ') + '.' + (t.needs_admin
    ? ' The payment stays held and it is not released automatically. An admin has to decide this trade.'
    : ''));

  openTradeDisputeId = t.dispute ? t.dispute.dispute_id : null;
  $('td-dispute').hidden = !t.dispute;

  // Refund the buyer without a dispute
  $('td-refund').hidden = !t.can_refund;
  $('td-refund-note').value = '';
  setMessage('td-refund-error', '');
  $('td-refund-btn').disabled = false;

  fillTimeline('td-timeline', 'td-timeline-none', t.activity, true);
  fillChat('td-chat', 'td-chat-none', t.messages);
  openDialog('trade-dialog');
}

$('td-refund-btn').addEventListener('click', () => {
  if (!currentTrade) return;
  setMessage('td-refund-error', '');
  const note = $('td-refund-note').value.trim();
  if (note.length < 5) { setMessage('td-refund-error', 'Write a short note that explains why.'); return; }
  if (!window.confirm('Refund ' + peso(currentTrade.amount) + ' to @' + currentTrade.buyer_username + '? This cannot be undone.')) return;

  submitDecision({
    path: '/admin/transactions/' + currentTrade.transaction_id + '/refund',
    body: { note },
    errorId: 'td-refund-error',
    buttonIds: ['td-refund-btn'],
    dialogId: 'trade-dialog',
    onDone: () => { currentTrade = null; }
  });
});

$('td-dispute-btn').addEventListener('click', () => {
  const id = openTradeDisputeId;
  $('trade-dialog').close();
  if (id) openReview(id);
});
bindClose('trade-dialog', ['td-close']);

// ---------- One user ----------
let currentUser = null;

async function deleteReview(review, button) {
  const note = window.prompt('Why is this review being deleted? (at least 5 characters, saved in the log)');
  if (note === null) return;
  if (note.trim().length < 5) { window.alert('Write a short note that explains why.'); return; }
  button.disabled = true;
  try {
    await postJson('/admin/reviews/' + review.review_ref + '/delete', { note: note.trim() });
    await openUser(currentUser.user_id);
    load();
  } catch (err) {
    window.alert(netError(err));
    button.disabled = false;
  }
}

function reviewItem(r) {
  const li = el('li');
  li.append('★ ' + r.score + ' from ', el('b', '', '@' + r.author_username),
    el('small', '', 'trade #' + r.transaction_id + ' · ' + fmtDate(r.rated_at)));
  if (r.feedback) li.appendChild(el('div', 'quote', r.feedback));

  const del = linkButton('Delete this review', button => deleteReview(r, button));
  del.style.cssText = 'font-size:.85rem;display:block;margin-top:.2rem';
  li.appendChild(del);
  return li;
}

function userTradeItem(t) {
  const li = el('li');
  li.append(
    linkButton('#' + t.transaction_id, () => { $('user-dialog').close(); openTrade(t.transaction_id); }),
    ' ' + t.item_description + ' · ' + peso(t.amount) + ' · as ' + t.role + ' with @' + t.partner_username + ' · ',
    tradeBadge(t.status)
  );
  return li;
}

// A "Show more" button under a list in the user window. Gives a function that shows or hides it.
function showMoreButton(kind, listId, toItem) {
  const button = makeButton('btn btn-outline btn-small more-btn', 'Show more', async () => {
    button.disabled = true;
    try {
      const data = await apiFetch('/admin/users/' + currentUser.user_id + '/list/' + kind + '?offset=' + $(listId).children.length);
      $(listId).append(...data.rows.map(toItem));
      button.hidden = !data.has_more;
    } catch (err) {
      window.alert(netError(err));
    } finally {
      button.disabled = false;
    }
  });
  button.hidden = true;
  $(listId).after(button);
  return hasMore => { button.hidden = !hasMore; };
}

const showMoreTrades = showMoreButton('trades', 'ud-trades', userTradeItem);
const showMoreReviews = showMoreButton('reviews', 'ud-reviews', reviewItem);
const showMoreActivity = showMoreButton('activity', 'ud-activity', a => activityItem(a, false));

async function openUser(id) {
  const u = await fetchForDialog('/admin/users/' + id);
  if (!u) return;
  currentUser = u;

  $('ud-avatar').replaceChildren(makeAvatar(u.username, u.avatar_file, 56));
  setTexts({
    'ud-title': '@' + u.username,
    'ud-sub': u.full_name + ' · ' + u.email,
    'ud-role': u.role === 'admin' ? 'Admin' : 'Member',
    'ud-status': statusLabel(u.account_status),
    'ud-verified': u.role === 'admin' ? 'Admin' : (u.verified ? 'Verified' + (u.verified_at ? ' on ' + fmtDate(u.verified_at) : '') : 'Not verified'),
    'ud-joined': fmtDate(u.created_at),
    'ud-seen': seenText(u),
    'ud-completed': u.completed_trades,
    'ud-active': u.active_trades,
    'ud-disputes': u.disputes,
    'ud-cancels': u.cancels_after_payment,
    'ud-rating': u.rating === null ? 'No ratings yet' : '★ ' + u.rating + ' (' + u.rating_count + ')'
  });

  // Control
  $('ud-control').hidden = !u.can_control;
  $('ud-locked').hidden = u.can_control;
  if (u.can_control) {
    $('ud-note').value = '';
    setMessage('ud-error', '');
    $('ud-suspend').hidden = u.account_status === 'suspended';
    $('ud-ban').hidden = u.account_status === 'banned';
    $('ud-activate').hidden = u.account_status === 'active';
    setDisabled(STATUS_BUTTONS, false);
    setMessage('ud-warn', u.active_trades === 0 ? '' : 'This user has ' + u.active_trades + ' trade(s) on process. Those trades stay as they are. A payment that is held is not released automatically while the user is suspended or banned. Open the trade to refund the buyer, or decide the dispute.');
  }

  // Messages
  $('ud-message').hidden = u.role === 'admin';

  // Their trades
  fillList('ud-trades', 'ud-trades-none', u.trades, userTradeItem);
  fillList('ud-reviews', 'ud-reviews-none', u.reviews, reviewItem);
  fillTimeline('ud-activity', 'ud-activity-none', u.activity, false);
  showMoreTrades(u.trades_more);
  showMoreReviews(u.reviews_more);
  showMoreActivity(u.activity_more);
  openDialog('user-dialog');
}

const STATUS_BUTTONS = ['ud-suspend', 'ud-ban', 'ud-activate'];

function changeStatus(status) {
  if (!currentUser) return;
  setMessage('ud-error', '');
  const note = $('ud-note').value.trim();
  if (status !== 'active' && note.length < 5) {
    setMessage('ud-error', 'Write a short note that explains why.');
    return;
  }
  const verb = status === 'banned' ? 'Ban' : (status === 'suspended' ? 'Suspend' : 'Reactivate');
  if (!window.confirm(verb + ' @' + currentUser.username + '?')) return;

  submitDecision({
    path: '/admin/users/' + currentUser.user_id + '/status',
    body: { status, note },
    errorId: 'ud-error',
    buttonIds: STATUS_BUTTONS,
    dialogId: 'user-dialog',
    onDone: () => { currentUser = null; }
  });
}

$('ud-suspend').addEventListener('click', () => changeStatus('suspended'));
$('ud-ban').addEventListener('click', () => changeStatus('banned'));
$('ud-activate').addEventListener('click', () => changeStatus('active'));
$('ud-message').addEventListener('click', () => {
  if (!currentUser) return;
  const id = currentUser.user_id;
  $('user-dialog').close();
  openChat(id);
});
bindClose('user-dialog', ['ud-close']);

// ---------- Start ----------
load();
setInterval(() => { if (!anyDialogOpen()) load(); }, 30000);

// Sidebar: highlight the menu item for the section on screen
const menuLinks = [...document.querySelectorAll('.sidebar a[href^="#"]')];
function markMenu(id) {
  menuLinks.forEach(a => {
    if (a.getAttribute('href') === '#' + id) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}
menuLinks.forEach(a => a.addEventListener('click', () => {
  const id = a.getAttribute('href').slice(1);
  markMenu(id);
  if (id === 'alerts') markAlertsSeen();
}));

if ('IntersectionObserver' in window) {
  const seen = new IntersectionObserver(entries => {
    entries.forEach(e => { if (e.isIntersecting) markMenu(e.target.id); });
  }, { rootMargin: '-20% 0px -65% 0px' });
  menuLinks.forEach(a => {
    const target = document.getElementById(a.getAttribute('href').slice(1));
    if (target) seen.observe(target);
  });
}
