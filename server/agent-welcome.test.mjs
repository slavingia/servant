import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentDmKey, cleanSuggestions, createMessaging, WELCOME_SUGGESTIONS } from './messaging.mjs';

const people = { ann: { id: 'ann', name: 'Ann Lee', role: 'member' }, bo: { id: 'bo', name: 'Bo Kim', role: 'member' } };
const make = (extra = {}) => createMessaging({ file: ':memory:', users: () => people, agentName: () => 'Agent', askAgent: async () => 'Sure', ...extra });
const get = async (m, user, path) => {
  let result;
  await m.handle({}, {}, { user, method: 'GET', parts: path.split('/').filter(Boolean), url: new URL(path, 'http://test'), send: (_r, status, body) => { result = { status, body }; }, fail: (_r, status, code) => { result = { status, code }; } });
  return result;
};

test('a new person gets one unread message from the agent: a question with quick replies', async () => {
  const m = make();
  try {
    m.joinDefaults('ann');
    m.welcomeFromAgent('ann');
    const list = (await get(m, people.ann, '/v1/conversations')).body.conversations;
    const dm = list.find(c => c.agentDm);
    assert.ok(dm, 'the conversation is in their list');
    assert.equal(dm.title, 'Agent');
    assert.equal(dm.unread, 1, 'exactly one unread');
    assert.equal(dm.lastMessage.user.agent, true);
    assert.match(dm.lastMessage.text, /^Hi Ann, I'm Agent/);
    assert.match(dm.lastMessage.text, /\?$/, 'it asks a question');
    assert.deepEqual(dm.lastMessage.suggestions, WELCOME_SUGGESTIONS);
    // Opening it reads it.
    const messages = (await get(m, people.ann, `/v1/conversations/${dm.id}/messages`)).body.messages;
    assert.equal(messages.length, 1);
    assert.deepEqual(messages[0].suggestions, WELCOME_SUGGESTIONS);
  } finally { m.close(); }
});

test('it is private, one per person, and never repeated', async () => {
  const m = make();
  try {
    m.welcomeFromAgent('ann');
    m.welcomeFromAgent('ann');
    m.welcomeFromAgent('bo');
    const count = m.db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE dm_key LIKE 'agent:%'").get().n;
    assert.equal(count, 2);
    assert.equal(m.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE user_id = 'agent'").get().n, 2, 'one message each');
    const bosView = (await get(m, people.bo, '/v1/conversations')).body.conversations.filter(c => c.agentDm);
    assert.equal(bosView.length, 1);
    const anns = m.db.prepare("SELECT id FROM conversations WHERE dm_key = ?").get(agentDmKey('ann')).id;
    assert.equal((await get(m, people.bo, `/v1/conversations/${anns}`)).status, 404, "Bo can't open Ann's");
    assert.notEqual((await get(m, people.bo, `/v1/conversations/${anns}/messages`)).status, 200);
  } finally { m.close(); }
});

test('the agent answers every message in that conversation without an @mention, and sees its own question first', async () => {
  const seen = [];
  const m = make({ askAgent: async o => { seen.push(o); return 'Happy to help'; } });
  try {
    const conv = m.welcomeFromAgent('ann');
    const mine = m.post(conv, 'ann', 'Show me around');
    await m.agentReply(m.db.prepare('SELECT * FROM conversations WHERE id = ?').get(conv.id), mine);
    assert.equal(seen.length, 1);
    assert.match(seen[0].text, /Only this person reads your reply/);
    assert.match(seen[0].text, /You: Hi Ann, I'm Agent/, "the agent sees its own opening question");
    assert.match(seen[0].text, /Ann Lee: Show me around/);
    const replies = m.db.prepare("SELECT user_id, text, thread_root FROM messages WHERE user_id = 'agent' ORDER BY seq").all();
    assert.equal(replies.at(-1).text, 'Happy to help');
    assert.equal(replies.at(-1).thread_root, null, 'replies in line, not in a thread');
    // The second message is answered in the same running session.
    const again = m.post(conv, 'ann', 'And my week?');
    await m.agentReply(m.db.prepare('SELECT * FROM conversations WHERE id = ?').get(conv.id), again);
    assert.equal(seen[1].sessionId, seen[0].sessionId);
    assert.equal(seen[1].fresh, false);
    assert.doesNotMatch(seen[1].text, /Hi Ann, I'm Agent/, 'later turns do not resend the opening');
  } finally { m.close(); }
});

test('a worker queues a job for every message there, and not for ordinary DMs', () => {
  const m = make({ externalWorker: true });
  try {
    const conv = m.welcomeFromAgent('ann');
    m.post(conv, 'ann', 'hello');
    assert.equal(m.db.prepare('SELECT COUNT(*) AS n FROM agent_jobs').get().n, 1);
    const dm = m.openDm(people.ann, ['bo']);
    m.post(dm, 'ann', 'hello bo');
    assert.equal(m.db.prepare('SELECT COUNT(*) AS n FROM agent_jobs').get().n, 1, 'a DM between people still needs @s');
  } finally { m.close(); }
});

test('quick replies are tidied: trimmed, short, at most four', () => {
  assert.deepEqual(cleanSuggestions(['  Show   me  around ', '', null, 'x'.repeat(100), 'a', 'b', 'c']).map(s => s.length), [14, 60, 1, 1]);
  assert.deepEqual(cleanSuggestions('nope'), []);
});

test('the welcome survives a restart and stays one', () => {
  const m = make();
  try {
    m.welcomeFromAgent('ann');
    const before = m.db.prepare("SELECT suggestions FROM messages WHERE user_id = 'agent'").get().suggestions;
    assert.deepEqual(JSON.parse(before), WELCOME_SUGGESTIONS);
    m.welcomeFromAgent('ann');
    assert.equal(m.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE user_id = 'agent'").get().n, 1);
  } finally { m.close(); }
});
