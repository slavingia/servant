import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { surveyPage } from './survey-page.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const sample = { id: 'sv_demo', title: 'How did we do?', question: 'How was your experience?', closed: false };

class Element {
  constructor(tag = '') { this.tag = tag; this.hidden = false; this.disabled = false; this.value = ''; this.checked = false; this.children = []; this.listeners = {}; this.textContent = ''; }
  set innerHTML(_) { throw Error('Untrusted HTML must never be assigned'); }
  setAttribute(name, value) { this[name] = value; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  focus() { this.focused = true; }
  querySelector(tag) { return this.children.find(child => child.tag === tag) || null; }
  reportValidity() { return this.value.includes('@'); }
  click() { return this.disabled ? undefined : this.onclick?.(); }
}

function page({ url = 'https://example.com/s/sv_demo', token = '', draft, view, handler } = {}) {
  const html = surveyPage();
  const elements = Object.fromEntries([...html.matchAll(/<([^\s>]+)[^>]*\bid="([^"]+)"[^>]*>/g)].map(([tag, type, id]) => {
    const element = new Element(type); element.hidden = /\bhidden\b/.test(tag); element.disabled = /\bdisabled\b/.test(tag); return [id, element];
  }));
  const ratings = Array.from({ length: 5 }, (_, index) => Object.assign(new Element('input'), { value: String(index + 1) }));
  const location = new URL(url);
  const storage = new Map();
  if (token) storage.set('servant-survey:sv_demo:token', token);
  if (draft) storage.set('servant-survey:sv_demo:draft', JSON.stringify(draft));
  const requests = [], broadcasts = [];
  let channel;
  let currentView = view || { survey: { ...sample }, responses: [], verified: false, mine: null };
  const document = {
    title: '', getElementById: id => elements[id], createElement: tag => new Element(tag),
    querySelector(selector) {
      if (selector.endsWith(':checked')) return ratings.find(rating => rating.checked);
      return ratings.find(rating => rating.value === selector.match(/value="([^"]+)"/)?.[1]);
    },
  };
  vm.runInNewContext(html.match(/<script>([\s\S]*)<\/script>/)[1], {
    document, location, URLSearchParams,
    history: { replaceState(_state, _title, next) { const nextUrl = new URL(next, location); location.href = nextUrl.href; } },
    sessionStorage: { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    crypto: { randomUUID: () => '12345678-draft' },
    BroadcastChannel: class { constructor() { channel = this; } postMessage(data) { broadcasts.push(data); } },
    fetch: async (path, init) => {
      const req = { path, ...init, body: init.body ? JSON.parse(init.body) : undefined }; requests.push(req);
      const result = await handler?.(req);
      return { ok: (result?.status || 200) < 400, status: result?.status || 200, json: async () => result?.body || currentView };
    },
  });
  return { elements, ratings, requests, broadcasts, document, location, storage,
    setView: next => { currentView = next; },
    verifyInOtherTab: async nextToken => { channel.onmessage({ data: { token: nextToken } }); await tick(); },
    select: number => { ratings.forEach(rating => { rating.checked = Number(rating.value) === number; }); },
    submit: () => elements['survey-form'].onsubmit({ preventDefault() {} }),
  };
}

test('the public page has exactly five accessible faces and no survey values in executable HTML', () => {
  const html = surveyPage('</script><script>bad()</script>');
  assert.equal([...html.matchAll(/type="radio"/g)].length, 5);
  for (let rating = 1; rating <= 5; rating++) assert.match(html, new RegExp(`aria-label="${rating} out of 5,`));
  assert.doesNotMatch(html, /bad\(\)|on(?:click|submit)=|https?:\/\/[^\s<]+\.(?:js|css)/);
  assert.match(html, /No personal information: names, contact details, addresses/);
  assert.match(html, /Verify your email to submit. The team can use it to reply/);
  assert.match(html, /Detected personal information is removed from your comment before saving/);
  assert.match(html, /aria-describedby="email-hint"/);
  assert.doesNotMatch(html, /Math\.random/);
});

test('reading a magic link clears its fragment and never consumes it until Verify email', async () => {
  const p = page({ url: 'https://example.com/team/s/sv_demo#verify=secret-link', handler: req => req.path.endsWith('/verify') ? { body: { token: 'verified-session', expiresAt: 999999 } } : undefined });
  await tick();
  assert.equal(p.location.hash, '');
  assert.equal(p.requests.length, 1);
  assert.equal(p.requests[0].path, '/team/public/surveys/sv_demo');
  assert.equal(p.elements['verification-link'].hidden, false);
  p.setView({ survey: sample, responses: [], mine: null, verified: true });
  await p.elements.verify.click();
  const check = p.requests.find(req => req.path.endsWith('/verify'));
  assert.deepEqual(check.body, { token: 'secret-link' });
  assert.equal(p.elements['verification-link'].hidden, true);
  assert.equal(p.requests.at(-1).headers.Authorization, 'Bearer verified-session');
  assert.equal(p.elements.submit.disabled, false);
  assert.equal(p.broadcasts[0].token, 'verified-session');
  assert.ok([...p.storage.values()].every(value => !value.includes('secret-link')));
});

test('email verification preserves the draft, never stores the email, and another tab enables submission', async () => {
  const p = page({ handler: req => req.path.endsWith('/email') ? { body: { ok: true } } : undefined });
  await tick();
  p.select(4); p.elements.feedback.value = 'The page was easy to use.'; p.elements['no-pii'].checked = true;
  p.elements.email.value = 'someone@personal.example';
  await p.elements['send-link'].click();
  assert.deepEqual(p.requests.at(-1).body, { email: 'someone@personal.example' });
  assert.equal(p.elements.email.value, '');
  assert.ok([...p.storage.values()].every(value => !value.includes('someone@')));
  const draft = JSON.parse(p.storage.get('servant-survey:sv_demo:draft'));
  assert.equal(draft.rating, '4'); assert.equal(draft.text, 'The page was easy to use.');
  p.setView({ survey: sample, responses: [], mine: null, verified: true });
  await p.verifyInOtherTab('session-from-link');
  assert.equal(p.elements.submit.disabled, false);
  assert.equal(p.elements.feedback.value, 'The page was easy to use.');
  assert.equal(p.elements.verification.hidden, true);
});

test('submitting is verified, single-flight, idempotent after network failure, and confirms a private response', async () => {
  let release, attempts = 0;
  const p = page({ token: 'verified', view: { survey: sample, responses: [], mine: null, verified: true }, handler: async req => {
    if (!req.path.endsWith('/responses')) return;
    attempts++;
    if (attempts === 1) { await new Promise(resolve => { release = resolve; }); return { status: 503, body: { error: { message: 'Try again' } } }; }
    p.setView({ survey: sample, responses: [], mine: { ...req.body, visibility: 'pending', reply: '' }, verified: true });
    return { body: { response: { id: 'r1', rating: req.body.rating, text: req.body.text } } };
  } });
  await tick();
  p.select(5); p.elements.feedback.value = 'A clear and helpful experience.'; p.elements['no-pii'].checked = true;
  const saving = p.submit(); await p.submit();
  assert.equal(attempts, 1); assert.equal(p.elements.submit.disabled, true);
  release(); await saving;
  assert.equal(p.elements.error.textContent, 'Try again');
  await p.submit();
  const submissions = p.requests.filter(req => req.path.endsWith('/responses'));
  assert.deepEqual(submissions[0].body, submissions[1].body);
  assert.deepEqual(submissions[0].body, { rating: 5, text: 'A clear and helpful experience.', noPii: true, requestId: '12345678-draft' });
  assert.equal(p.elements.mine.hidden, false);
  assert.match(p.elements['mine-description'].textContent, /Thank you. Your private response was saved/);
  assert.equal(p.elements.submit.disabled, true);
  assert.equal(p.storage.has('servant-survey:sv_demo:draft'), false);
});

test('the respondent page has no public board, upvotes, or internal review details even in a legacy payload', async () => {
  const response = { id: 'r1', rating: 2, text: '<img src=x onerror=bad()>', status: 'planned', visibility: 'published', reply: '<script>internal()</script>', votes: 4, voted: false };
  const html = surveyPage();
  assert.match(html, /Your response is private/);
  assert.doesNotMatch(html, /board|upvote|publish|mine-reply|load-more/i);
  const p = page({ view: { survey: sample, responses: [response], verified: true, mine: response } });
  await tick();
  assert.equal(p.elements.feedback.value, response.text);
  assert.match(p.elements['mine-description'].textContent, /Your private response was saved/);
  assert.doesNotMatch(p.elements['mine-description'].textContent, /planned|published|internal/);
  assert.equal(p.requests.length, 1);
  assert.equal(p.elements.board, undefined);
});

test('a closed survey stays readable and blocks new responses', async () => {
  const p = page({ token: 'verified', view: { survey: { ...sample, closed: true }, verified: true, mine: null } });
  await tick();
  assert.equal(p.elements.closed.hidden, false);
  assert.equal(p.elements.submit.disabled, true);
  assert.equal(p.elements.feedback.disabled, true);
  await p.submit();
  assert.equal(p.requests.length, 1);
});

test('an expired session is removed and retries the public read without credentials', async () => {
  const p = page({ token: 'expired', handler: req => req.headers.Authorization ? { status: 401, body: { error: { message: 'Verify again' } } } : undefined });
  await tick();
  assert.equal(p.requests.length, 2);
  assert.equal(p.requests[1].headers.Authorization, undefined);
  assert.equal(p.elements['survey-form'].hidden, false);
  assert.equal(p.elements.submit.disabled, true);
  assert.equal(p.storage.has('servant-survey:sv_demo:token'), false);
});

test('a delayed anonymous read cannot erase a newly verified session or overwrite its response', async () => {
  let finishAnonymous;
  const p = page({ handler: async req => {
    if (!req.headers.Authorization) {
      await new Promise(resolve => { finishAnonymous = resolve; });
      return { body: { survey: sample, responses: [], verified: false, mine: null } };
    }
    return { body: { survey: sample, responses: [], verified: true, mine: { rating: 5, text: 'Already saved', visibility: 'pending' } } };
  } });
  await p.verifyInOtherTab('new-session');
  assert.equal(p.elements.mine.hidden, false);
  finishAnonymous(); await tick();
  assert.equal(p.storage.get('servant-survey:sv_demo:token'), 'new-session');
  assert.equal(p.elements.mine.hidden, false);
  assert.equal(p.elements.feedback.value, 'Already saved');
});

test('an unrecognized cross-tab session never announces a successful verification', async () => {
  const p = page(); await tick();
  await p.verifyInOtherTab('not-a-session');
  assert.equal(p.elements.message.hidden, true);
  assert.equal(p.elements.submit.disabled, true);
});

test('closed surveys still allow email verification to retrieve the respondent’s own answer', async () => {
  const p = page({ view: { survey: { ...sample, closed: true }, verified: false, mine: null } });
  await tick();
  assert.equal(p.elements.verification.hidden, false);
  p.setView({ survey: { ...sample, closed: true }, verified: true, mine: { rating: 3, text: 'A suggestion' } });
  await p.verifyInOtherTab('verified');
  assert.equal(p.elements.mine.hidden, false);
  assert.equal(p.elements.feedback.value, 'A suggestion');
  assert.equal(p.elements.submit.disabled, true);
});

test('refresh retries errors and only updates the respondent’s own answer', async () => {
  let attempts = 0;
  const p = page({ token: 'verified', view: { survey: sample, verified: true, mine: null }, handler: () => {
    if (++attempts === 2) return { status: 503, body: { error: { message: 'Try loading again' } } };
  } });
  await tick();
  await p.elements.refresh.click();
  assert.equal(p.elements.error.textContent, 'Try loading again');
  assert.equal(p.elements.refresh.disabled, false);
  p.setView({ survey: sample, verified: true, mine: { rating: 4, text: 'Saved in another tab' } });
  await p.elements.refresh.click();
  assert.equal(p.elements.mine.hidden, false);
  assert.equal(p.elements.feedback.value, 'Saved in another tab');
  assert.equal(p.elements.submit.disabled, true);
});


test('switching respondent sessions clears the previous saved answer before the new session loads', async () => {
  let finishRead;
  const p = page({ token: 'first-session', view: { survey: sample, verified: true, mine: { rating: 5, text: 'First respondent private answer' } }, handler: async req => {
    if (req.headers.Authorization !== 'Bearer second-session') return;
    await new Promise(resolve => { finishRead = resolve; });
    return { body: { survey: sample, verified: true, mine: null } };
  } });
  await tick();
  assert.equal(p.elements.feedback.value, 'First respondent private answer');
  await p.verifyInOtherTab('second-session');
  assert.equal(p.elements.mine.hidden, true);
  assert.equal(p.elements['mine-description'].textContent, '');
  assert.equal(p.elements.feedback.value, '');
  assert.equal(p.elements['no-pii'].checked, false);
  assert.equal(p.ratings.some(rating => rating.checked), false);
  finishRead(); await tick();
  assert.equal(p.elements.feedback.value, '');
  assert.equal(p.elements.submit.disabled, false);
  assert.equal(p.storage.has('servant-survey:sv_demo:draft'), false);
});

test('an expired session removes its saved answer while anonymous refresh is still pending', async () => {
  let expired = false, finishAnonymous;
  const p = page({ token: 'expiring-session', view: { survey: sample, verified: true, mine: { rating: 4, text: 'Saved private answer' } }, handler: async req => {
    if (!expired) return;
    if (req.headers.Authorization) return { status: 401, body: { error: { message: 'Verify again' } } };
    await new Promise(resolve => { finishAnonymous = resolve; });
    return { body: { survey: sample, verified: false, mine: null } };
  } });
  await tick();
  expired = true;
  const refreshing = p.elements.refresh.click(); await tick();
  assert.equal(p.elements.feedback.value, '');
  assert.equal(p.elements.mine.hidden, true);
  assert.equal(p.elements['mine-description'].textContent, '');
  assert.equal(p.elements.submit.disabled, true);
  assert.equal(p.storage.has('servant-survey:sv_demo:token'), false);
  finishAnonymous(); await refreshing;
  assert.equal(p.elements.feedback.value, '');
  assert.equal(p.elements.verification.hidden, false);
});


test('entering a contact email alone does not bypass verification before submission', async () => {
  const p = page();
  await tick();
  p.select(4); p.elements.feedback.value = 'A useful service.';
  p.elements.email.value = 'reply@example.com'; p.elements['no-pii'].checked = true;
  await p.submit();
  assert.equal(p.requests.length, 1);
  assert.equal(p.elements.submit.disabled, true);
  assert.equal(p.elements.email.focused, true);
  assert.equal(p.elements.message.textContent, 'Verify email to submit.');
  assert.equal(p.elements.mine.hidden, true);
  assert.ok([...p.storage.values()].every(value => !value.includes('reply@example.com')));
});

test('a closed survey shows no empty form, only a saved response', async () => {
  const closed = { ...sample, closed: true };
  const p = page({ view: { survey: closed, verified: false, mine: null } });
  await tick();
  assert.equal(p.elements.answer.hidden, true, 'no faces or comment box to fill in');
  assert.equal(p.elements.submit.hidden, true, 'no Submit button');
  assert.equal(p.elements.verification.hidden, false, 'verifying an email still shows a saved response');
  assert.equal(p.elements['email-hint'].textContent, 'Verify your email to see your response.', 'not "to submit": a closed survey takes no answers');
  p.setView({ survey: closed, verified: true, mine: { rating: 2, text: 'Too slow' } });
  await p.verifyInOtherTab('verified');
  assert.equal(p.elements.answer.hidden, false, 'what the person sent is shown');
  assert.equal(p.elements.feedback.value, 'Too slow');
  const open = page({ view: { survey: sample, verified: false, mine: null } });
  await tick();
  assert.equal(open.elements.answer.hidden, false);
  assert.equal(open.elements.submit.hidden, false);
  assert.equal(open.elements['email-hint'].textContent, 'Verify your email to submit. The team can use it to reply.');
});

// The page follows docs/design-system.md like the rest of Servant, through the server's one stylesheet.
test('the public page uses the shared stylesheet: the app\'s palette in light and dark, its type roles and corners', async () => {
  const { lightColors, darkColors } = await import('../app/src/lib/theme-colors.ts');
  const palette = new Set([...Object.values(lightColors), ...Object.values(darkColors)].map(value => value.toUpperCase()));
  const css = surveyPage().match(/<style>([\s\S]*?)<\/style>/)[1].trimStart();
  const { pageStyle } = await import('./page-style.mjs');
  assert.ok(css.startsWith(pageStyle()), 'the shared stylesheet comes first');
  const own = css.slice(pageStyle().length);
  assert.doesNotMatch(own, /#[0-9a-fA-F]{3,8}\b/, 'the page\'s own layout names no color: it uses the shared variables');
  const colors = [...new Set(css.match(/#[0-9a-fA-F]{3,8}\b/g))];
  assert.ok(colors.length >= 8, 'found the page colors');
  for (const color of colors) assert.ok(palette.has(color.toUpperCase()), `${color} is not in theme-colors.ts`);
  assert.match(css, /@media \(prefers-color-scheme:dark\)/, 'it follows dark mode');
  assert.doesNotMatch(css, /text-transform:\s*uppercase/, 'sentence case, no uppercase labels');
  assert.doesNotMatch(css, /box-shadow:(?!inset)/, 'no drop shadows');
  for (const [, px] of css.matchAll(/border-radius:(\d+)px/g)) assert.ok([6, 10].includes(Number(px)), `corner ${px}px is not a design-system radius`);
  assert.doesNotMatch(css, /font-size:\.\d+rem/, 'sizes are the type roles, in pixels');
  for (const [, px] of css.matchAll(/font-size:(\d+)px/g)) assert.ok(Number(px) >= 12, `${px}px text is smaller than the smallest type role`);
  // A workspace with its own color gets it on the public page too.
  const themed = surveyPage({ primaryColor: '#7C3AED' });
  assert.match(themed, /--primary:#7C3AED/);
  assert.doesNotMatch(themed, /#0071BC/i, 'no default blue left behind');
});

test('successful submission immediately replaces the raw draft with the sanitized server answer', async () => {
  let finishRefresh, saved = false;
  const raw = 'Please call 202-555-0182 about the form.';
  const sanitized = 'Please call [REDACTED] about the form.';
  const response = { id: 'r1', rating: 4, text: sanitized };
  const p = page({ token: 'verified', view: { survey: sample, verified: true, mine: null }, handler: async req => {
    if (req.path.endsWith('/responses')) { saved = true; return { body: { response } }; }
    if (saved) {
      await new Promise(resolve => { finishRefresh = resolve; });
      return { status: 503, body: { error: { message: 'Could not refresh' } } };
    }
  } });
  await tick();
  p.select(4); p.elements.feedback.value = raw; p.elements['no-pii'].checked = true;
  const saving = p.submit(); await tick();
  const submissions = p.requests.filter(req => req.path.endsWith('/responses'));
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].body.text, raw, 'the server receives the original once to redact');
  assert.equal(p.elements.feedback.value, sanitized, 'only the server answer remains while refresh is pending');
  assert.equal(p.elements.mine.hidden, false);
  assert.equal(p.storage.has('servant-survey:sv_demo:draft'), false);
  assert.ok([...p.storage.values()].every(value => !value.includes(raw)));
  assert.ok(Object.values(p.elements).every(element => !element.textContent.includes(raw)));
  finishRefresh(); await saving;
  assert.equal(p.elements.feedback.value, sanitized);
  assert.equal(p.elements.submit.disabled, true, 'a refresh failure cannot resubmit or restore the raw answer');
  assert.equal(p.storage.has('servant-survey:sv_demo:draft'), false);
});

test('a delayed submission never shows its sanitized response under a different respondent session', async () => {
  let finishSubmission;
  const p = page({ token: 'first-session', view: { survey: sample, verified: true, mine: null }, handler: async req => {
    if (req.path.endsWith('/responses')) {
      await new Promise(resolve => { finishSubmission = resolve; });
      return { body: { response: { id: 'r1', rating: 4, text: 'First respondent [REDACTED]' } } };
    }
    if (req.headers.Authorization === 'Bearer second-session') return { body: { survey: sample, verified: true, mine: { id: 'r2', rating: 5, text: 'Second respondent answer' } } };
  } });
  await tick();
  p.select(4); p.elements.feedback.value = 'First respondent raw answer'; p.elements['no-pii'].checked = true;
  const saving = p.submit(); await tick();
  await p.verifyInOtherTab('second-session');
  assert.equal(p.elements.feedback.value, 'Second respondent answer');
  const writes = [];
  let value = p.elements.feedback.value;
  Object.defineProperty(p.elements.feedback, 'value', { get: () => value, set: next => { writes.push(next); value = next; } });
  finishSubmission(); await saving;
  assert.equal(p.elements.feedback.value, 'Second respondent answer');
  assert.ok(writes.every(text => !text.includes('First respondent')));
});
