import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSurveys, hasSurveyPii, surveyPublicUrl, magicLinkSender } from './surveys.mjs';

function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-surveys-'));
  const file = path.join(dir, 'surveys.db');
  options.seed?.(file);
  let time = 1_800_000_000_000;
  const messages = [];
  const settings = { file, now: () => time, redact: async text => text, send: async message => { messages.push(message); }, ...options };
  let surveys = createSurveys(settings);
  const survey = surveys.create({ title: 'Checkout experience', question: 'How was your experience?' });
  t.after(() => { surveys.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return {
    get surveys() { return surveys; }, file, survey, messages,
    advance(ms) { time += ms; },
    reopen() { surveys.close(); surveys = createSurveys(settings); },
    async link(email = 'reader@example.com', surveyId = survey.id, extra = {}) {
      await surveys.startVerification(surveyId, { email, ip: '127.0.0.1', publicUrl: 'https://feedback.example.org', ...extra });
      return new URL(messages.at(-1).url).hash.slice('#verify='.length);
    },
    async verify(email = 'reader@example.com', surveyId = survey.id) {
      const magic = await this.link(email, surveyId);
      return surveys.verify(surveyId, magic).token;
    },
  };
}
const input = (patch = {}) => ({ rating: 4, text: 'The instructions were clear.', requestId: 'response-request-123', noPii: true, ...patch });

test('public readers see the survey but no feedback or private result totals', async t => {
  const f = fixture(t), { surveys, survey } = f;
  const token = await f.verify();
  const response = await surveys.submit(survey.id, token, input());
  assert.equal(response.visibility, undefined);
  const publicView = surveys.publicView(survey.id);
  assert.equal(publicView.verified, false);
  assert.equal(publicView.mine, null);
  assert.equal(publicView.responses, undefined);
  assert.equal(publicView.total, undefined);
  assert.equal(publicView.nextOffset, undefined);
  assert.equal(publicView.survey.responseCount, undefined);
  assert.equal(publicView.results, undefined);
  assert.equal(surveys.publicView(survey.id, token).mine.id, response.id);
  assert.equal(surveys.detail(survey.id).responses[0].text, input().text);
  assert.equal(surveys.list()[0].pendingCount, 1);
});

test('verification accepts non-government mailboxes, uses one-time links, and scopes sessions to a survey', async t => {
  const f = fixture(t), { surveys, survey } = f;
  const second = surveys.create({ title: 'Second survey' });
  const link = await f.link(' Reader@Example.com ');
  assert.equal(f.messages[0].to, 'reader@example.com');
  assert.match(f.messages[0].url, new RegExp(`/s/${survey.id}#verify=`));
  assert.equal(new URL(f.messages[0].url).search, '');
  assert.match(f.messages[0].text, /submit private feedback/);
  assert.doesNotMatch(f.messages[0].text, /upvote|publish/);
  assert.throws(() => surveys.verify(second.id, link), { code: 'verification_expired' });
  const verified = surveys.verify(survey.id, link);
  assert.equal(typeof verified.expiresAt, 'number');
  assert.throws(() => surveys.verify(survey.id, link), { code: 'verification_expired' });
  await assert.rejects(() => surveys.submit(second.id, verified.token, input()), { code: 'verification_required' });
  assert.equal(surveys.publicView(survey.id, verified.token).verified, true);
  assert.equal(surveys.publicView(second.id, verified.token).verified, false);
});

test('unverified requests cannot submit, including with a magic token instead of a session', async t => {
  const f = fixture(t), { surveys, survey } = f;
  const magic = await f.link();
  for (const token of [undefined, '', 'forged', magic]) {
    await assert.rejects(() => surveys.submit(survey.id, token, input()), { code: 'verification_required' });
  }
  assert.deepEqual(surveys.detail(survey.id).results, { total: 0, average: null, distribution: [0, 0, 0, 0, 0] });
});

test('magic links and sessions expire and expiration is checked at the exact boundary', async t => {
  const f = fixture(t), { surveys, survey } = f;
  const old = await f.link();
  f.advance(10 * 60_000);
  assert.throws(() => surveys.verify(survey.id, old), { code: 'verification_expired' });
  const token = await f.verify();
  f.advance(24 * 60 * 60_000);
  assert.equal(surveys.publicView(survey.id, token).verified, false);
  await assert.rejects(() => surveys.submit(survey.id, token, input()), { code: 'verification_required' });
});

test('only integer ratings 1–5, bounded plain text and explicit no-PII confirmation are accepted', async t => {
  const f = fixture(t), { surveys, survey } = f;
  const token = await f.verify();
  for (const rating of [undefined, null, 0, 6, -1, '5', 2.5, NaN, Infinity]) {
    await assert.rejects(() => surveys.submit(survey.id, token, input({ rating })), { code: 'invalid_rating' });
  }
  for (const text of [[], {}, 12, 'x'.repeat(2001)]) {
    await assert.rejects(() => surveys.submit(survey.id, token, input({ text })), { code: 'invalid_survey' });
  }
  await assert.rejects(() => surveys.submit(survey.id, token, input({ noPii: false })), { code: 'pii_confirmation_required' });
  await assert.rejects(() => surveys.submit(survey.id, token, input({ requestId: 'short' })), { code: 'invalid_request' });
  const ratingOnly = await surveys.submit(survey.id, token, input({ rating: 1, text: '' }));
  assert.equal(ratingOnly.visibility, undefined);
  assert.equal(surveys.detail(survey.id).responses[0].visibility, 'hidden');
  assert.equal(surveys.list()[0].pendingCount, 0);
  assert.equal(surveys.detail(survey.id).results.average, 1);
});

test('common PII remains rejected in survey metadata, edits, and team notes', async t => {
  const f = fixture(t), { surveys, survey } = f;
  const token = await f.verify();
  for (const text of ['mail me: jane@example.com', 'SSN 123-45-6789', 'Call (202) 555-0182', 'Account 123456789012', '１２３４５６７８９']) {
    assert.equal(hasSurveyPii(text), true);
    assert.throws(() => surveys.create({ title: text }), { code: 'pii_detected' });
    assert.throws(() => surveys.update(survey.id, { question: text }), { code: 'pii_detected' });
  }
  const response = await surveys.submit(survey.id, token, input());
  assert.throws(() => surveys.moderate(survey.id, response.id, { reply: 'Email help@example.com' }), { code: 'pii_detected' });
  assert.throws(() => surveys.moderate(survey.id, response.id, { text: 'Call 202 555 0182' }), { code: 'pii_detected' });
  assert.equal(surveys.detail(survey.id).responses[0].reply, '');
});

test('one response per verified mailbox survives new sessions and retries cannot change an answer', async t => {
  const f = fixture(t), { surveys, survey } = f;
  const token = await f.verify();
  const response = await surveys.submit(survey.id, token, input());
  assert.equal((await surveys.submit(survey.id, token, input())).id, response.id);
  await assert.rejects(() => surveys.submit(survey.id, token, input({ rating: 1 })), { code: 'request_conflict' });
  const again = await f.verify('READER@example.com');
  assert.equal((await surveys.submit(survey.id, again, input())).id, response.id);
  await assert.rejects(() => surveys.submit(survey.id, again, input({ requestId: 'another-request' })), { code: 'already_submitted' });
  assert.equal(surveys.detail(survey.id).results.total, 1);
  surveys.moderate(survey.id, response.id, { text: 'The instructions were useful.' });
  assert.equal((await surveys.submit(survey.id, token, input())).text, 'The instructions were useful.', 'retries never restore text removed by the team');
});

test('staff can review, annotate, resolve, redact, hide, and delete private feedback', async t => {
  const f = fixture(t), { surveys, survey } = f;
  const token = await f.verify();
  const response = await surveys.submit(survey.id, token, input());
  const reviewed = surveys.moderate(survey.id, response.id, { text: 'The form needs clearer instructions.', visibility: 'reviewed', status: 'planned', reply: 'Consider updating the instructions.' });
  assert.equal(reviewed.visibility, 'reviewed');
  assert.equal(reviewed.status, 'planned');
  assert.equal(reviewed.reply, 'Consider updating the instructions.');
  assert.equal(surveys.publicView(survey.id).mine, null);
  surveys.moderate(survey.id, response.id, { status: 'resolved', visibility: 'hidden' });
  const mine = surveys.publicView(survey.id, token).mine;
  assert.deepEqual(Object.keys(mine).sort(), ['createdAt', 'id', 'rating', 'surveyId', 'text', 'updatedAt']);
  assert.equal(mine.text, reviewed.text);
  assert.deepEqual(await surveys.submit(survey.id, token, input()), mine, 'retries must not expose internal review fields');
  assert.equal(surveys.detail(survey.id).responses[0].status, 'resolved');
  for (const visibility of ['invalid', 'published']) {
    assert.throws(() => surveys.moderate(survey.id, response.id, { visibility }), { code: 'invalid_survey' });
  }
  assert.throws(() => surveys.moderate(survey.id, response.id, { status: 'invalid' }), { code: 'invalid_survey' });
  assert.equal(surveys.detail(survey.id).responses[0].visibility, 'hidden');
  assert.deepEqual(surveys.removeResponse(survey.id, response.id), { ok: true });
  assert.equal(surveys.detail(survey.id).results.total, 0);
  assert.equal(surveys.publicView(survey.id, token).mine, null);
});

test('legacy published feedback and votes stay stored but never appear publicly or to other respondents', async t => {
  const f = fixture(t), { survey } = f;
  const author = await f.verify(), reader = await f.verify('other@example.net');
  const response = await f.surveys.submit(survey.id, author, input());
  const db = new DatabaseSync(f.file);
  try {
    db.prepare("UPDATE survey_responses SET visibility='published',reply='Internal follow-up',status='planned' WHERE id=?").run(response.id);
    db.prepare('INSERT INTO survey_votes VALUES (?,?)').run(response.id, 'legacy-voter');
  } finally { db.close(); }
  f.reopen();
  const { surveys } = f;
  for (const token of [undefined, '', 'forged', reader]) {
    const view = surveys.publicView(survey.id, token, { offset: 0 });
    assert.deepEqual(Object.keys(view).sort(), ['mine', 'survey', 'verified']);
    assert.equal(view.mine, null);
    assert.doesNotMatch(JSON.stringify(view), /instructions|Internal follow-up|planned|legacy-voter|published/);
    assert.equal(view.survey.responseCount, undefined);
  }
  const mine = surveys.publicView(survey.id, author).mine;
  assert.equal(mine.id, response.id);
  assert.equal(mine.text, input().text);
  for (const field of ['visibility', 'status', 'reply', 'votes', 'voted', 'participant']) assert.equal(mine[field], undefined);
  assert.equal(surveys.detail(survey.id).responses[0].visibility, 'reviewed');
  assert.equal(surveys.detail(survey.id).responses[0].reply, 'Internal follow-up');
  assert.equal(surveys.vote, undefined);
  const saved = new DatabaseSync(f.file);
  try {
    assert.equal(saved.prepare('SELECT visibility FROM survey_responses WHERE id=?').get(response.id).visibility, 'published');
    assert.equal(saved.prepare('SELECT COUNT(*) AS n FROM survey_votes').get().n, 1);
  } finally { saved.close(); }
  const other = await surveys.submit(survey.id, reader, input({ text: 'A different response.' }));
  assert.equal(surveys.publicView(survey.id, reader).mine.id, other.id);
  assert.equal(surveys.publicView(survey.id, author).mine.id, response.id);
});

test('private results count all ratings exactly regardless of review state', async t => {
  const f = fixture(t), { surveys, survey } = f;
  for (let rating = 1; rating <= 5; rating++) {
    const token = await f.verify(`reader${rating}@example.com`);
    const response = await surveys.submit(survey.id, token, input({ rating }));
    surveys.moderate(survey.id, response.id, { visibility: rating % 2 ? 'reviewed' : 'hidden' });
  }
  assert.deepEqual(surveys.detail(survey.id).results, { total: 5, average: 3, distribution: [1, 1, 1, 1, 1] });
  assert.equal(surveys.list()[0].responseCount, 5);
});

test('closed surveys expose only the respondent’s own response and reject new answers; safe retries still work', async t => {
  const f = fixture(t), { surveys, survey } = f;
  const author = await f.verify();
  const response = await surveys.submit(survey.id, author, input());
  surveys.moderate(survey.id, response.id, { visibility: 'reviewed' });
  surveys.update(survey.id, { closed: true });
  const reader = await f.verify('late@example.com');
  assert.equal(surveys.publicView(survey.id, reader).survey.closed, true);
  assert.equal(surveys.publicView(survey.id, reader).mine, null);
  assert.equal(surveys.publicView(survey.id, author).mine.id, response.id);
  await assert.rejects(() => surveys.submit(survey.id, reader, input()), { code: 'survey_closed' });
  assert.equal((await surveys.submit(survey.id, author, input())).id, response.id);
  surveys.update(survey.id, { closed: false });
  assert.ok((await surveys.submit(survey.id, reader, input())).id);
});

test('contact emails stay in private contact columns while tokens, IPs and cross-survey identities remain protected', async t => {
  const f = fixture(t);
  const token = await f.verify('private@example.com');
  const response = await f.surveys.submit(f.survey.id, token, input());
  const other = f.surveys.create({ title: 'Other experience' });
  const otherToken = await f.verify('private@example.com', other.id);
  await f.surveys.submit(other.id, otherToken, input());
  const unconsumed = await f.link('private@example.com');
  const db = new DatabaseSync(f.file);
  try {
    const tables = ['surveys', 'survey_responses', 'survey_sessions', 'survey_challenges', 'survey_rate_events'];
    const dump = JSON.stringify(tables.map(table => db.prepare(`SELECT * FROM ${table}`).all().map(({ contact_email, ...row }) => row)));
    for (const table of ['survey_responses', 'survey_sessions', 'survey_challenges']) {
      assert.ok(db.prepare(`SELECT contact_email FROM ${table}`).all().every(row => row.contact_email === 'private@example.com'));
    }
    for (const secret of ['private@example.com', token, otherToken, unconsumed, '127.0.0.1']) assert.equal(dump.includes(secret), false, secret);
    const identities = db.prepare('SELECT participant FROM survey_responses ORDER BY survey_id').all();
    assert.notEqual(identities[0].participant, identities[1].participant);
    for (const forbidden of ['participant', 'request_id', 'request_hash']) assert.equal(JSON.stringify(f.surveys.detail(f.survey.id)).includes(forbidden), false);
  } finally { db.close(); }
  f.reopen();
  assert.equal(f.surveys.publicView(f.survey.id, token).mine.id, response.id);
  assert.equal(f.surveys.detail(f.survey.id).results.total, 1);
  assert.equal(f.surveys.detail(f.survey.id).responses[0].contactEmail, 'private@example.com');
  assert.equal((fs.statSync(f.file).mode & 0o777), 0o600);
});

test('email sending is rate limited per mailbox and IP, persists through restart, and recovers after the window', async t => {
  const f = fixture(t);
  for (let n = 0; n < 5; n++) await f.link();
  f.reopen();
  await assert.rejects(() => f.link(), { code: 'rate_limited' });
  for (let n = 0; n < 15; n++) await f.link(`reader${n}@example.com`);
  await assert.rejects(() => f.link('twenty-first@example.com'), { code: 'rate_limited' });
  f.advance(10 * 60_000);
  await f.link();
  assert.equal(f.messages.length, 21);
});

test('failed delivery invalidates the magic link and never exposes the mailer error', async t => {
  let failedMessage;
  const f = fixture(t, { send: async message => { failedMessage = message; throw Error('provider leaked private@example.com secret'); } });
  await assert.rejects(() => f.surveys.startVerification(f.survey.id, { email: 'private@example.com', publicUrl: 'https://feedback.example.org' }), error => {
    assert.equal(error.code, 'email_send_failed');
    assert.doesNotMatch(error.message, /provider|private@example|secret/);
    return true;
  });
  assert.throws(() => f.surveys.verify(f.survey.id, new URL(failedMessage.url).hash.slice('#verify='.length)), { code: 'verification_expired' });
  await assert.rejects(() => magicLinkSender({ to: 'nobody@example.com' }), /not configured/);
});

test('links require a configured HTTPS origin or local HTTP and cannot use credentials, fragments, or queries', () => {
  assert.equal(surveyPublicUrl('https://feedback.example.org', 'survey_1'), 'https://feedback.example.org/s/survey_1');
  assert.equal(surveyPublicUrl('http://localhost:1234', 'survey_1'), 'http://localhost:1234/s/survey_1');
  assert.equal(surveyPublicUrl('https://feedback.example.org/servant/', 'survey_1'), 'https://feedback.example.org/servant/s/survey_1');
  for (const url of [undefined, '', 'not a URL', 'http://feedback.example.org', 'javascript:alert(1)', 'https://user:secret@feedback.example.org', 'https://feedback.example.org?host=evil', 'https://feedback.example.org#wrong', 'https://relay.example.org/hubs/private']) {
    assert.throws(() => surveyPublicUrl(url, 'survey_1'), { code: 'survey_url_unavailable' });
  }
});


test('the reply address comes only from the verified mailbox and never from a submission body', async t => {
  const f = fixture(t), { surveys, survey } = f;
  const magic = await f.link(' Verified+Reply@Example.com ');
  const db = new DatabaseSync(f.file);
  try { assert.equal(db.prepare('SELECT contact_email FROM survey_challenges').get().contact_email, 'verified+reply@example.com'); }
  finally { db.close(); }
  const verified = surveys.verify(survey.id, magic);
  assert.deepEqual(Object.keys(verified).sort(), ['expiresAt', 'token']);
  const response = await surveys.submit(survey.id, verified.token, input({ email: 'unverified@example.com' }));
  assert.equal(response.contactEmail, undefined);
  assert.equal(surveys.detail(survey.id).responses[0].contactEmail, 'verified+reply@example.com');
  assert.doesNotMatch(JSON.stringify(surveys.publicView(survey.id, verified.token)), /verified\+reply|unverified@example|contactEmail/);
  f.reopen();
  assert.equal((await f.surveys.submit(survey.id, verified.token, input({ email: 'another@example.com' }))).id, response.id);
  assert.equal(f.surveys.detail(survey.id).responses[0].contactEmail, 'verified+reply@example.com');
  const saved = new DatabaseSync(f.file);
  try {
    assert.equal(saved.prepare('SELECT contact_email FROM survey_sessions').get().contact_email, 'verified+reply@example.com');
    assert.equal(saved.prepare('SELECT COUNT(*) AS n FROM survey_challenges').get().n, 0);
  } finally { saved.close(); }
});

test('verification requires one valid mailbox and rejects control, address-list and URL injection before delivery', async t => {
  const f = fixture(t);
  for (const email of [undefined, '', '  ', null, 5, [], {}, 'missing-at', 'a@example', 'a@-example.com', 'a@example-.com', '.a@example.com', 'a..b@example.com', 'a.@example.com', 'a@' + 'x'.repeat(64) + '.com', 'x'.repeat(65) + '@example.com', 'a@example.com\r\nBcc:other@example.com', 'a@example.com\n', '\ta@example.com', 'a\0@example.com', 'a%0d%0a@example.com', 'a@example.com,b@example.com', 'a@example.com;b@example.com', 'Pat Tester <a@example.com>', 'mailto:a@example.com', 'https://example.com', 'a@example.com?subject=Injected', 'a@example.com#fragment', 'x'.repeat(250) + '@example.com']) {
    await assert.rejects(() => f.surveys.startVerification(f.survey.id, { email, publicUrl: 'https://feedback.example.org' }), { code: 'email_invalid' }, String(email));
  }
  assert.equal(f.messages.length, 0);
  assert.ok(await f.verify('pat.tester+research@example.gov'));
});

test('legacy verification schemas migrate without deleting responses or substituting an unverified reply email', async t => {
  const legacySession = 's'.repeat(43), legacyMagic = 'm'.repeat(43);
  const digest = value => crypto.createHash('sha256').update(value).digest('hex');
  for (const hasPriorContact of [false, true]) {
    const f = fixture(t, { seed(file) {
      const db = new DatabaseSync(file);
      db.exec(`CREATE TABLE surveys (id TEXT PRIMARY KEY,title TEXT NOT NULL,question TEXT NOT NULL,closed INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL);
        CREATE TABLE survey_responses (id TEXT PRIMARY KEY,survey_id TEXT NOT NULL REFERENCES surveys(id),participant TEXT NOT NULL,request_id TEXT NOT NULL,request_hash TEXT NOT NULL,rating INTEGER NOT NULL,text TEXT NOT NULL,visibility TEXT NOT NULL DEFAULT 'pending',status TEXT NOT NULL DEFAULT 'open',reply TEXT NOT NULL DEFAULT '',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL${hasPriorContact ? ',contact_email TEXT' : ''},UNIQUE(survey_id,participant),UNIQUE(survey_id,participant,request_id));
        CREATE TABLE survey_votes (response_id TEXT NOT NULL REFERENCES survey_responses(id) ON DELETE CASCADE,participant TEXT NOT NULL,PRIMARY KEY(response_id,participant));
        CREATE TABLE survey_sessions (token_hash TEXT PRIMARY KEY,survey_id TEXT NOT NULL,participant TEXT NOT NULL,expires_at INTEGER NOT NULL);
        CREATE TABLE survey_challenges (token_hash TEXT PRIMARY KEY,survey_id TEXT NOT NULL,participant TEXT NOT NULL,expires_at INTEGER NOT NULL);
        INSERT INTO surveys VALUES ('legacy-survey','Older survey','How was your experience?',0,1);
        INSERT INTO survey_responses (id,survey_id,participant,request_id,request_hash,rating,text,visibility,status,reply,created_at,updated_at) VALUES ('legacy-response','legacy-survey','submission:old-request','response-request-123','old-request-hash',4,'Legacy private feedback','published','planned','Legacy team note',1,1);
        INSERT INTO survey_votes VALUES ('legacy-response','legacy-voter');`);
      if (hasPriorContact) db.prepare("UPDATE survey_responses SET contact_email='prior@example.com'").run();
      db.prepare('INSERT INTO survey_sessions VALUES (?,?,?,?)').run(digest(legacySession), 'legacy-survey', 'legacy-session-reader', 1_800_086_400_000);
      db.prepare('INSERT INTO survey_challenges VALUES (?,?,?,?)').run(digest(legacyMagic), 'legacy-survey', 'legacy-challenge-reader', 1_800_000_600_000);
      db.close();
    } });
    let stored = f.surveys.detail('legacy-survey').responses[0];
    assert.equal(stored.contactEmail, hasPriorContact ? 'prior@example.com' : null);
    assert.equal(stored.visibility, 'reviewed');
    assert.equal(stored.text, 'Legacy private feedback');
    if (hasPriorContact) {
      const mailboxSession = await f.verify('prior@example.com', 'legacy-survey');
      assert.equal(f.surveys.publicView('legacy-survey', mailboxSession).mine, null, 'verifying a contact address cannot claim an older unverified response');
      assert.equal(f.surveys.detail('legacy-survey').responses[0].contactEmail, 'prior@example.com');
    }
    assert.equal(f.surveys.publicView('legacy-survey', legacySession).verified, true);
    assert.equal(f.surveys.publicView('legacy-survey', legacySession).mine, null);
    const fromSession = await f.surveys.submit('legacy-survey', legacySession, input({ email: 'forged@example.com' }));
    const verified = f.surveys.verify('legacy-survey', legacyMagic);
    const fromChallenge = await f.surveys.submit('legacy-survey', verified.token, input({ email: 'forged@example.com' }));
    for (const response of f.surveys.detail('legacy-survey').responses.filter(item => [fromSession.id, fromChallenge.id].includes(item.id))) assert.equal(response.contactEmail, null);
    f.reopen();
    stored = f.surveys.detail('legacy-survey').responses.find(item => item.id === 'legacy-response');
    assert.equal(stored.contactEmail, hasPriorContact ? 'prior@example.com' : null);
    const db = new DatabaseSync(f.file);
    try {
      assert.equal(db.prepare("SELECT visibility FROM survey_responses WHERE id='legacy-response'").get().visibility, 'published');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM survey_votes').get().n, 1);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM survey_responses').get().n, 3);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM survey_sessions').get().n, hasPriorContact ? 3 : 2);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM survey_challenges').get().n, 0, 'only the consumed legacy challenge is removed');
    } finally { db.close(); }
  }
});

// What the public page and the app show when something is refused: a sentence that starts with a capital, in the
// page's own words. Its button is "Send verification link"; nothing on it is called a "magic link".
test('refusals start with a capital and use the page\'s words', async t => {
  const f = fixture(t), { surveys, survey } = f;
  // Submitting is asynchronous (it waits for redaction), so a refusal may be thrown or rejected.
  const said = async work => { try { await work(); } catch (error) { return error.message; } throw Error('expected a refusal'); };
  assert.equal(await said(() => surveys.create({ title: '', question: 'How was it?' })), 'A survey title must be 1–120 characters');
  assert.equal(await said(() => surveys.submit(survey.id, undefined, input())), 'Verify your email first');
  assert.equal(await said(() => surveys.verify(survey.id, 'not-a-link')), 'This link is invalid or expired. Send a new verification link');
  const token = await f.verify();
  assert.equal(await said(() => surveys.submit(survey.id, token, input({ text: 'x'.repeat(2001) }))), 'Feedback must be at most 2000 characters');
  const source = fs.readFileSync(new URL('./surveys.mjs', import.meta.url), 'utf8') + fs.readFileSync(new URL('./survey-routes.mjs', import.meta.url), 'utf8');
  const messages = [...source.matchAll(/(?:fault|fail)\((?:res, )?\d+, '[a-z_]+', '([^']+)'/g)].map(m => m[1]);
  assert.ok(messages.length >= 15, 'found the refusals');
  for (const message of messages) {
    assert.doesNotMatch(message, /magic/i, message);
    assert.match(message, /^[A-Z]/, `"${message}" starts with a capital`);
  }
});

function heldRedaction() {
  const pending = [];
  return {
    calls: [],
    redact(text) {
      this.calls.push(text);
      return new Promise((resolve, reject) => { pending.push({ resolve, reject }); });
    },
    finish(text) { for (const item of pending.splice(0)) item.resolve(text); },
  };
}
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('submission redaction happens before storage and only sanitized feedback reaches readers', async t => {
  const raw = 'Contact Pat Tester at pat.tester@example.gov or (202) 555-0182.';
  const clean = 'Contact [PERSON] at [EMAIL] or [PHONE].';
  const received = [];
  const f = fixture(t, { redact: async text => { received.push(text); return clean; } });
  const token = await f.verify();
  const response = await f.surveys.submit(f.survey.id, token, input({ text: raw }));
  assert.deepEqual(received, [raw]);
  assert.equal(response.text, clean);
  assert.equal(f.surveys.publicView(f.survey.id, token).mine.text, clean);
  assert.equal(f.surveys.detail(f.survey.id).responses[0].text, clean);
  assert.equal(f.surveys.detail(f.survey.id).responses[0].contactEmail, 'reader@example.com');
  const db = new DatabaseSync(f.file);
  try {
    const row = db.prepare('SELECT * FROM survey_responses').get();
    assert.equal(row.text, clean);
    assert.match(row.request_hash, /^hmac:/);
    assert.notEqual(row.request_hash.slice('hmac:'.length), crypto.createHash('sha256').update(JSON.stringify([4, raw])).digest('hex'));
    const tables = ['surveys', 'survey_responses', 'survey_sessions', 'survey_challenges', 'survey_rate_events'];
    const stored = JSON.stringify(tables.map(table => db.prepare(`SELECT * FROM ${table}`).all()));
    for (const pii of [raw, 'Pat Tester', 'pat.tester@example.gov', '(202) 555-0182']) assert.equal(stored.includes(pii), false);
  } finally { db.close(); }
});

test('raw-payload retries use the keyed fingerprint without rerunning redaction or restoring a staff edit', async t => {
  let calls = 0;
  const raw = 'Please contact pat.tester@example.gov.';
  const f = fixture(t, { redact: async () => { calls++; return 'Please contact [EMAIL].'; } });
  const token = await f.verify();
  const body = input({ text: raw });
  const original = await f.surveys.submit(f.survey.id, token, body);
  f.surveys.moderate(f.survey.id, original.id, { text: 'A contact request.' });
  f.reopen();
  const retry = await f.surveys.submit(f.survey.id, token, body);
  assert.equal(retry.id, original.id);
  assert.equal(retry.text, 'A contact request.');
  assert.equal(calls, 1, 'persisted retries must not need the redaction runtime');
  await assert.rejects(() => f.surveys.submit(f.survey.id, token, input({ text: 'Please contact jo.park@example.gov.' })), { code: 'request_conflict' });
  assert.equal(calls, 1, 'different raw PII cannot pass as the same request even if redaction would yield identical text');
  assert.equal(f.surveys.detail(f.survey.id).results.total, 1);
});

test('unavailable, failing, and malformed redactors save no response and expose no raw diagnostics', async t => {
  const raw = 'Contact pat.tester@example.gov.';
  for (const redact of [null, async () => { throw new Error(`Runtime diagnostic: ${raw}`); }, async () => undefined, async () => null, async () => ({ text: 'Safe' }), async () => 42, async () => raw, async () => 'x'.repeat(20_001)]) {
    const f = fixture(t, { redact });
    const token = await f.verify();
    await assert.rejects(() => f.surveys.submit(f.survey.id, token, input({ text: raw })), error => {
      assert.equal(error.status, 503);
      assert.equal(error.code, 'survey_pii_unavailable');
      assert.doesNotMatch(error.message, /Runtime diagnostic|pat\.tester@example|Contact/);
      return true;
    });
    assert.equal(f.surveys.detail(f.survey.id).results.total, 0);
    assert.equal(f.surveys.list()[0].pendingCount, 0);
    assert.equal(f.surveys.publicView(f.survey.id, token).mine, null);
  }
});

test('session expiry, revocation, and survey closure during redaction prevent the pending write', async t => {
  for (const change of ['expiry', 'revocation', 'closure']) {
    const held = heldRedaction();
    const f = fixture(t, { redact: text => held.redact(text) });
    const token = await f.verify();
    const pending = f.surveys.submit(f.survey.id, token, input());
    const rejected = assert.rejects(pending, { code: change === 'closure' ? 'survey_closed' : 'verification_required' });
    await nextTurn();
    assert.equal(held.calls.length, 1);
    assert.equal(f.surveys.detail(f.survey.id).results.total, 0);
    if (change === 'expiry') f.advance(24 * 60 * 60_000);
    else if (change === 'closure') f.surveys.update(f.survey.id, { closed: true });
    else {
      const db = new DatabaseSync(f.file);
      try { db.prepare('DELETE FROM survey_sessions').run(); } finally { db.close(); }
    }
    held.finish('The instructions were clear.');
    await rejected;
    assert.equal(f.surveys.detail(f.survey.id).results.total, 0, change);
  }
});

test('concurrent redactions preserve one response and resolve matching retries or reject conflicting requests', async t => {
  for (const scenario of ['same-request', 'different-request', 'different-raw-text']) {
    const held = heldRedaction();
    const f = fixture(t, { redact: text => held.redact(text) });
    const token = await f.verify();
    const first = input({ text: 'Contact pat.tester@example.gov.' });
    const second = scenario === 'different-request' ? { ...first, requestId: 'another-request' }
      : scenario === 'different-raw-text' ? { ...first, text: 'Contact jo.park@example.gov.' } : { ...first };
    const pending = Promise.allSettled([
      f.surveys.submit(f.survey.id, token, first),
      f.surveys.submit(f.survey.id, token, second),
    ]);
    await nextTurn();
    assert.ok(held.calls.length >= 1);
    assert.equal(f.surveys.detail(f.survey.id).results.total, 0);
    held.finish('Contact [EMAIL].');
    const settled = await pending;
    const successes = settled.filter(item => item.status === 'fulfilled');
    const failures = settled.filter(item => item.status === 'rejected');
    if (scenario === 'same-request') {
      assert.equal(successes.length, 2);
      assert.equal(successes[0].value.id, successes[1].value.id);
    } else {
      assert.equal(successes.length, 1);
      assert.equal(failures.length, 1);
      assert.equal(failures[0].reason.code, scenario === 'different-request' ? 'already_submitted' : 'request_conflict');
    }
    assert.equal(f.surveys.detail(f.survey.id).results.total, 1, scenario);
    assert.equal(f.surveys.detail(f.survey.id).responses[0].text, 'Contact [EMAIL].');
  }
});

test('submission snapshots caller input before awaiting redaction', async t => {
  const held = heldRedaction();
  const f = fixture(t, { redact: text => held.redact(text) });
  const token = await f.verify();
  const body = input({ text: 'Contact pat.tester@example.gov.' });
  const original = { ...body };
  const pending = f.surveys.submit(f.survey.id, token, body);
  await nextTurn();
  assert.deepEqual(held.calls, [original.text]);
  Object.assign(body, { rating: 1, text: 'Different text', requestId: 'changed-request', noPii: false, email: 'forged@example.gov' });
  held.finish('Contact [EMAIL].');
  const response = await pending;
  assert.equal(response.rating, original.rating);
  assert.equal(response.text, 'Contact [EMAIL].');
  assert.equal(f.surveys.detail(f.survey.id).responses[0].contactEmail, 'reader@example.com');
  assert.equal((await f.surveys.submit(f.survey.id, token, original)).id, response.id);
  assert.equal(held.calls.length, 1);
  const db = new DatabaseSync(f.file);
  try { assert.equal(db.prepare('SELECT request_id FROM survey_responses').get().request_id, original.requestId); }
  finally { db.close(); }
});


test('existing plain-SHA request fingerprints still retry without redaction after an upgrade', async t => {
  let calls = 0;
  let unavailable = false;
  const f = fixture(t, { redact: async text => {
    calls++;
    if (unavailable) throw new Error('Runtime is offline');
    return text;
  } });
  const token = await f.verify();
  const body = input();
  const original = await f.surveys.submit(f.survey.id, token, body);
  const legacyHash = crypto.createHash('sha256').update(JSON.stringify([body.rating, body.text])).digest('hex');
  const db = new DatabaseSync(f.file);
  try { db.prepare('UPDATE survey_responses SET request_hash=? WHERE id=?').run(legacyHash, original.id); }
  finally { db.close(); }
  f.surveys.moderate(f.survey.id, original.id, { text: 'Staff-reviewed feedback.' });
  f.reopen(); unavailable = true;
  const retry = await f.surveys.submit(f.survey.id, token, body);
  assert.equal(retry.id, original.id);
  assert.equal(retry.text, 'Staff-reviewed feedback.');
  await assert.rejects(() => f.surveys.submit(f.survey.id, token, input({ rating: 2 })), { code: 'request_conflict' });
  assert.equal(calls, 1);
  assert.equal(f.surveys.detail(f.survey.id).results.total, 1);
});

test('longer redaction placeholders are saved intact rather than truncated to the raw input limit', async t => {
  const clean = '[PERSON] '.repeat(500).trim();
  const f = fixture(t, { redact: async () => clean });
  const token = await f.verify();
  const response = await f.surveys.submit(f.survey.id, token, input());
  assert.ok(clean.length > 2000);
  assert.equal(response.text, clean);
  assert.equal(f.surveys.detail(f.survey.id).responses[0].text, clean);
  const reviewed = f.surveys.moderate(f.survey.id, response.id, { text: clean, reply: 'Keep the useful details.', visibility: 'reviewed' });
  assert.equal(reviewed.text, clean);
  assert.equal(reviewed.reply, 'Keep the useful details.');
  assert.equal(reviewed.visibility, 'reviewed');
});
