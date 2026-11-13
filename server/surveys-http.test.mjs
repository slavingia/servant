import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { testFetch } from './encrypted-test-client.mjs';
import { TERMS_VERSION, TERMS_ITEMS } from './terms.mjs';
import { createSurveyRoutes, surveySettings, surveyPermissionsFor } from './survey-routes.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-surveys-http-'));
process.env.SERVANT_DATA_DIR = directory;
process.env.SERVANT_WORKER_MODE = 'external';
process.env.SERVANT_PORT = '0';
process.env.SERVANT_HOST = '127.0.0.1';
const deliveries = [];
globalThis.__servantSurveyEmailSend = async payload => { deliveries.push(payload); };
let redact = async text => text;
globalThis.__servantSurveyRedact = text => redact(text);
let server, base, staffToken;
const members = new Map();
const cfg = { port: 0, host: '127.0.0.1', name: 'Survey test', upstreams: {}, publicUrl: 'https://feedback.example.test', surveys: { mailer: { command: 'fixture-mailer' } } };

async function request(method, route, body, token, encrypted = route.startsWith('/v1/')) {
  const response = await (encrypted ? (url, init) => testFetch(directory, url, init) : fetch)(base + route, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: await response.json() };
}

before(async () => {
  fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify(cfg));
  const mod = await import('./server.mjs');
  server = await mod.startServer(cfg);
  if (!server.listening) await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const code = mod.createInvite({ name: 'Survey staff', role: 'owner' });
  const paired = await request('POST', '/v1/pair', { code, device: 'Test browser', terms: { version: TERMS_VERSION, items: TERMS_ITEMS } });
  assert.equal(paired.status, 201);
  staffToken = paired.data.token;
  for (const tier of [0, 1, 2, 3, 4, 5]) {
    const code = mod.createInvite({ name: `Survey role ${tier}`, role: 'member' });
    const paired = await request('POST', '/v1/pair', { code, device: 'Test browser', terms: { version: TERMS_VERSION, items: TERMS_ITEMS } });
    assert.equal(paired.status, 201);
    const assigned = await request('PATCH', `/v1/people/${paired.data.user.id}`, { agentTier: tier }, staffToken);
    assert.equal(assigned.status, 200);
    members.set(tier, { token: paired.data.token, id: paired.data.user.id });
  }
});

after(async () => {
  await server?.shutdown();
  delete globalThis.__servantSurveyEmailSend;
  delete globalThis.__servantSurveyRedact;
  fs.rmSync(directory, { recursive: true, force: true });
});

test('public share → magic link → private response → staff review, with participant and staff access separate', async () => {
  assert.equal((await request('GET', '/v1/surveys')).status, 401);
  assert.equal((await request('GET', '/v1/surveys', undefined, staffToken, false)).status, 426);
  const created = await request('POST', '/v1/surveys', { title: 'Website experience', question: 'How was your visit?' }, staffToken);
  assert.equal(created.status, 201);
  const survey = created.data.survey;
  assert.equal(survey.shareUrl, `${cfg.publicUrl}/s/${survey.id}`);
  assert.equal(survey.emailReady, true);
  const publicPath = `/public/surveys/${survey.id}`;
  const page = await fetch(`${base}/s/${survey.id}`);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  assert.match(page.headers.get('content-security-policy'), /script-src 'sha256-/);
  const markup = await page.text();
  assert.match(markup, /<html/);
  const script = markup.match(/<script>([\s\S]*?)<\/script>/)[1];
  assert.ok(page.headers.get('content-security-policy').includes(`'sha256-${crypto.createHash('sha256').update(script).digest('base64')}'`));
  assert.doesNotMatch(page.headers.get('content-security-policy'), /script-src[^;]*'unsafe-inline'/);
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  assert.equal((await request('POST', publicPath + '/responses', { rating: 5, text: '', noPii: true, requestId: 'survey-request-1' })).status, 401);
  assert.equal((await request('POST', publicPath + '/email', { email: 'participant@example.com' })).status, 200);
  assert.equal(deliveries.at(-1).to, 'participant@example.com', 'public email need not use a government domain');
  const magic = new URL(deliveries.at(-1).url);
  assert.equal(magic.origin, cfg.publicUrl);
  assert.equal(magic.search, '');
  const proof = new URLSearchParams(magic.hash.slice(1)).get('verify');
  assert.ok(proof);
  const verified = await request('POST', publicPath + '/verify', { token: proof });
  assert.equal(verified.status, 200);
  const participant = verified.data.token;
  assert.notEqual((await request('POST', publicPath + '/verify', { token: proof })).status, 200);
  assert.equal((await request('GET', '/v1/surveys', undefined, participant)).status, 401, 'survey bearer cannot become a staff member');
  const answer = { rating: 4, text: 'Make the navigation clearer', noPii: true, requestId: 'survey-request-1', email: 'unverified@example.com' };
  const submitted = await request('POST', publicPath + '/responses', answer, participant);
  assert.equal(submitted.status, 201);
  const responseId = submitted.data.response.id;
  assert.doesNotMatch(JSON.stringify(submitted.data), /contactEmail|participant@example|unverified@example/);
  assert.equal((await request('POST', publicPath + '/responses', answer, participant)).data.response.id, responseId);
  let view = await request('GET', publicPath);
  assert.deepEqual(Object.keys(view.data).sort(), ['mine', 'survey', 'verified']);
  assert.equal(view.data.mine, null);
  assert.equal((await request('GET', publicPath, undefined, participant)).data.mine.id, responseId);
  const details = await request('GET', `/v1/surveys/${survey.id}`, undefined, staffToken);
  assert.equal(details.data.results.total, 1);
  assert.equal(details.data.results.average, 4);
  assert.deepEqual(details.data.results.distribution, [0, 0, 0, 1, 0]);
  assert.equal(details.data.responses[0].contactEmail, 'participant@example.com', 'reply address comes only from the verified mailbox');
  const manage = `/v1/surveys/${survey.id}/responses/${responseId}`;
  assert.equal((await request('PATCH', manage, { visibility: 'reviewed', reply: 'Investigate the navigation.', status: 'planned' }, staffToken)).status, 200);
  const own = (await request('GET', publicPath, undefined, participant)).data.mine;
  assert.deepEqual(Object.keys(own).sort(), ['createdAt', 'id', 'rating', 'surveyId', 'text', 'updatedAt']);
  assert.doesNotMatch(JSON.stringify(own), /Investigate|planned|reviewed/);
  const saved = (await request('GET', `/v1/surveys/${survey.id}`, undefined, staffToken)).data.responses[0];
  assert.equal(saved.reply, 'Investigate the navigation.');
  assert.equal(saved.visibility, 'reviewed');
  assert.equal(saved.contactEmail, 'participant@example.com');
  assert.equal((await request('PATCH', manage, { visibility: 'published' }, staffToken)).status, 400);

  // Data written by an older version remains private, without deleting it.
  const db = new DatabaseSync(path.join(directory, 'surveys.db'));
  try { db.prepare("UPDATE survey_responses SET visibility='published' WHERE id=?").run(responseId); }
  finally { db.close(); }
  view = await request('GET', publicPath);
  assert.deepEqual(Object.keys(view.data).sort(), ['mine', 'survey', 'verified']);
  assert.equal(view.data.mine, null);
  assert.doesNotMatch(JSON.stringify(view.data), /Make the navigation clearer|Investigate|planned|responseCount|contactEmail|participant@example/);
  const publicResponse = await fetch(base + publicPath);
  assert.equal(publicResponse.headers.get('cache-control'), 'no-store');
  assert.equal((await request('POST', publicPath + '/email', { email: 'another@example.com' })).status, 200);
  const otherProof = new URLSearchParams(new URL(deliveries.at(-1).url).hash.slice(1)).get('verify');
  const other = (await request('POST', publicPath + '/verify', { token: otherProof })).data.token;
  const otherView = await request('GET', publicPath, undefined, other);
  assert.equal(otherView.data.mine, null);
  assert.equal(otherView.data.verified, true);
  assert.doesNotMatch(JSON.stringify(otherView.data), /Make the navigation clearer|Investigate|planned|contactEmail|participant@example/);
  assert.equal((await request('POST', publicPath + '/email', { email: 'PARTICIPANT@example.com' })).status, 200);
  const repeatProof = new URLSearchParams(new URL(deliveries.at(-1).url).hash.slice(1)).get('verify');
  const repeat = (await request('POST', publicPath + '/verify', { token: repeatProof })).data.token;
  assert.equal((await request('GET', publicPath, undefined, repeat)).data.mine.id, responseId);
  assert.equal((await request('POST', publicPath + '/responses', { ...answer, requestId: 'different-request' }, repeat)).status, 409);
  const vote = publicPath + `/responses/${responseId}/vote`;
  for (const method of ['PUT', 'DELETE']) {
    assert.equal((await request(method, vote)).status, 404);
    assert.equal((await request(method, vote, undefined, participant)).status, 404);
  }
  assert.equal((await request('PATCH', `/v1/surveys/${survey.id}`, { closed: true }, staffToken)).status, 200);
  assert.equal((await request('GET', publicPath, undefined, participant)).data.mine.id, responseId);
  assert.equal((await request('POST', publicPath + '/responses', answer, participant)).data.response.id, responseId);
  assert.equal((await request('POST', publicPath + '/responses', answer, other)).status, 409);
  assert.equal((await request('DELETE', manage, undefined, staffToken)).status, 200);
  assert.equal((await request('GET', publicPath, undefined, participant)).data.mine, null);
});

test('submissions store only redacted comments, preserve the private verified reply email, and fail safely when redaction fails', async () => {
  const savedRedact = redact;
  try {
    const survey = (await request('POST', '/v1/surveys', { title: 'Private contact feedback' }, staffToken)).data.survey;
    const publicPath = `/public/surveys/${survey.id}`;
    const original = 'I am Jo Park. My SSN is 452-78-1934. The navigation could be clearer.';
    const sanitized = 'I am [REDACTED]. My SSN is [REDACTED]. The navigation could be clearer.';
    let calls = 0;
    redact = async text => { calls++; assert.equal(text, original); return sanitized; };
    const answer = { rating: 4, text: original, requestId: crypto.randomUUID(), noPii: true };
    assert.equal((await request('POST', publicPath + '/responses', answer)).status, 401);
    assert.equal(calls, 0);
    await request('POST', publicPath + '/email', { email: 'reply@example.com' });
    const proof = new URLSearchParams(new URL(deliveries.at(-1).url).hash.slice(1)).get('verify');
    const respondent = (await request('POST', publicPath + '/verify', { token: proof })).data.token;
    const response = await request('POST', publicPath + '/responses', answer, respondent);
    assert.equal(response.status, 201);
    assert.equal(response.data.response.text, sanitized);
    assert.equal(calls, 1);
    assert.equal((await request('GET', publicPath, undefined, respondent)).data.mine.text, sanitized);
    assert.equal((await request('GET', publicPath)).data.mine, null);
    const stored = (await request('GET', `/v1/surveys/${survey.id}`, undefined, staffToken)).data.responses[0];
    assert.equal(stored.text, sanitized);
    assert.equal(stored.contactEmail, 'reply@example.com');
    assert.doesNotMatch(JSON.stringify(stored), /Jo Park|452-78-1934/);
    for (const filename of ['surveys.db', 'surveys.db-wal']) {
      const file = path.join(directory, filename);
      if (fs.existsSync(file)) assert.equal(fs.readFileSync(file).includes(Buffer.from('452-78-1934')), false, 'original identifier never written to SQLite');
    }
    redact = async () => { throw new Error('provider leaked 452-78-1934'); };
    const retry = await request('POST', publicPath + '/responses', answer, respondent);
    assert.equal(retry.status, 201, 'committed retries do not depend on the model');
    assert.equal(retry.data.response.text, sanitized);
    assert.equal((await request('POST', publicPath + '/responses', { ...answer, text: original.replace('452-78-1934', '452-78-1935') }, respondent)).status, 409);

    const another = (await request('POST', '/v1/surveys', { title: 'Redaction outage' }, staffToken)).data.survey;
    const anotherPath = `/public/surveys/${another.id}`;
    await request('POST', anotherPath + '/email', { email: 'retry@example.com' });
    const anotherProof = new URLSearchParams(new URL(deliveries.at(-1).url).hash.slice(1)).get('verify');
    const anotherToken = (await request('POST', anotherPath + '/verify', { token: anotherProof })).data.token;
    const failure = await request('POST', anotherPath + '/responses', answer, anotherToken);
    assert.equal(failure.status, 503);
    assert.equal(failure.data.error.code, 'survey_pii_unavailable');
    assert.doesNotMatch(JSON.stringify(failure.data), /provider|452-78-1934/);
    assert.equal((await request('GET', `/v1/surveys/${another.id}`, undefined, staffToken)).data.results.total, 0);
    redact = async () => sanitized;
    assert.equal((await request('POST', anotherPath + '/responses', answer, anotherToken)).status, 201);
  } finally { redact = savedRedact; }
});

test('staff can review expanded redacted comments while public input limits remain unchanged', async () => {
  const savedRedact = redact;
  try {
    const clean = '[REDACTED]'.repeat(2000);
    redact = async () => clean;
    const survey = (await request('POST', '/v1/surveys', { title: 'Expanded redaction' }, staffToken)).data.survey;
    const publicPath = `/public/surveys/${survey.id}`;
    await request('POST', publicPath + '/email', { email: 'expanded@example.com' });
    const proof = new URLSearchParams(new URL(deliveries.at(-1).url).hash.slice(1)).get('verify');
    const respondent = (await request('POST', publicPath + '/verify', { token: proof })).data.token;
    const answer = { rating: 4, text: 'Original feedback', requestId: crypto.randomUUID(), noPii: true };
    const submitted = await request('POST', publicPath + '/responses', answer, respondent);
    assert.equal(submitted.status, 201);
    assert.equal(submitted.data.response.text, clean);
    const route = `/v1/surveys/${survey.id}/responses/${submitted.data.response.id}`;
    const reviewed = await request('PATCH', route, { text: clean, reply: 'Useful feedback.', visibility: 'reviewed' }, staffToken);
    assert.equal(reviewed.status, 200);
    assert.equal(reviewed.data.response.text, clean);
    assert.equal(reviewed.data.response.reply, 'Useful feedback.');
    assert.equal(reviewed.data.response.visibility, 'reviewed');
    assert.equal((await request('PATCH', route, { text: 'x'.repeat(20_001) }, staffToken)).status, 400);
    assert.equal((await request('POST', publicPath + '/responses', { ...answer, text: 'x'.repeat(2001) }, respondent)).status, 400);
  } finally { redact = savedRedact; }
});

test('hosting configuration does not create broken relay links or trust request headers', () => {
  for (const publicUrl of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/?x=1', 'https://example.com/#x', 'https://relay.test/hubs', 'https://relay.test/hubs/abcdefghijklmnopqrstuv']) {
    assert.equal(surveySettings({ publicUrl }).publicUrl, '');
  }
  assert.equal(surveySettings({ publicUrl: 'http://127.0.0.1:8787' }).publicUrl, 'http://127.0.0.1:8787');
  assert.equal(surveySettings({ publicUrl: 'https://relay.test/hubs/abcdefghijklmnopqrstuv', surveys: { publicUrl: 'https://surveys.test' } }).publicUrl, 'https://surveys.test');
});

test('HTTP boundaries reject invalid content and metadata PII without exposing participant identity', async () => {
  const created = await request('POST', '/v1/surveys', { title: 'Boundary checks' }, staffToken);
  assert.equal(created.status, 201);
  const id = created.data.survey.id;
  const publicPath = `/public/surveys/${id}`;
  for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'application/json-extra']) {
    const response = await fetch(base + publicPath + '/email', { method: 'POST', headers: { 'Content-Type': contentType }, body: '{}' });
    assert.equal(response.status, 415);
  }
  for (const body of [null, [], 'text']) {
    assert.equal((await request('POST', publicPath + '/email', body)).status, 400);
    assert.equal((await request('PATCH', `/v1/surveys/${id}`, body, staffToken)).status, 400);
  }
  const malformed = await fetch(base + publicPath + '/email', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  for (const email of ['', 'invalid', 'one@example.com,two@example.com', 'reader@example.com\r\nBcc:other@example.com', [], 42]) {
    const response = await request('POST', publicPath + '/email', { email });
    assert.equal(response.status, 400);
    assert.equal(response.data.error.code, 'email_invalid');
  }
  assert.equal((await request('POST', '/v1/surveys', { title: 'Contact person@example.com' }, staffToken)).status, 400);
  assert.equal((await request('PATCH', `/v1/surveys/${id}`, { question: 'Call 202-555-0175' }, staffToken)).status, 400);
  for (const query of ['', '?offset=50', '?offset=-1', '?responses=true']) {
    const view = await request('GET', publicPath + query);
    assert.equal(view.status, 200);
    assert.deepEqual(Object.keys(view.data).sort(), ['mine', 'survey', 'verified']);
    assert.equal(view.data.mine, null);
  }
  assert.equal((await fetch(base + '/s/missing-survey')).status, 404);
});

test('email setup fails closed and configured proxy prefixes, not request hosts, determine share and magic URLs', async () => {
  const saved = cfg.surveys;
  try {
    cfg.surveys = { mailer: { command: '' } };
    const disabled = await request('POST', '/v1/surveys', { title: 'Disabled email survey' }, staffToken);
    assert.equal(disabled.data.survey.emailReady, false);
    const beforeCount = deliveries.length;
    const attempt = await request('POST', `/public/surveys/${disabled.data.survey.id}/email`, { email: 'reader@example.com' });
    assert.equal(attempt.status, 503);
    assert.equal(attempt.data.error.code, 'email_unavailable');
    assert.equal(deliveries.length, beforeCount);

    cfg.surveys = { publicUrl: 'https://feedback.example.test/servant/', mailer: saved.mailer };
    const configured = await request('POST', '/v1/surveys', { title: 'Mounted survey' }, staffToken);
    const id = configured.data.survey.id;
    assert.equal(configured.data.survey.shareUrl, `https://feedback.example.test/servant/s/${id}`);
    const response = await fetch(`${base}/public/surveys/${id}/email`, { method: 'POST', headers: {
      'Content-Type': 'application/json', Host: 'attacker.example', 'X-Forwarded-Host': 'attacker.example', 'X-Forwarded-Proto': 'http',
    }, body: JSON.stringify({ email: 'mounted@example.com' }) });
    assert.equal(response.status, 200);
    assert.equal(new URL(deliveries.at(-1).url).origin, 'https://feedback.example.test');
    assert.equal(new URL(deliveries.at(-1).url).pathname, `/servant/s/${id}`);
    assert.doesNotMatch(JSON.stringify(await response.json()), /mounted@example|verify=/);
  } finally { cfg.surveys = saved; }
});

test('staff mutation rechecks authorization after a delayed request body before writing', async () => {
  let allowed = true, finish, entered, writes = 0;
  const started = new Promise(resolve => { entered = resolve; });
  const body = new Promise(resolve => { finish = resolve; });
  const routes = createSurveyRoutes({
    store: () => ({ create: () => { writes++; return { id: 'unexpected' }; } }),
    readBody: async () => { entered(); return body; },
    requireAuth: () => { if (!allowed) throw Object.assign(new Error('Revoked'), { status: 401, code: 'unauthorized' }); return { user: { role: 'owner' } }; },
    clientIp: () => '127.0.0.1',
    send: () => assert.fail('Revoked mutation must not return success'), fail: () => assert.fail('Unexpected route failure'),
  });
  const pending = routes.staff({ url: '/v1/surveys', method: 'POST', headers: { 'content-type': 'application/json' } }, {}, cfg);
  await started;
  allowed = false;
  finish({ title: 'Must not be written' });
  await assert.rejects(() => pending, { status: 401, code: 'unauthorized' });
  assert.equal(writes, 0);
});

test('survey roles allow researchers and admins to manage, business owners to read, and deny unrelated members', async () => {
  const created = await request('POST', '/v1/surveys', { title: 'Role access survey' }, staffToken);
  assert.equal(created.status, 201);
  const surveyId = created.data.survey.id;
  const detailPath = `/v1/surveys/${surveyId}`;
  const publicPath = `/public/surveys/${surveyId}`;
  await request('POST', publicPath + '/email', { email: 'roles@example.com' });
  const proof = new URLSearchParams(new URL(deliveries.at(-1).url).hash.slice(1)).get('verify');
  const respondent = (await request('POST', publicPath + '/verify', { token: proof })).data.token;
  const submitted = await request('POST', publicPath + '/responses', { rating: 3, text: 'Private research feedback', noPii: true, requestId: 'role-response-1' }, respondent);
  assert.equal(submitted.status, 201);
  const responsePath = `${detailPath}/responses/${submitted.data.response.id}`;
  const mutations = [
    ['POST', '/v1/surveys', { title: 'Unauthorized creation' }],
    ['PATCH', detailPath, { title: 'Unauthorized edit', closed: true }],
    ['PATCH', responsePath, { text: 'Unauthorized response edit', reply: 'Unauthorized note', visibility: 'reviewed' }],
    ['DELETE', responsePath],
  ];
  for (const [tier, member] of members) {
    const canView = tier === 2 || tier === 4;
    const permissions = { canView, canManage: tier === 4 };
    assert.deepEqual((await request('GET', '/v1/me', undefined, member.token)).data.surveyPermissions, permissions);
    const list = await request('GET', '/v1/surveys', undefined, member.token);
    const detail = await request('GET', detailPath, undefined, member.token);
    assert.equal(list.status, canView ? 200 : 403, `tier ${tier} list`);
    assert.equal(detail.status, canView ? 200 : 403, `tier ${tier} detail`);
    if (canView) {
      assert.deepEqual(list.data.permissions, permissions);
      assert.deepEqual(detail.data.permissions, permissions);
      assert.equal(detail.data.results.total, 1);
      assert.equal(detail.data.responses[0].text, 'Private research feedback');
      assert.equal(detail.data.responses[0].contactEmail, 'roles@example.com');
    } else {
      assert.doesNotMatch(JSON.stringify([list.data, detail.data]), /Role access survey|Private research feedback|roles@example.com/);
    }
    if (tier !== 4) {
      for (const [method, route, body] of mutations) {
        assert.equal((await request(method, route, body, member.token)).status, 403, `tier ${tier} ${method} ${route}`);
      }
    }
  }
  const adminPermissions = { canView: true, canManage: true };
  assert.deepEqual((await request('GET', '/v1/me', undefined, staffToken)).data.surveyPermissions, adminPermissions);
  assert.deepEqual((await request('GET', '/v1/surveys', undefined, staffToken)).data.permissions, adminPermissions);
  assert.equal((await request('GET', detailPath, undefined, staffToken)).data.survey.title, 'Role access survey', 'denied writes do not mutate data');
  const researcher = members.get(4).token;
  assert.equal((await request('POST', '/v1/surveys', { title: 'Researcher survey' }, researcher)).status, 201);
  const updated = await request('PATCH', detailPath, { title: 'Researcher edited survey', question: 'Was the service helpful?', closed: true }, researcher);
  assert.equal(updated.status, 200);
  assert.equal(updated.data.survey.title, 'Researcher edited survey');
  assert.equal(updated.data.survey.question, 'Was the service helpful?');
  assert.equal(updated.data.survey.closed, true);
  assert.equal((await request('PATCH', detailPath, { closed: false }, researcher)).status, 200);
  assert.equal((await request('PATCH', responsePath, { reply: 'Internal research note', visibility: 'reviewed' }, researcher)).status, 200);
  assert.equal((await request('DELETE', responsePath, undefined, researcher)).status, 200);
});

test('survey authorization uses current role assignments for existing sessions', async () => {
  const member = members.get(0);
  try {
    assert.equal((await request('GET', '/v1/surveys', undefined, member.token)).status, 403);
    assert.equal((await request('PATCH', `/v1/people/${member.id}`, { agentTier: 4 }, staffToken)).status, 200);
    assert.deepEqual((await request('GET', '/v1/surveys', undefined, member.token)).data.permissions, { canView: true, canManage: true });
    assert.equal((await request('PATCH', `/v1/people/${member.id}`, { agentTier: 2 }, staffToken)).status, 200);
    assert.equal((await request('POST', '/v1/surveys', { title: 'No longer allowed' }, member.token)).status, 403);
    assert.deepEqual((await request('GET', '/v1/me', undefined, member.token)).data.surveyPermissions, { canView: true, canManage: false });
    assert.equal((await request('PATCH', `/v1/people/${member.id}`, { agentTier: 0 }, staffToken)).status, 200);
    assert.equal((await request('GET', '/v1/surveys', undefined, member.token)).status, 403);
  } finally { await request('PATCH', `/v1/people/${member.id}`, { agentTier: 0 }, staffToken); }
});

test('every body-bearing staff mutation rechecks researcher permissions after upload', async () => {
  for (const [method, url] of [['POST', '/v1/surveys'], ['PATCH', '/v1/surveys/srv_demo'], ['PATCH', '/v1/surveys/srv_demo/responses/rsp_demo']]) {
    let tier = 4, finish, entered, writes = 0;
    const started = new Promise(resolve => { entered = resolve; });
    const body = new Promise(resolve => { finish = resolve; });
    const write = () => { writes++; return {}; };
    const routes = createSurveyRoutes({
      store: () => ({ create: write, update: write, moderate: write }),
      readBody: async () => { entered(); return body; },
      requireAuth: () => ({ user: { role: 'member', agentTier: tier } }),
      clientIp: () => '127.0.0.1',
      send: () => assert.fail('A downgraded researcher must not mutate data'), fail: () => assert.fail('Unexpected route failure'),
    });
    const pending = routes.staff({ url, method, headers: { 'content-type': 'application/json' } }, {}, cfg);
    await started;
    tier = 2;
    finish({ title: 'Must not be saved' });
    await assert.rejects(() => pending, { status: 403, code: 'forbidden' });
    assert.equal(writes, 0);
  }
});

test('survey permission labels respect explicit tiers and legacy business owners', () => {
  const none = { canView: false, canManage: false };
  assert.deepEqual(surveyPermissionsFor(null), none);
  assert.deepEqual(surveyPermissionsFor({ role: 'member' }), none);
  assert.deepEqual(surveyPermissionsFor({ role: 'member', vibeCoder: true }), { canView: true, canManage: false });
  assert.deepEqual(surveyPermissionsFor({ role: 'member', agentTier: 0, vibeCoder: true }), none);
  assert.deepEqual(surveyPermissionsFor({ role: 'member', agentTier: 5 }), none);
  assert.deepEqual(surveyPermissionsFor({ role: 'owner', agentTier: 0 }), { canView: true, canManage: true });
});
