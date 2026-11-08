// Adds Support and Feedback to the menu, and the small numbers beside Dashboard and Support:
//  - Dashboard: how many trade requests are waiting
//  - Support: how many messages from the admins were not read yet
// A suspended account only sees Support and Sign out.
(function () {
  if (typeof apiFetch !== 'function' || typeof getToken !== 'function' || !getToken()) return;

  // The Google Form for the survey. Change the link here if it ever changes.
  const FEEDBACK_URL = 'https://forms.gle/Rex91MrokLRTdjg47';

  const sidebar = document.querySelector('.sidebar');
  if (!sidebar) return;

  const user = getUser() || {};
  const suspended = user.account_status === 'suspended';
  const onSupport = onSupportPage();
  const spacer = sidebar.querySelector('.spacer');

  const style = document.createElement('style');
  style.textContent =
    '.sidebar .nav-count{margin-left:.4rem;padding:.05rem .5rem;border-radius:999px;' +
    'background:var(--gold);color:var(--ink);font-size:.75rem;font-weight:700;}';
  document.head.appendChild(style);

  // A suspended account only sees Support and Sign out
  if (suspended) {
    sidebar.querySelectorAll('a').forEach(a => {
      if (a.classList.contains('brand')) a.setAttribute('href', 'support.html');
      else if (a.id !== 'signout') a.remove();
    });
  }

  function linkTo(href) {
    return Array.from(sidebar.querySelectorAll('a'))
      .find(a => a.getAttribute('href') === href && !a.classList.contains('brand'));
  }

  // A small number beside a menu link
  function makeCounter(link, singular, plural) {
    if (!link) return function () {};
    const badge = document.createElement('span');
    badge.className = 'nav-count';
    badge.hidden = true;
    link.appendChild(badge);
    return function (n) {
      badge.hidden = !n;
      badge.textContent = n || '';
      badge.title = n + (n === 1 ? singular : plural);
    };
  }

  // Support link
  let support = linkTo('support.html');
  if (!support) {
    support = document.createElement('a');
    support.href = 'support.html';
    support.textContent = 'Support';
    sidebar.insertBefore(support, spacer || null);
  }
  if (onSupport) support.setAttribute('aria-current', 'page');

  // Feedback link (opens the Google Form in a new tab)
  if (!suspended && !sidebar.querySelector('a[data-feedback]')) {
    const feedback = document.createElement('a');
    feedback.href = FEEDBACK_URL;
    feedback.target = '_blank';
    feedback.rel = 'noopener noreferrer';
    feedback.textContent = 'Feedback';
    feedback.setAttribute('data-feedback', '1');
    sidebar.insertBefore(feedback, spacer || null);
  }

  const showRequests = suspended ? function () {} :
    makeCounter(linkTo('dashboard.html'), ' trade request is waiting', ' trade requests are waiting');
  const showSupport = makeCounter(support, ' unread message from the admins', ' unread messages from the admins');

  // The pages call these right after something changes
  window.setNavRequestCount = showRequests;
  window.setNavSupportCount = showSupport;

  async function refresh() {
    if (!suspended) {
      try {
        const list = await apiFetch('/requests');
        showRequests(list.length);
      } catch (err) { /* the menu number is optional */ }
    }
    try {
      const r = await apiFetch('/support/unread');
      showSupport(onSupport ? 0 : r.unread);
    } catch (err) { /* the menu number is optional */ }
  }

  refresh();
  setInterval(refresh, 30000);
})();