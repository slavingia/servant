import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStateStore } from './state-store.mjs';
import { testFetch } from './encrypted-test-client.mjs';
import { TERMS_VERSION, TERMS_ITEMS } from "./terms.mjs";
const ACCEPT = { version: TERMS_VERSION, items: TERMS_ITEMS };

// Never inherit an owner's upstream, push service, discovery, or data path.
for (const key of Object.keys(process.env)) if (/^(SERVANT_|HERMES_)/.test(key) || key === 'API_SERVER_KEY') delete process.env[key];
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-link-api-'));
process.env.SERVANT_DATA_DIR = directory;
process.env.SERVANT_WORKER_MODE = 'external';
process.env.SERVANT_PUSH_CONFIG = path.join(directory, 'push.json');
fs.writeFileSync(process.env.SERVANT_PUSH_CONFIG, '{}');
const config = { host: '127.0.0.1', port: 0, name: 'Isolated QR test', agentName: 'Test agent', agentAccess: 'limited', publicUrl: '', discoveryUrl: '', adminKey: '', upstreams: {} };
let server, base, mod;
before(async () => { mod = await import('./server.mjs'); server = await mod.startServer(config); base = `http://127.0.0.1:${server.address().port}`; });
after(async () => { await server?.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); });
async function api(method, route, body, token) {
  const response = await testFetch(directory, base + route, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
async function phone() {
  const result = await api('POST', '/v1/pair', { terms: ACCEPT, code: mod.createInvite({ name: 'QR teammate', role: 'member' }), device: 'Test phone' });
  assert.equal(result.status, 201);
  return result.body;
}
async function start() {
  const result = await api('POST', '/v1/device-links', { device: 'Servant for Mac' });
  assert.equal(result.status, 201);
  return result.body;
}

test('encrypted QR flow approves on phone and signs in the Mac as the same user exactly once', async () => {
  const paired = await phone(), link = await start();
  const route = '/v1/device-links/' + link.id;
  assert.equal((await api('GET', route)).status, 401);
  assert.equal((await api('POST', route + '/approve', {})).status, 401);
  const preview = await api('GET', route, undefined, paired.token);
  assert.equal(preview.body.code, link.code);
  assert.equal(preview.body.device, 'Servant for Mac');
  assert.ok(!JSON.stringify(preview.body).includes(link.secret));
  assert.equal((await api('POST', route + '/poll', { secret: link.id })).status, 404);
  assert.equal((await api('POST', route + '/poll', { secret: link.secret })).body.status, 'pending');
  assert.equal((await api('POST', route + '/approve', {}, paired.token)).status, 200);
  assert.equal((await api('POST', route + '/approve', {}, paired.token)).status, 409);
  const claims = await Promise.all([api('POST', route + '/poll', { secret: link.secret }), api('POST', route + '/poll', { secret: link.secret })]);
  assert.deepEqual(claims.map(result => result.status).sort(), [200, 410]);
  const desktop = claims.find(result => result.status === 200).body;
  assert.deepEqual(desktop.user, paired.user);
  assert.equal(desktop.server.name, config.name);
  assert.notEqual(desktop.token, paired.token);
  const me = await api('GET', '/v1/me', undefined, desktop.token);
  assert.equal(me.body.user.id, paired.user.id);
  assert.equal(me.body.device.label, 'Servant for Mac');
  assert.equal((await api('GET', '/v1/me', undefined, paired.token)).status, 200, 'phone stays signed in');
});

test('device-link endpoints always require encryption, even for a legacy phone', async () => {
  const paired = await phone(), link = await start();
  const store = createStateStore({ directory });
  store.mutate(state => { for (const device of Object.values(state.devices)) if (device.userId === paired.user.id) device.legacyPlaintextUntil = Date.now() + 60000; });
  store.close();
  for (const [method, route] of [['POST', '/v1/device-links'], ['GET', '/v1/device-links/' + link.id], ['POST', '/v1/device-links/' + link.id + '/approve'], ['POST', '/v1/device-links/' + link.id + '/poll']]) {
    const response = await fetch(base + route, { method, headers: { Authorization: 'Bearer ' + paired.token }, ...(method === 'POST' ? { body: '{}' } : {}) });
    assert.equal(response.status, 426);
    await response.text();
  }
});

test('phone sign-out after approval prevents Mac redemption', async () => {
  const paired = await phone(), link = await start(), route = '/v1/device-links/' + link.id;
  assert.equal((await api('POST', route + '/approve', {}, paired.token)).status, 200);
  assert.equal((await api('POST', '/v1/signout', {}, paired.token)).status, 200);
  const claim = await api('POST', route + '/poll', { secret: link.secret });
  assert.equal(claim.status, 410);
  assert.equal(claim.body.error.code, 'denied_device_link');
});

test('denial creates no Mac device and server restart retains pending requests', async () => {
  const paired = await phone(), link = await start(), route = '/v1/device-links/' + link.id;
  await server.shutdown();
  server = await mod.startServer(config);
  base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await api('GET', route, undefined, paired.token)).body.code, link.code);
  assert.equal((await api('POST', route + '/deny', {}, paired.token)).status, 200);
  assert.equal((await api('POST', route + '/poll', { secret: link.secret })).body.error.code, 'denied_device_link');
  const store = createStateStore({ directory });
  assert.equal(Object.values(store.read().devices).filter(device => device.userId === paired.user.id).length, 1);
  store.close();
});

test('one person can keep four independent devices; revoking one preserves all other sessions', async () => {
  const first = await phone();
  const devices = [first];
  for (let i = 0; i < 2; i++) {
    const link = await start(), route = '/v1/device-links/' + link.id;
    // Approve from either existing device, without replacing its session.
    assert.equal((await api('POST', route + '/approve', {}, devices[i].token)).status, 200);
    const result = await api('POST', route + '/poll', { secret: link.secret });
    assert.equal(result.status, 200);
    devices.push(result.body);
  }
  const invite = mod.createInvite({ userId: first.user.id });
  const extra = await api('POST', '/v1/pair', { terms: ACCEPT, code: invite, device: 'Browser' });
  assert.equal(extra.status, 201); devices.push(extra.body);
  assert.equal(new Set(devices.map(device => device.token)).size, 4);
  for (const device of devices) {
    assert.equal(device.user.id, first.user.id);
    assert.equal((await api('GET', '/v1/me', undefined, device.token)).status, 200);
  }
  assert.equal((await api('POST', '/v1/signout', {}, devices[1].token)).status, 200);
  for (let i = 0; i < devices.length; i++) assert.equal((await api('GET', '/v1/me', undefined, devices[i].token)).status, i === 1 ? 401 : 200);
  const store = createStateStore({ directory });
  const state = store.read();
  assert.equal(Object.values(state.users).filter(user => user.id === first.user.id).length, 1);
  assert.equal(Object.values(state.devices).filter(device => device.userId === first.user.id && !device.revokedAt).length, 3);
  store.close();
});

test('sign-in link: made on a signed-in phone, pasted on a computer, signs in as the same person once', async () => {
  const paired = await phone();
  assert.equal((await api('POST', '/v1/sign-in-links', {})).status, 401);
  const made = await api('POST', '/v1/sign-in-links', {}, paired.token);
  assert.equal(made.status, 200);
  assert.match(made.body.link, /^servant:\/\/pair\?code=/);
  const redeemed = await api('POST', '/v1/pair', { terms: ACCEPT, code: made.body.code, device: 'Browser' });
  assert.equal(redeemed.status, 201);
  assert.equal(redeemed.body.user.id, paired.user.id);
  assert.notEqual(redeemed.body.token, paired.token);
  assert.equal((await api('GET', '/v1/me', undefined, paired.token)).status, 200, 'phone stays signed in');
  assert.equal((await api('POST', '/v1/pair', { terms: ACCEPT, code: made.body.code, device: 'Browser' })).status, 403, 'works once');
  const first = await api('POST', '/v1/sign-in-links', {}, paired.token);
  const second = await api('POST', '/v1/sign-in-links', {}, paired.token);
  assert.equal((await api('POST', '/v1/pair', { terms: ACCEPT, code: first.body.code, device: 'Browser' })).status, 403, 'a new link replaces the old one');
  assert.equal((await api('POST', '/v1/pair', { terms: ACCEPT, code: second.body.code, device: 'Browser' })).status, 201);
});
