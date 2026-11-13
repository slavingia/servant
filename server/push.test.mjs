import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPushService, defaults, isMention, notificationPayload, previewText, wantsNotification, updatePushRegistration, updateVoipRegistration, updatePreferences } from './push.mjs';
import { createMessaging } from './messaging.mjs';
import { fcmMessage, apnsPayload, voipPayload, apnsTopic } from './push-transport.mjs';

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
  const n = notificationPayload(info, { ...user, notifications: { contentPreviews: false } }, 'd_1');
  assert.equal(n.title, 'Servant'); assert.equal(n.body, 'You have a new message');
  assert.equal(n.data.userId, user.id); assert.equal(n.data.deviceId, 'd_1');
  assert.equal(apnsPayload(n).aps['thread-id'], 'ch_test');
  // expo-notifications on iOS reads tap data only from userInfo.body.
  assert.equal(apnsPayload(n).body.conversationId, 'ch_test');
  assert.equal(apnsPayload(n).body.userId, n.data.userId);
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


test('alerts show sender and message by default, for channels, DMs and agent replies', () => {
  const channel = notificationPayload(info, user, 'd_1');
  assert.equal(channel.title, 'Bob in #test'); assert.equal(channel.body, 'Hello Alice');
  const dm = notificationPayload({ kind: 'dm', conversationId: 'dm_x', title: 'Bob Jones', body: 'Lunch?' }, user, 'd_1');
  assert.equal(dm.title, 'Bob Jones'); assert.equal(dm.body, 'Lunch?');
  const agent = notificationPayload({ kind: 'agent', chatId: 'cht_x', title: 'Agent · Refund status', body: '## Done\n\n**Two** files changed, see `a.js`' }, user, 'd_1');
  assert.equal(agent.title, 'Agent · Refund status'); assert.equal(agent.body, 'Done Two files changed, see a.js');
  for (const payload of [apnsPayload(dm), fcmMessage('fake', dm)]) {
    const s = JSON.stringify(payload);
    assert.ok(s.includes('Bob Jones') && s.includes('Lunch?'));
  }
  assert.equal(apnsPayload(dm).aps.alert.title, 'Bob Jones');
  assert.equal(fcmMessage('fake', dm).message.notification.body, 'Lunch?');
  const long = notificationPayload({ ...info, body: 'x'.repeat(1000) }, user, 'd_1');
  assert.equal(long.body.length, 240); assert.ok(long.body.endsWith('…'));
  // Empty text (e.g. a bare attachment with no label) falls back to the generic line.
  assert.equal(notificationPayload({ ...info, body: '' }, user, 'd_1').body, 'You have a new message');
});

test('the switch turns content off; old builds sending previews:false cannot', () => {
  const u = { ...user, notifications: { previews: false } };
  assert.equal(notificationPayload(info, u, 'd_1').body, 'Hello Alice', 'legacy forced-false flag is ignored');
  updatePreferences(u, { previews: false, mode: 'all' });
  assert.equal(u.notifications.contentPreviews, true);
  updatePreferences(u, { contentPreviews: false });
  assert.equal(u.notifications.previews, false);
  const off = notificationPayload(info, u, 'd_1');
  assert.equal(off.title, 'Servant'); assert.equal(off.body, 'You have a new message');
  assert.throws(() => updatePreferences(u, { contentPreviews: 'yes' }));
});

test('transport passes only title, body and opaque routing fields', () => {
  const n = notificationPayload(info, user, 'd_1');
  const direct = { ...n, data: { ...n.data, preview: 'Sensitive extra field', token: 'secret-ish' } };
  for (const payload of [apnsPayload(direct), fcmMessage('fake', direct)]) {
    const s = JSON.stringify(payload);
    assert.equal(s.includes('Sensitive extra field'), false);
    assert.equal(s.includes('secret-ish'), false);
    assert.ok(s.includes('ch_test'), 'opaque destination is retained for notification taps');
  }
  assert.equal(apnsPayload({ ...n, title: '', body: null }).aps.alert.body, 'You have a new message');
});

test('previews join list items instead of running them together', () => {
  assert.equal(previewText("Here's a plan:\n\n1. **Check** the page\n2. Compare timing\n3. Send it", 140), "Here's a plan: Check the page · Compare timing · Send it");
  assert.equal(previewText('- one\n- two', 140), 'one · two');
  assert.equal(previewText('Plain text\nline two', 140), 'Plain text line two');
});

test('a call rings other members once, only while fresh, and a tap opens the call', () => {
  const dir = tmp(); const people = { a: { id: 'a', name: 'Alice' }, b: { id: 'b', name: 'Bob' } };
  const queued = [];
  const m = createMessaging({ file: path.join(dir, 'messages.db'), users: () => people, agentName: () => 'Agent', askAgent: async () => '', onMessage: e => queued.push(e) });
  try {
    const ch = m.createChannel(people.a, { name: 'room', memberIds: ['b'] });
    const card = m.agentPost(ch.id, 'Alice started a meeting', { call: { id: 'meet_abc', by: 'a' } });
    assert.deepEqual(queued.at(-1).call, { id: 'meet_abc', by: 'a' });
    const info = m.notificationFor(card.seq, people.b, queued.at(-1));
    assert.equal(info.title, 'Alice is calling');
    assert.equal(info.meetingId, 'meet_abc');
    assert.equal(wantsNotification(info, { mode: 'mentions', pausedUntil: 0 }), true);
    assert.equal(wantsNotification(info, { mode: 'none', pausedUntil: 0 }), false);
    assert.equal(notificationPayload(info, people.b, 'd').data.meetingId, 'meet_abc');
    assert.equal(m.notificationFor(card.seq, people.a, queued.at(-1)), null, 'not the caller');
    m.db.prepare('UPDATE messages SET created_at = created_at - 60000 WHERE seq = ?').run(card.seq);
    assert.equal(m.notificationFor(card.seq, people.b, queued.at(-1)), null, 'stale call no longer rings');
  } finally { m.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('calls ring an iPhone through its VoIP token and Android through a data-only push; alerts are the fallback', async () => {
  const dir = tmp(); const sent = [];
  const call = { id: 'meet_abc', by: 'a' };
  const info = { kind: 'channel', conversationId: 'ch_x', meetingId: 'meet_abc', caller: 'Alice', place: '#room', mentioned: true, badge: 1, title: 'Alice is calling', body: 'In #room. Tap to join' };
  const state = { users: { u: { ...user, id: 'u' } }, devices: {
    ios: { id: 'ios', userId: 'u', push: { token: 'a'.repeat(64), platform: 'ios' } },
    old: { id: 'old', userId: 'u', push: { token: 'b'.repeat(64), platform: 'ios' } },
    droid: { id: 'droid', userId: 'u', push: { token: 'c'.repeat(64), platform: 'android' } } } };
  updateVoipRegistration(state, state.devices.ios, { token: 'd'.repeat(64) });
  updateVoipRegistration(state, state.devices.droid, { android: true });
  assert.throws(() => updateVoipRegistration(state, state.devices.old, { token: 'nope' }));
  const p = createPushService({ file: path.join(dir, 'push.db'), state: () => state, mutate: fn => fn(state), resolve: () => info, send: async (target, n) => { sent.push({ target, n }); return { ok: true }; }, log: () => {} });
  p.enqueue({ kind: 'message', messageId: '9', call });await tick();
  const by = id => sent.filter(x => x.target.token === ({ ios: 'd', old: 'b', droid: 'c' })[id].repeat(64))[0];
  assert.equal(by('ios').target.platform, 'ios-voip');
  assert.equal(by('old').target.platform, 'ios', 'a build without call support still gets an alert');
  assert.equal(by('droid').target.ringing, true);
  assert.equal(by('ios').n.call.caller, 'Alice');
  assert.equal(by('ios').n.data.meetingId, 'meet_abc');
  p.close();fs.rmSync(dir, { recursive: true, force: true });
});
test('call payloads carry only the meeting, caller and place; non-calls never go to PushKit', () => {
  const n = { title: 'Alice is calling', body: 'x', call: { meetingId: 'meet_abc', caller: 'Alice', place: '#room' }, data: { userId: 'u', deviceId: 'd', meetingId: 'meet_abc' } };
  assert.deepEqual(Object.keys(voipPayload(n)).sort(), ['caller', 'meetingId', 'place', 'sentAt']);
  assert.equal(voipPayload({ ...n, call: { ...n.call, meetingId: '../x' } }), null);
  assert.equal(voipPayload({ title: 'Hi', body: 'x', data: {} }), null);
  const ring = fcmMessage('tok', n, true).message;
  assert.equal(ring.notification, undefined);
  assert.equal(ring.data.type, 'call');
  assert.equal(ring.android.ttl, '45s');
  assert.ok(fcmMessage('tok', n, false).message.notification, 'old builds show a normal alert');
});
test('call registrations are removed with the device push registration', () => {
  const device = { id: 'd', push: { token: 'x' }, voip: { token: 'y' }, ringsCalls: true };
  updatePushRegistration({ devices: { d: device } }, device, { token: null });
  assert.equal(device.voip, undefined); assert.equal(device.ringsCalls, undefined);
});

test('APNs topic comes from push.json apnsTopic, then SERVANT_BUNDLE_ID, then the placeholder', () => {
  assert.equal(apnsTopic({ apnsTopic: 'org.example.app' }, false, { SERVANT_BUNDLE_ID: 'ignored.id' }), 'org.example.app');
  assert.equal(apnsTopic({ apnsTopic: 'org.example.app' }, true, {}), 'org.example.app.voip');
  assert.equal(apnsTopic({}, false, { SERVANT_BUNDLE_ID: 'net.team.servant' }), 'net.team.servant');
  assert.equal(apnsTopic({ apnsTopic: '  ' }, true, { SERVANT_BUNDLE_ID: 'net.team.servant' }), 'net.team.servant.voip');
  assert.equal(apnsTopic(null, false, {}), 'com.example.servant');
  assert.equal(apnsTopic(undefined, true, {}), 'com.example.servant.voip');
});

test('multi-server clients retain their aggregate badge when another server pushes', async () => {
  const device = { id: 'd', userId: 'u' };
  const state = { users: { u: { id: 'u', name: 'Pat Tester' } }, devices: { d: device } };
  updatePushRegistration(state, device, { token: 'a'.repeat(64), platform: 'ios', aggregateBadge: true });
  assert.equal(device.push.aggregateBadge, true);
  const dir = tmp();
  const delivered = [];
  const push = createPushService({ file: path.join(dir, 'push.db'), state: () => state, mutate: fn => fn(state),
    resolve: () => ({ kind: 'dm', conversationId: 'dm_test', badge: 2 }), send: async (target, notification) => { delivered.push(notification); return { ok: true }; }, autoDrain: false });
  try {
    push.enqueue({ kind: 'dm', messageId: '1' });
    await push.drain();
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].badge, null);
    assert.equal('badge' in apnsPayload(delivered[0]).aps, false);
    assert.equal('notification_count' in fcmMessage('token', delivered[0]).message.android.notification, false);
    updatePushRegistration(state, device, { token: 'a'.repeat(64), platform: 'ios', aggregateBadge: false });
    assert.equal(device.push.aggregateBadge, undefined, 'returning to one server restores ordinary badges');
  } finally { push.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// A visitor's message to the secure inbox alerts like a direct message and routes by the case's own id.
test('a case alert reads like a direct message, routes by case id and passes only that id to the provider', () => {
  const alert = { kind: 'dm', caseId: 'inbox_abc-123', title: 'Ana Ruiz · CASE-000001', body: 'Is my example account open?' };
  assert.ok(wantsNotification(alert, defaults), 'the default setting alerts for it, as for a direct message');
  assert.equal(wantsNotification(alert, { ...defaults, mode: 'none' }), false);
  assert.equal(wantsNotification(alert, { ...defaults, pausedUntil: Date.now() + 60000 }), false);
  const n = notificationPayload(alert, user, 'd_1');
  assert.equal(n.title, 'Ana Ruiz · CASE-000001'); assert.equal(n.body, 'Is my example account open?');
  assert.equal(n.group, 'inbox_abc-123');
  assert.deepEqual(n.data, { userId: user.id, deviceId: 'd_1', caseId: 'inbox_abc-123' });
  const apns = apnsPayload({ ...n, data: { ...n.data, email: 'ana@example.gov', subject: 'A private question' } });
  assert.deepEqual(apns.body, { userId: user.id, deviceId: 'd_1', caseId: 'inbox_abc-123' }, 'nothing else about the case leaves the server');
  assert.equal(apns.aps['thread-id'], 'inbox_abc-123');
  const fcm = fcmMessage('t'.repeat(30), n);
  assert.deepEqual(JSON.parse(fcm.message.data.body), { userId: user.id, deviceId: 'd_1', caseId: 'inbox_abc-123' });
  assert.equal(fcm.message.android.notification.tag, 'inbox_abc-123');
  const quiet = notificationPayload(alert, { ...user, notifications: { contentPreviews: false } }, 'd_1');
  assert.equal(quiet.title, 'Servant'); assert.equal(quiet.body, 'You have a new message');
  assert.equal(notificationPayload(alert, user, 'd_1', { plain: true }).body, 'Confirm it\'s you in Servant to see new messages');
});
