import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStateStore } from './state-store.mjs';
import { testFetch } from './encrypted-test-client.mjs';
import { serverIdentity } from './secure-transport.mjs';

// No real account, email service, upstream or deployment participates.
for (const key of Object.keys(process.env)) if (/^(SERVANT_|HERMES_)/.test(key) || key === 'API_SERVER_KEY') delete process.env[key];
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-inbox-api-'));
process.env.SERVANT_DATA_DIR = directory;
process.env.SERVANT_WORKER_MODE = 'external';
process.env.SERVANT_PUSH_CONFIG = path.join(directory, 'push.json');
fs.writeFileSync(process.env.SERVANT_PUSH_CONFIG, '{}');
const config = {
  host: '127.0.0.1', port: 0, name: 'Example team', publicUrl: '', discoveryUrl: '', adminKey: '', upstreams: {},
  recordsPreservation: { enabled: true }, sessionMaxHours: 12,
  emailVerification: { enabled: true, domains: ['example.gov'], mailer: { command: 'true' } },
};
const tokens = { owner: crypto.randomBytes(32).toString('base64url'), member: crypto.randomBytes(32).toString('base64url') };
let server, base, mod, state;
before(async () => {
  state = createStateStore({ directory });
  state.mutate(s => {
    for (const [id, token] of Object.entries(tokens)) {
      s.users[id] = { id, name: id === 'owner' ? 'Pat Tester' : 'Jo Park', role: id, email: `${id}@example.gov`, emailVerifiedAt: Date.now() };
      s.devices[crypto.createHash('sha256').update(token).digest('hex')] = { id: `${id}-device`, userId: id, createdAt: Date.now(), sessionVerifiedAt: Date.now(), legacyPlaintextUntil: Date.now() + 60_000 };
    }
  });
  mod = await import('./server.mjs');
  server = await mod.startServer(config);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await server?.shutdown(); state?.close(); fs.rmSync(directory, { recursive: true, force: true }); });
const message = (text = 'Hello team', extra = {}) => ({ text, requestId: crypto.randomUUID(), ...extra });
const input = extra => ({ name: 'Ana Ruiz', email: 'ana@example.gov', subject: 'Private question', ...message(), ...extra });
const attachment = { name: 'question.txt', data: Buffer.from('private document').toString('base64') };
async function api(method, route, body, token, headers = {}) {
  const response = await testFetch(directory, base + route, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
async function start(extra) {
  const result = await api('POST', '/v1/inbox/guest/start', input(extra));
  assert.equal(result.status, 201, JSON.stringify(result.body));
  return result.body;
}

test('public page and script have a pinned key and restrictive headers; only encrypted APIs accept messages', async () => {
  const response = await fetch(base + '/contact');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.ok((await response.text()).includes(serverIdentity(directory).publicKey));
  const script = await fetch(base + '/contact/inbox.js');
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);
  await script.text();
  for (const [method, route, body] of [['POST', '/v1/inbox/guest/start', input()], ['GET', '/v1/inbox'], ['POST', '/v1/inbox/guest/messages', message()]]) {
    for (const token of [undefined, tokens.owner]) {
      const plain = await fetch(base + route, { method, headers: token ? { Authorization: `Bearer ${token}` } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
      assert.equal(plain.status, 426, route);
      assert.equal((await plain.json()).error.code, 'encryption_required');
    }
  }
});

test('team list publishes only the configured direct public entry link, never a relay or request header', async () => {
  assert.equal((await api('GET', '/v1/inbox', undefined, tokens.owner)).body.publicUrl, null);
  config.publicUrl = 'https://chat.example.gov/';
  assert.equal((await api('GET', '/v1/inbox', undefined, tokens.owner, { 'X-Forwarded-Host': 'untrusted.example.gov' })).body.publicUrl, 'https://chat.example.gov/contact');
  config.publicUrl = base;
  assert.equal((await api('GET', '/v1/inbox', undefined, tokens.member)).body.publicUrl, base + '/contact');
  for (const url of ['https://relay.example.gov/hubs/example-app', 'https://user:secret@chat.example.gov', 'https://chat.example.gov/?token=secret']) {
    config.publicUrl = url;
    assert.equal((await api('GET', '/v1/inbox', undefined, tokens.owner)).body.publicUrl, null);
  }
  config.publicUrl = '';
});

test('visitor and team exchange encrypted messages and files without granting membership or disclosing other guests', async () => {
  const before = state.read();
  const a = await start({ attachments: [attachment] });
  const b = await start({ name: 'Jo Park' });
  const id = a.conversation.id;
  assert.equal(Object.keys(state.read().users).length, Object.keys(before.users).length);
  assert.equal(Object.keys(state.read().devices).length, Object.keys(before.devices).length);
  for (const route of ['/v1/me', '/v1/people', '/v1/inbox', `/v1/inbox/${id}`, '/v1/conversations']) assert.equal((await api('GET', route, undefined, a.token)).status, 401, route);
  assert.equal((await api('GET', '/v1/inbox/guest/conversation', undefined, tokens.owner)).status, 401);
  const detail = await api('GET', '/v1/inbox/guest/conversation', undefined, a.token);
  assert.equal(detail.body.conversation.id, id);
  assert.equal(detail.body.messages.length, 1);
  assert.equal((await api('GET', `/v1/inbox/guest/conversation?id=${id}`, undefined, b.token)).body.conversation.id, b.conversation.id);
  const fileId = a.messages[0].attachments[0].id;
  assert.equal((await api('GET', `/v1/inbox/guest/files/${fileId}`, undefined, b.token)).status, 404);
  assert.equal((await api('GET', `/v1/inbox/${b.conversation.id}/files/${fileId}`, undefined, tokens.member)).status, 404);
  assert.equal((await api('GET', `/v1/inbox/${id}/files/${fileId}`, undefined, tokens.member)).body.file.data, attachment.data);
  const reply = await api('POST', `/v1/inbox/${id}/messages`, message('The team reply', { attachments: [{ ...attachment, name: 'answer.txt' }] }), tokens.member);
  assert.equal(reply.status, 201);
  assert.equal(reply.body.message.sender, 'staff');
  const guestReply = await api('GET', '/v1/inbox/guest/conversation?after=' + a.messages[0].sequence, undefined, a.token);
  assert.equal(guestReply.body.messages.length, 1);
  assert.equal(guestReply.body.messages[0].text, 'The team reply');
  assert.equal(guestReply.body.conversation.unread, 1);
  assert.equal((await api('GET', '/v1/inbox/guest/files/' + reply.body.message.attachments[0].id, undefined, a.token)).body.file.data, attachment.data);
  assert.equal((await api('POST', '/v1/inbox/guest/read', { through: reply.body.message.sequence }, a.token)).status, 200);
  assert.equal((await api('GET', '/v1/inbox/guest/conversation', undefined, a.token)).body.conversation.unread, 0);
  assert.equal((await api('POST', `/v1/inbox/${id}/read`, { through: a.messages[0].sequence }, tokens.owner)).status, 200);
  assert.equal((await api('GET', `/v1/inbox/${id}`, undefined, tokens.owner)).body.conversation.unread, 0);
  assert.equal((await api('GET', `/v1/inbox/${id}`, undefined, tokens.member)).body.conversation.unread, 1);
  assert.equal((await api('PATCH', `/v1/inbox/${id}`, { status: 'resolved', assigneeId: 'owner' }, tokens.owner)).status, 200);
  const resolved = await api('GET', '/v1/inbox?status=resolved&q=private', undefined, tokens.member);
  assert.ok(resolved.body.conversations.some(c => c.id === id && c.assigneeId === 'owner'));
  assert.equal((await api('POST', '/v1/inbox/guest/messages', message('A follow-up'), a.token)).body.conversation.status, 'open');
  assert.equal((await api('DELETE', `/v1/inbox/${id}`, undefined, tokens.owner)).status, 404);
});

test('flag off hides page, script, files and APIs without deleting conversation, reads or files', async () => {
  const a = await start({ attachments: [attachment] });
  config.features = { secureInbox: false };
  assert.equal((await api('GET', '/v1/me', undefined, tokens.owner)).body.features.secureInbox, false);
  for (const route of ['/contact', '/contact/inbox.js']) {
    const response = await fetch(base + route);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, 'feature_off');
  }
  for (const [method, route, body, token] of [
    ['GET', '/v1/inbox', undefined, tokens.owner], ['GET', `/v1/inbox/${a.conversation.id}`, undefined, tokens.owner],
    ['GET', `/v1/inbox/${a.conversation.id}/files/${a.messages[0].attachments[0].id}`, undefined, tokens.owner],
    ['GET', '/v1/inbox/guest/conversation', undefined, a.token], ['POST', '/v1/inbox/guest/messages', message(), a.token],
    ['POST', '/v1/inbox/guest/start', input()], ['GET', `/v1/inbox/guest/files/${a.messages[0].attachments[0].id}`, undefined, a.token],
  ]) {
    const response = await api(method, route, body, token);
    assert.equal(response.status, 404, route);
    assert.equal(response.body.error.code, 'feature_off');
  }
  config.features = {};
  assert.equal((await api('GET', '/v1/me', undefined, tokens.owner)).body.features.secureInbox, true);
  assert.equal((await api('GET', '/v1/inbox/guest/conversation', undefined, a.token)).body.messages[0].text, 'Hello team');
  assert.equal((await api('GET', `/v1/inbox/guest/files/${a.messages[0].attachments[0].id}`, undefined, a.token)).body.file.data, attachment.data);
});

test('retry and restart keep the same conversation, token, messages and files', async () => {
  const initial = input({ attachments: [attachment] });
  const created = await api('POST', '/v1/inbox/guest/start', initial);
  assert.equal(created.status, 201);
  const a = created.body;
  const outgoing = message('A durable reply');
  const sent = await api('POST', '/v1/inbox/guest/messages', outgoing, a.token);
  await server.shutdown();
  server = await mod.startServer(config);
  base = `http://127.0.0.1:${server.address().port}`;
  const retried = await api('POST', '/v1/inbox/guest/start', initial);
  assert.equal(retried.body.token, a.token);
  assert.equal(retried.body.conversation.id, a.conversation.id);
  assert.equal((await api('POST', '/v1/inbox/guest/messages', outgoing, a.token)).body.message.id, sent.body.message.id);
  assert.equal((await api('GET', '/v1/inbox/guest/conversation', undefined, a.token)).body.messages.length, 2);
  const conflict = await api('POST', '/v1/inbox/guest/start', { ...initial, text: 'changed' });
  assert.equal(conflict.status, 409);
  assert.equal('token' in conflict.body, false);
});

test('expired or revoked team devices cannot read or reply; invalid bodies fail without appending', async () => {
  const a = await start();
  const key = crypto.createHash('sha256').update(tokens.member).digest('hex');
  state.mutate(s => { s.devices[key].sessionVerifiedAt = Date.now() - 13 * 60 * 60 * 1000; });
  for (const [method, route, body] of [['GET', '/v1/inbox'], ['GET', `/v1/inbox/${a.conversation.id}`], ['POST', `/v1/inbox/${a.conversation.id}/messages`, message()], ['PATCH', `/v1/inbox/${a.conversation.id}`, { status: 'resolved' }]]) {
    const expired = await api(method, route, body, tokens.member, { 'X-Servant-Reverify': '1' });
    assert.equal(expired.status, 401);
    assert.equal(expired.body.error.code, 'session_expired');
  }
  state.mutate(s => { s.devices[key].sessionVerifiedAt = Date.now(); s.devices[key].revokedAt = Date.now(); });
  assert.equal((await api('GET', '/v1/inbox', undefined, tokens.member)).status, 401);
  state.mutate(s => { delete s.devices[key].revokedAt; });
  for (const body of [null, [], message('', { attachments: [{ name: '../secret', data: 'YQ==' }] }), message('', { attachments: [{ name: 'file', data: 'not base64' }] }), { text: 'No id' }]) {
    const invalid = await api('POST', '/v1/inbox/guest/messages', body, a.token);
    assert.equal(invalid.status, 400, JSON.stringify(body));
  }
  assert.equal((await api('GET', '/v1/inbox/guest/conversation?after=-1', undefined, a.token)).status, 400);
  assert.equal((await api('POST', '/v1/inbox/guest/read', { through: 999_999 }, a.token)).status, 400);
  assert.equal((await api('GET', '/v1/inbox/guest/conversation', undefined, a.token)).body.messages.length, 1);
});

test('public start limits survive a restart and spoofed forwarded IP headers cannot bypass the socket quota', async () => {
  let rejected;
  for (let i = 0; i < 12; i++) {
    const response = await api('POST', '/v1/inbox/guest/start', input(), undefined, { 'cf-connecting-ip': `192.0.2.${i}`, 'x-forwarded-for': `192.0.2.${i}` });
    if (response.status === 429) { rejected = response; break; }
    assert.equal(response.status, 201);
  }
  assert.equal(rejected?.body.error.code, 'rate_limited');
  await server.shutdown();
  server = await mod.startServer(config);
  base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await api('POST', '/v1/inbox/guest/start', input(), undefined, { 'cf-connecting-ip': '198.51.100.1' })).status, 429);
});
