import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStateStore } from './state-store.mjs';
import { testFetch } from './encrypted-test-client.mjs';
import { normalizeFeatures, featureForKind, featureOffMessage } from './features.mjs';
import { createMessaging } from './messaging.mjs';

// Per-instance feature flags (features.mjs, docs/features.md "Features"): an instance that only wants the
// agent turns channels, direct messages and meetings off. The config is read per request, so
// each test rewrites config.json; nothing is deleted, so turning a flag back on restores it all.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-features-'));
process.env.SERVANT_DATA_DIR = directory;
const tokens = { owner: 'features-owner-device', member: 'features-member-device' };
let server, base, state;

const ALL_ON = { channels: true, directMessages: true, meetings: true, secureInbox: true };
const ALL_OFF = { channels: false, directMessages: false, meetings: false, secureInbox: false };
function configure(features) {
  // Upstreams point at a closed port: only agent routes that never call the agent are exercised.
  fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({
    host: '127.0.0.1', port: 0, name: 'Features test', publicUrl: 'https://features.example.test',
    upstreams: { owner: { url: 'http://127.0.0.1:1', key: 'k' }, member: { url: 'http://127.0.0.1:1', key: 'k' }, researcher: { url: 'http://127.0.0.1:1', key: 'k' } },
    ...(features ? { features } : {}),
  }));
}

before(async () => {
  configure(null);
  state = createStateStore({ directory });
  state.mutate(s => {
    for (const [id, token] of Object.entries(tokens)) {
      s.users[id] = { id, name: `${id} Flags`, role: id === 'owner' ? 'owner' : 'member', agentTier: 3 };
      s.devices[crypto.createHash('sha256').update(token).digest('hex')] = { id: `${id}-device`, userId: id };
    }
  });
  const { startServer } = await import('./server.mjs');
  server = await startServer();
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await server?.shutdown();
  state?.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

async function request(route, { who = 'owner', method = 'GET', body } = {}) {
  return testFetch(directory, base + route, {
    method,
    headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${tokens[who] ?? who}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function api(route, options) {
  const response = await request(route, options);
  const result = await response.json();
  assert.ok(response.ok, `${options?.method || 'GET'} ${route} -> ${response.status}: ${JSON.stringify(result)}`);
  return result;
}
async function refused(route, feature, options) {
  const response = await request(route, options);
  const result = await response.json();
  assert.equal(response.status, 404, `${options?.method || 'GET'} ${route} -> ${response.status}: ${JSON.stringify(result)}`);
  assert.deepEqual(result.error, { code: 'feature_off', message: featureOffMessage(feature) }, `${route}`);
}
const me = (who = 'owner') => api('/v1/me', { who }).then(r => r.features);
const conversations = (who = 'owner') => api('/v1/conversations', { who }).then(r => r.conversations);
const post = (id, text, who = 'owner') => api(`/v1/conversations/${id}/messages`, { who, method: 'POST', body: { text } }).then(r => r.message);

test('normalizeFeatures: every flag is on unless its value is exactly false', () => {
  assert.deepEqual(normalizeFeatures(undefined), ALL_ON);
  assert.deepEqual(normalizeFeatures(null), ALL_ON);
  assert.deepEqual(normalizeFeatures([]), ALL_ON);
  assert.deepEqual(normalizeFeatures({ channels: 'false', directMessages: 0, meetings: null }), ALL_ON);
  assert.deepEqual(normalizeFeatures({ channels: false }), { ...ALL_ON, channels: false });
  assert.deepEqual(normalizeFeatures({ ...ALL_OFF, extra: false }), ALL_OFF);
  assert.equal(featureForKind('channel'), 'channels');
  assert.equal(featureForKind('dm'), 'directMessages');
  assert.equal(featureForKind('other'), null);
  assert.equal(featureOffMessage('directMessages'), "This server doesn't use direct messages");
});

let channel, dm, channelMessage, dmMessage, recording;

test('with no features key every flag is on: /v1/me says so and channels, DMs and meetings all work', async () => {
  assert.deepEqual(await me(), ALL_ON);
  assert.deepEqual(await me('member'), ALL_ON);
  channel = (await api('/v1/conversations', { method: 'POST', body: { name: 'flags-room', topic: 'kept' } })).conversation;
  dm = (await api('/v1/conversations', { method: 'POST', body: { kind: 'dm', userIds: ['member'] } })).conversation;
  channelMessage = await post(channel.id, 'Flags channel message');
  dmMessage = await post(dm.id, 'Flags direct message');
  assert.ok((await conversations()).some(c => c.id === channel.id) && (await conversations()).some(c => c.id === dm.id));
  assert.ok(Array.isArray((await api('/v1/channels/browse')).channels));
  recording = await api('/v1/recordings', { method: 'POST', body: { size: 1024, durationMs: 1000, ext: 'm4a' } });
  assert.match(recording.id, /^rec_/);
  assert.ok(Array.isArray((await api('/v1/meetings')).meetings));
});

test('all three off: the gated routes refuse clearly and everything else still works', async () => {
  configure(ALL_OFF);
  assert.deepEqual(await me(), ALL_OFF);

  // Channels: nothing listed, nothing readable, nothing new, nothing posted.
  assert.deepEqual(await conversations(), []);
  assert.deepEqual(await conversations('member'), []);
  await refused(`/v1/conversations/${channel.id}`, 'channels');
  await refused(`/v1/conversations/${channel.id}/messages`, 'channels');
  await refused(`/v1/conversations/${channel.id}/messages`, 'channels', { method: 'POST', body: { text: 'nope' } });
  await refused('/v1/conversations', 'channels', { method: 'POST', body: { name: 'another-room' } });
  await refused('/v1/channels/browse', 'channels');
  await refused('/v1/conversations/order', 'channels', { method: 'POST', body: { ids: [channel.id] } });
  await refused(`/v1/messages/${channelMessage.id}/reactions`, 'channels', { method: 'POST', body: { emoji: '👍', active: true } });
  await refused(`/v1/messages/${channelMessage.id}`, 'channels', { method: 'PATCH', body: { text: 'edited' } });
  // Direct messages too, including the DM's own message routes.
  await refused(`/v1/conversations/${dm.id}`, 'directMessages');
  await refused(`/v1/conversations/${dm.id}/messages`, 'directMessages', { method: 'POST', body: { text: 'nope' } });
  await refused('/v1/conversations', 'directMessages', { method: 'POST', body: { kind: 'dm', userIds: ['member'] } });
  await refused(`/v1/messages/${dmMessage.id}`, 'directMessages', { method: 'DELETE' });
  // Meetings: no list, no call, no recording, no guest page.
  await refused('/v1/meetings', 'meetings');
  await refused('/v1/meetings', 'meetings', { method: 'POST', body: { conversationId: channel.id } });
  await refused('/v1/recordings', 'meetings');
  await refused('/v1/recordings', 'meetings', { method: 'POST', body: { size: 1024, durationMs: 1000, ext: 'm4a' } });
  await refused(`/v1/recordings/${recording.id}`, 'meetings');
  const guestPage = await fetch(`${base}/m/ABCDEFGH`);
  assert.equal(guestPage.status, 404, await guestPage.text());
  // Search keeps people and drops channels and their messages.
  const found = await api('/v1/search?q=flags');
  assert.deepEqual(found.channels, []);
  assert.deepEqual(found.messages, []);
  assert.ok(found.people.some(p => p.id === 'member'));

  // Kept: people, profile, agent chats, projects, notifications, feedback, presence, releases, the leaderboard.
  assert.ok((await api('/v1/people')).people.some(p => p.id === 'member'));
  assert.equal((await api('/v1/people/me', { method: 'PATCH', body: { name: 'owner Flags' } })).user.name, 'owner Flags');
  assert.ok(Array.isArray((await api('/v1/chats?scope=org')).chats));
  assert.ok(Array.isArray((await api('/v1/projects')).projects));
  assert.equal(typeof (await api('/v1/notifications')).registered, 'boolean');
  assert.ok(Array.isArray((await api('/v1/feedback')).reports));
  assert.ok(await api('/v1/presence', { method: 'POST', body: { active: true, sessionId: 'features-session-1' } }));
  assert.ok('release' in await api('/v1/releases/latest'));
  assert.ok(Array.isArray((await api('/v1/leaderboard')).people));
  assert.ok(Array.isArray((await api('/v1/devices')).devices));
});

test('each flag alone turns off only its own routes', async () => {
  configure({ channels: false });
  assert.deepEqual(await me(), { ...ALL_ON, channels: false });
  // The person's DM and their own conversation with the agent, which everyone has.
  assert.deepEqual((await conversations()).map(c => c.kind), ['dm', 'dm']);
  assert.ok((await conversations()).some(c => c.id === dm.id));
  await refused(`/v1/conversations/${channel.id}`, 'channels');
  assert.equal((await post(dm.id, 'DMs still work without channels')).text, 'DMs still work without channels');
  const search = await api('/v1/search?q=flags');
  assert.deepEqual(search.channels, []);
  assert.ok(search.messages.length && search.messages.every(m => m.conversationKind === 'dm'));
  assert.ok(Array.isArray((await api('/v1/meetings')).meetings));

  configure({ directMessages: false });
  assert.deepEqual(await me(), { ...ALL_ON, directMessages: false });
  assert.ok((await conversations()).every(c => c.kind === 'channel') && (await conversations()).some(c => c.id === channel.id));
  await refused(`/v1/conversations/${dm.id}`, 'directMessages');
  await refused('/v1/conversations', 'directMessages', { method: 'POST', body: { kind: 'dm', userIds: ['member'] } });
  assert.equal((await post(channel.id, 'Channels still work without DMs')).text, 'Channels still work without DMs');
  assert.ok((await api('/v1/search?q=flags')).messages.every(m => m.conversationKind === 'channel'));

  configure({ meetings: false });
  assert.deepEqual(await me(), { ...ALL_ON, meetings: false });
  assert.ok((await conversations()).some(c => c.id === channel.id) && (await conversations()).some(c => c.id === dm.id));
  await refused('/v1/meetings', 'meetings', { method: 'POST', body: { conversationId: channel.id } });
  await refused('/v1/recordings', 'meetings');
  assert.equal((await post(channel.id, 'Talk goes on without calls')).text, 'Talk goes on without calls');
});

test('turning everything back on restores the same conversations, messages and recordings', async () => {
  configure(ALL_ON);
  assert.deepEqual(await me(), ALL_ON);
  const list = await conversations();
  assert.ok(list.some(c => c.id === channel.id && c.topic === 'kept'));
  assert.ok(list.some(c => c.id === dm.id));
  const texts = (await api(`/v1/conversations/${channel.id}/messages`)).messages.map(m => m.text);
  assert.ok(texts.includes('Flags channel message') && texts.includes('Channels still work without DMs'));
  assert.ok((await api(`/v1/conversations/${dm.id}/messages`)).messages.some(m => m.text === 'Flags direct message'));
  // A recording still being uploaded is not listed yet, so ask for it by id.
  assert.equal((await api(`/v1/recordings/${recording.id}`)).meeting.id, recording.id);
  assert.ok(Array.isArray((await api('/v1/meetings')).meetings));
  assert.ok((await api('/v1/search?q=flags')).channels.some(c => c.id === channel.id));
});

test('a hidden conversation never notifies, streams or forwards (messaging module)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-features-msg-'));
  let features = { ...ALL_ON };
  const people = { a: { id: 'a', name: 'Ann', role: 'owner' }, b: { id: 'b', name: 'Ben', role: 'member' } };
  const messaging = createMessaging({ file: path.join(dir, 'messages.db'), users: () => people, agentName: () => 'Agent', askAgent: async () => 'ok', features: () => features });
  try {
    const room = messaging.createChannel(people.a, { name: 'quiet-room' });
    const direct = messaging.openDm(people.a, ['b']);
    const inRoom = messaging.post(room, 'a', 'Ping in the room');
    const inDm = messaging.post(direct, 'a', 'Ping in the DM');
    assert.ok(messaging.notificationFor(inRoom.seq, people.b));
    assert.ok(messaging.notificationFor(inDm.seq, people.b));
    assert.equal(messaging.forwardSource(String(inRoom.seq), 'b').text, 'Ping in the room');

    features = { ...ALL_ON, channels: false };
    assert.equal(messaging.notificationFor(inRoom.seq, people.b), null, 'no push for a channel message while channels are off');
    assert.ok(messaging.notificationFor(inDm.seq, people.b), 'DMs still notify');
    assert.throws(() => messaging.forwardSource(String(inRoom.seq), 'b'), e => e.code === 'feature_off' && e.status === 404);
    assert.throws(() => messaging.forwardInto(room.id, people.b, 'text'), e => e.code === 'feature_off');
    assert.equal(messaging.forwardSource(String(inDm.seq), 'b').text, 'Ping in the DM');

    features = { ...ALL_ON, directMessages: false };
    assert.equal(messaging.notificationFor(inDm.seq, people.b), null);
    assert.ok(messaging.notificationFor(inRoom.seq, people.b));
    assert.throws(() => messaging.forwardInto(direct.id, people.b, 'text'), e => e.code === 'feature_off');

    features = { ...ALL_ON };
    assert.ok(messaging.notificationFor(inRoom.seq, people.b) && messaging.notificationFor(inDm.seq, people.b));
  } finally {
    messaging.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
