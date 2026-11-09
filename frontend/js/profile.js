startPage();

let profile = null;
let verification = null;
let reviews = [];
let showVerifyForm = false;   // the verification form opens only after pressing "Verify now"

function fmtLongDate(iso) {
  return new Date(iso).toLocaleDateString('en-PH', { month: 'long', day: 'numeric', year: 'numeric' });
}
// Show a message in a green (ok) or red (error) line
function say(prefix, text, ok) {
  $(prefix + '-error').hidden = true;
  if ($(prefix + '-ok')) $(prefix + '-ok').hidden = true;
  if (!text) return;
  const line = $(prefix + (ok ? '-ok' : '-error'));
  line.textContent = text;
  line.hidden = false;
}

// ---------- Profile: view mode ----------
function renderProfile() {
  const p = profile;
  $('pf-avatar').replaceChildren(makeAvatar(p.username, p.avatar_file, 72));
  $('pf-title').replaceChildren('@' + p.username);
  if (p.verified) $('pf-title').appendChild(verifiedBadge());
  $('pf-sub').textContent = p.email;
  $('pf-remove').hidden = !p.avatar_file;

  $('pf-first').textContent = p.first_name || p.full_name || '–';
  $('pf-last').textContent = p.last_name || '–';
  $('pf-username-value').textContent = '@' + p.username;
  $('pf-email-value').textContent = p.email;
  $('pf-joined').textContent = fmtMonthYear(p.created_at);

  rememberProfile(p);

  // The Edit button for the username is locked while trades are on process or during the 30 days
  let reason = '';
  if (p.active_trades > 0) reason = 'You cannot change your username while you have trades on process.';
  else if (p.next_username_change) reason = 'You can change your username again on ' + fmtLongDate(p.next_username_change) + '.';
  $('pf-username-edit').disabled = !!reason;
  $('pf-username-hint').textContent = reason;
  $('pf-username-hint').hidden = !reason;

  // The numbers above the reviews
  $('rev-sub').textContent = p.rating_count
    ? '★ ' + Number(p.avg_rating).toFixed(1) + ' from ' + p.rating_count + (p.rating_count === 1 ? ' rating' : ' ratings')
      + '. Their names are hidden from you and from everyone else.'
    : 'Ratings from the people you traded with. Their names are hidden from you and from everyone else.';
}

// ---------- My reviews: stars, comment, date, and whether the writer was the buyer or the seller ----------
function renderReviews() {
  const list = $('rev-list');
  list.innerHTML = '';
  reviews.forEach(r => {
    const li = el('li', 'rev-item');
    const top = el('div');
    top.append(
      el('strong', '', '★ ' + r.score),
      el('span', 'rev-meta', ' · from the ' + r.as_role.toLowerCase() + ' · ' + fmtLongDate(r.rated_at))
    );
    li.appendChild(top);
    if (r.feedback) li.appendChild(el('p', 'rev-text', r.feedback));

    const act = el('div', 'rev-actions');
    if (r.reported_by_me) {
      act.appendChild(el('span', 'rev-meta', 'You reported this review. An admin will look at it.'));
    } else {
      act.append(...makeReportControls({
        openText: 'Report this review',
        panelClass: 'rev-report',
        reviewRef: r.review_ref,
        onStart: () => say('rev', ''),
        onSent: () => {
          r.reported_by_me = true;
          renderReviews();
          say('rev', 'Thank you. An admin will look at this review.', true);
        },
        onError: message => say('rev', message)
      }));
    }
    li.appendChild(act);
    list.appendChild(li);
  });
  $('rev-none').hidden = reviews.length > 0;
}

// Photo: choose a file and it uploads right away
$('pf-choose').addEventListener('click', () => $('pf-file').click());
$('pf-file').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  say('pf-photo', '');
  if (!file) return;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { say('pf-photo', 'Choose a JPG, PNG, or WEBP photo.'); return; }
  if (file.size > 2 * 1024 * 1024) { say('pf-photo', 'The photo must be 2 MB or smaller.'); return; }
  const form = new FormData();
  form.append('photo', file);
  $('pf-choose').disabled = true;
  try {
    await apiUpload('/profile/avatar', form);
    await loadAll();
    say('pf-photo', 'Your photo was updated.', true);
  } catch (err) { say('pf-photo', netError(err)); }
  $('pf-choose').disabled = false;
});
$('pf-remove').addEventListener('click', async () => {
  say('pf-photo', '');
  try {
    await apiFetch('/profile/avatar', { method: 'DELETE' });
    await loadAll();
    say('pf-photo', 'Your photo was removed.', true);
  } catch (err) { say('pf-photo', netError(err)); }
});

// ---------- Username: Edit opens the form, Save or Cancel closes it ----------
function openUsernameEdit() {
  say('pf-username', '');
  $('pf-username-input').value = profile.username;
  $('pf-username-form').hidden = false;
  $('pf-username-edit').hidden = true;
  $('pf-username-input').focus();
}
function closeUsernameEdit() {
  $('pf-username-form').hidden = true;
  $('pf-username-edit').hidden = false;
}
$('pf-username-edit').addEventListener('click', openUsernameEdit);
$('pf-username-cancel').addEventListener('click', () => { say('pf-username', ''); closeUsernameEdit(); });

$('pf-username-form').addEventListener('submit', async e => {
  e.preventDefault();
  say('pf-username', '');
  const btn = $('pf-username-save');
  btn.disabled = true;
  try {
    const result = await apiFetch('/profile/username', { method: 'PUT', body: JSON.stringify({ username: $('pf-username-input').value }) });
    closeUsernameEdit();
    await loadAll();
    say('pf-username', 'Your username is now @' + result.username + '.', true);
  } catch (err) {
    say('pf-username', netError(err));
  }
  btn.disabled = false;
});

// ---------- Email: Edit opens the form, then the PIN step ----------
const emailResend = $('pf-email-resend');
function backToEmailForm() {
  $('pf-email-verify').hidden = true;
  $('pf-email-form').hidden = false;
  $('pf-email-pin').value = '';
}
function openEmailEdit() {
  say('pf-email', '');
  backToEmailForm();
  $('pf-email-panel').hidden = false;
  $('pf-email-edit').hidden = true;
  $('pf-new-email').focus();
}
function closeEmailEdit() {
  stopCooldown(emailResend);
  backToEmailForm();
  $('pf-new-email').value = '';
  $('pf-email-password').value = '';
  $('pf-email-panel').hidden = true;
  $('pf-email-edit').hidden = false;
}
$('pf-email-edit').addEventListener('click', openEmailEdit);
$('pf-email-cancel-1').addEventListener('click', () => { say('pf-email', ''); closeEmailEdit(); });
$('pf-email-cancel-2').addEventListener('click', () => { say('pf-email', ''); closeEmailEdit(); });
$('pf-email-other').addEventListener('click', () => { say('pf-email', ''); backToEmailForm(); });

$('pf-email-form').addEventListener('submit', async e => {
  e.preventDefault();
  say('pf-email', '');
  const btn = $('pf-email-send');
  btn.disabled = true;
  try {
    const result = await postJson('/profile/email/start', { new_email: $('pf-new-email').value, password: $('pf-email-password').value });
    $('pf-email-password').value = '';
    $('pf-email-form').hidden = true;
    $('pf-email-verify').hidden = false;
    $('pf-email-verify-text').textContent = 'We sent a 6-digit PIN to ' + result.new_email + '. Type it below to confirm the change. It expires in 10 minutes.';
    $('pf-email-pin').focus();
    startCooldown(emailResend, 60);
  } catch (err) { say('pf-email', netError(err)); }
  btn.disabled = false;
});
$('pf-email-verify').addEventListener('submit', async e => {
  e.preventDefault();
  say('pf-email', '');
  const btn = $('pf-email-confirm');
  btn.disabled = true;
  try {
    await postJson('/profile/email/verify', { pin: $('pf-email-pin').value.trim() });
    closeEmailEdit();
    await loadAll();
    say('pf-email', 'Your email was changed. Use the new email the next time you sign in.', true);
  } catch (err) { say('pf-email', netError(err)); }
  btn.disabled = false;
});
emailResend.addEventListener('click', async () => {
  say('pf-email', '');
  emailResend.disabled = true;
  try {
    await postJson('/profile/email/resend');
    say('pf-email', 'A new PIN was sent.', true);
    startCooldown(emailResend, 60);
  } catch (err) { say('pf-email', netError(err)); emailResend.disabled = false; }
});

// ---------- Password: change it while signed in ----------
function closePasswordEdit() {
  $('pf-password-form').reset();
  $('pf-password-form').hidden = true;
  $('pf-password-edit').hidden = false;
}
$('pf-password-edit').addEventListener('click', () => {
  say('pf-password', '');
  $('pf-password-form').hidden = false;
  $('pf-password-edit').hidden = true;
  $('pf-password-current').focus();
});
$('pf-password-cancel').addEventListener('click', () => { say('pf-password', ''); closePasswordEdit(); });
$('pf-password-form').addEventListener('submit', async e => {
  e.preventDefault();
  say('pf-password', '');
  if ($('pf-password-new').value !== $('pf-password-confirm').value) {
    say('pf-password', 'The new passwords do not match.');
    return;
  }
  const btn = $('pf-password-save');
  btn.disabled = true;
  try {
    await postJson('/profile/password', { current_password: $('pf-password-current').value, new_password: $('pf-password-new').value });
    closePasswordEdit();
    say('pf-password', 'Your password was changed.', true);
  } catch (err) { say('pf-password', netError(err)); }
  btn.disabled = false;
});

// ---------- Identity verification ----------
function renderVerification() {
  const v = verification;
  const canStart = !v.verified && !v.pending;

  $('vf-verified').hidden = !v.verified;
  $('vf-pending').hidden = !v.pending;
  $('vf-rejected').hidden = !(v.rejected && canStart);

  // The button, or the form (never both)
  $('vf-intro').hidden = !canStart || showVerifyForm;
  $('vf-form-wrap').hidden = !canStart || !showVerifyForm;
  $('vf-start').textContent = v.rejected ? 'Verify again' : 'Verify now';

  if (v.verified) {
    $('vf-verified-text').textContent = (v.verified_at ? 'Verified on ' + fmtLongDate(v.verified_at) + '. ' : '') +
      'Your name on file: ' + v.full_name + '.';
  }
  if (v.pending) {
    $('vf-pending-text').textContent = 'Sent ' + fmtTime(v.pending.submitted_at) + ' as "' + v.pending.typed_name + '" (' + v.pending.id_type + '). An admin will check it. You will see the result here.';
  }
  if (v.rejected) {
    $('vf-rejected-text').textContent = (v.rejected.reject_reason || 'No reason was given.') + ' You can send a new request.';
  }

  // The ID kinds
  const select = $('vf-type');
  if (!select.options.length) {
    select.innerHTML = '<option value="">Choose an ID</option>';
    v.id_types.forEach(t => {
      const option = el('option', '', t);
      option.value = t;
      select.appendChild(option);
    });
  }

  // The code: the form fields open only after the code is shown
  const hasCode = !!v.code;
  $('vf-code-box').hidden = !hasCode;
  $('vf-fields').disabled = !hasCode;
  $('vf-cancel-early').hidden = hasCode;   // once the form is open, Cancel is inside the form
  $('vf-get-code').textContent = hasCode ? 'Get a new code' : 'Get my code';
  if (hasCode) {
    $('vf-code').textContent = v.code;
    $('vf-code-expires').textContent = 'Write this code on paper. It is good until ' + fmtTime(v.code_expires_at) + '.';
  }
}

$('vf-start').addEventListener('click', () => {
  say('vf', '');
  showVerifyForm = true;
  renderVerification();
});
function cancelVerifyForm() {
  say('vf', '');
  showVerifyForm = false;
  renderVerification();
}
$('vf-cancel').addEventListener('click', cancelVerifyForm);
$('vf-cancel-2').addEventListener('click', cancelVerifyForm);

$('vf-get-code').addEventListener('click', async () => {
  say('vf', '');
  $('vf-get-code').disabled = true;
  try {
    await postJson('/verification/code');
    verification = await apiFetch('/verification');
    renderVerification();
  } catch (err) { say('vf', netError(err)); }
  $('vf-get-code').disabled = false;
});

// Show a small preview of the chosen picture
function bindPreview(inputId, imgId) {
  $(inputId).addEventListener('change', e => {
    const img = $(imgId);
    const file = e.target.files[0];
    if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
    if (!file) { img.hidden = true; return; }
    const url = URL.createObjectURL(file);
    img.dataset.url = url;
    img.src = url;
    img.hidden = false;
  });
}
bindPreview('vf-id', 'vf-id-preview');
bindPreview('vf-selfie', 'vf-selfie-preview');

$('vf-form').addEventListener('submit', async e => {
  e.preventDefault();
  say('vf', '');
  const types = ['image/jpeg', 'image/png', 'image/webp'];
  const idFile = $('vf-id').files[0];
  const selfie = $('vf-selfie').files[0];
  if (!idFile || !selfie) { say('vf', 'Add a picture of your ID and a selfie holding it.'); return; }
  for (const f of [idFile, selfie]) {
    if (!types.includes(f.type)) { say('vf', f.name + ' must be a JPG, PNG, or WEBP picture.'); return; }
    if (f.size > 5 * 1024 * 1024) { say('vf', f.name + ' is bigger than 5 MB.'); return; }
  }
  const form = new FormData();
  form.append('first_name', $('vf-first').value);
  form.append('last_name', $('vf-last').value);
  form.append('id_type', $('vf-type').value);
  form.append('consent', $('vf-consent').checked ? 'true' : 'false');
  form.append('id_photo', idFile);
  form.append('selfie', selfie);

  const btn = $('vf-submit');
  btn.disabled = true;
  try {
    await apiUpload('/verification/submit', form);
    e.target.reset();
    $('vf-id-preview').hidden = true;
    $('vf-selfie-preview').hidden = true;
    showVerifyForm = false;
    verification = await apiFetch('/verification');
    renderVerification();
  } catch (err) { say('vf', netError(err)); }
  btn.disabled = false;
});

// ---------- Load ----------
async function loadAll() {
  try {
    [profile, verification, reviews] = await Promise.all([
      apiFetch('/profile'), apiFetch('/verification'), apiFetch('/reviews/mine')
    ]);
    setMessage('page-error', '');
    renderProfile();
    renderVerification();
    renderReviews();
  } catch (err) {
    setMessage('page-error', netError(err));
  }
}
loadAll();

// Pick up the admin's decision without reloading the page
setInterval(async () => {
  try {
    const v = await apiFetch('/verification');
    const changed = v.verified !== verification.verified
      || !!v.pending !== !!verification.pending
      || !!v.rejected !== !!verification.rejected;
    if (changed) await loadAll();
  } catch (err) { /* try again next time */ }
}, 30000);
