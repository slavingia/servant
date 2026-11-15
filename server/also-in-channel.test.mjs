// "Also send to #channel": a thread reply its author also sends to the conversation. It stays a reply in its
// thread, and the conversation shows it too, saying which message it answers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createMessaging } from './messaging.mjs';

const people = { pat: { id: 'pat', name: 'Pat Tester', role: 'owner' }, jo: { id: 'jo', name: 'Jo Park', role: 'member' }, ana: { id: 'ana', name: 'Ana Ruiz', role: 'member' } };
function chat(file = ':memory:') {
  const m = createMessaging({ file, users: () => people, agentName: () => 'Agent', askAgent: async () => 'ok' });
  const route = async (userId, method, url, body = {}) => {
    let response;
    await m.handle({}, {}, { user: people[userId], method, parts: url.split('?')[0].split('/').filter(Boolean), url: new URL(url, 'http://local'), cors: {}, readBody: async () => body,
      send: (_r, status, data) => { response = { status, data }; }, fail: (_r, status, code) => { response = { status, code }; } });
    return response;
  };
  const shown = async (who, id) => (await route(who, 'GET', `/v1/conversations/${id}/messages`)).data.messages;
  const unread = async (who, id) => (await route(who, 'GET', '/v1/conversations')).data.conversations.find(c => c.id === id).unread;
  return { m, route, shown, unread };
}

test('a reply also sent to the channel is in the thread and in the channel, and says what it answers', async () => {
  const { m, route, shown, unread } = chat();
  try {
    const c = m.createChannel(people.pat, { name: 'permits', memberIds: ['jo', 'ana'] });
    const question = m.post(c, 'pat', 'Is the intake form\n  ready for Monday?');
    await route('ana', 'POST', `/v1/conversations/${c.id}/read`);
    const quiet = await route('jo', 'POST', `/v1/conversations/${c.id}/messages`, { text: 'Checking now', threadRoot: String(question.seq) });
    assert.equal(quiet.status, 201);
    assert.equal(quiet.data.message.alsoInChannel, undefined);
    assert.equal(await unread('ana', c.id), 0, 'an ordinary reply stays in its thread');
    const loud = await route('jo', 'POST', `/v1/conversations/${c.id}/messages`, { text: 'Yes, it went live this morning', threadRoot: String(question.seq), alsoInChannel: true });
    assert.equal(loud.status, 201);
    assert.equal(loud.data.message.alsoInChannel, true);
    assert.equal(loud.data.message.threadRoot, String(question.seq));
    assert.deepEqual(loud.data.message.replyTo, { user: 'Pat Tester', text: 'Is the intake form ready for Monday?' });

    const inChannel = (await shown('ana', c.id)).filter(p => !p.activity).map(p => p.text);
    assert.deepEqual(inChannel, ['Is the intake form\n  ready for Monday?', 'Yes, it went live this morning'], 'the channel shows it; the ordinary reply is not there');
    const thread = (await route('ana', 'GET', `/v1/conversations/${c.id}/threads/${question.seq}`)).data;
    assert.deepEqual(thread.replies.map(p => p.text), ['Checking now', 'Yes, it went live this morning'], 'and it is still one reply in the thread');
    assert.equal(thread.root.replyCount, 2);

    // It counts as unread in the channel, and reading the channel reads it.
    assert.equal(await unread('ana', c.id), 1);
    assert.equal(await unread('jo', c.id), 0, 'not for the person who sent it');
    await route('ana', 'POST', `/v1/conversations/${c.id}/read`, { messageIds: [loud.data.message.id] });
    assert.equal(await unread('ana', c.id), 0);
  } finally { m.close(); }
});

test('only a thread reply can be also sent; a deleted first message leaves no words behind', async () => {
  const { m, route, shown } = chat();
  try {
    const c = m.createChannel(people.pat, { name: 'permits', memberIds: ['jo'] });
    const plain = await route('jo', 'POST', `/v1/conversations/${c.id}/messages`, { text: 'A message of its own', alsoInChannel: true });
    assert.equal(plain.data.message.alsoInChannel, undefined, 'without a thread there is nothing to also send');
    assert.equal(m.db.prepare('SELECT in_channel FROM messages WHERE seq = ?').get(Number(plain.data.message.id)).in_channel, 0);

    const long = m.post(c, 'pat', 'word '.repeat(60));
    const reply = await route('jo', 'POST', `/v1/conversations/${c.id}/messages`, { text: 'Agreed', threadRoot: String(long.seq), alsoInChannel: true });
    assert.equal(reply.data.message.replyTo.text.length, 120, 'a long first message is cut');
    assert.ok(reply.data.message.replyTo.text.endsWith('…'));
    assert.equal((await route('pat', 'DELETE', `/v1/messages/${long.seq}`)).status, 200);
    const after = (await shown('jo', c.id)).find(p => p.id === reply.data.message.id);
    assert.deepEqual(after.replyTo, { user: 'Pat Tester', text: '' });
  } finally { m.close(); }
});

test('a database from before this gains the column, and its replies stay in their threads', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-also-'));
  const file = path.join(dir, 'messages.db');
  try {
    let { m } = chat(file);
    const c = m.createChannel(people.pat, { name: 'permits', memberIds: ['jo'] });
    const first = m.post(c, 'pat', 'First');
    m.post(c, 'jo', 'A reply', first.seq);
    m.close();
    const db = new DatabaseSync(file);
    db.exec('ALTER TABLE messages DROP COLUMN in_channel');
    db.close();
    const again = chat(file);
    try {
      assert.deepEqual((await again.shown('pat', c.id)).filter(p => !p.activity).map(p => p.text), ['First']);
      const sent = await again.route('jo', 'POST', `/v1/conversations/${c.id}/messages`, { text: 'Also here', threadRoot: String(first.seq), alsoInChannel: true });
      assert.equal(sent.data.message.alsoInChannel, true);
    } finally { again.m.close(); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
