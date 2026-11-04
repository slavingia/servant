import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMessaging, splitWorkChat } from './messaging.mjs';

const people = { ann: { id: 'ann', name: 'Ann Lee', role: 'owner' }, bo: { id: 'bo', name: 'Bo Kim', role: 'member' } };
const reply = (m, seq) => m.db.prepare("SELECT text FROM messages WHERE user_id = 'agent' AND thread_root = ? ORDER BY seq DESC").get(seq)?.text;

test('splitWorkChat finds only a trailing tag', () => {
  assert.deepEqual(splitWorkChat("On it.\n<servant-chat>Update the refund script</servant-chat>"), { text: 'On it.', title: 'Update the refund script' });
  assert.equal(splitWorkChat('Answer with <servant-chat>x</servant-chat> in the middle and more').title, null);
  assert.equal(splitWorkChat('Plain answer').title, null);
});

test('@s doing real work opens a shared agent chat and links it in the thread; quick answers stay in the thread', async () => {
  const opened = [];
  let answer = "I'll take this to a shared chat.\n<servant-chat>Update the refund script</servant-chat>";
  const seen = [];
  const m = createMessaging({
    file: ':memory:', users: () => people, agentName: () => 'Agent',
    askAgent: async o => { seen.push(o.text); return answer; },
    startWorkChat: async o => { opened.push(o); return { id: 'cht_work1', title: o.title }; },
  });
  try {
    const desk = m.createChannel(people.ann, { name: 'refund-desk' });
    const ask = m.post(desk, 'ann', '@s please update the refund script with the EITC hold');
    await m.agentReply(desk, ask);
    assert.match(seen[0], /<servant-chat>/, 'the agent is told how to hand off work');
    assert.equal(opened.length, 1);
    assert.equal(opened[0].userId, 'ann');
    assert.equal(opened[0].title, 'Update the refund script');
    assert.match(opened[0].where, /#refund-desk/);
    assert.match(opened[0].transcript, /update the refund script/);
    const text = reply(m, ask.seq);
    assert.match(text, /\[Update the refund script\]\(\/chat\/cht_work1\)/, 'thread links the new chat');
    assert.doesNotMatch(text, /servant-chat/, 'the tag never shows');

    answer = 'The hold lifts mid-February.';
    const quick = m.post(desk, 'bo', '@s when does the EITC hold lift?');
    await m.agentReply(desk, quick);
    assert.equal(opened.length, 1, 'no chat for a quick answer');
    assert.equal(reply(m, quick.seq), 'The hold lifts mid-February.');
  } finally { m.close(); }
});

test('if opening the chat fails, the thread says so instead of going quiet', async () => {
  const m = createMessaging({
    file: ':memory:', users: () => people, agentName: () => 'Agent',
    askAgent: async () => 'On it.\n<servant-chat>Big job</servant-chat>',
    startWorkChat: async () => { throw new Error('agent 502'); },
  });
  try {
    const desk = m.createChannel(people.ann, { name: 'desk' });
    const ask = m.post(desk, 'ann', '@s do the big job');
    await m.agentReply(desk, ask);
    assert.match(reply(m, ask.seq), /couldn't open a shared chat for this \(agent 502\)/);
  } finally { m.close(); }
});
