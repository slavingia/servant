// Reply emails through the real server: the public page, the encrypted visitor routes, the team's routes and the
// timer that sends. Mail is captured in this process; no email service takes part.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStateStore } from './state-store.mjs';
import { testFetch } from './encrypted-test-client.mjs';
import { inboxNoticeSettings } from './secure-inbox-notices.mjs';

for (const key of Object.keys(process.env)) if (/^(SERVANT_|HERMES_)/.test(key) || key === 'API_SERVER_KEY') delete process.env[key];
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-notices-api-'));
process.env.SERVANT_DATA_DIR = directory;
process.env.SERVANT_WORKER_MODE = 'external';
process.env.SERVANT_PUSH_CONFIG = path.join(directory, 'push.json');
fs.writeFileSync(process.env.SERVANT_PUSH_CONFIG, '{}');
const mailer = { command: 'true' };
const config = {
  host: '127.0.0.1', port: 0, name: 'Example team', publicUrl: '', discoveryUrl: '', adminKey: '', upstreams: {},
  // The sign-in mailer is the default sender; the delay is off so the tests do not wait a minute.
  emailVerification: { enabled: true, domains: ['example.gov'], mailer },
  secureInbox: { noticeDelaySeconds: 0 },
};
const owner = crypto.randomBytes(32).toString('base64url');
const outbox = [];
let failing = false;
globalThis.__servantInboxEmailSend = async (message, settings) => {
  if (failing) throw new Error('Email delivery failed');
  outbox.push({ ...message, command: settings.mailer.command });
};
let server, base, state;
before(async () => {
  state = createStateStore({ directory });
  state.mutate(s => {
    s.users.owner = { id: 'owner', name: 'Pat Tester', role: 'owner', email: 'owner@example.gov', emailVerifiedAt: Date.now() };
    s.devices[crypto.createHash('sha256').update(owner).digest('hex')] = { id: 'owner-device', userId: 'owner', createdAt: Date.now(), sessionVerifiedAt: Date.now(), legacyPlaintextUntil: Date.now() + 60_000 };
  });
  const mod = await import('./server.mjs');
  server = await mod.startServer(config);
  base = `http://127.0.0.1:${server.address().port}`;
  config.publicUrl = base;
});
after(async () => { delete globalThis.__servantInboxEmailSend; await server?.shutdown(); state?.close(); fs.rmSync(directory, { recursive: true, force: true }); });

const request = extra => ({ requestId: crypto.randomUUID(), ...extra });
const input = extra => request({ name: 'Ana Ruiz', email: 'ana@example.gov', subject: 'Example account review', text: 'I need help updating the example account.', ...extra });
async function api(method, route, body, token) {
  const response = await testFetch(directory, base + route, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// The timer sends about once a second here.
async function mailCount(count, wait = 6000) {
  for (const until = Date.now() + wait; outbox.length < count && Date.now() < until;) await sleep(100);
  return outbox.length;
}

test('the page offers a reply email only when the server can send one', async () => {
  const offered = await (await fetch(base + '/contact')).text();
  assert.match(offered, /data-notices="1"/);
  assert.match(offered, /we can email you when one arrives/);
  assert.match(offered, /To get an email when the team replies\. The reply itself stays on this page\./);
  for (const id of ['alerts', 'alerts-email-form', 'alerts-code-form', 'alerts-stop', 'return-note']) assert.match(offered, new RegExp(`id="${id}"`));
  config.emailVerification.mailer = null;
  const plain = await (await fetch(base + '/contact')).text();
  config.emailVerification.mailer = mailer;
  assert.match(plain, /data-notices="0"/);
  assert.match(plain, /Replies appear on this page, so come back to it\./);
  assert.match(plain, /Contact information only\. Replies stay in this chat\./);
});

test('a visitor confirms a code, is emailed each unread reply with the private link, and can stop', async () => {
  outbox.length = 0;
  const first = input();
  const started = await api('POST', '/v1/inbox/guest/start', first);
  assert.equal(started.status, 201, JSON.stringify(started.body));
  assert.deepEqual(started.body.notify, { available: true, state: 'pending', email: 'ana@example.gov' });
  assert.equal('created' in started.body, false);
  const { token, conversation: { id } } = started.body;
  assert.equal(outbox.length, 1, 'the address given with the first message is sent its code');
  assert.deepEqual({ to: outbox[0].to, subject: outbox[0].subject, command: outbox[0].command }, { to: 'ana@example.gov', subject: `Your code for Example team is ${outbox[0].code}`, command: 'true' });
  // A retry of the same start is the same conversation and sends nothing more.
  const again = await api('POST', '/v1/inbox/guest/start', first);
  assert.deepEqual([again.status, again.body.token, again.body.conversation.id, again.body.notify.state], [201, token, id, 'pending']);
  assert.equal(outbox.length, 1);

  const wrong = await api('POST', '/v1/inbox/guest/notify/confirm', { code: outbox[0].code === '000000' ? '111111' : '000000' }, token);
  assert.deepEqual([wrong.status, wrong.body.error.code], [403, 'notice_code_wrong']);
  assert.equal((await api('POST', '/v1/inbox/guest/notify/confirm', { code: outbox[0].code })).status, 401, 'a code is nothing without the conversation it was given for');
  const on = await api('POST', '/v1/inbox/guest/notify/confirm', { code: outbox[0].code }, token);
  assert.deepEqual([on.status, on.body.notify], [200, { available: true, state: 'on', email: 'ana@example.gov' }]);
  assert.deepEqual((await api('GET', `/v1/inbox/${id}/case`, undefined, owner)).body.notify, { available: true, state: 'on', email: 'ana@example.gov' });

  assert.equal((await api('POST', `/v1/inbox/${id}/messages`, request({ text: 'Secret reply about the account.' }), owner)).status, 201);
  assert.equal(await mailCount(2), 2, 'the reply is emailed');
  const notice = outbox[1];
  assert.deepEqual({ to: notice.to, subject: notice.subject }, { to: 'ana@example.gov', subject: 'New reply from Example team' });
  assert.ok(notice.url.startsWith(`${base}/contact#resume=`));
  assert.ok(notice.text.includes(notice.url));
  for (const secret of ['Secret reply', 'Example account review', 'Pat Tester', 'Ana Ruiz', 'CASE-', id]) assert.ok(!JSON.stringify(outbox).includes(secret), `${secret} is not in any email`);
  // The link in the email opens this conversation in a browser that has never seen it.
  const link = notice.url.split('#resume=')[1];
  const opened = await api('GET', '/v1/inbox/guest/conversation', undefined, link);
  assert.deepEqual([opened.status, opened.body.conversation.id, opened.body.messages.map(m => m.text)], [200, id, ['I need help updating the example account.', 'Secret reply about the account.']]);
  await sleep(1500);
  assert.equal(outbox.length, 2, 'one email for that reply, not one per pass');

  assert.equal((await api('POST', '/v1/inbox/guest/read', { through: opened.body.messages[1].sequence }, link)).status, 200);
  assert.equal((await api('POST', `/v1/inbox/${id}/messages`, request({ text: 'A second reply.' }), owner)).status, 201);
  assert.equal(await mailCount(3), 3, 'and each later reply is emailed too');

  const stopped = await api('POST', '/v1/inbox/guest/notify/stop', undefined, link);
  assert.deepEqual([stopped.status, stopped.body.notify], [200, { available: true, state: 'off', email: 'ana@example.gov' }]);
  assert.equal((await api('POST', `/v1/inbox/${id}/messages`, request({ text: 'After they stopped.' }), owner)).status, 201);
  await sleep(1800);
  assert.equal(outbox.length, 3, 'nothing after Stop emails');
  const kinds = (await api('GET', `/v1/inbox/${id}/activity`, undefined, owner)).body.activity.map(event => event.kind);
  assert.deepEqual(kinds, ['case.created', 'notice.on', 'case.link-created', 'notice.sent', 'notice.sent', 'notice.off']);
});

test('the routes need the visitor\'s own credential and an encrypted request, and refuse a bad address', async () => {
  outbox.length = 0;
  const started = (await api('POST', '/v1/inbox/guest/start', input({ email: '' }))).body;
  assert.deepEqual(started.notify, { available: true, state: 'none', email: null });
  assert.equal(outbox.length, 0, 'no address, no email');
  for (const route of ['/v1/inbox/guest/notify', '/v1/inbox/guest/notify/confirm', '/v1/inbox/guest/notify/stop']) {
    assert.equal((await api('POST', route, { email: 'ana@example.gov', code: '000000' })).status, 401, route);
    assert.equal((await api('POST', route, { email: 'ana@example.gov', code: '000000' }, owner)).status, 401, `${route} is not a team route`);
    const plain = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${started.token}` }, body: '{}' });
    assert.equal(plain.status, 426, `${route} without encryption`);
  }
  const bad = await api('POST', '/v1/inbox/guest/notify', { email: 'ana@example.gov\nBcc: jo@example.gov' }, started.token);
  assert.deepEqual([bad.status, bad.body.error.code], [400, 'invalid_email']);
  const later = await api('POST', '/v1/inbox/guest/notify', { email: 'ana@example.gov' }, started.token);
  assert.deepEqual([later.status, later.body.notify], [200, { available: true, state: 'pending', email: 'ana@example.gov' }]);
  assert.equal(outbox.length, 1, 'an address added later gets its code then');
});

test('a mailer that fails does not lose the conversation, and the page can ask again', async () => {
  outbox.length = 0;
  failing = true;
  const started = await api('POST', '/v1/inbox/guest/start', input({ email: 'jo@example.gov' }));
  assert.equal(started.status, 201);
  const refused = await api('POST', '/v1/inbox/guest/notify', { email: 'jo@example.gov' }, started.body.token);
  failing = false;
  assert.deepEqual([refused.status, refused.body.error.code], [502, 'email_send_failed']);
  assert.match(refused.body.error.message, /The code could not be sent\. Check the address and try again, or save your return link/);
  assert.deepEqual((await api('GET', '/v1/inbox/guest/conversation', undefined, started.body.token)).body.notify, { available: true, state: 'off', email: 'jo@example.gov' });
  assert.equal((await api('POST', '/v1/inbox/guest/notify', { email: 'jo@example.gov' }, started.body.token)).body.notify.state, 'pending');
  assert.equal(outbox.length, 1);
});

test('with the secure inbox switched off nothing is sent, and the waiting reply is emailed when it is back on', async () => {
  outbox.length = 0;
  const started = (await api('POST', '/v1/inbox/guest/start', input({ email: 'sam@example.gov' }))).body;
  assert.equal((await api('POST', '/v1/inbox/guest/notify/confirm', { code: outbox[0].code }, started.token)).body.notify.state, 'on');
  config.secureInbox.noticeDelaySeconds = 2;
  assert.equal((await api('POST', `/v1/inbox/${started.conversation.id}/messages`, request({ text: 'Reply before the switch.' }), owner)).status, 201);
  config.features = { secureInbox: false };
  assert.equal((await api('POST', '/v1/inbox/guest/notify/stop', undefined, started.token)).status, 404);
  await sleep(4000);
  assert.equal(outbox.length, 1, 'only the code so far');
  delete config.features;
  config.secureInbox.noticeDelaySeconds = 0;
  assert.equal(await mailCount(2), 2);
  assert.equal(outbox[1].to, 'sam@example.gov');
});

test('with no mailer the visitor is told email is not available', async () => {
  outbox.length = 0;
  config.emailVerification.mailer = null;
  try {
    const started = (await api('POST', '/v1/inbox/guest/start', input({ email: 'lee@example.gov' }))).body;
    assert.deepEqual(started.notify, { available: false, state: 'none', email: null });
    const refused = await api('POST', '/v1/inbox/guest/notify', { email: 'lee@example.gov' }, started.token);
    assert.deepEqual([refused.status, refused.body.error.code], [503, 'email_unavailable']);
    assert.equal(outbox.length, 0);
  } finally { config.emailVerification.mailer = mailer; }
});

test('the owner\'s config file reaches the feature: its secureInbox block sets the mailer and the wait', async () => {
  const { loadConfig } = await import('./server.mjs');
  const file = path.join(directory, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ name: 'Example team', publicUrl: 'https://chat.example.gov', secureInbox: { mailer: { command: '/path/to/send-mail.sh' }, noticeDelaySeconds: 5 } }));
  try {
    const loaded = loadConfig();
    assert.deepEqual(loaded.secureInbox, { mailer: { command: '/path/to/send-mail.sh' }, noticeDelaySeconds: 5 });
    const settings = inboxNoticeSettings(loaded);
    assert.deepEqual([settings.ready, settings.delayMs, settings.mailer.command], [true, 5000, '/path/to/send-mail.sh']);
    fs.writeFileSync(file, JSON.stringify({ publicUrl: 'https://chat.example.gov', secureInbox: 'yes' }));
    assert.deepEqual(loadConfig().secureInbox, {}, 'anything but an object is ignored');
    assert.equal(inboxNoticeSettings(loadConfig()).ready, false);
  } finally { fs.rmSync(file, { force: true }); }
});
