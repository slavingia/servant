import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMessaging } from './messaging.mjs';

const people = { ann: { id: 'ann', name: 'Ann Lee', role: 'owner' }, bo: { id: 'bo', name: 'Bo Kim', role: 'member' } };

test('a script on this Mac notifies someone: the agent posts in their agent conversation and it pushes', async () => {
  const pushed = [];
  const asked = [];
  const m = createMessaging({ file: ':memory:', users: () => people, agentName: () => 'Agent', askAgent: async (...a) => { asked.push(a); return 'Sure'; }, onMessage: e => pushed.push(e) });
  try {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4480000000049454e44ae426082', 'hex');
    const first = m.notifyFromAgent('ann', '  Analytics: 3,212 installs  ', { attachments: [{ name: 'chart.png', mime: 'image/png', data: png }] });
    const again = m.notifyFromAgent('ann', 'GitHub: two new issues');
    assert.equal(again.conversationId, first.conversationId, 'one conversation, reused');
    const conv = m.db.prepare('SELECT * FROM conversations WHERE id = ?').get(first.conversationId);
    assert.equal(conv.dm_key, 'agent:ann');
    const rows = m.db.prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq').all(first.conversationId);
    const notes = rows.filter(r => r.text.startsWith('Analytics') || r.text.startsWith('GitHub'));
    assert.deepEqual(notes.map(r => r.text), ['Analytics: 3,212 installs', 'GitHub: two new issues']);
    assert.ok(notes.every(r => r.user_id !== 'ann'), 'posted by the agent, not by Ann, so Ann is notified');
    assert.equal(m.db.prepare('SELECT COUNT(*) n FROM attachments WHERE message_seq = ?').get(notes[0].seq).n, 1);
    const ids = pushed.map(e => e.messageId);
    assert.ok(ids.includes(first.messageId) && ids.includes(again.messageId), 'both go through the push path');
    assert.ok(m.notificationFor(Number(first.messageId), people.ann), 'Ann gets a notification');
    await new Promise(r => setTimeout(r, 20));
    assert.equal(asked.length, 0, 'the agent does not answer its own notice');
    assert.throws(() => m.notifyFromAgent('ann', '   '), /Write the message/);
    assert.throws(() => m.notifyFromAgent('nobody', 'hi'), /No such person/);
  } finally { m.close(); }
});
