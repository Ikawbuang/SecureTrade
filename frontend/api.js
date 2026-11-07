const API = 'http://localhost:3000/api';

const IDLE_REASON = 'You were signed out because you were inactive.';
const ACTIVE_KEY = 'st_last_active';   // when the user last did something (shared by all open tabs)

function getToken() {
  return localStorage.getItem('st_token');
}

function getUser() {
  try { return JSON.parse(localStorage.getItem('st_user')); } catch { return null; }
}

// Keep the saved user up to date after the profile changes
function saveUser(patch) {
  const user = Object.assign(getUser() || {}, patch);
  localStorage.setItem('st_user', JSON.stringify(user));
  return user;
}

// Sign out. The reason (if any) is shown on the login page.
function logout(reason) {
  localStorage.removeItem('st_token');
  localStorage.removeItem('st_user');
  localStorage.removeItem(ACTIVE_KEY);
  if (reason) localStorage.setItem('st_logout_reason', reason);
  else localStorage.removeItem('st_logout_reason');
  window.location.href = 'login.html';
}

// Call the backend with the login token. If the server says we are signed out
// (another device, idle, suspended), go back to login and show why.
async function apiFetch(path, options = {}) {
  const token = getToken();
  if (!token) { window.location.href = 'login.html'; throw new Error('Not logged in'); }

  const res = await fetch(API + path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token,
      ...(options.headers || {})
    }
  });

  if (res.status === 401) {
    const data = await res.json().catch(() => ({}));
    logout(data.message);
    throw new Error(data.message || 'Please log in again.');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || 'Something went wrong. Please try again.');
  return data;
}

// Send a file (FormData) to the backend with the login token
async function apiUpload(path, formData, method) {
  const token = getToken();
  if (!token) { window.location.href = 'login.html'; throw new Error('Not logged in'); }

  const res = await fetch(API + path, {
    method: method || 'POST',
    headers: { Authorization: 'Bearer ' + token },
    body: formData
  });

  if (res.status === 401) {
    const data = await res.json().catch(() => ({}));
    logout(data.message);
    throw new Error(data.message || 'Please log in again.');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || 'Something went wrong. Please try again.');
  return data;
}

// Fetch a private picture (it needs the login token) and give back a link the page can show
async function fetchPrivateImage(path) {
  const res = await fetch(API + path, { headers: { Authorization: 'Bearer ' + getToken() } });
  if (!res.ok) throw new Error('Could not load the picture.');
  return URL.createObjectURL(await res.blob());
}

// The address of a profile photo
function avatarUrl(file) {
  return file ? API + '/avatars/' + file : null;
}

// A round profile picture: the photo if there is one, otherwise the first letter of the username
function makeAvatar(username, file, size) {
  size = size || 40;
  const letter = (username || '?').charAt(0).toUpperCase();
  const box = document.createElement('span');
  box.style.cssText =
    'display:inline-grid;place-items:center;flex-shrink:0;overflow:hidden;border-radius:50%;' +
    'background:#dfe3f6;color:#25306b;font-weight:700;vertical-align:middle;' +
    'width:' + size + 'px;height:' + size + 'px;font-size:' + Math.round(size * 0.42) + 'px;';
  box.title = username ? '@' + username : '';

  if (file) {
    const img = document.createElement('img');
    img.src = avatarUrl(file);
    img.alt = '';
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
    img.addEventListener('error', () => { img.remove(); box.textContent = letter; });
    box.appendChild(img);
  } else {
    box.textContent = letter;
  }
  return box;
}

// "✔ Verified": this person showed an ID to an admin
function verifiedBadge() {
  const b = document.createElement('span');
  b.textContent = '✔ Verified';
  b.title = 'This person verified their identity with an ID';
  b.style.cssText =
    'display:inline-block;margin-left:.4rem;padding:.08rem .5rem;border-radius:999px;background:#d6f4ee;' +
    'color:#146b5a;font-size:.72rem;font-weight:700;vertical-align:middle;white-space:nowrap;';
  return b;
}

// "Not verified": this person cannot trade yet
function notVerifiedTag() {
  const b = document.createElement('span');
  b.textContent = 'Not verified';
  b.title = 'This person has not verified their identity yet';
  b.style.cssText =
    'display:inline-block;margin-left:.4rem;padding:.08rem .5rem;border-radius:999px;background:#fdecc8;' +
    'color:#8a5a00;font-size:.72rem;font-weight:700;vertical-align:middle;white-space:nowrap;';
  return b;
}

// A star button to add or remove a favorite. It saves right away (favorites are private).
function makeStar(username, isFavorite, onChange) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.style.cssText = 'background:none;border:0;padding:0 .15rem;font-size:1.3rem;line-height:1;cursor:pointer;';
  let fav = !!isFavorite;

  const paint = () => {
    btn.textContent = fav ? '★' : '☆';
    btn.title = fav ? 'Remove from favorites' : 'Add to favorites';
    btn.setAttribute('aria-pressed', String(fav));
    btn.style.color = fav ? '#e0a100' : '#8a90b5';
  };
  paint();

  btn.addEventListener('click', async e => {
    e.stopPropagation();
    btn.disabled = true;
    try {
      if (fav) await apiFetch('/favorites/' + encodeURIComponent(username), { method: 'DELETE' });
      else await apiFetch('/favorites/' + encodeURIComponent(username), { method: 'PUT', body: JSON.stringify({}) });
      fav = !fav;
      paint();
      if (onChange) onChange(fav);
    } catch (err) {
      alert(err.message);
    }
    btn.disabled = false;
  });
  return btn;
}

// Tell the server "I'm online" every minute while a page is open
function startHeartbeat() {
  if (!getToken()) return;
  const ping = () => {
    if (document.hidden) return;
    apiFetch('/heartbeat', { method: 'POST' }).catch(() => {});
  };
  ping();
  setInterval(ping, 60000);
  document.addEventListener('visibilitychange', ping);
}

// Sign out after a while without the user doing anything (clicks, typing, scrolling, touch).
// Pages that refresh themselves in the background do not count as activity.
function startIdleWatch() {
  if (!getToken()) return;

  let idleMs = (Number(localStorage.getItem('st_idle_minutes')) || 15) * 60000;

  // Use the same limit as the server
  fetch(API + '/config')
    .then(r => r.json())
    .then(c => {
      if (c && c.idle_minutes) {
        idleMs = c.idle_minutes * 60000;
        localStorage.setItem('st_idle_minutes', String(c.idle_minutes));
      }
    })
    .catch(() => {});

  if (!localStorage.getItem(ACTIVE_KEY)) localStorage.setItem(ACTIVE_KEY, String(Date.now()));

  let lastMark = 0;
  const onActivity = () => {
    const now = Date.now();
    if (now - lastMark < 1000) return;
    lastMark = now;
    localStorage.setItem(ACTIVE_KEY, String(now));
  };
  ['click', 'keydown', 'scroll', 'touchstart', 'wheel'].forEach(name =>
    window.addEventListener(name, onActivity, { passive: true, capture: true })
  );

  // Every 15 seconds: sign out if idle too long, otherwise tell the server the user is active
  let lastPing = 0;
  setInterval(() => {
    const last = Number(localStorage.getItem(ACTIVE_KEY)) || 0;
    const now = Date.now();
    if (now - last > idleMs) { logout(IDLE_REASON); return; }
    if (now - last < 60000 && now - lastPing > 60000) {
      lastPing = now;
      apiFetch('/activity', { method: 'POST' }).catch(() => {});
    }
  }, 15000);
}

startHeartbeat();
startIdleWatch();

// ---------- Small helpers used by many pages ----------
// Make an element with a class and text
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// Show a message in the element with this id, or hide it when the message is empty
function setMessage(id, msg) {
  const box = document.getElementById(id);
  box.textContent = msg;
  box.hidden = !msg;
}

// A clear message when the server cannot be reached
function netError(err) {
  return err instanceof TypeError ? 'Cannot reach the server. Is the backend running?' : err.message;
}

// "Oct 18, 3:05 PM"
function fmtTime(iso) {
  return new Date(iso).toLocaleString('en-PH', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
