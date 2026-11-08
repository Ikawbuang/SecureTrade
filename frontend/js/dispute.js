startPage();

const tradeId = new URLSearchParams(location.search).get('id');
const MAX_FILES = 5;
const MAX_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

let info = null;
let lastSignature = '';
const blobUrls = [];      // image previews, cleaned up when the page redraws

function fmtDateTime(iso) {
  return new Date(iso).toLocaleString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// ---------- The list of my disputes (no trade chosen) ----------
function disputeRow(d) {
  const status = el('div');
  status.appendChild(ST.disputeBadge(d));
  if (d.needs_my_reply) status.appendChild(el('span', 'needs-reply', 'Needs your reply'));

  const open = el('a', '', 'Open');
  open.href = 'dispute.html?id=' + d.transaction_id;

  return tableRow([
    '#' + d.dispute_id, d.item_description, d.my_role === 'buyer' ? 'Buyer' : 'Seller',
    '@' + d.partner_username, ST.pesoShort(d.amount), status, open
  ]);
}

async function loadList() {
  let list;
  try {
    list = await apiFetch('/disputes');
  } catch (err) {
    setMessage('page-error', netError(err));
    return;
  }
  setMessage('page-error', '');

  $('list-rows').replaceChildren(...list.map(disputeRow));

  $('list-empty').hidden = list.length > 0;
  $('list-view').querySelector('.table-wrap').hidden = list.length === 0;
  $('list-view').hidden = false;
}

// ---------- One trade: the form, or the dispute itself ----------

// Check the chosen images and list their names
function checkImages(files) {
  if (files.length > MAX_FILES) return 'You can upload up to ' + MAX_FILES + ' images.';
  for (const f of files) {
    if (!IMAGE_TYPES.includes(f.type)) return f.name + ' is not a JPG, PNG, WEBP, or GIF image.';
    if (f.size > MAX_BYTES) return f.name + ' is bigger than 5 MB.';
  }
  return '';
}
function listFiles(input, listId) {
  const list = $(listId);
  list.innerHTML = '';
  for (const f of input.files) list.appendChild(el('li', '', f.name));
}
$('proof').addEventListener('change', e => listFiles(e.target, 'files'));
$('reply-proof').addEventListener('change', e => listFiles(e.target, 'reply-files'));

const showThumbs = (listEl, items) =>
  addEvidenceThumbs(listEl, items, blobUrls, item => item.name || 'Evidence');

function renderTradeLine() {
  const t = info.trade;
  const other = t.my_role === 'buyer' ? 'Seller @' + t.seller_username : 'Buyer @' + t.buyer_username;
  $('tl-item').textContent = t.item_description;
  $('tl-meta').textContent = 'Trade #' + t.transaction_id + ' · ' + other + ' · ' + ST.peso(Number(t.amount));
  const link = 'transaction.html?id=' + t.transaction_id;
  $('tl-link').href = link;
  $('back-link').href = link;
  $('cannot-link').href = link;
  $('thread-trade-link').href = link;
}

function renderForm() {
  $('page-title').textContent = 'Report a problem';
  $('page-sub').textContent = 'Tell us what went wrong. Your payment stays in escrow while an admin reviews the trade.';

  const reason = $('reason');
  reason.innerHTML = '<option value="">Choose a reason</option>';
  info.reasons.forEach(r => {
    const opt = el('option', '', r);
    opt.value = r;
    reason.appendChild(opt);
  });

  const box = $('outcomes');
  box.innerHTML = '';
  info.outcomes.forEach((o, i) => {
    const input = el('input');
    input.type = 'radio';
    input.name = 'outcome';
    input.value = o.value;
    input.checked = i === 0;
    const text = el('div');
    text.append(o.label, el('span', '', o.hint));
    const label = el('label');
    label.append(input, text);
    box.appendChild(label);
  });

  $('dispute-form').hidden = false;
}

function renderThread() {
  const d = info.dispute;
  const t = info.trade;
  const partner = t.my_role === 'buyer' ? t.seller_username : t.buyer_username;

  $('page-title').textContent = 'Dispute #' + d.dispute_id;
  $('page-sub').textContent = d.dispute_status === 'resolved'
    ? 'An admin decided this dispute.'
    : 'Your payment stays in escrow while an admin reviews the trade.';

  const badge = $('thread-badge');
  const labels = {
    open:         ['badge-dispute',  'Dispute open'],
    under_review: ['badge-held',     'Under review'],
    resolved:     ['badge-released', 'Resolved']
  };
  const b = labels[d.dispute_status] || ['badge-pending', d.dispute_status];
  badge.className = 'badge ' + b[0];
  badge.textContent = b[1];

  $('thread-meta').textContent = 'Opened ' + fmtDateTime(d.opened_at) + ' by ' + (d.filed_by_me ? 'you' : '@' + d.filed_by_username);
  $('f-reason').textContent = d.reason;
  $('f-desc').textContent = d.description || '';
  $('f-outcome').textContent = ST.outcomeLabels[d.requested_outcome] || '';

  // The person who opened it
  const opener = d.filed_by_me ? 'you' : '@' + d.filed_by_username;
  $('ev-opener-title').textContent = 'Evidence from ' + opener;
  const openerEvidence = d.evidence.filter(e => e.submitted_by_username === d.filed_by_username);
  showThumbs($('ev-opener'), openerEvidence);
  $('ev-opener-none').hidden = openerEvidence.length > 0;

  // The other person's reply
  const replier = d.filed_by_me ? '@' + partner : 'you';
  $('reply-title').textContent = 'Reply from ' + replier;
  const replyEvidence = d.evidence.filter(e => e.submitted_by_username !== d.filed_by_username);
  $('reply-shown').hidden = !d.reply;
  $('reply-waiting').hidden = true;
  if (d.reply) {
    $('reply-text').textContent = d.reply;
    showThumbs($('ev-reply'), replyEvidence);
  } else if (d.dispute_status !== 'resolved') {
    $('reply-waiting').textContent = d.filed_by_me
      ? 'Waiting for @' + partner + ' to reply.'
      : 'You have not replied yet.';
    $('reply-waiting').hidden = false;
  } else {
    $('reply-waiting').textContent = 'No reply was sent.';
    $('reply-waiting').hidden = false;
  }

  // Reply form: only for the person who did not open the dispute
  $('reply-form').hidden = !d.can_reply;
  $('reply-form-title').textContent = d.reply ? 'Update your reply' : 'Reply to this dispute';
  $('reply-submit').textContent = d.reply ? 'Update reply' : 'Send reply';

  // Admin decision
  const resolution = $('resolution');
  resolution.hidden = d.dispute_status !== 'resolved';
  if (d.dispute_status === 'resolved') {
    resolution.className = 'notice ok';
    resolution.textContent = d.resolution || 'The admin made a decision.';
  }

  $('thread').hidden = false;
}

function render() {
  blobUrls.splice(0).forEach(u => URL.revokeObjectURL(u));
  $('dispute-form').hidden = true;
  $('cannot').hidden = true;
  $('thread').hidden = true;

  renderTradeLine();
  if (info.dispute) renderThread();
  else if (info.can_file) renderForm();
  else $('cannot').hidden = false;
  $('layout').hidden = false;
}

async function load() {
  try {
    info = await apiFetch('/transactions/' + tradeId + '/dispute');
  } catch (err) {
    if (!info) {
      setMessage('page-error', netError(err));
    }
    return;
  }
  setMessage('page-error', '');

  // Only redraw when something changed, so a reply being typed is not lost
  const d = info.dispute;
  const signature = [
    info.trade.status,
    d ? d.dispute_status : 'none',
    d ? (d.reply || '').length : 0,
    d ? d.evidence.length : 0,
    d ? (d.resolution || '') : ''
  ].join(':');
  if (signature !== lastSignature) {
    lastSignature = signature;
    render();
  }
}

// Open a dispute
$('dispute-form').addEventListener('submit', async e => {
  e.preventDefault();
  setMessage('form-error', '');
  const files = Array.from($('proof').files);
  const problem = checkImages(files);
  if (problem) { setMessage('form-error', problem); return; }

  const form = new FormData();
  form.append('reason', $('reason').value);
  form.append('description', $('desc').value);
  form.append('outcome', document.querySelector('input[name="outcome"]:checked').value);
  files.forEach(f => form.append('files', f));

  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    await apiUpload('/transactions/' + tradeId + '/dispute', form);
    lastSignature = '';
    await load();
  } catch (err) {
    setMessage('form-error', netError(err));
  }
  btn.disabled = false;
});

// Reply to a dispute
$('reply-form').addEventListener('submit', async e => {
  e.preventDefault();
  setMessage('reply-error', '');
  setMessage('reply-ok', '');
  const files = Array.from($('reply-proof').files);
  const problem = checkImages(files);
  if (problem) { setMessage('reply-error', problem); return; }

  const form = new FormData();
  form.append('message', $('reply-message').value);
  files.forEach(f => form.append('files', f));

  const btn = $('reply-submit');
  btn.disabled = true;
  try {
    await apiUpload('/transactions/' + tradeId + '/dispute/reply', form);
    e.target.reset();
    $('reply-files').innerHTML = '';
    lastSignature = '';
    await load();
    setMessage('reply-ok', 'Your reply was sent.');
  } catch (err) {
    setMessage('reply-error', netError(err));
  }
  btn.disabled = false;
});

// ---------- Start ----------
if (!tradeId) {
  // Opened from the menu: show all my disputes
  loadList();
  setInterval(loadList, 30000);
} else if (!/^\d+$/.test(String(tradeId))) {
  setMessage('page-error', 'That trade link is not valid. Open a dispute from the list below.');
  loadList();
} else {
  load();
  setInterval(load, 15000);   // pick up the other person's reply and the admin decision
}
