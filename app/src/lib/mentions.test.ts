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

test('offers the agent as @agent first when the conversation can reach it', () => {
  const people = [{ id: 'me', name: 'Alex' }, { id: 'g', name: 'Agnes Park' }];
  assert.deepEqual(mentionMatches(people, 'me', '', true).map(p => p.id), ['agent', 'g']);
  assert.deepEqual(mentionMatches(people, 'me', 'ag', true).map(p => p.id), ['agent', 'g']);
  assert.deepEqual(mentionMatches(people, 'me', 'AGE', true).map(p => p.id), ['agent']);
  assert.deepEqual(mentionMatches(people, 'me', 'agn', true).map(p => p.id), ['g']);
  assert.deepEqual(mentionMatches(people, 'me', 'ag').map(p => p.id), ['g']);
  const match = { start: 0, end: 3, query: 'ag' };
  assert.deepEqual(insertMention('@ag', match, 'agent'), { text: '@agent ', cursor: 7 });
  assert.deepEqual(mentionMatches(people, 'me', 's', true).map(p => p.id), ['g'], 'the old short form offers no agent row');
  assert.equal(mentionMatches(people, 'me', 'ag', true)[0]!.name, 'agent');
  assert.deepEqual(insertMention('@ag', match, mentionMatches(people, 'me', 'ag', true)[0]!.name), { text: '@agent ', cursor: 7 });
});

test('@agent is the only name that reaches the agent, and typing toward it brings up its special row', () => {
  const people = [{ id: 'me', name: 'Alex' }, { id: 'g', name: 'Agnes Park' }, { id: 'v', name: 'Servando Ruiz' }];
  assert.deepEqual([...AGENT_HANDLES], ['agent']);
  assert.deepEqual(agentMentionNames(), ['@agent']);
  for (const typed of ['', 'a', 'A', 'ag', 'agen', 'agent', 'AGENT']) {
    assert.equal(mentionMatches(people, 'me', typed, true)[0]!.id, 'agent', `"${typed}" offers the agent first`);
    assert.equal(matchesAgentHandle(typed), true, typed);
  }
  // The names it used to answer to, past the end of the name, or something else entirely: just people.
  for (const typed of ['s', 'se', 'serv', 'servant', 'agents', 'agentx', 'z']) {
    assert.equal(matchesAgentHandle(typed), false, typed);
    assert.ok(!mentionMatches(people, 'me', typed, true).some(p => p.id === 'agent'), typed);
  }
  // A person whose name matches still shows, after the agent row.
  assert.deepEqual(mentionMatches(people, 'me', 'ag', true).map(p => p.id), ['agent', 'g']);
  // Where the agent can't be reached (a DM between two people) the row never appears.
  for (const typed of ['', 'a', 'agent']) assert.ok(!mentionMatches(people, 'me', typed, false).some(p => p.id === 'agent'));
  // Picking the row writes @agent and a space, with the caret after the space, so the next key carries on the sentence.
  const match = activeMention('hey @ag', { start: 7, end: 7 })!;
  assert.deepEqual(insertMention('hey @ag', match, mentionMatches(people, 'me', 'ag', true)[0]!.name), { text: 'hey @agent ', cursor: 11 });
  assert.deepEqual(insertMention('hey @ag, thanks', match, 'agent'), { text: 'hey @agent, thanks', cursor: 10 }, 'no second space before punctuation');
});

// The owner could not keep typing after clicking the Agent row: in a browser, pressing the mouse on a suggestion
// took focus from the box, the list closed a quarter second later, and a click held longer landed on nothing.
test('pressing a suggestion does not take focus from the message box, and a placed caret is let go', async () => {
  const fs = await import('node:fs'); const path = await import('node:path');
  const source = fs.readFileSync(path.join(import.meta.dirname, '../components/Messaging.tsx'), 'utf8');
  assert.match(source, /const KEEP_COMPOSER_FOCUS = \(Platform\.OS === "web" \? \{ onMouseDown: \(event: \{ preventDefault\(\): void \}\) => event\.preventDefault\(\) \} : \{\}\)/);
  assert.match(source, /accessibilityLabel="Mention suggestions" \{\.\.\.KEEP_COMPOSER_FOCUS\}>/);
  assert.match(source, /accessibilityLabel="Commands" \{\.\.\.KEEP_COMPOSER_FOCUS\}>/);
  assert.match(source, /const timer = setTimeout\(\(\) => setInsertedSelection\(undefined\), 80\);/, 'the caret is handed over once, not held');
  assert.match(source, /setInsertedSelection\(caret\);\n    input\.current\?\.focus\(\);/);
});
