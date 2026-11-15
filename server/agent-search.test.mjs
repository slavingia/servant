// The agent looks up earlier messages (owner's decision, 11/15): it asks with a hidden line, Servant searches as
// the person who asked, and the answer is written from what came back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMessaging, SEARCH_TAG } from './messaging.mjs';

const people = { pat: { id: 'pat', name: 'Pat Tester', role: 'owner' }, jo: { id: 'jo', name: 'Jo Park', role: 'member' }, ana: { id: 'ana', name: 'Ana Ruiz', role: 'member' } };
function setup(answers) {
  const asked = [];
  const m = createMessaging({ file: ':memory:', users: () => people, agentName: () => 'Agent',
    askAgent: async o => { asked.push(o.text); const next = answers.shift(); o.onDelta?.(next); return next; } });
  const conv = id => m.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
  const replies = () => m.db.prepare("SELECT text FROM messages WHERE user_id = 'agent' AND activity IS NULL ORDER BY seq").all().map(r => r.text);
  return { m, asked, conv, replies };
}

test('the hidden line is a whole reply with a short query, and nothing else', () => {
  assert.equal(SEARCH_TAG.exec('<servant-search>budget review from:@Jo-Park</servant-search>')[1], 'budget review from:@Jo-Park');
  assert.equal(SEARCH_TAG.exec('  <servant-search>permits</servant-search>\n')[1], 'permits');
  for (const text of ['I will search <servant-search>x</servant-search>', '<servant-search></servant-search>', '<servant-search>' + 'x'.repeat(201) + '</servant-search>', '<servant-search>a<b></servant-search>']) assert.equal(SEARCH_TAG.exec(text), null);
});

test('asked in a channel, the agent searches that channel and public ones, never a private channel others are not in', async () => {
  const { m, asked, conv, replies } = setup(['<servant-search>budget review</servant-search>', 'The review moved to Tuesday.']);
  try {
    const open = m.createChannel(people.pat, { name: 'finance' });
    const other = m.createChannel(people.pat, { name: 'planning' });
    const secret = m.createChannel(people.pat, { name: 'leadership', private: true, memberIds: ['jo'] });
    m.post(other, 'jo', 'Budget review moved to Tuesday');
    m.post(secret, 'jo', 'Budget review: the cuts nobody outside this room may hear about');
    m.post(open, 'ana', 'Budget review slides are ready');
    const mention = m.post(open, 'pat', '@agent when is the budget review?');
    await m.agentReply(conv(open.id), mention);
    assert.equal(asked.length, 2);
    assert.match(asked[0], /reply with exactly <servant-search>a few words<\/servant-search>/, 'the agent is told how to search');
    assert.match(asked[1], /^\[Search results, newest first\. Now answer the latest message; don't search again\.\]/);
    assert.match(asked[1], /Ana Ruiz in #finance, \d{4}-\d\d-\d\d: Budget review slides are ready/);
    assert.match(asked[1], /Jo Park in #planning, \d{4}-\d\d-\d\d: Budget review moved to Tuesday/);
    assert.doesNotMatch(asked[1], /leadership|cuts nobody/, 'Pat is in the private channel, but this answer is read by people who are not');
    assert.deepEqual(replies(), ['The review moved to Tuesday.'], 'the search request itself is never shown');
  } finally { m.close(); }
});

test('asked in a person\'s own chat with the agent, it searches everything that person can read, and only that', async () => {
  const { m, asked, conv } = setup(['<servant-search>budget review</servant-search>', 'Here is what I found.']);
  try {
    const secret = m.createChannel(people.pat, { name: 'leadership', private: true, memberIds: ['jo'] });
    const theirs = m.createChannel(people.ana, { name: 'ana-only', private: true });
    m.post(secret, 'jo', 'Budget review: the leadership numbers');
    m.post(theirs, 'ana', 'Budget review notes Pat cannot read');
    const chat = m.welcomeFromAgent('pat');
    const question = m.post(chat, 'pat', 'What did leadership say about the budget review?');
    await m.agentReply(conv(chat.id), question);
    assert.match(asked[1], /Jo Park in #leadership, \d{4}-\d\d-\d\d: Budget review: the leadership numbers/, 'only Pat reads this answer');
    assert.doesNotMatch(asked[1], /ana-only|Pat cannot read/, 'a channel Pat is not in is never searched');
  } finally { m.close(); }
});

test('it searches once: nothing found is said plainly, a second request is dropped, and long messages are cut', async () => {
  const none = setup(['<servant-search>zzzunknownword</servant-search>', 'I could not find that.']);
  try {
    const c = none.m.createChannel(people.pat, { name: 'general-two' });
    await none.m.agentReply(none.conv(c.id), none.m.post(c, 'pat', '@agent find it'));
    assert.match(none.asked[1], /^\[Search results: nothing matched\./);
    assert.deepEqual(none.replies(), ['I could not find that.']);
  } finally { none.m.close(); }
  const twice = setup(['<servant-search>report</servant-search>', '<servant-search>report again</servant-search>']);
  try {
    const c = twice.m.createChannel(people.pat, { name: 'general-three' });
    twice.m.post(c, 'jo', 'Report: ' + 'x'.repeat(900));
    await twice.m.agentReply(twice.conv(c.id), twice.m.post(c, 'pat', '@agent the report?'));
    assert.equal(twice.asked.length, 2, 'no third round');
    assert.ok(twice.asked[1].length < 800 && twice.asked[1].includes('…'), 'a long message is cut');
    assert.equal(twice.replies().some(text => text.includes('servant-search')), false, 'a search request is never posted');
  } finally { twice.m.close(); }
});
