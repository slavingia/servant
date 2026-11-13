// A visitor's message reaches the team's phones, through the real server: the encrypted visitor routes, the push
// queue and the provider payloads. Sends are captured in this process; no push service takes part.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStateStore } from './state-store.mjs';
import { testFetch } from './encrypted-test-client.mjs';
import { apnsPayload } from './push-transport.mjs';

for (const key of Object.keys(process.env)) if (/^(SERVANT_|HERMES_)/.test(key) || key === 'API_SERVER_KEY') delete process.env[key];
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-inbox-push-'));
process.env.SERVANT_DATA_DIR = directory;
process.env.SERVANT_PUSH_CONFIG = path.join(directory, 'push.json');
fs.writeFileSync(process.env.SERVANT_PUSH_CONFIG, '{}');
const config = { host: '127.0.0.1', port: 0, name: 'Example team', publicUrl: '', discoveryUrl: '', adminKey: '', upstreams: {} };
const owner = crypto.randomBytes(32).toString('base64url'), member = crypto.randomBytes(32).toString('base64url');
const sent = [];
globalThis.__servantPushSend = async (target, notification) => { sent.push({ token: target.token, notification }); return { ok: true }; };
const pushToken = letter => letter.repeat(64);
let server, base, state;
before(async () => {
  state = createStateStore({ directory });
  state.mutate(s => {
    s.users.owner = { id: 'owner', name: 'Pat Tester', role: 'owner' };
    s.users.member = { id: 'member', name: 'Jo Park', role: 'member' };
    const device = (token, id, userId, letter) => { s.devices[crypto.createHash('sha256').update(token).digest('hex')] = { id, userId, createdAt: Date.now(), sessionVerifiedAt: Date.now(), legacyPlaintextUntil: Date.now() + 60_000, push: { platform: 'ios', token: pushToken(letter), environment: 'production' } }; };
    device(owner, 'owner-device', 'owner', 'a');
    device(member, 'member-device', 'member', 'b');
  });
  const mod = await import('./server.mjs');
  server = await mod.startServer(config);
  base = `http://127.0.0.1:${server.address().port}`;
  config.publicUrl = base;
});
after(async () => { delete globalThis.__servantPushSend; await server?.shutdown(); state?.close(); fs.rmSync(directory, { recursive: true, force: true }); });

const request = extra => ({ requestId: crypto.randomUUID(), ...extra });
async function api(method, route, body, token) {
  const response = await testFetch(directory, base + route, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function alerts(count, wait = 4000) {
  for (const until = Date.now() + wait; sent.length < count && Date.now() < until;) await sleep(50);
  // Time for one that should not have been sent to show up.
  await sleep(300);
  return sent.map(item => item.token[0]).sort().join('');
}

test('a new case and each visitor message alert the team like a direct message; a resend alerts once', async () => {
  sent.length = 0;
  const first = request({ name: 'Ana Ruiz', subject: 'Example account review', text: 'I need help updating the example account.' });
  const started = await api('POST', '/v1/inbox/guest/start', first);
  assert.equal(started.status, 201, JSON.stringify(started.body));
  const { token, conversation: { id } } = started.body;
  assert.equal(await alerts(2), 'ab', 'unassigned: the owner and the member');
  const toOwner = sent.find(item => item.token === pushToken('a')).notification;
  assert.equal(toOwner.title, 'Ana Ruiz · CASE-000001');
  assert.equal(toOwner.body, 'I need help updating the example account.');
  assert.deepEqual(toOwner.data, { userId: 'owner', deviceId: 'owner-device', caseId: id });
  // What Apple receives: the title, the body and ids to route the tap. No subject, email or anything else.
  const provider = apnsPayload(toOwner);
  assert.deepEqual(Object.keys(provider).sort(), ['aps', 'body', 'caseId', 'deviceId', 'userId']);
  assert.doesNotMatch(JSON.stringify(provider), /Example account review/);

  assert.equal((await api('POST', '/v1/inbox/guest/start', first)).status, 201);
  assert.equal(await alerts(3, 600), 'ab', 'the same start sent again alerts nobody twice');

  // The case is assigned: only that person hears from now on.
  sent.length = 0;
  assert.equal((await api('PATCH', `/v1/inbox/${id}`, { assigneeId: 'member' }, owner)).status, 200);
  const again = request({ text: 'Any news?' });
  assert.equal((await api('POST', '/v1/inbox/guest/messages', again, token)).status, 201);
  assert.equal(await alerts(1), 'b');
  assert.equal(sent[0].notification.body, 'Any news?');
  assert.equal((await api('POST', '/v1/inbox/guest/messages', again, token)).status, 201);
  assert.equal(await alerts(2, 600), 'b', 'the same message sent again alerts once');

  // A teammate's reply is not news to the team's phones.
  sent.length = 0;
  assert.equal((await api('POST', `/v1/inbox/${id}/messages`, request({ text: 'We are looking into it.' }), member)).status, 201);
  assert.equal(await alerts(1, 600), '');
});

test('notification settings, deep work and having the case open all keep a visitor message quiet', async () => {
  const started = await api('POST', '/v1/inbox/guest/start', request({ name: 'Sam Lee', subject: 'Example question', text: 'Hello' }));
  const { token, conversation: { id } } = started.body;
  await alerts(2);
  const quiet = async (label, expected) => {
    sent.length = 0;
    assert.equal((await api('POST', '/v1/inbox/guest/messages', request({ text: label }), token)).status, 201, label);
    assert.equal(await alerts(2, 800), expected, label);
  };
  assert.equal((await api('PATCH', '/v1/notifications', { mode: 'none' }, member)).status, 200);
  await quiet('The member turned notifications off', 'a');
  assert.equal((await api('PATCH', '/v1/notifications', { mode: 'mentions' }, member)).status, 200);

  state.mutate(s => { s.users.owner.deepWorkSince = Date.now(); });
  await quiet('The owner is in deep work', 'b');
  state.mutate(s => { delete s.users.owner.deepWorkSince; });

  assert.equal((await api('PATCH', '/v1/notifications', { contentPreviews: false }, owner)).status, 200);
  await quiet('The owner hides sender and message', 'ab');
  const hidden = sent.find(item => item.token === pushToken('a')).notification;
  assert.deepEqual([hidden.title, hidden.body], ['Servant', 'You have a new message']);
  assert.equal((await api('PATCH', '/v1/notifications', { contentPreviews: true }, owner)).status, 200);

  // Someone with the case open on their phone sees the message arrive there; reading it settles the alert for good.
  assert.equal((await api('POST', '/v1/notifications/presence', { conversation: id, active: true }, member)).status, 200);
  await quiet('The member has the case open', 'a');
  const latest = (await api('GET', `/v1/inbox/${id}`, undefined, member)).body.messages.at(-1).sequence;
  assert.equal((await api('POST', `/v1/inbox/${id}/read`, { through: latest }, member)).status, 200);
  assert.equal((await api('POST', '/v1/notifications/presence', { conversation: null, active: false }, member)).status, 200);
  sent.length = 0;
  assert.equal(await alerts(1, 6000), '', 'nothing arrives later for a message already read');

  await quiet('Everything back on', 'ab');
});
