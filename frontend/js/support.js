startPage();

const me = getUser() || {};

// Admins answer from the admin panel
if (me.role === 'admin') window.location.replace('admin-dashboard.html#messages');

let data = null;
let lastSignature = '';

// The account status: a suspended account can only use this page
function renderStatus() {
  const stored = (getUser() || {}).account_status || 'active';
  const status = data.account_status;

  if (status === 'suspended') {
    if (stored !== 'suspended') {
      // Just suspended: reload so the menu shows only Support and Sign out
      saveUser({ account_status: 'suspended' });
      window.location.reload();
      return;
    }
    $('suspended-text').textContent =
      'You can only use Support until an admin reactivates it.' +
      (data.suspension_reason ? ' Reason: ' + data.suspension_reason + '.' : '') +
      ' Write to the admins below if you want to appeal.';
    $('suspended-box').hidden = false;
    $('active-box').hidden = true;
  } else {
    $('suspended-box').hidden = true;
    if (stored === 'suspended') {
      saveUser({ account_status: 'active' });
      $('active-box').hidden = false;
    }
  }
}

function render() {
  const box = $('messages');
  box.innerHTML = '';
  if (data.messages.length === 0) {
    box.appendChild(el('p', 'no-msgs', 'No messages yet. Write to the admins and they will reply here.'));
    return;
  }
  data.messages.forEach(m => {
    const mine = !m.from_admin;

    const row = el('div', 'msgrow' + (mine ? ' me' : ''));
    const msg = el('div', 'msg' + (mine ? ' me' : ''));
    msg.append(el('small', '', (mine ? 'You' : 'Admin') + ' · ' + fmtTime(m.sent_at)), document.createTextNode(m.content));

    const avatar = mine ? makeAvatar(me.username, me.avatar_file, 30) : makeAvatar('Admin', null, 30);
    row.append(avatar, msg);
    box.appendChild(row);
  });
  box.scrollTop = box.scrollHeight;
}

async function load() {
  try {
    data = await apiFetch('/support');
  } catch (err) {
    if (!data) setMessage('page-error', netError(err));
    return;
  }
  setMessage('page-error', '');
  renderStatus();

  // Only redraw when there is something new
  const signature = data.messages.map(m => m.message_id).join('|');
  if (signature !== lastSignature) {
    lastSignature = signature;
    render();
  }
  // Opening this page marks the admin's messages as read
  if (window.setNavSupportCount) window.setNavSupportCount(0);
}

$('chat-form').addEventListener('submit', async e => {
  e.preventDefault();
  setMessage('send-error', '');
  const content = $('chat-input').value.trim();
  if (!content) return;
  $('chat-send').disabled = true;
  try {
    await postJson('/support', { content });
    $('chat-input').value = '';
    await load();
  } catch (err) {
    setMessage('send-error', netError(err));
  }
  $('chat-send').disabled = false;
});

load();
// Pick up the admin's reply. A hidden tab does not count, so messages stay unread until you look.
setInterval(() => { if (!document.hidden) load(); }, 5000);
