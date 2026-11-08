ST.applyBrand();
setTexts({ 'fee-step': (ST.feeRate * 100) + '%', 'fee-terms': (ST.feeRate * 100) + '%', 'team-line': ST.footerText() });

// ---------- Which form is showing ----------
const forms = {
  login:    $('form-login'),
  register: $('form-register'),
  verify:   $('form-verify'),
  forgot:   $('form-forgot'),
  reset:    $('form-reset')
};
const tabsBar = $('tabs');
const tabLogin = $('tab-login');
const tabRegister = $('tab-register');

function clearMessages() {
  document.querySelectorAll('.form-error, .form-ok, .form-notice').forEach(p => { p.hidden = true; p.textContent = ''; });
  $('login-warn').hidden = true;
}

function show(name) {
  clearMessages();
  for (const key in forms) forms[key].hidden = key !== name;
  tabsBar.hidden = !(name === 'login' || name === 'register');
  tabLogin.setAttribute('aria-selected', name === 'login');
  tabRegister.setAttribute('aria-selected', name === 'register');
}

tabLogin.addEventListener('click', () => show('login'));
tabRegister.addEventListener('click', () => show('register'));
document.querySelectorAll('[data-switch]').forEach(link => {
  link.addEventListener('click', e => { e.preventDefault(); show(link.dataset.switch); });
});

// ---------- Helpers ----------
// Call the backend. A problem keeps the server's message and its code (for example ALREADY_LOGGED_IN).
async function callApi(path, body) {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || 'Something went wrong. Please try again.');
    err.code = data.code;
    throw err;
  }
  return data;
}

function saveSession(data) {
  localStorage.setItem('st_token', data.token);
  localStorage.setItem('st_user', JSON.stringify(data.user));
  localStorage.setItem('st_last_active', String(Date.now()));   // starts the idle timer
  localStorage.removeItem('st_logout_reason');
}

// Admins go to the admin dashboard, a suspended account goes to Support, everyone else to their dashboard
function goHome(user) {
  let page = 'dashboard.html';
  if (user && user.role === 'admin') page = 'admin-dashboard.html';
  else if (user && user.account_status === 'suspended') page = 'support.html';
  window.location.href = page;
}

// ---------- Already signed in? Go straight to the dashboard ----------
// The saved login is checked with the server. If it is still good (not idle for more than
// 15 minutes, and not opened on another device), there is no need to sign in again.
(async function checkSignedIn() {
  const token = localStorage.getItem('st_token');
  if (!token) return;
  document.body.style.visibility = 'hidden';
  try {
    const res = await fetch(API + '/me', { headers: { Authorization: 'Bearer ' + token } });
    if (res.ok) {
      const me = await res.json();
      let saved = {};
      try { saved = JSON.parse(localStorage.getItem('st_user')) || {}; } catch (e) { saved = {}; }
      localStorage.setItem('st_user', JSON.stringify({ ...saved, ...me }));
      goHome(me);
      return;
    }
    if (res.status === 401) {
      const data = await res.json().catch(() => ({}));
      ['st_token', 'st_user', 'st_last_active'].forEach(key => localStorage.removeItem(key));
      if (!localStorage.getItem('st_logout_reason') && /signed out|inactive|not active/i.test(data.message || '')) {
        setMessage('login-notice', data.message);
      }
    }
  } catch (err) { /* the server cannot be reached: show the sign-in form */ }
  document.body.style.visibility = '';
})();

// ---------- Sign in ----------
async function doLogin(force) {
  const data = await callApi('/login', {
    email: $('login-email').value,
    password: $('login-password').value,
    force: !!force
  });
  saveSession(data);
  goHome(data.user);
}

$('form-login').addEventListener('submit', async e => {
  e.preventDefault();
  setMessage('login-error', '');
  $('login-warn').hidden = true;
  const btn = $('login-submit');
  btn.disabled = true;
  try {
    await doLogin(false);
  } catch (err) {
    if (err.code === 'ALREADY_LOGGED_IN') {
      // The password was right, but the account is open somewhere else. Ask before signing that device out.
      $('login-warn-text').textContent = err.message;
      $('login-warn').hidden = false;
    } else {
      setMessage('login-error', netError(err));
    }
    btn.disabled = false;
  }
});

// Continue: sign in here, and the other device is signed out
$('login-continue').addEventListener('click', async () => {
  const btn = $('login-continue');
  btn.disabled = true;
  setMessage('login-error', '');
  try {
    await doLogin(true);
  } catch (err) {
    $('login-warn').hidden = true;
    setMessage('login-error', netError(err));
    btn.disabled = false;
  }
});

// Cancel: nothing changes, the other device stays signed in
$('login-cancel').addEventListener('click', () => {
  $('login-warn').hidden = true;
  $('login-password').value = '';
});

// If the email or password is edited, the warning no longer applies
['login-email', 'login-password'].forEach(id => {
  $(id).addEventListener('input', () => { $('login-warn').hidden = true; });
});

// ---------- Create account ----------
let pendingEmail = '';
const verifyResend = $('verify-resend');

// Step 1: send the PIN
$('form-register').addEventListener('submit', async e => {
  e.preventDefault();
  setMessage('reg-error', '');
  const password = $('reg-password').value;
  if (password !== $('reg-confirm').value) {
    setMessage('reg-error', 'Passwords do not match.');
    return;
  }
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    const email = $('reg-email').value.trim();
    await callApi('/register/start', {
      first_name: $('reg-first').value,
      last_name: $('reg-last').value,
      username: $('reg-username').value,
      email,
      password,
      is_adult: $('reg-adult').checked
    });
    pendingEmail = email;
    show('verify');
    $('verify-text').textContent =
      'We sent a 6-digit PIN to ' + email + '. Type it below to finish creating your account. It expires in 10 minutes.';
    $('verify-pin').value = '';
    $('verify-pin').focus();
    startCooldown(verifyResend, 60);
  } catch (err) {
    setMessage('reg-error', netError(err));
  }
  btn.disabled = false;
});

// Step 2: check the PIN, create the account, and sign in
$('form-verify').addEventListener('submit', async e => {
  e.preventDefault();
  setMessage('verify-error', '');
  setMessage('verify-info', '');
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    const data = await callApi('/register/verify', {
      email: pendingEmail,
      pin: $('verify-pin').value.trim()
    });
    saveSession(data);
    goHome(data.user);
  } catch (err) {
    setMessage('verify-error', netError(err));
    btn.disabled = false;
  }
});

verifyResend.addEventListener('click', async () => {
  setMessage('verify-error', '');
  setMessage('verify-info', '');
  verifyResend.disabled = true;
  try {
    await callApi('/register/resend', { email: pendingEmail });
    setMessage('verify-info', 'A new PIN was sent to ' + pendingEmail + '.');
    startCooldown(verifyResend, 60);
  } catch (err) {
    setMessage('verify-error', netError(err));
    verifyResend.disabled = false;
  }
});

// ---------- Forgot password ----------
let resetEmail = '';
const resetResend = $('reset-resend');

// Step 1: send the PIN
$('form-forgot').addEventListener('submit', async e => {
  e.preventDefault();
  setMessage('forgot-error', '');
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    const email = $('forgot-email').value.trim();
    await callApi('/password/forgot', { email });
    resetEmail = email;
    show('reset');
    $('reset-text').textContent =
      'If ' + email + ' has an account, we sent a 6-digit PIN to it. Type the PIN and your new password below.';
    $('reset-pin').value = '';
    $('reset-pin').focus();
    startCooldown(resetResend, 60);
  } catch (err) {
    setMessage('forgot-error', netError(err));
  }
  btn.disabled = false;
});

// Step 2: check the PIN and change the password (every device is signed out)
$('form-reset').addEventListener('submit', async e => {
  e.preventDefault();
  setMessage('reset-error', '');
  setMessage('reset-info', '');
  const password = $('reset-password').value;
  if (password !== $('reset-confirm').value) {
    setMessage('reset-error', 'Passwords do not match.');
    return;
  }
  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    await callApi('/password/reset', {
      email: resetEmail,
      pin: $('reset-pin').value.trim(),
      new_password: password
    });
    show('login');
    $('login-email').value = resetEmail;
    $('login-password').value = '';
    setMessage('login-info', 'Your password was changed and every device was signed out. Sign in with your new password.');
  } catch (err) {
    setMessage('reset-error', netError(err));
  }
  btn.disabled = false;
});

resetResend.addEventListener('click', async () => {
  setMessage('reset-error', '');
  setMessage('reset-info', '');
  resetResend.disabled = true;
  try {
    await callApi('/password/forgot', { email: resetEmail });
    setMessage('reset-info', 'If the email has an account, a new PIN was sent.');
    startCooldown(resetResend, 60);
  } catch (err) {
    setMessage('reset-error', netError(err));
    resetResend.disabled = false;
  }
});

// ---------- Why was I sent here? (signed out on another device, or inactive) ----------
const logoutReason = localStorage.getItem('st_logout_reason');
if (logoutReason) {
  setMessage('login-notice', logoutReason);
  localStorage.removeItem('st_logout_reason');
}
