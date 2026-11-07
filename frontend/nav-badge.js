// Shows how many trade requests are waiting, as a small number beside "Dashboard" in the menu.
(function () {
  if (typeof apiFetch !== 'function' || typeof getToken !== 'function' || !getToken()) return;

  const link = Array.from(document.querySelectorAll('.sidebar a'))
    .find(a => a.getAttribute('href') === 'dashboard.html' && !a.classList.contains('brand'));
  if (!link) return;

  const style = document.createElement('style');
  style.textContent =
    '.sidebar .nav-count{margin-left:.4rem;padding:.05rem .5rem;border-radius:999px;' +
    'background:var(--gold);color:var(--ink);font-size:.75rem;font-weight:700;}';
  document.head.appendChild(style);

  const badge = document.createElement('span');
  badge.className = 'nav-count';
  badge.hidden = true;
  link.appendChild(badge);

  function show(n) {
    badge.hidden = !n;
    badge.textContent = n || '';
    badge.title = n + (n === 1 ? ' trade request is waiting' : ' trade requests are waiting');
  }

  // The dashboard calls this right after you accept or decline a request
  window.setNavRequestCount = show;

  async function refresh() {
    try {
      const list = await apiFetch('/requests');
      show(list.length);
    } catch (err) { /* the menu number is optional */ }
  }

  refresh();
  setInterval(refresh, 30000);
})();