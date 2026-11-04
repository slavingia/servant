import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMessaging } from './messaging.mjs';

const people = {
  owner: { id: 'owner', name: 'Owner', role: 'owner' },
  maya: { id: 'maya', name: 'Maya', role: 'member' },
  sam: { id: 'sam', name: 'Sam', role: 'member' },
};
const member = (m, conv, uid) => !!m.db.prepare('SELECT 1 FROM members WHERE conversation_id = ? AND user_id = ?').get(conv, uid);

test('everyone is in every public channel: existing, new, and for people who join later', () => {
  const roster = { owner: people.owner, maya: people.maya };
  const m = createMessaging({ file: ':memory:', users: () => roster, agentName: () => 'Agent' });
  try {
    // A channel made before this change with only its creator.
    const old = m.createChannel(people.owner, { name: 'design' });
    m.db.prepare("DELETE FROM members WHERE conversation_id = ? AND user_id = 'maya'").run(old.id);
    m.post(old, 'owner', 'Earlier history');
    const priv = m.createChannel(people.owner, { name: 'secret', private: true });
    assert.equal(member(m, priv.id, 'maya'), false, 'private channels stay invite-only');

    // Startup / sign-in backfill: Maya lands in #design, already read, with no "joined" note.
    m.joinDefaults('maya');
    assert.equal(member(m, old.id, 'maya'), true);
    assert.equal(member(m, priv.id, 'maya'), false);
    const unread = m.db.prepare("SELECT last_read_seq FROM members WHERE conversation_id = ? AND user_id = 'maya'").get(old.id).last_read_seq;
    assert.equal(unread, m.db.prepare('SELECT MAX(seq) AS s FROM messages WHERE conversation_id = ?').get(old.id).s, 'history starts read');
    assert.equal(m.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND activity IS NOT NULL AND user_id = 'maya'").get(old.id).n, 0);

    // A new public channel includes everyone right away.
    const fresh = m.createChannel(people.maya, { name: 'launch' });
    assert.equal(member(m, fresh.id, 'owner'), true);

    // Someone who joins the server later gets every public channel.
    roster.sam = people.sam;
    m.joinDefaults('sam');
    for (const c of [old, fresh]) assert.equal(member(m, c.id, 'sam'), true);
  } finally { m.close(); }
});

test('leaving a channel sticks until you join it again', () => {
  const m = createMessaging({ file: ':memory:', users: () => ({ owner: people.owner, maya: people.maya }), agentName: () => 'Agent' });
  try {
    const c = m.createChannel(people.owner, { name: 'random' });
    m.db.prepare("DELETE FROM members WHERE conversation_id = ? AND user_id = 'maya'").run(c.id);
    m.db.prepare("INSERT INTO channel_leaves VALUES (?, 'maya', 1)").run(c.id);
    m.joinDefaults('maya');
    assert.equal(member(m, c.id, 'maya'), false, 'a leave is respected on the next backfill');
  } finally { m.close(); }
});
