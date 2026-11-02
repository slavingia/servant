import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStateStore } from './state-store.mjs';
import { createDeviceLink, previewDeviceLink, approveDeviceLink, denyDeviceLink, pollDeviceLink, DEVICE_LINK_TTL_MS, DEVICE_LINK_IP_LIMIT, DEVICE_LINK_LIMIT } from './device-links.mjs';

const at = 1000000;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function fixture() {
  const user = { id: 'usr_test', name: 'Existing teammate', role: 'member', createdAt: 1 };
  const device = { id: 'dev_phone', userId: user.id, label: 'Phone', createdAt: 1, lastSeenAt: 1 };
  return { state: { users: { [user.id]: user }, devices: { phoneHash: device }, invites: {}, chats: {} }, auth: { user, device } };
}
const starts = state => createDeviceLink(state, { device: 'Mac', ip: 'test-network' }, at);
const fails = (fn, code) => assert.throws(fn, e => e.code === code);

test('QR handle cannot poll or reveal a token; approval retains the exact existing user', () => {
  const { state, auth } = fixture();
  const link = starts(state);
  assert.match(link.id, /^[A-Za-z0-9_-]{43}$/);
  assert.match(link.secret, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(link.id, link.secret);
  assert.match(link.code, /^\d{3} \d{3}$/);
  const saved = JSON.stringify(state);
  assert.ok(!saved.includes(link.secret));
  assert.ok(!saved.includes('test-network'));
  const preview = previewDeviceLink(state, link.id, at);
  assert.deepEqual(Object.keys(preview).sort(), ['code', 'device', 'expiresAt', 'id', 'status']);
  assert.equal(preview.code, link.code);
  fails(() => pollDeviceLink(state, link.id, link.id, at), 'invalid_device_link');
  fails(() => pollDeviceLink(state, link.id, '', at), 'invalid_device_link');
  assert.deepEqual(pollDeviceLink(state, link.id, link.secret, at), { status: 'pending', expiresAt: at + DEVICE_LINK_TTL_MS });
  assert.equal(Object.keys(state.devices).length, 1);
  assert.deepEqual(approveDeviceLink(state, link.id, auth, at), { ok: true });
  assert.equal(Object.keys(state.devices).length, 1, 'approval does not issue an unclaimed device');
  const result = pollDeviceLink(state, link.id, link.secret, at + 1);
  assert.equal(result.status, 'approved');
  assert.deepEqual(result.user, { id: auth.user.id, name: auth.user.name, role: auth.user.role });
  assert.equal(Object.keys(state.users).length, 1);
  assert.equal(state.devices[digest(result.token)].userId, auth.user.id);
  assert.equal(state.devices[digest(result.token)].label, 'Mac');
  assert.ok(!JSON.stringify(state).includes(result.token));
  fails(() => pollDeviceLink(state, link.id, link.secret, at + 2), 'used_device_link');
  fails(() => approveDeviceLink(state, link.id, auth, at + 2), 'used_device_link');
  assert.equal(Object.keys(state.devices).length, 2);
});

test('expired, denied, previously approved and malformed requests cannot be reused', () => {
  const { state, auth } = fixture();
  let link = starts(state);
  for (const action of [() => previewDeviceLink(state, link.id, link.expiresAt), () => approveDeviceLink(state, link.id, auth, link.expiresAt), () => pollDeviceLink(state, link.id, link.secret, link.expiresAt)]) fails(action, 'expired_device_link');
  link = starts(state);
  approveDeviceLink(state, link.id, auth, at);
  fails(() => approveDeviceLink(state, link.id, auth, at), 'device_link_approved');
  denyDeviceLink(state, link.id, auth, at);
  fails(() => pollDeviceLink(state, link.id, link.secret, at), 'denied_device_link');
  for (const id of [null, '', '__proto__', 'a'.repeat(100000)]) fails(() => previewDeviceLink(state, id, at), 'invalid_device_link');
  assert.equal(Object.keys(state.devices).length, 1);
});

test('revocation or account removal between approval and redemption blocks a new session', () => {
  for (const change of [
    (state, auth) => { auth.device.revokedAt = at + 1; },
    (state, auth) => { delete state.devices.phoneHash; },
    (state, auth) => { delete state.users[auth.user.id]; },
    (state, auth) => { auth.user.deactivatedAt = at + 1; },
  ]) {
    const { state, auth } = fixture();
    const link = starts(state);
    approveDeviceLink(state, link.id, auth, at);
    change(state, auth);
    fails(() => pollDeviceLink(state, link.id, link.secret, at + 2), 'denied_device_link');
    assert.ok(!Object.values(state.devices).some(device => device.label === 'Mac'));
  }
});

test('creation is bounded, keeps used requests in the limit, and prunes only expired desktop records', () => {
  const { state, auth } = fixture();
  state.invites.legacy = { name: 'Ordinary invite', expiresAt: at - 1 };
  for (let i = 0; i < DEVICE_LINK_IP_LIMIT; i++) {
    const link = starts(state);
    denyDeviceLink(state, link.id, auth, at);
  }
  fails(() => starts(state), 'rate_limited');
  createDeviceLink(state, { device: '\u0000  Mac\n', ip: 'test-network' }, at + DEVICE_LINK_TTL_MS);
  assert.equal(Object.keys(state.invites).length, 2);
  assert.ok(state.invites.legacy);
  assert.equal(Object.values(state.invites).find(record => record.kind === 'desktop-link').device, 'Mac');
  for (let i = 1; i < DEVICE_LINK_LIMIT; i++) createDeviceLink(state, { ip: 'network-' + i }, at + DEVICE_LINK_TTL_MS);
  fails(() => createDeviceLink(state, { ip: 'extra-network' }, at + DEVICE_LINK_TTL_MS), 'rate_limited');
});

test('approval survives reopening account storage and redemption remains single use across connections', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-link-state-'));
  let store = createStateStore({ directory });
  let second;
  try {
    store.mutate(state => Object.assign(state, fixture().state));
    const link = store.mutate(state => starts(state));
    store.mutate(state => approveDeviceLink(state, link.id, { user: state.users.usr_test, device: state.devices.phoneHash }, at));
    store.close();
    store = createStateStore({ directory });
    second = createStateStore({ directory });
    const result = store.mutate(state => pollDeviceLink(state, link.id, link.secret, at + 1));
    assert.equal(result.user.id, 'usr_test');
    fails(() => second.mutate(state => pollDeviceLink(state, link.id, link.secret, at + 2)), 'used_device_link');
    assert.equal(Object.keys(second.read().devices).length, 2);
  } finally { second?.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});
