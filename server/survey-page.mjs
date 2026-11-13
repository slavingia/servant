// Public surveys are deliberately separate from the paired staff application.
// Nothing supplied by a survey or respondent is interpolated into this HTML.
//
// The page uses the server's one stylesheet (page-style.mjs): the app's palette in light and dark with the
// workspace's color, the type roles, 6 and 10 pixel corners and 48-point controls. Only its own layout is here:
// the faces, the confirmation checkbox and the email row. The theme is the only value placed in the page.
import { pageStyle } from "./page-style.mjs";
export function surveyPage(theme) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="color-scheme" content="light dark"><link rel="icon" href="data:,"><title>Survey</title>
<style>
${pageStyle(theme)}
main{max-width:712px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:22px;line-height:28px;letter-spacing:-.3px;margin:0 0 24px}
h2{margin:0 0 8px}
.mine p:last-child{margin-bottom:0}
.card{margin:0 0 24px}
fieldset{border:0;padding:0;margin:0 0 24px;min-width:0}
legend{font-size:18px;line-height:24px;font-weight:700;letter-spacing:-.15px;padding:0;margin-bottom:12px}
.faces{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px}
.face{position:relative;display:flex;flex-direction:column;align-items:center;gap:4px;min-width:0;padding:12px 4px;border:1px solid var(--borderStrong);border-radius:10px;background:var(--background);text-align:center;cursor:pointer;margin:0;font-weight:400}
.face input{position:absolute;opacity:0;width:1px;height:1px}
.face:has(input:checked){border-color:var(--blue);box-shadow:inset 0 0 0 1px var(--blue);background:var(--blueSoft)}
.face:has(input:focus-visible){outline:3px solid var(--blue);outline-offset:2px}
.face:has(input:disabled){opacity:.6;cursor:default}
.face .emoji{font-size:32px;line-height:38px}
.face .number{font-size:13px;line-height:18px;font-weight:600}
.face .description{font-size:12px;line-height:16px;color:var(--muted)}
#privacy-hint{margin-bottom:16px}
.optional{font-weight:400;color:var(--muted)}
textarea{min-height:120px;margin-bottom:8px}
textarea:disabled{background:var(--surface);color:var(--muted)}
.check{display:flex;gap:12px;align-items:flex-start;margin:0 0 24px;font-size:15px;line-height:22px;font-weight:400}
.check input{flex-shrink:0;width:24px;height:24px;margin:0;accent-color:var(--primary)}
.verification{margin:0 0 24px}
.verification p{margin-bottom:8px}
.email-row{display:flex;gap:8px;align-items:flex-start;margin-bottom:8px}
.email-row input{flex:1;min-width:0}
.email-row button{white-space:nowrap}
.verified{font-weight:600;color:var(--greenDark)}
@media(max-width:480px){.face .emoji{font-size:28px;line-height:34px}.email-row{flex-direction:column;align-items:stretch}}
</style></head><body>
<main>
  <h1 id="survey-title">Survey</h1>
  <noscript><div class="notice error">JavaScript is required.</div></noscript>
  <p id="error" class="notice error" role="alert"></p>
  <p id="message" class="sr-only" role="status" aria-live="polite" hidden></p>
  <div id="loading" class="notice" role="status">Loading survey…</div>
  <p id="closed" class="notice" hidden>Survey closed</p>
  <section id="mine" class="notice success mine" aria-labelledby="mine-title" hidden><h2 id="mine-title">Your response</h2><p id="mine-description"></p></section>
  <section id="verification-link" class="card" hidden><button id="verify" class="primary" type="button">Verify email</button></section>
  <form id="survey-form" class="card" hidden>
    <div id="answer">
    <fieldset id="rating-field"><legend id="survey-question">How was your experience?</legend>
    <div class="faces">
      <label class="face"><input type="radio" name="rating" value="1" required aria-label="1 out of 5, very unhappy"><span class="emoji" aria-hidden="true">😞</span><span class="number" aria-hidden="true">1</span><span class="description" aria-hidden="true">Very unhappy</span></label>
      <label class="face"><input type="radio" name="rating" value="2" aria-label="2 out of 5, unhappy"><span class="emoji" aria-hidden="true">🙁</span><span class="number" aria-hidden="true">2</span><span class="description" aria-hidden="true">Unhappy</span></label>
      <label class="face"><input type="radio" name="rating" value="3" aria-label="3 out of 5, neutral"><span class="emoji" aria-hidden="true">😐</span><span class="number" aria-hidden="true">3</span><span class="description" aria-hidden="true">Neutral</span></label>
      <label class="face"><input type="radio" name="rating" value="4" aria-label="4 out of 5, happy"><span class="emoji" aria-hidden="true">🙂</span><span class="number" aria-hidden="true">4</span><span class="description" aria-hidden="true">Happy</span></label>
      <label class="face"><input type="radio" name="rating" value="5" aria-label="5 out of 5, very happy"><span class="emoji" aria-hidden="true">😄</span><span class="number" aria-hidden="true">5</span><span class="description" aria-hidden="true">Very happy</span></label>
    </div></fieldset>
    <label class="field-label" for="feedback">Comment <span class="optional">(optional)</span></label>
    <textarea id="feedback" maxlength="2000" aria-describedby="privacy-hint"></textarea>
    <p id="privacy-hint" class="small muted hint">Your response is private. Detected personal information is removed from your comment before saving. Only authorized researchers, administrators and business owners can view survey feedback.</p>
    <label class="check"><input id="no-pii" type="checkbox" required><span>No personal information: names, contact details, addresses or account/tax details in my comment.</span></label>
    </div>
    <div id="verification" class="verification">
      <label class="field-label small" for="email">Email <span class="optional">(private)</span></label>
      <p id="email-hint" class="small muted">Verify your email to submit. The team can use it to reply.</p>
      <div class="email-row"><input id="email" type="email" autocomplete="email" maxlength="254" aria-describedby="email-hint" placeholder="you@example.com"><button id="send-link" class="secondary" type="button">Send verification link</button></div>
      <p id="email-message" class="small" role="status" aria-live="polite" hidden></p>
    </div>
    <p id="verified" class="verified small" hidden>Email verified</p>
    <button id="submit" class="primary full" type="submit" disabled>Submit feedback</button>
  </form>
  <button id="refresh" type="button" class="secondary">Refresh</button>
</main><script>(${surveyClient.toString()})();</script></body></html>`;
}

// Kept as a real function so syntax is checked by Node and browser tests can
// exercise the same client that ships, without a build step or remote scripts.
function surveyClient() {
  const $ = id => document.getElementById(id);
  const id = location.pathname.split('/').filter(Boolean).at(-1);
  const base = location.pathname.replace(/\/s\/[^/]+\/?$/, '/public/surveys/' + encodeURIComponent(id || ''));
  const key = 'servant-survey:' + id;
  const faces = ['😞', '🙁', '😐', '🙂', '😄'];
  let token = '', survey, mine, pending = false, requestId = '', verifyToken = '', refreshSequence = 0;
  let channel;
  const storage = {
    get(suffix) { try { return sessionStorage.getItem(key + suffix); } catch { return null; } },
    set(suffix, value) { try { sessionStorage.setItem(key + suffix, value); } catch { /* Private browsers may disable storage. */ } },
    remove(suffix) { try { sessionStorage.removeItem(key + suffix); } catch { /* See above. */ } },
  };
  const showError = message => { $('error').textContent = message || ''; };
  const announce = message => { $('message').textContent = message || ''; $('message').hidden = !message; };
  const setToken = value => {
    const next = value || '';
    // A new or expired session must not carry a previous respondent's saved
    // answer into the form. Drafts before verification still belong to this tab.
    if (next !== token && mine) renderMine(null);
    token = next;
    if (token) storage.set(':token', token); else storage.remove(':token');
  };
  const saveDraft = () => {
    const checked = document.querySelector('input[name=rating]:checked');
    storage.set(':draft', JSON.stringify({ rating: checked?.value || '', text: $('feedback').value, noPii: $('no-pii').checked, requestId }));
  };
  const newRequestId = () => crypto.randomUUID ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
  async function request(path = '', method = 'GET', body) {
    const requestToken = token;
    const response = await fetch(base + path, { method, credentials: 'omit', cache: 'no-store', headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}), ...(requestToken ? { Authorization: 'Bearer ' + requestToken } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    let result;
    try { result = await response.json(); } catch { throw new Error('The server did not respond. Please try again.'); }
    if (!response.ok) {
      if (response.status === 401 && token === requestToken) { setToken(''); updateControls(); }
      const error = new Error(typeof result.error === 'string' ? result.error : result.error?.message || result.message || 'Could not complete that request. Please try again.');
      error.code = result.code || result.error?.code;
      error.status = response.status;
      throw error;
    }
    return result;
  }
  function updateControls() {
    const closed = !!survey?.closed;
    $('rating-field').disabled = closed || !!mine || pending;
    $('feedback').disabled = closed || !!mine || pending;
    $('no-pii').disabled = closed || !!mine || pending;
    $('submit').disabled = !token || closed || !!mine || pending;
    $('submit').textContent = pending ? 'Saving…' : mine ? 'Response saved' : 'Submit feedback';
    $('verified').hidden = !token;
    $('verification').hidden = !!token;
    $('closed').hidden = !closed;
    // A closed survey takes no answers: only someone's own saved response is worth showing in the form,
    // and verifying an email address is for seeing that response, not for submitting.
    $('answer').hidden = closed && !mine;
    $('submit').hidden = closed && !mine;
    $('email-hint').textContent = closed ? 'Verify your email to see your response.' : 'Verify your email to submit. The team can use it to reply.';
  }
  function renderMine(response) {
    const previous = mine;
    mine = response || null;
    $('mine').hidden = !mine;
    if (!mine) {
      $('mine-description').textContent = '';
      if (previous) {
        $('feedback').value = '';
        $('no-pii').checked = false;
        for (let rating = 1; rating <= 5; rating++) document.querySelector('input[name=rating][value="' + rating + '"]').checked = false;
        requestId = '';
        storage.remove(':draft');
      }
      return;
    }
    $('mine-description').textContent = 'Thank you. Your private response was saved. ' + faces[mine.rating - 1] + ' ' + mine.rating + ' / 5';
    const savedRating = document.querySelector('input[name=rating][value="' + Number(mine.rating) + '"]');
    if (savedRating) savedRating.checked = true;
    $('feedback').value = mine.text || '';
    $('no-pii').checked = true;
    storage.remove(':draft');
  }
  async function refresh() {
    const sequence = ++refreshSequence;
    let requestedToken = token;
    let result;
    try { result = await request(); }
    catch (error) {
      if (sequence !== refreshSequence || requestedToken !== token && error.status !== 401) return false;
      if (error.status !== 401) throw error;
      requestedToken = token;
      result = await request();
    }
    // A delayed anonymous response must never erase a session just verified in
    // this or another tab, or replace the respondent's saved answer.
    if (sequence !== refreshSequence || requestedToken !== token) return false;
    survey = result.survey;
    if (!result.verified) setToken('');
    $('survey-title').textContent = survey.title;
    $('survey-question').textContent = survey.question;
    document.title = survey.title + ' · Servant';
    $('loading').hidden = true;
    $('survey-form').hidden = false;
    renderMine(result.mine);
    updateControls();
    return !!result.verified;
  }
  token = storage.get(':token') || '';
  try {
    const draft = JSON.parse(storage.get(':draft') || '{}');
    if (/^[1-5]$/.test(String(draft.rating))) document.querySelector('input[name=rating][value="' + draft.rating + '"]').checked = true;
    if (typeof draft.text === 'string') $('feedback').value = draft.text.slice(0, 2000);
    $('no-pii').checked = draft.noPii === true;
    if (typeof draft.requestId === 'string') requestId = draft.requestId;
  } catch { storage.remove(':draft'); }
  try {
    verifyToken = new URLSearchParams(location.hash.slice(1)).get('verify') || '';
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  } catch { showError('Could not read this verification link. Please request a new one.'); }
  if (verifyToken) $('verification-link').hidden = false;
  try {
    channel = new BroadcastChannel(key);
    channel.onmessage = event => {
      if (typeof event.data?.token !== 'string' || event.data.token.length > 200) return;
      setToken(event.data.token);
      void refresh().then(verified => { if (verified) announce('Email verified.'); }).catch(error => showError(error.message));
    };
  } catch { /* Verification still works when cross-tab messaging is unavailable. */ }
  $('verify').onclick = async () => {
    if (!verifyToken) return;
    $('verify').disabled = true; showError('');
    try {
      const result = await request('/verify', 'POST', { token: verifyToken });
      setToken(result.token); verifyToken = ''; $('verification-link').hidden = true;
      channel?.postMessage({ token });
      if (await refresh()) announce('Email verified.');
    } catch (error) { showError(error.message); $('verify').disabled = false; }
  };
  $('send-link').onclick = async () => {
    const input = $('email');
    if (!input.value.trim() || !input.reportValidity()) { input.focus(); showError('Enter a valid email address.'); return; }
    $('send-link').disabled = true; showError(''); saveDraft();
    try {
      await request('/email', 'POST', { email: input.value.trim() });
      input.value = '';
      $('email-message').textContent = 'Link sent. Expires in 10 minutes.';
      $('email-message').hidden = false;
    } catch (error) { showError(error.message); }
    finally { $('send-link').disabled = false; }
  };
  $('email').addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); $('send-link').click(); }
  });
  $('survey-form').addEventListener('input', () => { requestId = ''; saveDraft(); });
  $('survey-form').onsubmit = async event => {
    event.preventDefault();
    if (pending || mine || survey?.closed) return;
    if (!token) { announce('Verify email to submit.'); $('email').focus(); return; }
    const rating = Number(document.querySelector('input[name=rating]:checked')?.value);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5 || !$('no-pii').checked) return;
    requestId ||= newRequestId(); saveDraft(); pending = true; updateControls(); showError('');
    const submissionToken = token;
    try {
      const result = await request('/responses', 'POST', { rating, text: $('feedback').value.trim(), noPii: true, requestId });
      storage.remove(':draft');
      // Show the stored, sanitized answer immediately, even if the next read
      // is slow or fails. A different respondent's session must not see it.
      if (token === submissionToken) renderMine(result.response);
      await refresh();
      if (token === submissionToken) announce('Response saved.');
    } catch (error) {
      showError(error.message);
      if (error.code === 'already_submitted') await refresh().catch(() => {});
    } finally { pending = false; updateControls(); }
  };
  $('refresh').onclick = async () => {
    $('refresh').disabled = true; showError('');
    try { await refresh(); } catch (error) { showError(error.message); }
    finally { $('refresh').disabled = false; }
  };
  void refresh().catch(error => { $('loading').hidden = true; showError(error.message); });
}
