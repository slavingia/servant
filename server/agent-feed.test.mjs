import { test } from 'node:test';
import assert from 'node:assert/strict';
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
    assert.ok(!pushed.some(e => e.messageId === first.messageId || e.messageId === again.messageId), 'no push for feed posts');
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
