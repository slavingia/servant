import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMessaging, AGENT_ID } from './messaging.mjs';

function fixture(t, persistent = false) {
  const people = {
    owner: { id: 'owner', name: 'Owner', role: 'owner' },
    member: { id: 'member', name: 'Member', role: 'member' },
    outsider: { id: 'outsider', name: 'Outsider', role: 'member' },
  };
  const dir = persistent ? fs.mkdtempSync(path.join(os.tmpdir(), 'servant-presence-')) : null;
  const instances = [];
  const open = () => {
    const m = createMessaging({ file: dir ? path.join(dir, 'messages.db') : ':memory:', users: () => people, agentName: () => 'Agent' });
    instances.push(m);
    return m;
  };
  const first = open();
  t.after(() => {
    for (const m of instances) m.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });
  const route = async (m, userId, method, routePath, body = {}, extra = {}) => {
    let response;
    const context = {
      user: people[userId], method, parts: routePath.split('?')[0].split('/').filter(Boolean), url: new URL(routePath, 'http://local'),
      cors: {}, readBody: async () => body,
      send: (_res, status, data) => { response = { status, data }; },
      fail: (_res, status, code) => { response = { status, code }; },
      ...extra,
    };
    try { await m.handle({}, {}, context); }
    catch (error) {
      if (!error.status) throw error;
      response = { status: error.status, code: error.code };
    }
    return response;
  };
  const replay = async (m, userId, after) => {
    const res = new EventEmitter();
    const blocks = [];
    res.writeHead = () => {};
    res.write = block => { blocks.push(block); return true; };
    res.end = () => res.emit('close');
    const routePath = `/v1/events?after=${after}`;
    await m.handle({}, res, {
      user: people[userId], method: 'POST', parts: ['v1', 'events'], url: new URL(routePath, 'http://local'), cors: {},
      readBody: async () => ({}), send: () => assert.fail('Unexpected response'), fail: () => assert.fail('Unexpected error'),
    });
    res.emit('close');
    return blocks.filter(b => b.includes('event:')).map(block => ({
      event: block.match(/event: (.+)\n/)[1], data: JSON.parse(block.match(/data: (.+)\n/)[1]),
    }));
  };
  const channel = (privateChannel = true) => first.createChannel(people.owner, { name: `test-${Math.random().toString(36).slice(2)}`, private: privateChannel, memberIds: ['member'] });
  const getPosts = async (m, id, who = 'owner') => (await route(m, who, 'GET', `/v1/conversations/${id}/messages`)).data.messages;
  const read = (m, id, ids, who = 'member') => route(m, who, 'POST', `/v1/conversations/${id}/read`, { messageIds: ids.map(String) });
  const head = m => m.db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM live_events').get().id;
  return { first, people, open, route, replay, channel, getPosts, read, head };
}

test('receipts record only explicitly seen posts and thread replies, preserve first read time, and are idempotent', async t => {
  const f = fixture(t);
  const c = f.channel();
  const unseen = f.first.post(c, 'owner', 'Never shown');
  const seen = f.first.post(c, 'owner', 'Visible');
  const reply = f.first.post(c, 'owner', 'Visible reply', seen.seq);
  const own = f.first.post(c, 'member', 'My post');
  const events = [];
  f.first.subscribe('owner', (event, data) => events.push({ event, data }));
  assert.equal((await f.read(f.first, c.id, [seen.seq, reply.seq, own.seq, seen.seq])).status, 200);
  const posts = await f.getPosts(f.first, c.id);
  assert.deepEqual(posts.find(p => p.id === String(unseen.seq)).readBy, []);
  assert.deepEqual(posts.find(p => p.id === String(own.seq)).readBy, []);
  const receipt = posts.find(p => p.id === String(seen.seq)).readBy;
  assert.equal(receipt.length, 1);
  assert.equal(receipt[0].userId, 'member');
  assert.ok(receipt[0].readAt > 0);
  const thread = await f.route(f.first, 'owner', 'GET', `/v1/conversations/${c.id}/threads/${seen.seq}`);
  assert.deepEqual(thread.data.replies[0].readBy, receipt);
  assert.deepEqual(events.filter(e => e.event === 'messages.read'), [{ event: 'messages.read', data: {
    conversationId: c.id, userId: 'member', messageIds: [String(seen.seq), String(reply.seq)], readAt: receipt[0].readAt,
  } }]);
  const before = f.head(f.first);
  assert.equal((await f.read(f.first, c.id, [seen.seq, reply.seq])).status, 200);
  assert.equal(f.head(f.first), before);
  assert.deepEqual((await f.getPosts(f.first, c.id)).find(p => p.id === String(seen.seq)).readBy, receipt);
});

test('legacy read positions, posting, and joining never manufacture receipts', async t => {
  const f = fixture(t);
  const c = f.channel(false);
  const p = f.first.post(c, 'owner', 'Old message');
  await f.route(f.first, 'member', 'POST', `/v1/conversations/${c.id}/read`, { seq: p.seq });
  await f.route(f.first, 'outsider', 'POST', `/v1/conversations/${c.id}/join`);
  f.first.post(c, 'member', 'Response');
  for (const post of await f.getPosts(f.first, c.id)) assert.deepEqual(post.readBy, []);
});

test('invalid or cross-conversation receipt batches fail atomically and nonmembers cannot read', async t => {
  const f = fixture(t);
  const c = f.channel(), other = f.channel();
  const p = f.first.post(c, 'owner', 'Visible');
  const foreign = f.first.post(other, 'owner', 'Different conversation');
  for (const messageIds of [[String(p.seq), String(foreign.seq)], ['bogus'], [p.seq], Array(101).fill(String(p.seq)), null, ['9007199254740992']]) {
    assert.equal((await f.route(f.first, 'member', 'POST', `/v1/conversations/${c.id}/read`, { messageIds })).status, 400);
  }
  assert.equal((await f.read(f.first, c.id, [p.seq], 'outsider')).status, 404);
  const publicChannel = f.channel(false);
  await f.route(f.first, 'outsider', 'POST', `/v1/conversations/${publicChannel.id}/leave`); // everyone starts in; outsider left
  const publicPost = f.first.post(publicChannel, 'owner', 'Public');
  assert.equal((await f.read(f.first, publicChannel.id, [publicPost.seq], 'outsider')).status, 403);
  assert.deepEqual((await f.getPosts(f.first, c.id)).find(m => m.id === String(p.seq)).readBy, []);
  assert.equal((await f.read(f.first, publicChannel.id, [publicPost.seq])).status, 200);
  assert.deepEqual((await f.getPosts(f.first, publicChannel.id, 'outsider')).find(m => m.id === String(publicPost.seq)).readBy, []);
});

test('deleted, pending, agent, and channel activity messages never get read receipts', async t => {
  const f = fixture(t);
  const c = f.channel();
  const deleted = f.first.post(c, 'owner', 'Deleted');
  const pending = f.first.post(c, 'owner', 'Pending', null, { pending: true });
  const agent = f.first.post(c, AGENT_ID, 'Agent reply');
  await f.route(f.first, 'owner', 'DELETE', `/v1/messages/${deleted.seq}`);
  const activity = (await f.getPosts(f.first, c.id)).find(p => p.activity);
  const ids = [deleted.seq, pending.seq, agent.seq, ...(activity ? [activity.id] : [])];
  const events = [];
  f.first.subscribe('owner', (event, data) => events.push({ event, data }));
  assert.equal((await f.read(f.first, c.id, ids)).status, 200);
  assert.equal(f.first.db.prepare('SELECT COUNT(*) AS n FROM message_reads').get().n, 0);
  assert.equal(events.some(e => e.event === 'messages.read'), false);
});

test('reading a thread does not mark later top-level posts read', async t => {
  const f = fixture(t);
  const c = f.channel();
  const root = f.first.post(c, 'owner', 'Root');
  const top = f.first.post(c, 'owner', 'Unseen top-level');
  const reply = f.first.post(c, 'owner', 'Thread reply', root.seq);
  const before = f.first.db.prepare('SELECT last_read_seq FROM members WHERE conversation_id = ? AND user_id = ?').get(c.id, 'member').last_read_seq;
  await f.read(f.first, c.id, [reply.seq]);
  const after = f.first.db.prepare('SELECT last_read_seq FROM members WHERE conversation_id = ? AND user_id = ?').get(c.id, 'member').last_read_seq;
  assert.equal(after, before);
  assert.deepEqual((await f.getPosts(f.first, c.id)).find(m => m.id === String(top.seq)).readBy, []);
});

test('receipts persist across API instances and replay obeys current message and membership access', async t => {
  const f = fixture(t, true);
  const c = f.channel();
  const p = f.first.post(c, 'owner', 'Read then deleted');
  const q = f.first.post(c, 'owner', 'Still here');
  const before = f.head(f.first);
  await f.read(f.first, c.id, [p.seq, q.seq]);
  const second = f.open();
  const posts = await f.getPosts(second, c.id);
  assert.equal(posts.find(m => m.id === String(p.seq)).readBy[0].userId, 'member');
  assert.equal((await f.replay(second, 'owner', before)).filter(e => e.event === 'messages.read').length, 1);
  assert.equal((await f.replay(second, 'outsider', before)).some(e => e.event === 'messages.read'), false);
  await f.route(second, 'owner', 'DELETE', `/v1/messages/${p.seq}`);
  const events = (await f.replay(second, 'owner', before)).filter(e => e.event === 'messages.read');
  assert.deepEqual(events[0].data.messageIds, [String(q.seq)]);
  await f.route(second, 'member', 'POST', `/v1/conversations/${c.id}/leave`);
  assert.equal((await f.replay(second, 'owner', before)).some(e => e.event === 'messages.read'), false);
  assert.equal((await f.replay(second, 'member', before)).some(e => e.event === 'messages.read'), false);
  assert.deepEqual((await f.getPosts(second, c.id)).find(m => m.id === String(q.seq)).readBy, []);
});

test('presence leases persist, combine multiple sessions, and expire without changing last seen', async t => {
  const f = fixture(t, true);
  let at = 1000000;
  t.mock.method(Date, 'now', () => at);
  const presence = (m, sessionId, active = true) => f.route(m, 'member', 'POST', '/v1/presence', { sessionId, active });
  const person = async m => (await f.route(m, 'owner', 'GET', '/v1/people')).data.people.find(p => p.id === 'member');
  assert.deepEqual(await person(f.first), { id: 'member', agentTier: 1, name: 'Member', lastSeenAt: null, online: false, owner: false });
  await presence(f.first, 'session-one');
  const second = f.open();
  assert.equal((await person(second)).online, true);
  at += 10000;
  await presence(second, 'session-two');
  at += 10000;
  await presence(f.first, 'session-one', false);
  assert.equal((await person(second)).online, true);
  const lastSeenAt = at;
  at += 50001;
  const expired = await person(second);
  assert.equal(expired.online, false);
  assert.equal(expired.lastSeenAt, lastSeenAt);
  const count = f.head(second);
  await person(f.first);
  assert.equal(f.head(second), count);
});

test('presence validation and authorization prevent invalid writes; replay resolves current state', async t => {
  const f = fixture(t);
  for (const body of [{ active: true }, { active: 'yes', sessionId: 'session-one' }, { active: false, sessionId: '../wrong' }]) {
    assert.equal((await f.route(f.first, 'member', 'POST', '/v1/presence', body)).status, 400);
  }
  const body = { active: true, sessionId: 'session-one' };
  assert.equal((await f.route(f.first, 'member', 'POST', '/v1/presence', body, { isAuthorized: () => false })).status, 401);
  assert.equal(f.first.db.prepare('SELECT COUNT(*) AS n FROM people_presence').get().n, 0);
  const before = f.head(f.first);
  await f.route(f.first, 'member', 'POST', '/v1/presence', body);
  await f.route(f.first, 'member', 'POST', '/v1/presence', { ...body, active: false });
  const events = (await f.replay(f.first, 'owner', before)).filter(e => e.event === 'presence.updated');
  assert.ok(events.length > 0);
  assert.ok(events.every(e => e.data.userId === 'member' && e.data.online === false && e.data.lastSeenAt > 0));
  delete f.people.member;
  assert.equal((await f.replay(f.first, 'owner', before)).some(e => e.event === 'presence.updated'), false);
});

test('receipt writes recheck device authorization and current membership after reading the body', async t => {
  const f = fixture(t, true);
  const c = f.channel();
  const p = f.first.post(c, 'owner', 'Visible');
  assert.equal((await f.route(f.first, 'member', 'POST', `/v1/conversations/${c.id}/read`, { messageIds: [String(p.seq)] }, { isAuthorized: () => false })).status, 401);
  const second = f.open();
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const body = new Promise(resolve => { release = () => resolve({ messageIds: [String(p.seq)] }); });
  const pending = f.route(f.first, 'member', 'POST', `/v1/conversations/${c.id}/read`, {}, { readBody: () => { enter(); return body; } });
  await entered;
  await f.route(second, 'member', 'POST', `/v1/conversations/${c.id}/leave`);
  const before = f.head(second);
  release();
  assert.equal((await pending).status, 404);
  assert.equal(f.head(second), before);
  assert.equal(second.db.prepare('SELECT COUNT(*) AS n FROM message_reads').get().n, 0);
});

test('read receipts and their durable events roll back together on publication failure', async t => {
  const f = fixture(t);
  const c = f.channel();
  const p = f.first.post(c, 'owner', 'Visible');
  const before = f.head(f.first);
  f.first.db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON live_events WHEN NEW.event = 'messages.read' BEGIN SELECT RAISE(ABORT, 'test receipt failure'); END");
  await assert.rejects(f.read(f.first, c.id, [p.seq]), /test receipt failure/);
  assert.equal(f.head(f.first), before);
  assert.equal(f.first.db.prepare('SELECT COUNT(*) AS n FROM message_reads').get().n, 0);
});
