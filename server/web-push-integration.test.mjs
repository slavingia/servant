// A browser's alert, through the real server: it asks for the server's key, registers its subscription, someone
// writes, and what leaves for the push service is opened here with the browser's own keys. The push service is
// this process: requests to its address are caught before they reach the network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStateStore } from './state-store.mjs';
import { testFetch } from './encrypted-test-client.mjs';
import { decryptPush } from './web-push.mjs';

for (const key of Object.keys(process.env)) if (/^(SERVANT_|HERMES_)/.test(key) || key === 'API_SERVER_KEY') delete process.env[key];
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-web-push-'));
process.env.SERVANT_DATA_DIR = directory;
process.env.SERVANT_PUSH_CONFIG = path.join(directory, 'push.json');
fs.writeFileSync(process.env.SERVANT_PUSH_CONFIG, '{}');
fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({ name: 'Example team', contactEmail: 'team@example.gov' }));
const config = { host: '127.0.0.1', port: 0, name: 'Example team', publicUrl: '', discoveryUrl: '', adminKey: '', upstreams: {}, contactEmail: 'team@example.gov' };
const owner = crypto.randomBytes(32).toString('base64url'), member = crypto.randomBytes(32).toString('base64url');

// The push service.
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/example-browser';
const delivered = [];
const realFetch = globalThis.fetch;
let answer = 201;
globalThis.fetch = (url, options) => String(url).startsWith('https://fcm.googleapis.com/')
  ? Promise.resolve().then(() => { delivered.push({ url: String(url), options }); return new Response(null, { status: answer }); })
  : realFetch(url, options);
// The browser.
const receiver = crypto.createECDH('prime256v1'); receiver.generateKeys();
const authSecret = crypto.randomBytes(16);
const keys = { p256dh: receiver.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url') };

let server, base, state;
before(async () => {
  state = createStateStore({ directory });
  state.mutate(s => {
    s.users.owner = { id: 'owner', name: 'Pat Tester', role: 'owner' };
    s.users.member = { id: 'member', name: 'Jo Park', role: 'member' };
    const device = (token, id, userId) => { s.devices[crypto.createHash('sha256').update(token).digest('hex')] = { id, userId, createdAt: Date.now(), sessionVerifiedAt: Date.now(), legacyPlaintextUntil: Date.now() + 60_000 }; };
    device(owner, 'owner-device', 'owner');
    device(member, 'member-browser', 'member');
  });
  const mod = await import('./server.mjs');
  server = await mod.startServer(config);
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { globalThis.fetch = realFetch; await server?.shutdown(); state?.close(); fs.rmSync(directory, { recursive: true, force: true }); });

async function api(method, route, body, token) {
  const response = await testFetch(directory, base + route, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
const until = async (check, wait = 8000) => { for (const end = Date.now() + wait; Date.now() < end;) { if (check()) return true; await new Promise(r => setTimeout(r, 50)); } return check(); };

test('a browser registers and is alerted; the push service gets nothing it can read', async () => {
  // The server's key for browser push: the same every time, its private half kept in the data directory.
  const settings = await api('GET', '/v1/notifications', undefined, member);
  assert.equal(settings.status, 200);
  const serverKey = Buffer.from(settings.body.webPushKey, 'base64url');
  assert.deepEqual([serverKey.length, serverKey[0], settings.body.registered], [65, 4, false]);
  assert.equal((await api('GET', '/v1/notifications', undefined, owner)).body.webPushKey, settings.body.webPushKey);
  assert.equal(fs.statSync(path.join(directory, 'web-push-key')).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(directory, 'web-push-key')).toString('base64url') === settings.body.webPushKey, false, 'the file holds the private half, never sent');

  // An address inside the network, or without keys, is refused; a real subscription is kept.
  assert.equal((await api('PUT', '/v1/notifications', { platform: 'web', token: 'https://127.0.0.1:8787/v1/admin', keys }, member)).status, 400);
  assert.equal((await api('PUT', '/v1/notifications', { platform: 'web', token: ENDPOINT }, member)).status, 400);
  const registered = await api('PUT', '/v1/notifications', { platform: 'web', token: ENDPOINT, keys }, member);
  assert.deepEqual([registered.status, registered.body.registered, registered.body.deviceId], [200, true, 'member-browser']);
  assert.equal((await api('PATCH', '/v1/notifications', { mode: 'all' }, member)).status, 200);

  // Pat writes in #general.
  const general = (await api('GET', '/v1/conversations', undefined, owner)).body.conversations.find(c => c.name === 'general');
  const posted = await api('POST', `/v1/conversations/${general.id}/messages`, { text: 'The intake form went live this morning.' }, owner);
  assert.equal(posted.status, 201, JSON.stringify(posted.body));
  assert.ok(await until(() => delivered.length === 1), 'one request to the push service');
  const { url, options } = delivered[0];
  assert.equal(url, ENDPOINT);
  assert.deepEqual([options.method, options.headers['Content-Encoding'], options.headers.TTL, options.headers.Urgency], ['POST', 'aes128gcm', '3600', 'high']);

  // Signed by this server's key, for this push service, with the contact address from its settings.
  const [, token, key] = options.headers.Authorization.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.equal(key, settings.body.webPushKey);
  const [head, claims, signature] = token.split('.');
  const publicKey = crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: serverKey.subarray(1, 33).toString('base64url'), y: serverKey.subarray(33).toString('base64url') } });
  assert.equal(crypto.verify('sha256', Buffer.from(`${head}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')), true);
  const said = JSON.parse(Buffer.from(claims, 'base64url'));
  assert.deepEqual([said.aud, said.sub], ['https://fcm.googleapis.com', 'mailto:team@example.gov']);

  // Sealed: no name, word or id in what was sent. Opened with the browser's keys, it is the usual alert.
  const body = Buffer.from(options.body);
  assert.doesNotMatch(body.toString('latin1'), /Pat Tester|intake|general|member|owner/);
  const message = JSON.parse(decryptPush(body, receiver, authSecret));
  assert.deepEqual(message, { title: 'Pat Tester in #general', body: 'The intake form went live this morning.', tag: general.id,
    data: { userId: 'member', deviceId: 'member-browser', conversationId: general.id, messageId: posted.body.message.id } });
});

test('a subscription the push service says is gone stops being used', async () => {
  delivered.length = 0;
  answer = 410;
  const general = (await api('GET', '/v1/conversations', undefined, owner)).body.conversations.find(c => c.name === 'general');
  assert.equal((await api('POST', `/v1/conversations/${general.id}/messages`, { text: 'A second message.' }, owner)).status, 201);
  assert.ok(await until(() => delivered.length === 1));
  assert.ok(await until(() => state.read().devices && !Object.values(state.read().devices).find(d => d.id === 'member-browser').push), 'the registration is removed');
  assert.equal((await api('GET', '/v1/notifications', undefined, member)).body.registered, false);
  answer = 201;
  assert.equal((await api('POST', `/v1/conversations/${general.id}/messages`, { text: 'A third message.' }, owner)).status, 201);
  await new Promise(r => setTimeout(r, 600));
  assert.equal(delivered.length, 1, 'nothing more is sent to it');
});
