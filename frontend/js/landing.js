/* ==========================================================
   landing.js – the public page people see before they sign up.
   Someone who is already signed in goes straight to their own page.
   ========================================================== */

ST.applyBrand();
$('lp-copy').textContent = ST.footerText();

(async function goHomeIfSignedIn() {
  let token = null;
  try { token = localStorage.getItem('st_token'); } catch (err) { return; }
  if (!token) return;
  try {
    const res = await fetch(API + '/me', { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) return;   // the saved login is no longer valid, so the page stays
    const me = await res.json();
    let page = 'dashboard.html';
    if (me.role === 'admin') page = 'admin-dashboard.html';
    else if (me.account_status === 'suspended') page = 'support.html';
    window.location.replace(page);
  } catch (err) { /* the server cannot be reached: show the page */ }
})();
