import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMessaging, FEED_CHANNEL } from './messaging.mjs';

const people = { ann: { id: 'ann', name: 'Ann Lee', role: 'owner' }, bo: { id: 'bo', name: 'Bo Kim', role: 'member' } };

test('the agent posts its activity in one public #agent-feed everyone can read, without pushing', () => {
  const pushed = [];
  const m = createMessaging({ file: ':memory:', users: () => people, agentName: () => 'Agent', onMessage: e => pushed.push(e) });
  try {
    const first = m.feedFromAgent('  Shipped: abc1234 Fix the header  ');
    const again = m.feedFromAgent('Ran: analytics');
    assert.equal(again.conversationId, first.conversationId, 'one channel, reused');
    const conv = m.db.prepare('SELECT * FROM conversations WHERE id = ?').get(first.conversationId);
    assert.equal(conv.kind, 'channel');
    assert.equal(conv.name, FEED_CHANNEL);
    assert.equal(conv.private, 0, 'public');
    const members = m.db.prepare('SELECT user_id FROM members WHERE conversation_id = ?').all(conv.id).map(r => r.user_id).sort();
    assert.deepEqual(members, ['ann', 'bo'], 'everyone can read it');
    const rows = m.db.prepare("SELECT * FROM messages WHERE conversation_id = ? AND user_id = 'agent' ORDER BY seq").all(conv.id);
    assert.deepEqual(rows.map(r => r.text), ['Shipped: abc1234 Fix the header', 'Ran: analytics']);
    assert.ok(rows.every(r => r.user_id === 'agent'), 'posted by the agent');
    assert.equal(pushed.length, 0, 'no push for feed posts');
    assert.ok(rows.every(r => r.activity === 'feed'), 'silent activity lines');
    const unread = m.db.prepare("SELECT COUNT(*) AS n FROM messages x JOIN members b ON b.conversation_id = x.conversation_id WHERE x.conversation_id = ? AND x.seq > b.last_read_seq AND x.user_id != b.user_id AND x.activity IS NULL").get(conv.id).n;
    assert.equal(unread, 0, 'adds nothing to anyone\'s unread count');
    assert.throws(() => m.feedFromAgent('   '), /Write the message/);
  } finally { m.close(); }
});

test('an existing #agent-feed channel is reused, not duplicated', () => {
  const m = createMessaging({ file: ':memory:', users: () => people, agentName: () => 'Agent' });
  try {
    const made = m.createChannel(people.ann, { name: FEED_CHANNEL, topic: 'mine' });
    assert.equal(m.feedFromAgent('hello').conversationId, made.id);
  } finally { m.close(); }
});

test('the Feed screen gets one item per line the agent posted, newest first, with links pulled out', () => {
  const m = createMessaging({ file: ':memory:', users: () => people, agentName: () => 'Agent' });
  try {
    m.feedFromAgent('Sent\n- 1:54pm · Messaged Bo Kim\n\nShipped\n- 3:01pm · Servant: Fix it (https://github.com/x/y/commit/abc)');
    m.feedFromAgent('Feed is live');
    const { items } = m.feedItems();
    assert.deepEqual(items.map(i => [i.kind, i.text, i.time, i.url]), [
      ['note', 'Feed is live', null, null],
      ['shipped', 'Servant: Fix it', '3:01pm', 'https://github.com/x/y/commit/abc'],
      ['sent', 'Messaged Bo Kim', '1:54pm', null],
    ]);
  } finally { m.close(); }
});

test('no #agent-feed yet means an empty feed', () => {
  const m = createMessaging({ file: ':memory:', users: () => people, agentName: () => 'Agent' });
  try { assert.deepEqual(m.feedItems().items, []); } finally { m.close(); }
});

test('feed posts made before they went silent stop counting as unread', () => {
  const file = path.join(os.tmpdir(), `agent-feed-${process.pid}.db`);
  let m = createMessaging({ file, users: () => people, agentName: () => 'Agent' });
  try {
    const { conversationId } = m.feedFromAgent('new');
    m.db.prepare("UPDATE messages SET activity = NULL WHERE conversation_id = ? AND user_id = 'agent'").run(conversationId);
  } finally { m.close(); }
  m = createMessaging({ file, users: () => people, agentName: () => 'Agent' });
  try {
    assert.deepEqual(m.db.prepare("SELECT activity FROM messages WHERE user_id = 'agent'").all().map(r => r.activity), ['feed']);
  } finally { m.close(); for (const x of ['', '-wal', '-shm']) fs.rmSync(file + x, { force: true }); }
});
