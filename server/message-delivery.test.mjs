import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createMessaging, AGENT_ID } from './messaging.mjs';

const attachment = { name: 'answer.txt', mime: 'text/plain', data: Buffer.from('Completed attachment') };

function fixture(t, askAgent) {
  const people = { owner: { id: 'owner', name: 'Owner', role: 'owner' }, member: { id: 'member', name: 'Member' } };
  const messaging = createMessaging({ file: ':memory:', users: () => people, agentName: () => 'Agent', askAgent });
  t.after(() => messaging.close());
  const channel = messaging.createChannel(people.owner, { name: 'delivery', memberIds: ['member'] });
  const route = async path => {
    let response;
    await messaging.handle({}, { setHeader() {} }, {
      user: people.member, method: 'GET', parts: path.split('?')[0].split('/').filter(Boolean), url: new URL(path, 'http://local'),
      send: (_res, status, data) => { response = { status, data }; },
      fail: (_res, status, code) => { response = { status, code }; },
    });
    return response;
  };
  const replay = async () => {
    const res = new EventEmitter(), blocks = [];
    res.writeHead = () => {};
    res.write = block => { blocks.push(block); return true; };
    res.end = () => res.emit('close');
    await messaging.handle({}, res, {
      user: people.member, method: 'POST', parts: ['v1', 'events'], url: new URL('http://local/v1/events?after=0'), cors: {},
      send: () => assert.fail('Unexpected response'), fail: () => assert.fail('Unexpected error'),
    });
    res.emit('close');
    return blocks.filter(block => block.includes('event:')).map(block => ({
      event: block.match(/event: (.+)\n/)[1], data: JSON.parse(block.match(/data: (.+)\n/)[1]),
    }));
  };
  return { messaging, people, channel, route, replay };
}

test('shared replies keep durable drafts private and deliver the complete answer once', async t => {
  let finish, delta;
  const f = fixture(t, ({ onDelta }) => {
    delta = onDelta;
    onDelta('Unfinished draft');
    return new Promise(resolve => { finish = resolve; });
  });
  const root = f.messaging.post(f.channel, 'owner', '@agent answer');
  const events = [];
  f.messaging.subscribe('member', (event, data) => events.push({ event, data }));
  const running = f.messaging.agentReply(f.channel, root);
  const pending = f.messaging.db.prepare('SELECT * FROM messages WHERE pending = 1').get();
  try {
    assert.equal(pending.text, 'Unfinished draft', 'partial output is checkpointed for worker recovery');
    const created = events.find(e => e.event === 'message.created' && e.data.id === String(pending.seq));
    assert.equal(created.data.pending, true);
    assert.equal(created.data.text, '');
    assert.deepEqual(created.data.attachments, []);
    const before = f.messaging.db.prepare('SELECT MAX(id) AS id FROM live_events').get().id;
    delta(' with more words');
    assert.equal(f.messaging.db.prepare('SELECT MAX(id) AS id FROM live_events').get().id, before, 'deltas do not create live events');

    const thread = await f.route(`/v1/conversations/${f.channel.id}/threads/${root.seq}`);
    assert.equal(thread.data.replies[0].pending, true);
    assert.equal(thread.data.replies[0].text, '');
    assert.deepEqual(thread.data.replies[0].attachments, []);
    assert.deepEqual((await f.route('/v1/search?q=Unfinished')).data.messages, []);
    assert.equal(f.messaging.notificationFor(pending.seq, f.people.member), null);
    const replayed = (await f.replay()).filter(e => e.event.startsWith('message.') && e.data.id === String(pending.seq));
    assert.ok(replayed.length);
    assert.ok(replayed.every(e => e.data.pending && !e.data.text && !e.data.attachments.length));
    assert.equal(events.filter(e => e.event === 'message.updated' && e.data.id === String(pending.seq)).length, 0);

    finish({ text: 'Completed answer', attachments: [attachment] });
    await running;
    const completed = events.filter(e => e.event === 'message.updated' && e.data.id === String(pending.seq));
    assert.equal(completed.length, 1);
    assert.equal(completed[0].data.pending, false);
    assert.equal(completed[0].data.text, 'Completed answer');
    assert.equal(completed[0].data.attachments.length, 1);
    assert.equal((await f.route(`/v1/conversations/${f.channel.id}/threads/${root.seq}`)).data.replies[0].text, 'Completed answer');
    assert.equal((await f.route(`/v1/conversations/${f.channel.id}/media`)).data.items.length, 1);
    assert.equal(f.messaging.notificationFor(pending.seq, f.people.member).body, 'Completed answer');
  } finally {
    finish('Test cleanup');
    await running;
  }
});

test('pending content is absent from snapshots, previews, media, and attachment downloads', async t => {
  const f = fixture(t, async () => 'Unused');
  const pending = f.messaging.post(f.channel, AGENT_ID, 'Unfinished draft', null, { pending: true, attachments: [attachment] });
  const file = f.messaging.db.prepare('SELECT id FROM attachments WHERE message_seq = ?').get(pending.seq);
  const posts = (await f.route(`/v1/conversations/${f.channel.id}/messages`)).data.messages;
  const post = posts.find(p => p.id === String(pending.seq));
  assert.equal(post.text, '');
  assert.deepEqual(post.attachments, []);
  const conversations = (await f.route('/v1/conversations')).data.conversations;
  const preview = conversations.find(c => c.id === f.channel.id).lastMessage;
  assert.equal(preview.pending, true);
  assert.equal(preview.text, '');
  assert.deepEqual(preview.attachments, []);
  assert.deepEqual((await f.route(`/v1/conversations/${f.channel.id}/media`)).data.items, []);
  assert.equal((await f.route(`/v1/attachments/${file.id}`)).status, 404);
  assert.deepEqual((await f.route('/v1/search?q=Unfinished')).data.messages, []);
});
