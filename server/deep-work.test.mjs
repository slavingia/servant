import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStateStore } from './state-store.mjs';
import { testFetch } from './encrypted-test-client.mjs';
import { createMessaging, AGENT_ID } from './messaging.mjs';
import { deepWorkFields, inDeepWork, setDeepWork } from './deep-work.mjs';
import { preferences, wantsNotification } from './push.mjs';

// Deep work (deep-work.mjs, docs/features.md "Deep work"): a person's own quiet mode, kept on the person so every
// device agrees. Off for everyone until they switch it on; nothing rings or buzzes for them while it is
// on; calls they missed are listed once when they switch it off; the instance's own flags still win.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-deep-work-'));
process.env.SERVANT_DATA_DIR = directory;
// The owner has two devices: the switch is per person, so both must agree.
const tokens = { owner: 'deep-work-owner-phone', ownerLaptop: 'deep-work-owner-laptop', member: 'deep-work-member-device' };
const userOf = { owner: 'owner', ownerLaptop: 'owner', member: 'member' };
let server, base, state;

function configure(features) {
  // Upstreams point at a closed port: no route here ever reaches the agent.
  fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({
    host: '127.0.0.1', port: 0, name: 'Deep work test', publicUrl: 'https://deep-work.example.test',
    upstreams: { owner: { url: 'http://127.0.0.1:1', key: 'k' }, member: { url: 'http://127.0.0.1:1', key: 'k' }, researcher: { url: 'http://127.0.0.1:1', key: 'k' } },
    ...(features ? { features } : {}),
  }));
}

before(async () => {
  configure(null);
  state = createStateStore({ directory });
  state.mutate(s => {
    s.users.owner = { id: 'owner', name: 'Owner Focus', role: 'owner', agentTier: 3 };
    s.users.member = { id: 'member', name: 'Member Focus', role: 'member', agentTier: 3 };
    for (const [who, token] of Object.entries(tokens)) s.devices[crypto.createHash('sha256').update(token).digest('hex')] = { id: `${who}-device`, userId: userOf[who] };
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
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokens[who]}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function api(route, options) {
  const response = await request(route, options);
  const result = await response.json();
  assert.ok(response.ok, `${options?.method || 'GET'} ${route} -> ${response.status}: ${JSON.stringify(result)}`);
  return result;
}
async function refused(route, status, options) {
  const response = await request(route, options);
  const result = await response.json();
  assert.equal(response.status, status, `${options?.method || 'GET'} ${route} -> ${response.status}: ${JSON.stringify(result)}`);
  return result.error;
}
const me = (who = 'owner') => api('/v1/me', { who });
const people = (who = 'member') => api('/v1/people', { who }).then(r => Object.fromEntries(r.people.map(p => [p.id, p])));
const switchDeepWork = (on, who = 'owner') => api('/v1/people/me', { who, method: 'PATCH', body: { deepWork: on } });
const startCall = (conversationId, who) => api('/v1/meetings', { who, method: 'POST', body: { conversationId } }).then(r => r.meeting);

test('pure helpers: off unless deepWorkSince is a time; switching on again keeps the start; off removes the field', () => {
  for (const user of [undefined, null, {}, { deepWorkSince: 0 }, { deepWorkSince: -5 }, { deepWorkSince: 'yes' }, { deepWorkSince: true }]) assert.equal(inDeepWork(user), false);
  assert.equal(inDeepWork({ deepWorkSince: 1 }), true);
  const user = { id: 'u', name: 'U' };
  setDeepWork(user, true, 100);
  assert.deepEqual(user, { id: 'u', name: 'U', deepWorkSince: 100 });
  setDeepWork(user, true, 200);
  assert.equal(user.deepWorkSince, 100, 'the start time never moves while it stays on');
  assert.deepEqual(deepWorkFields(user), { deepWork: true });
  setDeepWork(user, false);
  assert.deepEqual(user, { id: 'u', name: 'U' });
  assert.deepEqual(deepWorkFields(user), {});
  assert.deepEqual(deepWorkFields(undefined), {});
});

test('off until switched on; /v1/me, the people list, conversation members and presence agree on every device', async () => {
  assert.equal((await me()).deepWork, false);
  assert.equal((await me('ownerLaptop')).deepWork, false);
  assert.ok(!('deepWork' in (await people()).owner), 'old builds see the people list they always did');
  // Signing in on a new device answers with it too, so that device lands right from the start.
  const { createInvite } = await import('./server.mjs');
  const { TERMS_VERSION, TERMS_ITEMS } = await import('./terms.mjs');
  const joined = await (await testFetch(directory, `${base}/v1/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: createInvite({ name: 'Newcomer', role: 'member' }), device: 'Phone', terms: { version: TERMS_VERSION, items: TERMS_ITEMS } }) })).json();
  assert.equal(joined.deepWork, false);

  assert.deepEqual(await switchDeepWork(true), { user: { id: 'owner', name: 'Owner Focus', role: 'owner' }, deepWork: true, missed: [] });
  assert.equal((await me()).deepWork, true);
  assert.equal((await me('ownerLaptop')).deepWork, true, 'the other device of the same person sees it too');
  assert.equal((await me('member')).deepWork, false, 'nobody else is affected');
  const seen = await people();
  assert.equal(seen.owner.deepWork, true, 'everyone else sees the status');
  assert.ok(!('deepWork' in seen.member));
  // The DM header: the person someone is about to message or call carries the flag in the members list.
  const dm = (await api('/v1/conversations', { who: 'member', method: 'POST', body: { kind: 'dm', userIds: ['owner'] } })).conversation;
  const peer = (await api(`/v1/conversations/${dm.id}`, { who: 'member' })).conversation.members.find(m => m.id === 'owner');
  assert.equal(peer.deepWork, true);
  // Presence answers (and the presence.updated events built the same way) carry it as well.
  const presence = await api('/v1/presence', { method: 'POST', body: { sessionId: 'deep-work-session-1', active: true } });
  assert.equal(presence.deepWork, true);

  assert.deepEqual(await switchDeepWork(false), { user: { id: 'owner', name: 'Owner Focus', role: 'owner' }, deepWork: false, missed: [] });
  assert.equal((await me()).deepWork, false);
  assert.equal((await me('ownerLaptop')).deepWork, false);
  assert.ok(!('deepWork' in (await people()).owner));
  assert.ok(!('deepWork' in await api('/v1/presence', { method: 'POST', body: { sessionId: 'deep-work-session-1', active: false } })));
});

test('the rename route keeps its old shape: a name alone, a name with the switch, and nothing else', async () => {
  assert.equal((await refused('/v1/people/me', 400, { method: 'PATCH', body: {} })).code, 'name_required');
  assert.equal((await refused('/v1/people/me', 400, { method: 'PATCH', body: { deepWork: 'yes' } })).code, 'bad_request');
  assert.equal((await refused('/v1/people/me', 400, { method: 'PATCH', body: { deepWork: 1 } })).code, 'bad_request');
  assert.equal((await me()).deepWork, false, 'a refused request changes nothing');
  const renamed = await api('/v1/people/me', { method: 'PATCH', body: { name: 'Owner Focused' } });
  assert.equal(renamed.user.name, 'Owner Focused');
  assert.equal(renamed.deepWork, false);
  const both = await api('/v1/people/me', { method: 'PATCH', body: { name: 'Owner Focus', deepWork: true } });
  assert.deepEqual(both.user, { id: 'owner', name: 'Owner Focus', role: 'owner' });
  assert.equal(both.deepWork, true);
  assert.equal((await me()).user.name, 'Owner Focus');
  assert.equal((await me()).deepWork, true);
  await switchDeepWork(false);
});

test('only the person themself can flip their switch', async () => {
  // The per-person route takes tiers and names, never someone else's deep work: the field is refused for anyone,
  // and a member can't reach that route's changes at all.
  assert.equal((await refused('/v1/people/owner', 400, { who: 'member', method: 'PATCH', body: { deepWork: true } })).code, 'bad_request');
  assert.equal((await refused('/v1/people/owner', 403, { who: 'member', method: 'PATCH', body: { name: 'Hijacked', deepWork: true } })).code, 'forbidden');
  assert.equal((await refused('/v1/people/member', 400, { who: 'owner', method: 'PATCH', body: { deepWork: true } })).code, 'bad_request');
  assert.equal((await me()).user.name, 'Owner Focus');
  assert.equal((await me('member')).deepWork, false);
  assert.equal((await me('owner')).deepWork, false);
});

test('nothing rings or buzzes for someone in deep work: no channel message, mention, DM, call or invite (messaging module)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-deep-work-msg-'));
  const users = { a: { id: 'a', name: 'Ann', role: 'owner' }, b: { id: 'b', name: 'Ben', role: 'member' }, c: { id: 'c', name: 'Cy', role: 'member' } };
  const messaging = createMessaging({ file: path.join(dir, 'messages.db'), users: () => users, agentName: () => 'Agent', askAgent: async () => 'ok' });
  try {
    const room = messaging.createChannel(users.a, { name: 'focus-room' });
    const direct = messaging.openDm(users.a, ['b']);
    const inRoom = messaging.post(room, 'a', 'Ping in the room');
    const mention = messaging.post(room, 'a', '@Ben can you look?');
    const inDm = messaging.post(direct, 'a', 'Ping in the DM');
    // A call card is what rings: the push pipeline hands notificationFor the event with its `call`.
    const call = { id: 'meet_focus', by: 'a' };
    const ring = messaging.post(room, AGENT_ID, 'Ann started a meeting', null, { call });
    const ringEvent = { kind: 'message', messageId: String(ring.seq), call };
    const alerts = who => [inRoom, mention, inDm].map(m => messaging.notificationFor(m.seq, who)).concat(messaging.notificationFor(ring.seq, who, ringEvent));

    assert.ok(alerts(users.b).every(Boolean), 'before: channel, mention, DM and call all alert Ben');
    assert.equal(messaging.notificationFor(ring.seq, users.b, ringEvent).title, 'Ann is calling');

    setDeepWork(users.b, true);
    assert.deepEqual(alerts(users.b), [null, null, null, null], 'in deep work: nothing alerts Ben');
    assert.ok(messaging.notificationFor(inRoom.seq, users.c), 'Cy, not in deep work, still gets the same message');
    // The agent's own pushes take a separate lane (server.mjs resolve) that never looks at the switch.
    assert.ok(wantsNotification({ kind: 'agent', chatId: 'cht_1', title: 'Agent', body: 'Done' }, preferences(users.b)));
    // The messages themselves still arrived: the switch hides and silences, it never drops anything.
    assert.equal(messaging.forwardSource(String(inDm.seq), 'b').text, 'Ping in the DM');

    setDeepWork(users.b, false);
    assert.ok(alerts(users.b).every(Boolean), 'switched off: everything alerts again');
  } finally {
    messaging.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('while in deep work messages still arrive as unread; the calls that did not ring are listed once, on switching off', async () => {
  const general = (await api('/v1/conversations')).conversations.find(c => c.name === 'general');
  const dm = (await api('/v1/conversations', { who: 'member', method: 'POST', body: { kind: 'dm', userIds: ['owner'] } })).conversation;
  const room = (await api('/v1/conversations', { method: 'POST', body: { name: 'focus-room', memberIds: ['member'] } })).conversation;
  // A call from before the switch went on is not "missed while in deep work".
  const before = await startCall(general.id, 'member');

  await switchDeepWork(true);
  await api(`/v1/conversations/${dm.id}/messages`, { who: 'member', method: 'POST', body: { text: 'Quick one when you surface' } });
  const mine = (await api('/v1/conversations')).conversations.find(c => c.id === dm.id);
  assert.equal(mine.unread, 1, 'the message arrived and counts as unread');
  const missedCall = await startCall(dm.id, 'member');
  const ownCall = await startCall(room.id, 'owner');
  assert.notEqual(missedCall.id, before.id);

  const off = await switchDeepWork(false);
  assert.equal(off.deepWork, false);
  assert.deepEqual(off.missed.map(m => m.id), [missedCall.id], 'only the call someone else started for them while it was on');
  const [missed] = off.missed;
  assert.equal(missed.conversationId, dm.id);
  assert.equal(missed.place, '', 'a direct call has no place; a channel call carries #name');
  assert.deepEqual(missed.by, { id: 'member', name: 'Member Focus' });
  assert.ok(missed.startedAt >= missedCall.startedAt - 1 && missed.live === true);
  assert.deepEqual((await switchDeepWork(false)).missed, [], 'shown once: asking again lists nothing');
  assert.deepEqual((await switchDeepWork(true)).missed, [], 'switching on never lists anything');

  // A meeting started in a channel while it was on is an invite that did not ring: listed with its place.
  await api(`/v1/meetings/${ownCall.id}/end`, { method: 'POST', body: {} });
  const invite = await startCall(room.id, 'member');
  const second = await switchDeepWork(false);
  assert.deepEqual(second.missed.map(m => [m.id, m.place]), [[invite.id, '#focus-room']]);
  for (const id of [before.id, missedCall.id, invite.id]) await api(`/v1/meetings/${id}/end`, { who: 'member', method: 'POST', body: {} });
});

test("an instance's own flags stay the operator's override: deep work never turns a feature back on", async () => {
  configure({ channels: false });
  try {
    assert.equal((await me()).features.channels, false);
    await switchDeepWork(true);
    assert.equal((await me()).features.channels, false);
    assert.equal((await refused('/v1/channels/browse', 404)).code, 'feature_off');
    await switchDeepWork(false);
    assert.equal((await me()).features.channels, false);
    assert.equal((await refused('/v1/channels/browse', 404)).code, 'feature_off');
  } finally { configure(null); }
});
