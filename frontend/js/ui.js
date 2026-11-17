// Shared page helpers, loaded on every signed-in page and on the sign-in page:
//   UI.alert / UI.confirm / UI.prompt  pop-up cards instead of the browser's plain boxes
//   UI.viewImage                       a picture shown big, with a close button (delivery proof, evidence, IDs)
//   Show / Hide on every password box
//   UI.keepForm / UI.keep / UI.forget  typed text survives a refresh or a closed pop-up (never passwords or files)
(function () {
  const make = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  // ---------- Pop-up cards ----------
  // Resolves with true (OK), the typed text (prompt), or null (Cancel, Esc, or a click outside).
  function popup({ title, text, field, code, okText = 'OK', cancelText, danger, minLength = 0 }) {
    return new Promise(resolve => {
      const dlg = make('dialog', 'ui-pop');
      const form = make('form', 'ui-pop-body');
      const heading = make('h2', '', title);
      heading.id = 'ui-pop-title-' + Date.now();
      dlg.setAttribute('aria-labelledby', heading.id);
      form.appendChild(heading);
      if (text) form.appendChild(make('p', 'ui-pop-text', text));

      let input = null;
      if (code) {
        // A 6-digit code from an authenticator app (a recovery code also fits)
        input = make('input', 'ui-pop-code');
        input.type = 'text';
        input.inputMode = 'numeric';
        input.autocomplete = 'one-time-code';
        input.maxLength = 14;
        input.placeholder = '6-digit code';
        input.setAttribute('aria-label', '6-digit code from your authenticator app');
        form.appendChild(input);
      } else if (field) {
        input = make('textarea');
        input.rows = 3;
        input.maxLength = 500;
        input.placeholder = field;
        input.setAttribute('aria-label', field);
        form.appendChild(input);
      }
      const error = make('p', 'ui-pop-error');
      error.setAttribute('role', 'alert');
      error.hidden = true;
      form.appendChild(error);

      const row = make('div', 'ui-pop-actions');
      const ok = make('button', 'btn ' + (danger ? 'btn-danger' : 'btn-primary'), okText);
      ok.type = 'submit';
      row.appendChild(ok);
      if (cancelText) {
        const cancel = make('button', 'btn btn-outline', cancelText);
        cancel.type = 'button';
        cancel.addEventListener('click', () => finish(null));
        row.appendChild(cancel);
      }
      form.appendChild(row);
      dlg.appendChild(form);

      let done = false;
      function finish(value) {
        if (done) return;
        done = true;
        dlg.close();
        dlg.remove();
        resolve(value);
      }
      form.addEventListener('submit', e => {
        e.preventDefault();
        if (!input) return finish(true);
        const value = input.value.trim();
        if (value.length < minLength) {
          error.textContent = code ? 'Enter the 6-digit code from your authenticator app.' : 'Write at least ' + minLength + ' characters.';
          error.hidden = false;
          input.focus();
          return;
        }
        finish(value);
      });
      dlg.addEventListener('cancel', e => { e.preventDefault(); finish(cancelText ? null : true); });
      dlg.addEventListener('click', e => { if (e.target === dlg) finish(cancelText ? null : true); });

      document.body.appendChild(dlg);
      dlg.showModal();
      (input || ok).focus();
    });
  }

  const UI = {
    alert(text, title = 'Something went wrong') {
      return popup({ title, text });
    },
    async confirm(text, { title = 'Are you sure?', okText = 'Yes, continue', cancelText = 'Go back', danger = false } = {}) {
      return (await popup({ title, text, okText, cancelText, danger })) === true;
    },
    // Asks for the 6-digit code. Gives the code, or null when the person goes back.
    code(text, { title = 'Enter your code', okText = 'Confirm', danger = false } = {}) {
      return popup({ title, text, code: true, okText, cancelText: 'Go back', minLength: 6, danger });
    },
    prompt(text, { title = 'Add a note', placeholder = 'Type here', okText = 'Continue', minLength = 0, danger = false } = {}) {
      return popup({ title, text, field: placeholder, okText, cancelText: 'Cancel', minLength, danger });
    },
  };

  // ---------- Picture viewer ----------
  // Fits the screen first; tap the picture to see it at full size (scroll to move around).
  UI.viewImage = function (url, alt = 'Picture') {
    const dlg = make('dialog', 'ui-viewer');
    dlg.setAttribute('aria-label', alt);
    const bar = make('div', 'ui-viewer-bar');
    const hint = make('span', 'ui-viewer-hint', 'Tap the picture to zoom');
    const close = make('button', 'ui-viewer-close', '✕ Close');
    close.type = 'button';
    bar.append(hint, close);

    const stage = make('div', 'ui-viewer-stage');
    const img = make('img');
    img.src = url;
    img.alt = alt;
    stage.appendChild(img);
    img.addEventListener('click', e => {
      e.stopPropagation();
      const zoomed = stage.classList.toggle('zoomed');
      hint.textContent = zoomed ? 'Tap again to fit the screen' : 'Tap the picture to zoom';
    });

    const shut = () => { dlg.close(); dlg.remove(); };
    close.addEventListener('click', shut);
    stage.addEventListener('click', e => { if (e.target === stage) shut(); });
    dlg.addEventListener('close', () => dlg.remove());

    dlg.append(bar, stage);
    document.body.appendChild(dlg);
    dlg.showModal();
    close.focus();
  };

  // ---------- Show / Hide password ----------
  UI.addPasswordToggles = function (root = document) {
    root.querySelectorAll('input[type="password"]').forEach(input => {
      if (input.dataset.toggle) return;
      input.dataset.toggle = '1';
      const wrap = make('span', 'pw-wrap');
      input.parentNode.insertBefore(wrap, input);
      wrap.appendChild(input);
      const btn = make('button', 'pw-toggle', 'Show');
      btn.type = 'button';
      btn.setAttribute('aria-label', 'Show password');
      btn.setAttribute('aria-pressed', 'false');
      btn.addEventListener('click', () => {
        const show = input.type === 'password';
        input.type = show ? 'text' : 'password';
        btn.textContent = show ? 'Hide' : 'Show';
        btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
        btn.setAttribute('aria-pressed', String(show));
        input.focus();
      });
      wrap.appendChild(btn);
      // A form reset or a submit hides the password again
      if (input.form) input.form.addEventListener('reset', () => { input.type = 'password'; btn.textContent = 'Show'; btn.setAttribute('aria-pressed', 'false'); });
    });
  };

  // ---------- Typed text that stays ----------
  // Kept in this browser tab only (sessionStorage), and wiped on sign out.
  const PREFIX = 'st-draft:';
  const keyOf = name => PREFIX + location.pathname + location.search + ':' + name;
  const store = {
    get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* storage is blocked */ } },
    del(k) { try { sessionStorage.removeItem(k); } catch { /* storage is blocked */ } },
  };
  const SKIP = ['password', 'file', 'hidden', 'checkbox', 'submit', 'button'];

  // Keep one box. `name` defaults to its id. Radio buttons are kept by their group name.
  UI.keep = function (field, name) {
    if (SKIP.includes(field.type)) return;
    if (field.type === 'radio') {
      const key = keyOf(name || field.name);
      const saved = store.get(key);
      if (saved !== null) field.checked = field.value === saved;
      field.addEventListener('change', () => { if (field.checked) store.set(key, field.value); });
      return;
    }
    const key = keyOf(name || field.id);
    const saved = store.get(key);
    if (saved !== null) field.value = saved;
    const save = () => store.set(key, field.value);
    field.addEventListener('input', save);
    field.addEventListener('change', save);
  };

  // Keep every box in a form; a reset forgets them
  UI.keepForm = function (form) {
    form.querySelectorAll('input, textarea, select').forEach(f => UI.keep(f));
    form.addEventListener('reset', () => UI.forget(form));
  };

  // Forget a form's saved text (after it was sent), or single boxes by name
  UI.forget = function (formOrNames) {
    const names = Array.isArray(formOrNames)
      ? formOrNames
      : [...formOrNames.querySelectorAll('input, textarea, select')].map(f => (f.type === 'radio' ? f.name : f.id));
    names.filter(Boolean).forEach(n => store.del(keyOf(n)));
  };

  UI.forgetAll = function () {
    try {
      Object.keys(sessionStorage).filter(k => k.startsWith(PREFIX)).forEach(k => sessionStorage.removeItem(k));
    } catch { /* storage is blocked */ }
  };

  // Sign out wipes every saved draft
  document.addEventListener('click', e => { if (e.target.closest && e.target.closest('#signout')) UI.forgetAll(); }, true);

  // ---------- Phone menu ----------
  // On a phone the sidebar is a slim top bar; this button opens and closes the links.
  // A gold dot shows when a hidden link has a counter (new requests, unread updates).
  function addMenuButton() {
    const sidebar = document.querySelector('.app > .sidebar');
    if (!sidebar || sidebar.querySelector('.menu-toggle')) return;
    const btn = make('button', 'menu-toggle');
    btn.type = 'button';
    btn.setAttribute('aria-expanded', 'false');
    const dot = make('span', 'dot');
    dot.hidden = true;
    const label = make('span', '', '☰ Menu');
    btn.append(dot, label);
    const brand = sidebar.querySelector('.brand');
    sidebar.insertBefore(btn, brand ? brand.nextSibling : sidebar.firstChild);

    const setOpen = open => {
      sidebar.classList.toggle('open', open);
      btn.setAttribute('aria-expanded', String(open));
      label.textContent = open ? '✕ Close' : '☰ Menu';
    };
    btn.addEventListener('click', () => setOpen(!sidebar.classList.contains('open')));
    sidebar.addEventListener('click', e => { if (e.target.closest('a')) setOpen(false); });

    const refreshDot = () => {
      const none = ![...sidebar.querySelectorAll('.nav-count, .count')].some(c => !c.hidden && c.textContent.trim());
      if (dot.hidden !== none) dot.hidden = none;   // only on a real change, so the watcher below does not loop
    };
    new MutationObserver(refreshDot).observe(sidebar, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['hidden'] });
    refreshDot();
  }

  // ---------- Phone tables ----------
  // Each cell gets its column name, so on a phone a row can be shown as "Amount ... ₱300" lines
  function labelTables() {
    document.querySelectorAll('.table-wrap table').forEach(table => {
      const heads = [...table.querySelectorAll('thead th')].map(th => (th.querySelector('.sr-only') ? '' : th.textContent.trim()));
      const body = table.tBodies[0];
      if (!body || !heads.length) return;
      const apply = () => [...body.rows].forEach(tr => [...tr.cells].forEach((td, i) => {
        if (td.dataset.label === undefined && td.colSpan === 1) td.dataset.label = heads[i] || '';
      }));
      new MutationObserver(apply).observe(body, { childList: true });
      apply();
    });
  }

  window.UI = UI;

  const start = () => {
    UI.addPasswordToggles();
    addMenuButton();
    labelTables();
    document.querySelectorAll('form[data-keep]').forEach(UI.keepForm);
  };
  // The scripts sit at the end of <body>, so the forms already exist; run before the page script
  start();
})();
