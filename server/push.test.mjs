import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPushService, defaults, isMention, notificationPayload, previewText, wantsNotification, updatePushRegistration, updatePreferences } from './push.mjs';
import { createMessaging } from './messaging.mjs';
import { fcmMessage, apnsPayload, apnsTopic, createPushTransport, webPushMessage } from './push-transport.mjs';
import { decryptPush, temporaryWebPushIdentity } from './web-push.mjs';

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
test('a browser registers its push subscription: only a real push service address and whole keys are kept', () => {
  const receiver = crypto.createECDH('prime256v1'); receiver.generateKeys();
  const keys = { p256dh: receiver.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') };
  const endpoint = 'https://fcm.googleapis.com/fcm/send/example';
  const phone = { id: 'phone', userId: 'u', push: { platform: 'ios', token: 'a'.repeat(64), environment: 'production' } };
  const old = { id: 'old', userId: 'u', push: { platform: 'web', token: endpoint, ...keys } };
  const browser = { id: 'browser', userId: 'u' };
  const state = { devices: { phone, old, browser } };
  updatePushRegistration(state, browser, { platform: 'web', token: endpoint, keys });
  assert.deepEqual(browser.push, { platform: 'web', token: endpoint, ...keys });
  assert.equal(old.push, undefined, 'the same browser signed in again: its earlier session stops receiving');
  assert.equal(phone.push.platform, 'ios', 'other devices keep theirs');
  // Refused, leaving what was there: an address that is not a push service, or keys that are missing or wrong.
  for (const body of [{ platform: 'web', token: 'https://127.0.0.1/internal', keys }, { platform: 'web', token: 'http://fcm.googleapis.com/x', keys }, { platform: 'web', token: endpoint },
    { platform: 'web', token: endpoint, keys: { ...keys, auth: 'short' } }, { platform: 'web', token: endpoint, keys: { ...keys, p256dh: 'A'.repeat(87) } }]) {
    assert.throws(() => updatePushRegistration(state, browser, body), { code: 'bad_push_token', status: 400 });
    assert.equal(browser.push.token, endpoint);
  }
  // Turning it off in the browser removes it like any other device.
  updatePushRegistration(state, browser, { token: null });
  assert.equal(browser.push, undefined);
});

test('a browser alert is the same title, body and routing ids, sealed so the push service cannot read it', async () => {
  const receiver = crypto.createECDH('prime256v1'); receiver.generateKeys();
  const auth = crypto.randomBytes(16);
  const device = { platform: 'web', token: 'https://updates.push.services.mozilla.com/wpush/v2/example', p256dh: receiver.getPublicKey().toString('base64url'), auth: auth.toString('base64url') };
  const identity = temporaryWebPushIdentity();
  const requests = [];
  const transport = createPushTransport(() => ({}), async (url, options) => { requests.push({ url, options }); return { status: 201 }; }, () => ({ identity, subject: 'mailto:team@example.gov' }));
  const notification = notificationPayload({ kind: 'channel', conversationId: 'ch_1', messageId: 7, title: 'Jo Park in #general', body: 'Two requests have come in already.', secret: 'never' },
    { id: 'u1', notifications: { contentPreviews: true } }, 'd1');
  assert.deepEqual(await transport(device, { ...notification, internal: 'never' }), { ok: true });
  assert.equal(requests[0].url, device.token);
  const message = JSON.parse(decryptPush(requests[0].options.body, receiver, auth));
  assert.deepEqual(message, { title: 'Jo Park in #general', body: 'Two requests have come in already.', tag: 'ch_1', data: { userId: 'u1', deviceId: 'd1', conversationId: 'ch_1', messageId: '7' } });
  assert.equal(webPushMessage(notification).data.conversationId, 'ch_1');
  assert.doesNotMatch(Buffer.from(requests[0].options.body).toString('latin1'), /Jo Park|requests|ch_1|u1/, 'nothing readable leaves the server');
  assert.match(requests[0].options.headers.Topic, /^[A-Za-z0-9_-]{32}$/);
  // With previews off the browser gets the same generic words as a phone.
  const generic = notificationPayload({ kind: 'dm', conversationId: 'dm_1', title: 'Jo Park', body: 'private words' }, { id: 'u1', notifications: { contentPreviews: false } }, 'd1');
  await transport(device, generic);
  assert.deepEqual(JSON.parse(decryptPush(requests[1].options.body, receiver, auth)), { title: 'Servant', body: 'You have a new message', tag: 'dm_1', data: { userId: 'u1', deviceId: 'd1', conversationId: 'dm_1' } });
  // No signing identity: nothing is sent.
  await assert.rejects(createPushTransport(() => ({}), async () => assert.fail('must not send'))(device, notification), /WEB_PUSH_NOT_CONFIGURED/);
});

test('a browser subscription that is gone is removed, and one that fails for now is tried again', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-push-web-'));
  const endpoint = 'https://fcm.googleapis.com/fcm/send/example';
  const state = { users: { u: { id: 'u', notifications: { mode: 'all' } } }, devices: { b: { id: 'b', userId: 'u', push: { platform: 'web', token: endpoint, p256dh: 'p', auth: 'a' } } } };
  const answers = [{ ok: false, retry: true, code: '503' }, { ok: false, invalid: true, retry: false, code: '410' }];
  const sent = [];
  let now = 1000;
  const service = createPushService({ file: path.join(dir, 'push.db'), state: () => state, mutate: change => change(state), autoDrain: false, clock: () => now, log: () => {},
    resolve: event => ({ kind: 'dm', conversationId: 'dm_1', title: 'Jo Park', body: event.text }),
    send: async (target, notification) => { sent.push({ target, notification }); return answers.shift(); } });
  try {
    service.enqueue({ kind: 'message', messageId: 1, text: 'Hello' });
    await service.drain();
    assert.deepEqual([sent.length, service.pending(), sent[0].target.platform, sent[0].target.token], [1, 1, 'web', endpoint]);
    now += 6000;
    await service.drain();
    assert.deepEqual([sent.length, service.pending()], [2, 0]);
    assert.equal(state.devices.b.push, undefined, 'the browser unsubscribed: its registration is dropped');
  } finally { service.close(); fs.rmSync(dir, { recursive: true, force: true }); }
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

test('APNs topic comes from push.json apnsTopic, then SERVANT_BUNDLE_ID, then the placeholder', () => {
  assert.equal(apnsTopic({ apnsTopic: 'org.example.app' }, { SERVANT_BUNDLE_ID: 'ignored.id' }), 'org.example.app');
  assert.equal(apnsTopic({}, { SERVANT_BUNDLE_ID: 'net.team.servant' }), 'net.team.servant');
  assert.equal(apnsTopic({ apnsTopic: '  ' }, { SERVANT_BUNDLE_ID: 'net.team.servant' }), 'net.team.servant');
  assert.equal(apnsTopic(null, {}), 'com.example.servant');
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

test('a registration keeps which app it came from, when the app says so with a plain id', () => {
  const state = { devices: {} };
  const device = { id: 'd_app' };
  state.devices.x = device;
  updatePushRegistration(state, device, { platform: 'ios', token: 'a'.repeat(64), app: 'com.example.other' });
  assert.deepEqual(device.push, { platform: 'ios', token: 'a'.repeat(64), environment: 'production', app: 'com.example.other' });
  updatePushRegistration(state, device, { platform: 'ios', token: 'a'.repeat(64) });
  assert.equal('app' in device.push, false, 'an older build names none');
  for (const bad of ['', 'has space', 'https://example.gov', '../x', 7, null, 'a'.repeat(200)]) {
    updatePushRegistration(state, device, { platform: 'android', token: 't'.repeat(30), app: bad });
    assert.equal('app' in device.push, false, String(bad));
  }
});

// An entitlement request, decision or refused host opens the Entitlements screen; nothing else about it leaves the server.
test('an entitlement alert routes to the Entitlements page and passes only that to the provider', () => {
  const alert = { kind: 'agent', title: 'Entitlement request', body: 'Pat Tester asked for Tax data API', page: 'entitlements' };
  assert.ok(wantsNotification(alert, defaults));
  const n = notificationPayload(alert, user, 'd_1');
  assert.deepEqual(n.data, { userId: user.id, deviceId: 'd_1', page: 'entitlements' });
  const apns = apnsPayload({ ...n, data: { ...n.data, note: 'I work on the example app', page: 'entitlements' } });
  assert.deepEqual(apns.body, { userId: user.id, deviceId: 'd_1', page: 'entitlements' }, "the request's note never reaches the provider");
  assert.deepEqual(JSON.parse(fcmMessage('t'.repeat(30), n).message.data.body), { userId: user.id, deviceId: 'd_1', page: 'entitlements' });
  assert.deepEqual(apnsPayload({ ...n, data: { ...n.data, page: 'https://example.gov/x' } }).body, { userId: user.id, deviceId: 'd_1' }, 'a page is a plain word, never an address');
  const quiet = notificationPayload(alert, { ...user, notifications: { contentPreviews: false } }, 'd_1');
  assert.equal(quiet.title, 'Servant'); assert.equal(quiet.body, 'You have a new message');
  assert.deepEqual(quiet.data, n.data, 'with previews off the tap still opens Entitlements');
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

test('a push with no real unread count leaves the app icon alone instead of setting it to 1', () => {
  assert.equal(notificationPayload({ ...info, badge: 0 }, user, 'd_1').badge, null);
  assert.equal(notificationPayload({ ...info, badge: undefined }, user, 'd_1').badge, null);
  assert.equal(notificationPayload({ ...info, badge: 3 }, user, 'd_1').badge, 3);
});
