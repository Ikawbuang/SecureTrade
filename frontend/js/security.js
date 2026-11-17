startPage();

const cards = ['status-card', 'step-password', 'step-scan', 'step-codes'];
const showCards = (...ids) => cards.forEach(id => { $(id).hidden = !ids.includes(id); });

let moving = false;   // replacing a working setup (new phone)

// Where I stand, and which step to show
async function loadStatus() {
  let s;
  try {
    s = await apiFetch('/2fa');
  } catch (err) {
    setMessage('page-error', netError(err));
    return;
  }
  setMessage('page-error', '');
  const state = $('state');
  state.className = 'state ' + (s.enabled ? 'on' : 'off');
  state.textContent = s.enabled ? 'On' : 'Off';
  $('status-actions').hidden = !s.enabled;

  if (!s.available) {
    $('status-text').textContent = 'Two-step sign-in is not available on this server yet.';
    return showCards('status-card');
  }
  if (!s.required && !s.enabled) {
    $('status-text').textContent = 'Two-step sign-in is for admin accounts for now. Your account does not need it.';
    return showCards('status-card');
  }
  if (s.enabled) {
    const left = s.recovery_codes_left;
    $('status-text').textContent = 'Signing in, refunds and releases need a code from your authenticator app. '
      + 'You have ' + left + (left === 1 ? ' recovery code' : ' recovery codes') + ' left.'
      + (left <= 2 ? ' Get new ones soon.' : '');
    return showCards('status-card');
  }
  $('status-text').textContent = 'Not set up yet. The admin panel stays locked until you finish the steps below.';
  moving = false;
  $('move-code-field').hidden = true;
  showCards('status-card', 'step-password');
}

// Step 1: the password (and, when moving to a new phone, a current code)
$('password-form').addEventListener('submit', async e => {
  e.preventDefault();
  setMessage('password-error', '');
  const btn = $('password-submit');
  btn.disabled = true;
  try {
    const body = { password: $('sec-password').value };
    if (moving) body.code = $('sec-move-code').value.trim();
    const data = await postJson('/2fa/setup', body);
    $('sec-password').value = '';
    $('sec-move-code').value = '';
    $('qr').src = data.qr_image;
    $('secret').textContent = data.secret.replace(/(.{4})/g, '$1 ').trim();
    $('account').textContent = 'Account name in the app: SecureTrade (' + data.account + ')';
    showCards('step-scan');
    $('sec-code').value = '';
    $('sec-code').focus();
  } catch (err) {
    setMessage('password-error', netError(err));
  }
  btn.disabled = false;
});

// Step 2: one code proves the scan worked
$('code-form').addEventListener('submit', async e => {
  e.preventDefault();
  setMessage('code-error', '');
  const btn = $('code-submit');
  btn.disabled = true;
  try {
    const data = await postJson('/2fa/enable', { code: $('sec-code').value.trim() });
    showRecoveryCodes(data.recovery_codes);
  } catch (err) {
    setMessage('code-error', netError(err));
    $('sec-code').select();
  }
  btn.disabled = false;
});

// Step 3: the recovery codes, shown once
function showRecoveryCodes(list) {
  $('codes').replaceChildren(...list.map(code => el('li', '', code)));
  $('copied').hidden = true;
  showCards('step-codes');
}

$('copy-codes').addEventListener('click', async () => {
  const text = [...$('codes').children].map(li => li.textContent).join('\n');
  try {
    await navigator.clipboard.writeText('SecureTrade recovery codes\n' + text);
    $('copied').hidden = false;
  } catch (err) {
    UI.alert('Copying is blocked in this browser. Please write the codes down.', 'Could not copy');
  }
});

// Already on: new recovery codes, or a new phone
$('new-codes').addEventListener('click', async () => {
  const code = await UI.code('Your old recovery codes stop working. Type the 6-digit code from your authenticator app to continue.', { title: 'Get new recovery codes?', okText: 'Make new codes' });
  if (code === null) return;
  try {
    const data = await postJson('/2fa/recovery-codes', { code });
    showRecoveryCodes(data.recovery_codes);
  } catch (err) {
    UI.alert(netError(err));
  }
});

$('move-phone').addEventListener('click', () => {
  moving = true;
  $('move-code-field').hidden = false;
  $('sec-move-code').required = true;
  showCards('step-password');
  $('sec-password').focus();
});

loadStatus();
