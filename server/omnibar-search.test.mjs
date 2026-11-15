import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStateStore } from './state-store.mjs';
import { testFetch } from './encrypted-test-client.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-search-'));
process.env.SERVANT_DATA_DIR = directory;
const tokens = { owner: 'search-owner-device', member: 'search-member-device', outsider: 'search-outsider-device' };
let server, base, state, db;

before(async () => {
  state = createStateStore({ directory });
  state.mutate(s => {
    for (const [id, token] of Object.entries(tokens)) {
      s.users[id] = { id, name: id === 'member' ? 'ÉLODIE Search' : `${id} Search`, role: id === 'owner' ? 'owner' : 'member' };
      s.devices[crypto.createHash('sha256').update(token).digest('hex')] = { id: `${id}-device`, userId: id };
    }
  });
  const { startServer } = await import('./server.mjs');
  server = await startServer({ host: '127.0.0.1', port: 0, name: 'Omnibar test' });
  base = `http://127.0.0.1:${server.address().port}`;
  db = new DatabaseSync(path.join(directory, 'messages.db'));
});

after(async () => {
  db?.close();
  await server?.shutdown();
  state?.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

async function request(route, { who = 'owner', method = 'GET', body } = {}) {
  return testFetch(directory, base + route, {
    method,
    headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${tokens[who] ?? who}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function api(route, options) {
  const response = await request(route, options);
  const result = await response.json();
  assert.ok(response.ok, `${response.status}: ${JSON.stringify(result)}`);
  return result;
}
const search = (q, who = 'owner') => api(`/v1/search?q=${encodeURIComponent(q)}`, { who });
const channel = async (name, options = {}, who = 'owner') => (await api('/v1/conversations', {
  who, method: 'POST', body: { name, ...options },
})).conversation;
const post = async (conversationId, text, { who = 'owner', threadRoot } = {}) => (await api(`/v1/conversations/${conversationId}/messages`, {
  who, method: 'POST', body: { text, ...(threadRoot ? { threadRoot } : {}) },
})).message;

test('search requires encrypted, authenticated requests and bounds query length', async () => {
  assert.equal((await fetch(base + '/v1/search?q=search')).status, 426);
  assert.equal((await request('/v1/search?q=search', { who: null })).status, 401);
  assert.equal((await request('/v1/search?q=search', { who: 'bad-device' })).status, 401);
  for (const query of ['', 'x', '  x  ']) assert.deepEqual(await search(query), { channels: [], people: [], messages: [] });
  const long = await request('/v1/search?q=' + 'x'.repeat(101));
  assert.equal(long.status, 400);
  assert.equal((await long.json()).error.code, 'bad_query');
});

test('search discovers active public channels but never private unjoined channels or outsider messages', async () => {
  const joined = await channel('searchscope-joined', { private: true, memberIds: ['member'] });
  const publicOther = await channel('searchscope-public', {}, 'outsider');
  // Everyone starts in public channels; this person left it.
  await api(`/v1/conversations/${publicOther.id}/leave`, { method: 'POST', body: {}, who: 'owner' });
  const privateOther = await channel('searchscope-private', { private: true }, 'outsider');
  const ownDm = (await api('/v1/conversations', { method: 'POST', body: { kind: 'dm', userIds: ['member'] } })).conversation;
  const outsiderDm = (await api('/v1/conversations', { who: 'outsider', method: 'POST', body: { kind: 'dm', userIds: ['member'] } })).conversation;
  const readable = await post(joined.id, 'Searchscope joined channel text');
  const direct = await post(ownDm.id, 'Searchscope direct message');
  await post(publicOther.id, 'Searchscope public but not joined message', { who: 'outsider' });
  await post(privateOther.id, 'Searchscope inaccessible private message', { who: 'outsider' });
  await post(outsiderDm.id, 'Searchscope another person’s direct message', { who: 'outsider' });

  const found = await search('SEARCHSCOPE');
  assert.deepEqual(new Set(found.channels.map(c => c.id)), new Set([joined.id, publicOther.id]));
  assert.deepEqual(found.channels.find(c => c.id === joined.id), {
    id: joined.id, name: joined.name, topic: '', memberCount: 2, archived: false, joined: true, private: true,
  });
  assert.equal(found.channels.find(c => c.id === publicOther.id).joined, false);
  assert.deepEqual(new Set(found.messages.map(m => m.id)), new Set([readable.id, direct.id]));
  assert.equal(found.messages.find(m => m.id === direct.id).conversationTitle, 'ÉLODIE Search');
  assert.equal(found.messages.find(m => m.id === direct.id).conversationKind, 'dm');
  assert.equal(found.messages.find(m => m.id === readable.id).conversationTitle, joined.name);
  const response = await request('/v1/search?q=searchscope');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('personal archives remain searchable and deleted or unfinished content is excluded', async () => {
  const c = await channel('archive-searchscope');
  const kept = await post(c.id, 'Archivevisibility reference');
  const gone = await post(c.id, 'Archivevisibility deleted');
  const pending = await post(c.id, 'Archivevisibility pending');
  const activity = await post(c.id, 'Archivevisibility activity');
  await api(`/v1/messages/${gone.id}`, { method: 'DELETE' });
  db.prepare('UPDATE messages SET pending = 1 WHERE seq = ?').run(Number(pending.id));
  db.prepare("UPDATE messages SET activity = 'joined' WHERE seq = ?").run(Number(activity.id));
  await api(`/v1/conversations/${c.id}/archive`, { method: 'POST' });
  assert.equal((await search('archive-searchscope')).channels[0].archived, true);
  assert.deepEqual((await search('Archivevisibility')).messages.map(m => m.id), [kept.id]);
  await api(`/v1/conversations/${c.id}/restore`, { method: 'POST' });
  assert.equal((await search('archive-searchscope')).channels[0].archived, false);
  db.prepare('UPDATE conversations SET archived_at = ? WHERE id = ?').run(Date.now(), c.id);
  assert.equal((await search('archive-searchscope')).channels.length, 0);
  assert.equal((await search('Archivevisibility')).messages.length, 0);
});

test('search result access is re-evaluated after leaving or deleting a channel', async () => {
  const c = await channel('leave-searchscope', { private: true, memberIds: ['member'] });
  await post(c.id, 'Leavevisibility reference');
  assert.equal((await search('Leavevisibility', 'member')).messages.length, 1);
  await api(`/v1/conversations/${c.id}/leave`, { who: 'member', method: 'POST' });
  assert.equal((await search('Leavevisibility', 'member')).messages.length, 0);
  assert.equal((await search('leave-searchscope', 'member')).channels.length, 0);
  await api(`/v1/conversations/${c.id}`, { method: 'DELETE' });
  assert.equal((await search('Leavevisibility')).messages.length, 0);
});

test('Unicode matching is case insensitive and SQL wildcard and quote characters stay literal', async () => {
  const c = await channel('literal-searchscope', { topic: 'ÉLODIE planning' });
  const literal = await post(c.id, 'Literal tokens: 50%_off and O’NEIL café');
  await post(c.id, 'Other text should not match wildcard searches');
  const people = (await search('élodie')).people;
  assert.equal(people.length, 1);
  assert.equal(people[0].id, 'member');
  assert.equal((await search('Élodie')).channels[0].id, c.id);
  assert.deepEqual((await search('%_')).messages.map(m => m.id), [literal.id]);
  assert.deepEqual((await search('o’neil')).messages.map(m => m.id), [literal.id]);
  assert.deepEqual((await search("%' OR 1=1 --")).messages, []);
  assert.ok(!(await search('Search')).people.some(p => p.id === 'owner'));
});

test('old messages and thread replies remain usable search targets without truncating matching text', async () => {
  const c = await channel('history-searchscope');
  const old = await post(c.id, 'x'.repeat(2400) + ' Longhistoryneedle at the end');
  const reply = await post(c.id, 'Longhistoryneedle in thread', { threadRoot: old.id });
  for (let i = 0; i < 55; i++) await post(c.id, `Newer message ${i}`);
  const result = await search('longhistoryneedle');
  assert.deepEqual(result.messages.map(m => m.id), [reply.id, old.id]);
  assert.equal(result.messages[0].threadRoot, old.id);
  assert.ok(result.messages[1].text.includes('Longhistoryneedle'));
  assert.equal(result.messages[1].threadRoot, null);
  const thread = await api(`/v1/conversations/${c.id}/threads/${result.messages[0].threadRoot}`);
  assert.equal(thread.root.id, old.id);
  assert.equal(thread.replies[0].id, reply.id);
  const oldRoot = await api(`/v1/conversations/${c.id}/threads/${old.id}`);
  assert.equal(oldRoot.root.text, old.text);
});

test('each search group is bounded and message results are newest first', async () => {
  for (let i = 0; i < 12; i++) await channel(`bounded-searchscope-${i}`);
  state.mutate(s => {
    for (let i = 0; i < 12; i++) s.users[`bounded-${i}`] = { id: `bounded-${i}`, name: `Bounded-searchscope Person ${i}`, role: 'member' };
  });
  const c = await channel('bounded-message-source');
  const ids = [];
  for (let i = 0; i < 24; i++) ids.push((await post(c.id, `Bounded-searchscope message ${i}`)).id);
  const result = await search('bounded-searchscope');
  assert.equal(result.channels.length, 10);
  assert.equal(result.people.length, 10);
  assert.deepEqual(result.messages.map(m => m.id), ids.slice(-20).reverse());
});

test('words are matched whole and by their stem, in any order, with the last one as typed so far', async () => {
  const c = await channel('fts-words');
  const renewals = await post(c.id, 'The permit renewals were approved on Friday');
  const intake = await post(c.id, 'Intake form: two requests came in already');
  const ids = async q => (await search(q)).messages.map(m => m.id);
  assert.deepEqual(await ids('renewal approve'), [renewals.id], 'stems: renewal finds renewals, approve finds approved');
  assert.deepEqual(await ids('friday permit'), [renewals.id], 'any order');
  assert.deepEqual(await ids('permit reque'), [], 'every word must be there');
  assert.deepEqual(await ids('requests inta'), [intake.id], 'the last word may be the start of one');
  assert.deepEqual(await ids('"came in already"'), [intake.id], 'words in quotes, together');
  assert.deepEqual(await ids('"in came already"'), []);
  // Part of a word and text the index does not split into words are still found as typed.
  assert.deepEqual(await ids('newals'), [renewals.id]);
  // Nothing typed can act as a search operator.
  for (const q of ['permit OR zzzz', 'permit NOT approved', 'permit*', '(permit', 'text:permit', 'permit AND', '"permit', 'NEAR(permit approved)']) assert.ok(Array.isArray((await search(q)).messages), q);
});

test('filters narrow by conversation, writer, links, files and threads, alone or with words', async () => {
  const one = await channel('fts-filter-one'), two = await channel('fts-filter-two');
  await api(`/v1/conversations/${one.id}/members`, { method: 'POST', body: { userIds: ['member'] } }).catch(() => {});
  const mine = await post(one.id, 'Budget review notes for the quarter');
  const theirs = await post(one.id, 'Budget review slides are at https://example.gov/slides', { who: 'member' });
  const other = await post(two.id, 'Budget review moved to Tuesday');
  const reply = await post(one.id, 'Budget reply in the thread', { threadRoot: mine.id });
  const ids = async (q, who = 'owner') => (await search(q, who)).messages.map(m => m.id);
  assert.deepEqual(await ids('budget review'), [other.id, theirs.id, mine.id]);
  assert.deepEqual(await ids('budget review in:#fts-filter-one'), [theirs.id, mine.id]);
  assert.deepEqual(await ids('budget review in:fts-filter-two'), [other.id]);
  assert.deepEqual(await ids(`budget review in:${two.id}`), [other.id], 'a conversation id works too');
  assert.deepEqual(await ids('budget from:me'), [reply.id, other.id, mine.id]);
  assert.deepEqual(await ids('budget from:@ÉLODIE-Search'), [theirs.id]);
  assert.deepEqual(await ids('budget from:élodie'), [theirs.id], 'a first name, in any case');
  assert.deepEqual(await ids('budget has:link'), [theirs.id]);
  assert.deepEqual(await ids('budget is:thread'), [reply.id, mine.id], 'the reply and the message it answers');
  assert.deepEqual(await ids('in:fts-filter-one from:me is:thread'), [reply.id, mine.id], 'filters with no words');
  assert.deepEqual(await ids('has:file in:fts-filter-one'), []);
  // A filter that names nothing finds nothing, rather than everything.
  assert.deepEqual(await ids('budget in:no-such-channel'), []);
  assert.deepEqual(await ids('budget from:nobody'), []);
  // With a filter, only messages come back.
  const filtered = await search('fts-filter in:fts-filter-one');
  assert.deepEqual([filtered.channels, filtered.people], [[], []]);
  // A filter never reaches past what the person can read.
  const secret = await channel('fts-filter-private', { private: true });
  const hidden = await post(secret.id, 'Budget numbers nobody else may see');
  assert.deepEqual(await ids('budget in:fts-filter-private'), [hidden.id]);
  assert.deepEqual(await ids('budget in:fts-filter-private', 'outsider'), []);
  assert.deepEqual(await ids(`budget in:${secret.id}`, 'outsider'), []);
  assert.equal((await ids('budget from:owner', 'outsider')).includes(hidden.id), false, 'everything else the owner wrote in public channels, and not this');
});

test('the index follows edits and deletes, and says when there are more results than a page', async () => {
  const c = await channel('fts-changes');
  const m = await post(c.id, 'The zephyrword draft is ready');
  const ids = async q => (await search(q)).messages.map(x => x.id);
  assert.deepEqual(await ids('zephyrword'), [m.id]);
  await api(`/v1/messages/${m.id}`, { method: 'PATCH', body: { text: 'The quillword draft is ready' } });
  assert.deepEqual([await ids('zephyrword'), await ids('quillword')], [[], [m.id]], 'the old words are gone with the edit');
  await api(`/v1/messages/${m.id}`, { method: 'DELETE' });
  assert.deepEqual(await ids('quillword'), [], 'a deleted message is not found');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM messages_search WHERE messages_search MATCH '\"quillword\"'").get().n, 0, 'nor are its words left in the index');
  for (let i = 0; i < 23; i++) await post(c.id, `Paginationword number ${i}`);
  const page = await search('paginationword');
  assert.deepEqual([page.messages.length, page.more], [20, true]);
  assert.equal((await search('paginationword number 3')).more, false);
});

test('a server that already has messages indexes them when it is first updated', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-search-upgrade-'));
  try {
    const { createMessaging } = await import('./messaging.mjs');
    const people = { u: { id: 'u', name: 'Pat Tester', role: 'owner' } };
    const file = path.join(dir, 'messages.db');
    let m = createMessaging({ file, users: () => people, agentName: () => 'Agent' });
    const c = m.createChannel(people.u, { name: 'before-upgrade' });
    m.post(c, 'u', 'Written before the index existed: heirloomword');
    m.close();
    // As an older server left it: no index, no triggers.
    const raw = new DatabaseSync(file);
    raw.exec('DROP TRIGGER messages_search_insert; DROP TRIGGER messages_search_delete; DROP TRIGGER messages_search_update; DROP TABLE messages_search;');
    raw.exec("INSERT INTO messages (conversation_id, user_id, text, created_at) SELECT conversation_id, user_id, 'Also before: heirloomword again', created_at FROM messages LIMIT 1");
    raw.close();
    m = createMessaging({ file, users: () => people, agentName: () => 'Agent' });
    const count = m.db.prepare("SELECT COUNT(*) AS n FROM messages_search WHERE messages_search MATCH '\"heirloomword\"'").get().n;
    m.close();
    assert.equal(count, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
