import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activeMention, agentMentionNames, AGENT_HANDLES, insertMention, matchesAgentHandle, mentionMatches } from './mentions.ts';

test('finds the mention at the cursor, ignoring email, completed words and selected text', () => {
  const at = (text: string, cursor = text.length) => activeMention(text, { start: cursor, end: cursor });
  assert.deepEqual(at('@'), { start: 0, end: 1, query: '' });
  assert.deepEqual(at('Hi @Jo'), { start: 3, end: 6, query: 'Jo' });
  assert.deepEqual(at('Hi @Jordan, thanks', 6), { start: 3, end: 10, query: 'Jo' });
  assert.equal(at('person@example.com'), null);
  assert.equal(at('@Jordan thanks'), null);
  assert.equal(activeMention('@Jordan', { start: 1, end: 3 }), null);
  assert.equal(at('@@Jordan'), null);
});

test('matches only supplied conversation members, excluding self and agent, with Unicode names', () => {
  const people = [{ id: 'me', name: 'Alex' }, { id: 'j', name: 'Jordan Lee' }, { id: 'z', name: 'Zoë Martin' }, { id: 'a', name: 'Agent', agent: true }];
  assert.deepEqual(mentionMatches(people, 'me', '').map(p => p.id), ['j', 'z']);
  assert.deepEqual(mentionMatches(people, 'me', 'LEE').map(p => p.id), ['j']);
  assert.deepEqual(mentionMatches(people, 'me', 'zoe').map(p => p.id), ['z']);
  assert.deepEqual(mentionMatches(people, 'me', 'Jordan-L').map(p => p.id), ['j']);
  assert.deepEqual(mentionMatches(people, 'me', 'outsider'), []);
});

test('replaces only the active mention, keeping surrounding draft and positioning the cursor', () => {
  const text = 'Ask @Jo and @Sam later';
  const match = activeMention(text, { start: 7, end: 7 })!;
  assert.deepEqual(insertMention(text, match, 'Jordan Lee'), { text: 'Ask @Jordan-Lee and @Sam later', cursor: 16 });
  const middle = 'Hi @Jordan, thanks';
  assert.equal(insertMention(middle, activeMention(middle, { start: 6, end: 6 })!, 'Zoë Martin').text, 'Hi @Zoë-Martin, thanks');
});

test('offers the agent as @s first when the conversation can reach it', () => {
  const people = [{ id: 'me', name: 'Alex' }, { id: 'g', name: 'Agnes Park' }];
  assert.deepEqual(mentionMatches(people, 'me', '', true).map(p => p.id), ['agent', 'g']);
  assert.deepEqual(mentionMatches(people, 'me', 'ag', true).map(p => p.id), ['agent', 'g']);
  assert.deepEqual(mentionMatches(people, 'me', 'AGE', true).map(p => p.id), ['agent']);
  assert.deepEqual(mentionMatches(people, 'me', 'agn', true).map(p => p.id), ['g']);
  assert.deepEqual(mentionMatches(people, 'me', 'ag').map(p => p.id), ['g']);
  const match = { start: 0, end: 3, query: 'ag' };
  assert.deepEqual(insertMention('@ag', match, 'agent'), { text: '@agent ', cursor: 7 });
  assert.deepEqual(mentionMatches(people, 'me', 's', true).map(p => p.id), ['agent', 'g']);
  assert.equal(mentionMatches(people, 'me', 'ag', true)[0]!.name, 's');
  assert.deepEqual(insertMention('@ag', match, mentionMatches(people, 'me', 'ag', true)[0]!.name), { text: '@s ', cursor: 3 });
});

test('@agent, @s and @servant all reach the agent, and all of them bring up its special row', () => {
  const people = [{ id: 'me', name: 'Alex' }, { id: 'g', name: 'Agnes Park' }, { id: 'v', name: 'Servando Ruiz' }];
  assert.deepEqual([...AGENT_HANDLES], ['s', 'agent', 'servant']);
  assert.deepEqual(agentMentionNames(), ['@s', '@agent', '@servant']);
  // Typing any start of any of the three offers the agent first, ahead of people who happen to match.
  for (const typed of ['', 's', 'S', 'a', 'ag', 'agen', 'agent', 'se', 'ser', 'serv', 'servant', 'SERVANT']) {
    assert.equal(mentionMatches(people, 'me', typed, true)[0]!.id, 'agent', `"${typed}" offers the agent first`);
    assert.equal(matchesAgentHandle(typed), true, typed);
  }
  // Past the end of a handle, or something else entirely, it is just people.
  for (const typed of ['servants', 'agents', 'sx', 'z', 'servan7']) {
    assert.equal(matchesAgentHandle(typed), false, typed);
    assert.ok(!mentionMatches(people, 'me', typed, true).some(p => p.id === 'agent'), typed);
  }
  // A person whose name matches still shows, after the agent row.
  assert.deepEqual(mentionMatches(people, 'me', 'serv', true).map(p => p.id), ['agent', 'v']);
  // Where the agent can't be reached (a DM between two people) the row never appears.
  for (const typed of ['s', 'agent', 'servant']) assert.ok(!mentionMatches(people, 'me', typed, false).some(p => p.id === 'agent'));
  // Picking the row writes the short handle.
  const match = activeMention('hey @serv', { start: 9, end: 9 })!;
  assert.deepEqual(insertMention('hey @serv', match, mentionMatches(people, 'me', 'serv', true)[0]!.name), { text: 'hey @s ', cursor: 7 });
});
