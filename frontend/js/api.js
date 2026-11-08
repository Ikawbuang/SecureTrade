/* ==========================================================
   api.js – talking to the backend, and the pieces shared by
   every signed-in page. Load it after data.js.
   ========================================================== */

const IDLE_REASON = 'You were signed out because you were inactive.';
const ACTIVE_KEY = 'st_last_active';   // when the user last did something (shared by all open tabs)

/* ---------- Who is signed in ---------- */
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

// Save the parts of the profile the pages read from the saved user
function rememberProfile(p) {
  saveUser({ username: p.username, email: p.email, avatar_file: p.avatar_file, verified: p.verified, full_name: p.full_name });
}

function onSupportPage() {
  return location.pathname.split('/').pop() === 'support.html';
}

// A suspended account can only use the Support page
function goToSupport() {
  saveUser({ account_status: 'suspended' });
  if (!onSupportPage()) window.location.href = 'support.html';
}

// Sign out. If no reason is given, the person chose to sign out, so the server also clears
// this device's session (the next login on any device will not get the "already logged in" warning).
// If a reason is given (idle, another device, suspended), the page goes back to login and shows it.
async function logout(reason) {
  const token = getToken();
  if (token && !reason) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      await fetch(API + '/logout', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token },
        signal: controller.signal
      });
      clearTimeout(timer);
    } catch (err) { /* the server session ends by itself when the account goes idle */ }
  }
  ['st_token', 'st_user', ACTIVE_KEY].forEach(key => localStorage.removeItem(key));
  if (reason) localStorage.setItem('st_logout_reason', reason);
  else localStorage.removeItem('st_logout_reason');
  window.location.href = 'login.html';
}

// The footer at the bottom of the main area
function addFooter() {
  const support = el('a', '', 'Support');
  support.href = 'support.html';
  const footer = el('footer', 'site-footer', ST.footerText() + ' · ');
  footer.appendChild(support);
  document.querySelector('.main').appendChild(footer);
}

// What every signed-in page does first
function startPage() {
  ST.applyBrand();
  if (!getToken()) window.location.href = 'login.html';
  $('signout').addEventListener('click', e => { e.preventDefault(); logout(); });
  addFooter();
}

/* ---------- Calling the backend ---------- */

// Read the server's answer. If we are signed out (another device, idle), go back to login and show why.
// If the account is suspended, go to Support.
async function readReply(res) {
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    logout(data.message);
    throw new Error(data.message || 'Please log in again.');
  }
  if (res.status === 403 && data.code === 'SUSPENDED') {
    goToSupport();
    throw new Error(data.message || 'Your account is suspended.');
  }
  if (!res.ok) throw new Error(data.message || 'Something went wrong. Please try again.');
  return data;
}

// The login token as a header. Without a token, go to the login page.
function authHeader() {
  const token = getToken();
  if (!token) { window.location.href = 'login.html'; throw new Error('Not logged in'); }
  return { Authorization: 'Bearer ' + token };
}

// Call the backend with the login token
async function apiFetch(path, options = {}) {
  const res = await fetch(API + path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...authHeader(), ...(options.headers || {}) }
  });
  return readReply(res);
}

// Send JSON to the backend
function postJson(path, body = {}) {
  return apiFetch(path, { method: 'POST', body: JSON.stringify(body) });
}

// Send a file (FormData) to the backend with the login token
async function apiUpload(path, formData) {
  const res = await fetch(API + path, { method: 'POST', headers: authHeader(), body: formData });
  return readReply(res);
}

// Fetch a private picture (it needs the login token) and give back a link the page can show
async function fetchPrivateImage(path) {
  const res = await fetch(API + path, { headers: { Authorization: 'Bearer ' + getToken() } });
  if (!res.ok) throw new Error('Could not load the picture.');
  return URL.createObjectURL(await res.blob());
}

/* ---------- Small pieces shown on many pages ---------- */

// A round profile picture: the photo if there is one, otherwise the first letter of the username
function makeAvatar(username, file, size = 40) {
  const letter = (username || '?').charAt(0).toUpperCase();
  const box = el('span');
  box.style.cssText =
    'display:inline-grid;place-items:center;flex-shrink:0;overflow:hidden;border-radius:50%;' +
    'background:#dfe3f6;color:#25306b;font-weight:700;vertical-align:middle;' +
    'width:' + size + 'px;height:' + size + 'px;font-size:' + Math.round(size * 0.42) + 'px;';
  box.title = username ? '@' + username : '';

  if (file) {
    const img = el('img');
    img.src = API + '/avatars/' + file;
    img.alt = '';
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
    img.addEventListener('error', () => { img.remove(); box.textContent = letter; });
    box.appendChild(img);
  } else {
    box.textContent = letter;
  }
  return box;
}

// A small rounded label beside a name
function pillTag(text, title, background, color) {
  const tag = el('span', '', text);
  tag.title = title;
  tag.style.cssText =
    'display:inline-block;margin-left:.4rem;padding:.08rem .5rem;border-radius:999px;background:' + background + ';' +
    'color:' + color + ';font-size:.72rem;font-weight:700;vertical-align:middle;white-space:nowrap;';
  return tag;
}

function verifiedBadge() {
  return pillTag('✔ Verified', 'This person verified their identity with an ID', '#d6f4ee', '#146b5a');
}

function notVerifiedTag() {
  return pillTag('Not verified', 'This person has not verified their identity yet', '#fdecc8', '#8a5a00');
}

// A star button to add or remove a favorite. It saves right away (favorites are private).
function makeStar(username, isFavorite, onChange) {
  const btn = makeButton('');
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
      const path = '/favorites/' + encodeURIComponent(username);
      if (fav) await apiFetch(path, { method: 'DELETE' });
      else await apiFetch(path, { method: 'PUT', body: JSON.stringify({}) });
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

// A table row. Each value can be text, an element, or a ready-made <td>.
function tableRow(values) {
  const tr = el('tr');
  values.forEach(v => {
    if (v instanceof HTMLTableCellElement) { tr.appendChild(v); return; }
    const td = el('td');
    if (v instanceof Node) td.appendChild(v); else td.textContent = v;
    tr.appendChild(td);
  });
  return tr;
}

// Five clickable stars. Read the choice with stars.value.
function makeStarRating(box) {
  const stars = {
    value: 0,
    draw() {
      box.innerHTML = '';
      for (let i = 1; i <= 5; i++) {
        const b = makeButton(i <= stars.value ? 'on' : '', '★', () => stars.set(i));
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-checked', i === stars.value);
        b.setAttribute('aria-label', i + (i === 1 ? ' star' : ' stars'));
        box.appendChild(b);
      }
    },
    set(value) { stars.value = value; stars.draw(); }
  };
  stars.draw();
  return stars;
}

// A "Report" link that opens a box for the reason. Returns the link and the box.
function makeReportControls({ openText, panelClass, reviewRef, onStart, onSent, onError }) {
  const open = makeButton('link-btn', openText, () => { panel.hidden = false; open.hidden = true; reason.focus(); });
  const panel = el('div', panelClass);
  panel.hidden = true;

  const reason = el('input');
  reason.type = 'text';
  reason.maxLength = 300;
  reason.placeholder = 'Why? (abusive, false, personal information)';
  reason.setAttribute('aria-label', 'Reason for reporting');

  const send = makeButton('btn btn-primary btn-small', 'Send report', async () => {
    onStart();
    send.disabled = true;
    try {
      await postJson('/reviews/' + reviewRef + '/report', { reason: reason.value });
      onSent();
    } catch (err) {
      onError(netError(err));
      send.disabled = false;
    }
  });
  const cancel = makeButton('btn btn-outline btn-small', 'Cancel', () => { panel.hidden = true; open.hidden = false; });

  panel.append(reason, send, cancel);
  return [open, panel];
}

// Evidence pictures need the login token, so they are fetched and shown as previews.
// The preview links are added to blobUrls so the page can clean them up later.
function addEvidenceThumbs(listEl, items, blobUrls, titleOf) {
  listEl.innerHTML = '';
  items.forEach(item => {
    const title = titleOf(item);
    const btn = makeButton('');
    btn.title = title;
    const img = el('img');
    img.alt = item.name || 'Evidence';
    btn.appendChild(img);
    const li = el('li');
    li.appendChild(btn);
    listEl.appendChild(li);

    fetchPrivateImage('/evidence/' + item.evidence_id + '/file')
      .then(url => {
        blobUrls.push(url);
        img.src = url;
        btn.addEventListener('click', () => window.open(url, '_blank'));
      })
      .catch(() => { btn.textContent = 'Could not load'; });
  });
}

/* ---------- Staying signed in ---------- */

// Tell the server "I'm online" every minute while a page is open
function startHeartbeat() {
  if (!getToken()) return;
  const ping = () => {
    if (document.hidden) return;
    postJson('/heartbeat').catch(() => {});
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
      postJson('/activity').catch(() => {});
    }
  }, 15000);
}

// A suspended account can only use Support, so every other page sends it there
(function () {
  const u = getUser();
  if (getToken() && u && u.account_status === 'suspended' && !onSupportPage()) {
    window.location.replace('support.html');
  }
})();

startHeartbeat();
startIdleWatch();
