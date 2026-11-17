import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMessaging } from './messaging.mjs';

// Muting a conversation, like Slack: it stays in your list, but adds nothing to your badges and only
// an @mention of you by name, or a reply in a thread you're in, still alerts you.
const people = { pat: { id: 'pat', name: 'Pat Tester', role: 'owner' }, jo: { id: 'jo', name: 'Jo Park', role: 'member' }, ana: { id: 'ana', name: 'Ana Ruiz', role: 'member' } };
function chat() {
  const m = createMessaging({ file: ':memory:', users: () => people, agentName: () => 'Agent', askAgent: async () => 'ok' });
  const route = async (userId, method, url, body = {}) => {
    let response;
    await m.handle({}, {}, { user: people[userId], method, parts: url.split('?')[0].split('/').filter(Boolean), url: new URL(url, 'http://local'), cors: {}, readBody: async () => body,
      send: (_r, status, data) => { response = { status, data }; }, fail: (_r, status, code) => { response = { status, code }; } });
    return response;
  };
  const row = async (who, id) => (await route(who, 'GET', '/v1/conversations')).data.conversations.find(c => c.id === id);
  const say = async (who, id, text, threadRoot) => (await route(who, 'POST', `/v1/conversations/${id}/messages`, { text, ...(threadRoot ? { threadRoot } : {}) })).data.message;
  return { m, route, row, say };
}

test('muting a channel stops its alerts and badge but keeps it in the list; unmuting brings them back', async () => {
  const { m, route, row, say } = chat();
  try {
    const c = m.createChannel(people.pat, { name: 'noisy' });
    const other = m.createChannel(people.pat, { name: 'quiet' });
    assert.equal((await row('jo', c.id)).muted, false, 'not muted to start');

    const muted = await route('jo', 'POST', `/v1/conversations/${c.id}/mute`);
    assert.equal(muted.status, 200);
    assert.equal(muted.data.muted, true);
    assert.equal((await row('jo', c.id)).muted, true);
    assert.equal((await row('pat', c.id)).muted, false, 'only for the person who muted it');

    const plain = await say('pat', c.id, 'Lunch is here');
    assert.equal(m.notificationFor(Number(plain.id), people.jo), null, 'a plain post does not alert');
    assert.equal(m.notificationFor(Number((await say('pat', c.id, '@channel standup moved')).id), people.jo), null, '@channel does not break through');
    assert.equal(m.notificationFor(Number((await say('pat', c.id, '@here anyone?')).id), people.jo), null, '@here does not either');
    const named = await say('pat', c.id, '@Jo can you look?');
    assert.ok(m.notificationFor(Number(named.id), people.jo)?.mentioned, 'a mention of you by name still alerts');

    // A thread you're in still alerts.
    const root = await say('pat', c.id, 'Release plan');
    await say('jo', c.id, 'Looks good', root.id);
    const reply = await say('pat', c.id, 'Shipping now', root.id);
    assert.ok(m.notificationFor(Number(reply.id), people.jo)?.participant, 'a reply in your thread still alerts');

    // The badge leaves the muted channel out; the list row still shows it has news.
    await say('pat', c.id, 'One more thing');
    const elsewhere = await say('pat', other.id, 'Hi Jo');
    const info = m.notificationFor(Number(elsewhere.id), people.jo);
    assert.equal(info.badge, 1, 'the app badge counts only the unmuted channel');
    assert.ok((await row('jo', c.id)).unread > 0, 'the muted row still knows it has unread');

    assert.equal((await route('jo', 'POST', `/v1/conversations/${c.id}/unmute`)).data.muted, false);
    assert.equal((await row('jo', c.id)).muted, false);
    assert.ok(m.notificationFor(Number((await say('pat', c.id, 'Back to normal')).id), people.jo), 'alerts again after unmuting');
  } finally { m.close(); }
});

test('only a member can mute, and a DM can be muted too', async () => {
  const { m, route, row } = chat();
  try {
    const priv = m.createChannel(people.pat, { name: 'secret', private: true });
    const res = await route('ana', 'POST', `/v1/conversations/${priv.id}/mute`);
    assert.ok(res.status === 403 || res.status === 404, `outsider refused (${res.status})`);
    const dm = m.openDm(people.pat, ['jo']);
    assert.equal((await route('jo', 'POST', `/v1/conversations/${dm.id}/mute`)).status, 200);
    assert.equal((await row('jo', dm.id)).muted, true);
  } finally { m.close(); }
});
