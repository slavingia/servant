import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPushService, defaults, isMention, notificationPayload, wantsNotification, updatePushRegistration, updatePreferences } from './push.mjs';
import { createMessaging } from './messaging.mjs';
import { fcmMessage, apnsPayload } from './push-transport.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'servant-push-'));
const user = { id: 'u_alice', name: 'Alice Smith' };
const info = { kind: 'channel', conversationId: 'ch_test', title: 'Bob in #test', body: 'Hello Alice', messageId: '10', mentioned: true, badge: 2 };
const tick = () => new Promise(r => setTimeout(r, 0));
test('Slack-style default recipients and privacy settings', () => {
  assert.ok(isMention('Hello @Alice!', user));
  assert.ok(isMention('@Alice Smith please', user));
  assert.ok(isMention('@alice-smith please', user));
  assert.ok(isMention('@channel hello', user));
  assert.equal(isMention('alice@example.com or @Alicee', user), false);
  assert.equal(wantsNotification({ ...info, mentioned: false }, defaults), false);
  assert.ok(wantsNotification({ ...info, mentioned: false, participant: true }, defaults));
  assert.ok(wantsNotification({ ...info, mentioned: false, kind: 'dm' }, defaults));
  assert.ok(wantsNotification({ ...info, mentioned: false, kind: 'agent' }, defaults));
  assert.equal(wantsNotification(info, { ...defaults, pausedUntil: Date.now() + 60000 }), false);
  assert.equal(wantsNotification(info, { ...defaults, mode: 'none' }), false);
  const n = notificationPayload(info, { ...user, notifications: { previews: false } }, 'd_1');
  assert.equal(n.title, 'Servant'); assert.equal(n.body, 'You have a new message');
  assert.equal(n.data.userId, user.id); assert.equal(n.data.deviceId, 'd_1');
  assert.equal(apnsPayload(n).aps['thread-id'], 'ch_test');
  assert.equal(JSON.parse(fcmMessage('fake', n).message.data.body).conversationId, 'ch_test');
});
test('registration moves a token to the new session, settings validate inputs', () => {
  const token = 'a'.repeat(64);
  const old = { id: 'old', push: { token } }, current = { id: 'new' };
  const state = { devices: { old, current } };
  updatePushRegistration(state, current, { token, platform: 'ios' });
  assert.equal(old.push, undefined); assert.equal(current.push.token, token);
  assert.throws(() => updatePushRegistration(state, current, { token: 'bad', platform: 'ios' }));
  assert.throws(() => updatePreferences({}, { mode: 'surprise' }));
  assert.throws(() => updatePreferences({}, { pausedUntil: Infinity }));
  updatePushRegistration(state, current, { token: null });assert.equal(current.push, undefined);
});
test('message eligibility respects private membership, personal archive, sender, reads and thread participation', async () => {
  const dir = tmp(); const people = { a: { id: 'a', name: 'Alice' }, b: { id: 'b', name: 'Bob' }, c: { id: 'c', name: 'Cora' } };
  const queued = [];
  const m = createMessaging({ file: path.join(dir, 'messages.db'), users: () => people, agentName: () => 'Agent', askAgent: async () => 'Finished reply', onMessage: e => queued.push(e) });
  try {
    const ch = m.createChannel(people.a, { name: 'private', private: true, memberIds: ['b'] });
    assert.equal(queued.length, 0, 'membership activity does not enqueue push notifications');
    const activity = m.db.prepare("SELECT seq FROM messages WHERE activity IS NOT NULL LIMIT 1").get();
    assert.equal(m.notificationFor(activity.seq, people.b), null);
    const root = m.post(ch, 'a', 'Hi @Bob');
    assert.equal(m.notificationFor(root.seq, people.a), null);
    assert.equal(m.notificationFor(root.seq, people.c), null);
    assert.equal(m.notificationFor(root.seq, people.b).mentioned, true);
    m.db.prepare('UPDATE members SET archived_at = 1 WHERE user_id = ?').run('b');
    assert.equal(m.notificationFor(root.seq, people.b), null);
    m.db.prepare('UPDATE members SET archived_at = NULL WHERE user_id = ?').run('b');
    const reply = m.post(ch, 'b', 'Answer', root.seq);
    assert.equal(m.notificationFor(reply.seq, people.a).participant, true);
    const before = queued.length;
    await m.agentReply(ch, root);
    assert.equal(queued.length, before + 1, 'only completed agent response is notified');
    const agent = m.db.prepare("SELECT * FROM messages WHERE user_id = 'agent'").get();
    assert.equal(m.notificationFor(agent.seq, people.a).body, 'Finished reply');
    m.db.prepare('UPDATE members SET last_read_seq = ? WHERE user_id = ?').run(root.seq, 'b');
    assert.equal(m.notificationFor(root.seq, people.b), null);
  } finally { m.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
test('durable queue retries and rechecks revoked devices and changed membership', async () => {
  const dir = tmp(); let now = 1000, delivered = 0, visible = true;
  const state = { users: { u: { ...user, id: 'u' } }, devices: { d: { id: 'd', userId: 'u', push: { token: 'fake', platform: 'android' } } } };
  const options = { file: path.join(dir, 'push.db'), state: () => state, mutate: fn => fn(state), resolve: () => visible ? info : null, clock: () => now, log: () => {} };
  let p = createPushService({ ...options, send: async () => ({ ok: false, retry: true, code: 'UNAVAILABLE' }) });
  p.enqueue({ kind: 'message', messageId: '1' });await tick();assert.equal(p.pending(), 1);p.close();
  now += 6000;
  p = createPushService({ ...options, send: async () => { delivered++; return { ok: true }; } });
  await p.drain();assert.equal(delivered, 1);assert.equal(p.pending(), 0);
  state.devices.d.revokedAt = now;
  p.enqueue({ kind: 'message', messageId: '2' });await tick();assert.equal(p.pending(), 0);
  delete state.devices.d.revokedAt;
  state.devices.d.pushPresence = { conversation: 'ch_test', until: now + 1000 };
  p.enqueue({ kind: 'message', messageId: '3' });await tick();assert.equal(delivered, 1);
  delete state.devices.d.pushPresence;
  now += 1500;await p.drain();assert.equal(delivered, 2, "background transition must not lose an unread message");
  p.close();
  p = createPushService({ ...options, send: async () => ({ ok: false, retry: true }) });
  p.enqueue({ kind: 'message', messageId: '4' });await tick();visible = false;now += 6000;await p.drain();assert.equal(p.pending(), 0);
  p.close();fs.rmSync(dir, { recursive: true, force: true });
});
test('unregistered tokens are removed without touching replacement tokens', async () => {
  const dir = tmp();const device = { id: 'd', userId: 'u', push: { token: 'old' } };
  const state = { users: { u: { ...user, id: 'u' } }, devices: { d: device } };
  const p = createPushService({ file: path.join(dir, 'push.db'), state: () => state, mutate: fn => fn(state), resolve: () => info, send: async () => { device.push.token = 'new';return { ok: false, invalid: true }; } });
  p.enqueue({ kind: 'message', messageId: '5' });await tick();assert.equal(device.push.token, 'new');assert.equal(p.pending(), 0);
  p.close();fs.rmSync(dir, { recursive: true, force: true });
});

test('graceful shutdown records an in-flight delivery and preserves unsent jobs across restart', async () => {
  const dir = tmp();
  const state = { users: { u: { ...user, id: 'u' } }, devices: { d: { id: 'd', userId: 'u', push: { token: 'fake' } } } };
  const options = { file: path.join(dir, 'push.db'), state: () => state, mutate: fn => fn(state), resolve: () => info };
  const started = Promise.withResolvers(), response = Promise.withResolvers();
  let sends = 0;
  let p = createPushService({ ...options, send: () => { sends++; started.resolve(); return response.promise; } });
  try {
    p.enqueue({ kind: 'message', messageId: '1' });
    await started.promise;
    p.enqueue({ kind: 'message', messageId: '2' });
    const shutdown = p.shutdown();
    assert.equal(p.shutdown(), shutdown, 'repeated shutdown shares completion');
    let finished = false;
    shutdown.then(() => { finished = true; });
    // Producers normally stop before shutdown. A late enqueue remains durable
    // while the existing send is finishing, and must not start another delivery.
    p.enqueue({ kind: 'message', messageId: '3' });
    await tick();
    assert.equal(finished, false);
    assert.equal(sends, 1);
    assert.equal(p.pending(), 3);
    response.resolve({ ok: true });
    await shutdown;
    p.close(); // Immediate close after graceful shutdown is harmless.
    assert.throws(() => p.enqueue({ kind: 'message', messageId: '4' }), /closed/);

    p = createPushService({ ...options, send: async () => { sends++; return { ok: true }; } });
    assert.equal(p.pending(), 2, 'the confirmed delivery is removed before closing');
    await p.drain();
    assert.equal(sends, 3, 'only unsent jobs are delivered after restart');
    assert.equal(p.pending(), 0);
    await p.shutdown();
  } finally { response.resolve({ ok: true }); p.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('graceful shutdown records a failed send retry before closing', async () => {
  const dir = tmp();
  let now = 1000, sends = 0;
  const state = { users: { u: { ...user, id: 'u' } }, devices: { d: { id: 'd', userId: 'u', push: { token: 'fake' } } } };
  const options = { file: path.join(dir, 'push.db'), state: () => state, mutate: fn => fn(state), resolve: () => info, clock: () => now };
  const started = Promise.withResolvers(), response = Promise.withResolvers();
  let p = createPushService({ ...options, send: () => { started.resolve(); return response.promise; } });
  try {
    p.enqueue({ kind: 'message', messageId: '1' });
    await started.promise;
    const shutdown = p.shutdown();
    response.reject(new Error('transport unavailable'));
    await shutdown;
    p = createPushService({ ...options, send: async () => { sends++; return { ok: true }; } });
    assert.equal(p.pending(), 1);
    await p.drain();
    assert.equal(sends, 0, 'retry backoff survives graceful shutdown');
    now += 5000;
    await p.drain();
    assert.equal(sends, 1);
    assert.equal(p.pending(), 0);
    await p.shutdown();
  } finally { response.resolve({ ok: true }); p.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});


test('legacy preview preferences and transport inputs cannot leak message text to push providers', () => {
  const privateInfo = { ...info, title: 'Private sender and channel', body: 'Sensitive taxpayer message' };
  const legacyUser = { ...user, notifications: { previews: true } };
  const notification = notificationPayload(privateInfo, legacyUser, 'd_1');
  assert.equal(notification.title, 'Servant');
  assert.equal(notification.body, 'You have a new message');
  const direct = { ...notification, title: privateInfo.title, body: privateInfo.body, data: { ...notification.data, preview: privateInfo.body } };
  for (const payload of [apnsPayload(direct), fcmMessage('fake', direct)]) {
    const serialized = JSON.stringify(payload);
    assert.equal(serialized.includes(privateInfo.title), false);
    assert.equal(serialized.includes(privateInfo.body), false);
    assert.ok(serialized.includes('ch_test'), 'opaque destination is retained for notification taps');
  }
  updatePreferences(legacyUser, { previews: true });
  assert.equal(legacyUser.notifications.previews, false);
});
