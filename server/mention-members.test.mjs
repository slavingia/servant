import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMessaging } from './messaging.mjs';
import { isMention } from './push.mjs';

test('conversation details expose all members for mentions without expanding lists or leaking private membership', async () => {
  const users = Object.fromEntries(Array.from({ length: 55 }, (_, i) => [`p${i}`, { id: `p${i}`, name: `Person ${i}`, role: 'member' }]));
  const m = createMessaging({ file: ':memory:', users: () => users, agentName: () => 'Agent' });
  try {
    const channel = m.createChannel(users.p0, { name: 'large-private', private: true, memberIds: Object.keys(users).slice(1, 54) });
    const get = async (path, user = users.p0) => {
      let result;
      await m.handle({}, {}, { user, method: 'GET', parts: path.split('/').filter(Boolean), url: new URL(path, 'http://test'), send: (_res, status, body) => { result = { status, body }; }, fail: (_res, status) => { result = { status }; } });
      return result;
    };
    const detail = await get(`/v1/conversations/${channel.id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.conversation.members.length, 54);
    assert.equal(detail.body.conversation.members.some(p => p.id === 'p54'), false);
    const list = await get('/v1/conversations');
    assert.equal(list.body.conversations.find(c => c.id === channel.id).members, undefined);
    assert.equal((await get(`/v1/conversations/${channel.id}`, users.p54)).status, 404);
    const dm = m.openDm(users.p0, ['p1', 'p2']);
    assert.deepEqual((await get(`/v1/conversations/${dm.id}`)).body.conversation.members.map(p => p.id).sort(), ['p0', 'p1', 'p2']);
    const self = m.openDm(users.p0, ['p0']);
    assert.equal(m.openDm(users.p0, ['p0']).id, self.id);
    assert.equal((await get(`/v1/conversations/${self.id}`)).body.conversation.title, users.p0.name);
  } finally { m.close(); }
});

test('autocompleted full-name mentions use existing notification matching without matching a shared first name', () => {
  assert.ok(isMention('Hi @Jordan-Lee please review', { id: 'j1', name: 'Jordan Lee' }));
  assert.equal(isMention('Hi @Jordan-Lee please review', { id: 'j2', name: 'Jordan Smith' }), false);
  assert.ok(isMention('@Zoë-Martin, thanks', { id: 'z', name: 'Zoë Martin' }));
});
