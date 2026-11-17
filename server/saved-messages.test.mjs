import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createMessaging, AGENT_ID } from './messaging.mjs';
import { ensureRecordsSchema } from './records-preserve.mjs';

function fixture(t, { file = ':memory:', keeping = false } = {}) {
  const people = {
    pat: { id: 'pat', name: 'Pat Tester', role: 'owner' },
    jo: { id: 'jo', name: 'Jo Park', role: 'member' },
    ana: { id: 'ana', name: 'Ana Ruiz', role: 'member' },
  };
  const features = { channels: true, directMessages: true };
  const create = () => createMessaging({ file, users: () => people, agentName: () => 'Agent', features: () => features, recordsPreservation: () => keeping });
  let messaging = create();
  t.after(() => messaging.close());
  async function call(route, { who = 'jo', method = 'GET', body = {}, readBody, isAuthorized = () => true } = {}) {
    let response;
    const headers = {};
    const url = new URL(route, 'http://local');
    try {
      const handled = await messaging.handle({}, { setHeader: (key, value) => { headers[key] = value; } }, {
        user: people[who] ?? { id: who }, method, parts: url.pathname.split('/').filter(Boolean), url,
        readBody: readBody ?? (async () => body), isAuthorized,
        send: (_res, status, data) => { response = { status, data, headers }; },
        fail: (_res, status, code, message) => { response = { status, code, message, headers }; },
      });
      assert.equal(handled, true);
    } catch (error) {
      if (!error.status) throw error;
      response = { status: error.status, code: error.code, message: error.message, headers };
    }
    return response;
  }
  async function api(route, options) {
    const response = await call(route, options);
    assert.equal(response.status, 200, JSON.stringify(response));
    return response.data;
  }
  const saved = id => `/v1/saved-messages/${id}`;
  return {
    get messaging() { return messaging; }, people, features, call, api,
    channel: (options = {}) => messaging.createChannel(people.pat, { name: 'follow-up', ...options }),
    save: (id, options = {}) => api(saved(id), { method: 'POST', ...options }).then(data => data.item),
    status: (id, options) => api(saved(id), options).then(data => data.item),
    list: options => api('/v1/saved-messages', options).then(data => data.items),
    history: options => api('/v1/saved-messages', options).then(data => data.history),
    complete: (id, completed, options = {}) => api(saved(id), { method: 'PATCH', body: { completed }, ...options }).then(data => data.item),
    remove: (id, options = {}) => api(saved(id), { method: 'DELETE', ...options }),
    restart() { messaging.close(); messaging = create(); },
  };
}

test('saving is private, idempotent, and independent for each person', async t => {
  const f = fixture(t);
  const channel = f.channel();
  const post = f.messaging.post(channel, 'pat', 'Review the release notes');
  const events = [];
  f.messaging.subscribe('pat', (event, data) => events.push({ event, data }));
  f.messaging.subscribe('jo', (event, data) => events.push({ event, data }));
  const beforeEvents = f.messaging.db.prepare('SELECT COUNT(*) AS n FROM live_events').get().n;
  assert.equal(await f.status(post.seq), null);
  const saved = await f.save(post.seq, { body: { userId: 'ana' } });
  assert.equal(saved.messageId, String(post.seq));
  assert.equal(saved.message.text, post.text);
  assert.equal(saved.savedAt > 0, true);
  assert.equal(saved.completedAt, null);
  assert.deepEqual(saved.conversation, { id: channel.id, kind: 'channel', name: channel.name });
  assert.deepEqual(await f.save(post.seq), saved);
  assert.deepEqual(await f.list({ who: 'pat' }), [], 'even the owner cannot read another person’s saved list');
  assert.deepEqual(await f.list({ who: 'ana' }), [], 'request body cannot choose the saved-list owner');
  assert.equal(await f.status(post.seq, { who: 'pat' }), null);
  assert.equal((await f.call(`/v1/saved-messages/${post.seq}`, { who: 'pat', method: 'PATCH', body: { completed: true } })).status, 404);
  await f.remove(post.seq, { who: 'pat' });
  assert.equal((await f.list()).length, 1, 'removing an absent own save cannot remove someone else’s');
  await f.save(post.seq, { who: 'pat' });
  assert.equal((await f.list({ who: 'pat' })).length, 1);
  assert.deepEqual(events, [], 'private checklist changes never publish conversation events');
  assert.equal(f.messaging.db.prepare('SELECT COUNT(*) AS n FROM live_events').get().n, beforeEvents);
  assert.equal((await f.call('/v1/saved-messages')).headers['Cache-Control'], 'no-store');
});

test('completed items can be reopened or removed without changing the source', async t => {
  const f = fixture(t);
  const post = f.messaging.post(f.channel(), 'pat', 'Follow up tomorrow');
  const saved = await f.save(post.seq);
  const completed = await f.complete(post.seq, true);
  assert.ok(completed.completedAt >= saved.savedAt);
  assert.deepEqual(await f.complete(post.seq, true), completed, 'retries keep the original completion time');
  assert.deepEqual(await f.save(post.seq), completed, 'saving again does not reopen a completed item');
  assert.equal((await f.complete(post.seq, false)).completedAt, null);
  await f.remove(post.seq);
  await f.remove(post.seq);
  assert.deepEqual(await f.list(), []);
  assert.equal(await f.status(post.seq), null);
  assert.equal(f.messaging.db.prepare('SELECT text FROM messages WHERE seq = ?').get(post.seq).text, post.text);
});

test('saved references and completion survive restarting the server', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-saved-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const f = fixture(t, { file: path.join(directory, 'messages.db') });
  const post = f.messaging.post(f.channel(), 'pat', 'Persistent follow-up');
  await f.save(post.seq);
  const completed = await f.complete(post.seq, true);
  f.restart();
  assert.deepEqual(await f.status(post.seq), completed);
  assert.deepEqual(await f.list(), [completed]);
});

test('saved messages show current edits and become content-free tombstones after deletion', async t => {
  const f = fixture(t, { keeping: true });
  const channel = f.channel();
  const post = f.messaging.post(channel, 'pat', 'Draft next steps', null, {
    attachments: [{ name: 'notes.txt', mime: 'text/plain', data: Buffer.from('Original notes') }],
  });
  await f.save(post.seq);
  await f.api(`/v1/messages/${post.seq}`, { who: 'pat', method: 'PATCH', body: { text: 'Confirmed next steps' } });
  assert.equal((await f.list())[0].message.text, 'Confirmed next steps');
  assert.equal((await f.list())[0].message.attachments[0].name, 'notes.txt');
  await f.api(`/v1/messages/${post.seq}`, { who: 'pat', method: 'DELETE' });
  const tombstone = await f.status(post.seq);
  assert.equal(tombstone.message, null);
  assert.equal(tombstone.conversation, null);
  assert.equal((await f.list())[0].message, null);
  assert.equal((await f.call(`/v1/saved-messages/${post.seq}`, { method: 'POST' })).status, 404);
  assert.equal(f.messaging.db.prepare("SELECT text FROM records_archive WHERE event = 'message_deleted'").get().text, 'Confirmed next steps');
  assert.ok((await f.complete(post.seq, true)).completedAt);
  await f.remove(post.seq);
  assert.equal(f.messaging.db.prepare('SELECT COUNT(*) AS n FROM records_archive').get().n, 2, 'removing only a reference never deletes preserved content');
  const columns = f.messaging.db.prepare('PRAGMA table_info(saved_messages)').all().map(row => row.name);
  assert.deepEqual(columns, ['user_id', 'message_seq', 'saved_at', 'completed_at', 'completion_id'], 'no duplicated source content is stored');
});

test('full conversation deletion retains only removable saved references', async t => {
  const f = fixture(t, { keeping: true });
  const dm = f.messaging.openDm(f.people.pat, ['jo']);
  const post = f.messaging.post(dm, 'pat', 'Private follow-up');
  await f.save(post.seq);
  await f.api(`/v1/conversations/${dm.id}`, { who: 'pat', method: 'DELETE' });
  const saved = await f.status(post.seq);
  assert.equal(saved.message, null);
  assert.equal(saved.conversation, null);
  assert.equal(f.messaging.db.prepare('SELECT seq FROM messages WHERE seq = ?').get(post.seq), undefined);
  assert.equal(f.messaging.db.prepare("SELECT text FROM records_archive WHERE event = 'conversation_deleted_message'").get().text, 'Private follow-up');
  await f.remove(post.seq);
  assert.deepEqual(await f.list(), []);
});

test('a failed preservation write leaves both the source and saved view unchanged', async t => {
  const f = fixture(t, { keeping: true });
  const post = f.messaging.post(f.channel(), 'pat', 'Keep these words');
  const saved = await f.save(post.seq);
  ensureRecordsSchema(f.messaging.db);
  f.messaging.db.exec("CREATE TRIGGER refuse_record BEFORE INSERT ON records_archive BEGIN SELECT RAISE(ABORT, 'test archive failure'); END");
  assert.equal((await f.call(`/v1/messages/${post.seq}`, { who: 'pat', method: 'DELETE' })).status, 503);
  assert.deepEqual(await f.status(post.seq), saved);
});

test('private channels and DMs are readable only while the saver has access', async t => {
  const f = fixture(t);
  const privateChannel = f.channel({ private: true, memberIds: ['jo'] });
  const privatePost = f.messaging.post(privateChannel, 'pat', 'Private channel task');
  const dm = f.messaging.openDm(f.people.jo, ['ana']);
  const directPost = f.messaging.post(dm, 'ana', 'Private DM task');
  assert.equal((await f.call(`/v1/saved-messages/${privatePost.seq}`, { who: 'ana', method: 'POST' })).status, 404);
  assert.equal((await f.call(`/v1/saved-messages/${directPost.seq}`, { who: 'pat', method: 'POST' })).status, 404, 'owner role does not grant DM access');
  await f.save(privatePost.seq);
  const direct = await f.save(directPost.seq);
  assert.deepEqual(direct.conversation, { id: dm.id, kind: 'dm', name: 'Ana Ruiz' });
  await f.api(`/v1/conversations/${privateChannel.id}/leave`, { method: 'POST' });
  f.messaging.db.prepare('DELETE FROM members WHERE conversation_id = ? AND user_id = ?').run(dm.id, 'jo');
  for (const post of [privatePost, directPost]) {
    const saved = await f.status(post.seq);
    assert.equal(saved.message, null);
    assert.equal(saved.conversation, null);
    assert.equal((await f.call(`/v1/saved-messages/${post.seq}`, { method: 'POST' })).status, 404);
  }
  assert.ok((await f.list()).every(saved => !saved.message && !saved.conversation));
  await f.remove(privatePost.seq);
  await f.remove(directPost.seq);
  assert.deepEqual(await f.list(), []);
});

test('public preview readers may save, without gaining member-only read receipts', async t => {
  const f = fixture(t);
  const channel = f.channel();
  const post = f.messaging.post(channel, 'pat', 'Public follow-up');
  f.messaging.db.prepare('INSERT INTO message_reads VALUES (?, ?, ?, ?)').run(post.seq, channel.id, 'ana', Date.now());
  await f.api(`/v1/conversations/${channel.id}/leave`, { method: 'POST' });
  const saved = await f.save(post.seq);
  assert.equal(saved.message.text, post.text);
  assert.deepEqual(saved.message.readBy, []);
  assert.equal(f.messaging.db.prepare('SELECT * FROM members WHERE conversation_id = ? AND user_id = ?').get(channel.id, 'jo'), undefined);
});

test('thread replies, attachment-only posts, and finished agent posts can be saved', async t => {
  const f = fixture(t);
  const channel = f.channel();
  const root = f.messaging.post(channel, 'pat', 'Plan');
  const reply = f.messaging.post(channel, 'jo', 'I will check it', root.seq);
  const file = f.messaging.post(channel, 'pat', '', null, { attachments: [{ name: 'plan.txt', mime: 'text/plain', data: Buffer.from('Plan') }] });
  const agent = f.messaging.post(channel, AGENT_ID, 'Suggested next step');
  assert.equal((await f.save(reply.seq)).message.threadRoot, String(root.seq));
  assert.equal((await f.save(file.seq)).message.attachments.length, 1);
  assert.equal((await f.save(agent.seq)).message.user.agent, true);
  assert.deepEqual((await f.list()).map(item => item.messageId), [agent, file, reply].map(post => String(post.seq)));
});

test('pending messages, channel activity, nonexistent IDs, and malformed changes are rejected', async t => {
  const f = fixture(t);
  const channel = f.channel();
  const pending = f.messaging.post(channel, AGENT_ID, 'Unfinished answer', null, { pending: true });
  const activity = f.messaging.db.prepare('SELECT seq FROM messages WHERE activity IS NOT NULL LIMIT 1').get();
  assert.ok(activity);
  assert.equal((await f.call(`/v1/saved-messages/${pending.seq}`, { method: 'POST' })).status, 409);
  assert.equal((await f.call(`/v1/saved-messages/${activity.seq}`, { method: 'POST' })).status, 403);
  assert.equal((await f.call('/v1/saved-messages/9999999', { method: 'POST' })).status, 404);
  for (const id of ['0', '-1', '1.1', '01', '1e1', 'NaN', '9007199254740992']) {
    assert.equal((await f.call(`/v1/saved-messages/${id}`, { method: 'POST' })).status, 400);
  }
  const post = f.messaging.post(channel, 'pat', 'Valid message');
  await f.save(post.seq);
  for (const body of [null, [], {}, { completed: 'true' }, { completed: 1 }]) {
    assert.equal((await f.call(`/v1/saved-messages/${post.seq}`, { method: 'PATCH', body })).status, 400);
  }
  assert.equal((await f.status(post.seq)).completedAt, null);
  assert.equal((await f.list()).length, 1);
});

test('feature flags hide content while preserving saved and completed state', async t => {
  const f = fixture(t);
  const post = f.messaging.post(f.channel(), 'pat', 'Remember this');
  await f.save(post.seq);
  const completed = await f.complete(post.seq, true);
  f.features.channels = false;
  assert.equal((await f.status(post.seq)).message, null);
  assert.equal((await f.list())[0].conversation, null);
  const denied = await f.call(`/v1/saved-messages/${post.seq}`, { method: 'POST' });
  assert.equal(denied.status, 404);
  assert.equal(denied.code, 'feature_off');
  f.features.channels = true;
  assert.deepEqual(await f.status(post.seq), completed);
});

test('device revocation and access changes during body reads are rechecked before writing', async t => {
  const f = fixture(t);
  const channel = f.channel({ private: true, memberIds: ['jo'] });
  const post = f.messaging.post(channel, 'pat', 'Permission-sensitive follow-up');
  for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
    assert.equal((await f.call(`/v1/saved-messages/${post.seq}`, { method, isAuthorized: () => false })).status, 401);
  }
  assert.equal((await f.call('/v1/saved-messages', { who: 'removed-person' })).status, 401);
  let authorized = true;
  assert.equal((await f.call(`/v1/saved-messages/${post.seq}`, {
    method: 'POST', isAuthorized: () => authorized, readBody: async () => { authorized = false; return {}; },
  })).status, 401);
  assert.equal((await f.call(`/v1/saved-messages/${post.seq}`, {
    method: 'POST', readBody: async () => {
      await f.api(`/v1/conversations/${channel.id}/leave`, { method: 'POST' });
      return {};
    },
  })).status, 404);
  assert.deepEqual(await f.list(), []);
});

test('completion notes and exact timestamps remain in history after reopening and completing again', async t => {
  let clock = 1_800_000_000_123;
  t.mock.method(Date, 'now', () => clock);
  const f = fixture(t);
  const post = f.messaging.post(f.channel(), 'pat', 'Review the example-app release');
  const saved = await f.save(post.seq);
  const note = 'Checked the release notes.\n\nVerified the sign-in flow.  ';
  clock += 67_891;
  const completed = await f.complete(post.seq, true, { body: { completed: true, note, requestId: crypto.randomUUID() } });
  assert.equal(completed.completedAt, clock);
  const [first] = await f.history();
  assert.ok(first.id.startsWith('done_'));
  assert.deepEqual(first, { ...completed, id: first.id, note, reopenedAt: null });
  assert.equal(first.savedAt, saved.savedAt);
  clock += 8_765;
  await f.complete(post.seq, false);
  assert.deepEqual(await f.history(), [{ ...first, reopenedAt: clock }]);
  const reopenedAt = clock;
  clock += 12_345;
  const again = await f.complete(post.seq, true, { body: { completed: true, note: 'Checked the follow-up changes.' } });
  const history = await f.history();
  assert.equal(history.length, 2);
  assert.equal(history[0].completedAt, clock);
  assert.equal(history[0].note, 'Checked the follow-up changes.');
  assert.equal(history[0].reopenedAt, null);
  assert.equal(history[1].reopenedAt, reopenedAt);
  assert.equal(history[1].note, note);
  assert.notEqual(history[0].id, first.id);
  assert.equal(again.completedAt, history[0].completedAt);
});

test('repeated completion keeps its first note and request receipts prevent stale retries across cycles', async t => {
  const f = fixture(t);
  const post = f.messaging.post(f.channel(), 'pat', 'Finish the checklist');
  await f.save(post.seq);
  const requestId = crypto.randomUUID();
  const duplicateRequestId = crypto.randomUUID();
  const firstBody = { completed: true, note: 'Original work note', requestId };
  const first = await f.complete(post.seq, true, { body: firstBody });
  assert.deepEqual(await f.complete(post.seq, true, { body: { ...firstBody, note: 'Do not overwrite' } }), first);
  assert.deepEqual(await f.complete(post.seq, true, { body: { completed: true, note: firstBody.note, requestId: duplicateRequestId } }), first);
  assert.deepEqual(await f.complete(post.seq, true, { body: { completed: true } }), first);
  assert.equal((await f.history()).length, 1);
  assert.equal((await f.history())[0].note, firstBody.note);
  await f.complete(post.seq, false);
  for (const id of [requestId.toUpperCase(), duplicateRequestId]) {
    const retry = await f.complete(post.seq, true, { body: { completed: true, requestId: id, note: 'Late retry' } });
    assert.equal(retry.completedAt, null, 'a retry must not complete a reopened item');
  }
  await f.remove(post.seq);
  assert.equal(await f.complete(post.seq, true, { body: firstBody }), null, 'a retry must not recreate a removed bookmark');
  assert.equal(await f.status(post.seq), null);
  await f.save(post.seq);
  assert.equal((await f.complete(post.seq, true, { body: firstBody })).completedAt, null, 'a retry must not complete a new save of the same message');
  assert.equal((await f.history()).length, 1);
  const next = await f.complete(post.seq, true, { body: { completed: true, note: 'New work', requestId: crypto.randomUUID() } });
  assert.ok(next.completedAt);
  assert.equal((await f.history()).length, 2);
});

test('another completion cannot silently discard a new work note from a stale device', async t => {
  const f = fixture(t);
  const post = f.messaging.post(f.channel(), 'pat', 'Concurrent work');
  await f.save(post.seq);
  const firstRequest = crypto.randomUUID();
  const completed = await f.complete(post.seq, true, { body: { completed: true, note: 'First device note', requestId: firstRequest } });
  const secondRequest = crypto.randomUUID();
  const body = { completed: true, note: 'Second device note', requestId: secondRequest };
  const rejected = await f.call(`/v1/saved-messages/${post.seq}`, { method: 'PATCH', body });
  assert.equal(rejected.status, 409);
  assert.equal(rejected.code, 'already_completed');
  assert.match(rejected.message, /Your new note was not saved/);
  assert.deepEqual(await f.status(post.seq), completed);
  assert.equal((await f.history()).length, 1);
  assert.equal((await f.history())[0].note, 'First device note');
  assert.equal(f.messaging.db.prepare('SELECT 1 FROM saved_completion_requests WHERE request_id = ?').get(secondRequest), undefined, 'a rejected note must not consume its request ID');
  assert.equal((await f.call(`/v1/saved-messages/${post.seq}`, { method: 'PATCH', body: { completed: true, note: 'New note without a request ID' } })).status, 409);
  assert.deepEqual(await f.complete(post.seq, true, { body: { completed: true, note: '', requestId: crypto.randomUUID() } }), completed, 'a bare repeat remains idempotent');
  assert.deepEqual(await f.complete(post.seq, true, { body: { completed: true, note: 'Changed retry text', requestId: firstRequest } }), completed, 'a true request replay returns its receipt without rewriting history');
  await f.complete(post.seq, false);
  await f.complete(post.seq, true, { body });
  assert.equal((await f.history()).length, 2);
  assert.equal((await f.history())[0].note, body.note);
});

test('completion request IDs are scoped to the person and cannot be reused for another message', async t => {
  const f = fixture(t);
  const channel = f.channel();
  const first = f.messaging.post(channel, 'pat', 'First task');
  const second = f.messaging.post(channel, 'pat', 'Second task');
  await f.save(first.seq);
  await f.save(second.seq);
  const requestId = crypto.randomUUID();
  await f.complete(first.seq, true, { body: { completed: true, requestId } });
  const conflict = await f.call(`/v1/saved-messages/${second.seq}`, { method: 'PATCH', body: { completed: true, requestId } });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.code, 'completion_request_conflict');
  assert.equal((await f.status(second.seq)).completedAt, null);
  await f.save(second.seq, { who: 'pat' });
  await f.complete(second.seq, true, { who: 'pat', body: { completed: true, requestId, note: 'My separate note' } });
  assert.equal((await f.history()).length, 1);
  assert.equal((await f.history({ who: 'pat' }))[0].note, 'My separate note');
});

test('history and idempotency receipts survive bookmark removal, re-saving, and server restart', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-history-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const f = fixture(t, { file: path.join(directory, 'messages.db'), keeping: true });
  const post = f.messaging.post(f.channel(), 'pat', 'Durable work log');
  await f.save(post.seq);
  const body = { completed: true, note: 'Reviewed the document and recorded the outcome.', requestId: crypto.randomUUID() };
  await f.complete(post.seq, true, { body });
  const history = await f.history();
  await f.remove(post.seq);
  f.restart();
  assert.deepEqual(await f.list(), []);
  assert.deepEqual(await f.history(), history);
  assert.equal(await f.complete(post.seq, true, { body }), null);
  await f.save(post.seq);
  assert.equal((await f.complete(post.seq, true, { body })).completedAt, null);
  await f.complete(post.seq, true, { body: { completed: true, note: 'Second pass', requestId: crypto.randomUUID() } });
  f.restart();
  assert.equal((await f.history()).length, 2);
  assert.equal((await f.history()).find(item => item.id === history[0].id).note, body.note);
});

test('legacy completed bookmarks migrate once with original exact times and no invented note', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-history-migration-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'messages.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE saved_messages (
    user_id TEXT NOT NULL, message_seq INTEGER NOT NULL, saved_at INTEGER NOT NULL,
    completed_at INTEGER, PRIMARY KEY(user_id, message_seq)
  )`);
  old.prepare('INSERT INTO saved_messages VALUES (?, ?, ?, ?)').run('jo', 7, 1_700_000_000_123, 1_700_000_012_345);
  old.prepare('INSERT INTO saved_messages VALUES (?, ?, ?, ?)').run('jo', 8, 1_700_000_000_456, null);
  old.close();
  const f = fixture(t, { file });
  const history = await f.history();
  assert.equal(history.length, 1);
  assert.deepEqual(history[0], {
    id: history[0].id, messageId: '7', savedAt: 1_700_000_000_123, completedAt: 1_700_000_012_345,
    note: '', reopenedAt: null, message: null, conversation: null,
  });
  f.restart();
  assert.deepEqual(await f.history(), history);
  await f.complete(7, false);
  assert.ok((await f.history())[0].reopenedAt);
  await f.complete(7, true, { body: { completed: true, note: 'Completed after migration.' } });
  f.restart();
  assert.equal((await f.history()).length, 2);
});

test('completion notes and request IDs are validated strictly without truncating or changing state', async t => {
  const f = fixture(t);
  const post = f.messaging.post(f.channel(), 'pat', 'A task with work notes');
  await f.save(post.seq);
  const route = `/v1/saved-messages/${post.seq}`;
  for (const note of [null, 123, false, [], {}, 'x'.repeat(4001)]) {
    const invalid = await f.call(route, { method: 'PATCH', body: { completed: true, note } });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.code, 'invalid_completion_note');
  }
  for (const requestId of [null, 123, false, [], {}, '', 'not-a-uuid', '00000000-0000-0000-0000-000000000000', crypto.randomUUID() + 'x']) {
    const invalid = await f.call(route, { method: 'PATCH', body: { completed: true, requestId } });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.code, 'invalid_completion_request');
  }
  for (const extra of [{ note: 'Cannot silently discard my note' }, { requestId: crypto.randomUUID() }]) {
    assert.equal((await f.call(route, { method: 'PATCH', body: { completed: false, ...extra } })).status, 400);
  }
  assert.equal((await f.status(post.seq)).completedAt, null);
  assert.deepEqual(await f.history(), []);
  const note = 'x'.repeat(4000);
  await f.complete(post.seq, true, { body: { completed: true, note } });
  assert.equal((await f.history())[0].note, note);
});

test('completion, history, and request receipt all roll back when any write fails', async t => {
  const f = fixture(t, { keeping: true });
  const post = f.messaging.post(f.channel(), 'pat', 'Do not lose the work note');
  await f.save(post.seq);
  const body = { completed: true, note: 'The exact work performed', requestId: crypto.randomUUID() };
  for (const target of ['BEFORE INSERT ON saved_message_completions', 'BEFORE UPDATE OF completed_at ON saved_messages', 'BEFORE INSERT ON saved_completion_requests']) {
    f.messaging.db.exec(`CREATE TRIGGER refuse_saved_write ${target} BEGIN SELECT RAISE(ABORT, 'test write failure'); END`);
    const response = await f.call(`/v1/saved-messages/${post.seq}`, { method: 'PATCH', body });
    assert.equal(response.status, 503);
    assert.equal(response.code, 'saved_history_failed');
    assert.equal((await f.status(post.seq)).completedAt, null);
    assert.deepEqual(await f.history(), []);
    assert.equal(f.messaging.db.prepare('SELECT COUNT(*) AS n FROM saved_completion_requests').get().n, 0);
    f.messaging.db.exec('DROP TRIGGER refuse_saved_write');
  }
  await f.complete(post.seq, true, { body });
  const history = await f.history();
  f.messaging.db.exec("CREATE TRIGGER refuse_reopen BEFORE UPDATE OF reopened_at ON saved_message_completions BEGIN SELECT RAISE(ABORT, 'test reopen failure'); END");
  assert.equal((await f.call(`/v1/saved-messages/${post.seq}`, { method: 'PATCH', body: { completed: false } })).status, 503);
  assert.deepEqual(await f.history(), history);
  assert.equal((await f.status(post.seq)).completedAt, history[0].completedAt);
});

test('history notes remain immutable and private while live source permissions are rechecked', async t => {
  const f = fixture(t, { keeping: true });
  const channel = f.channel({ private: true, memberIds: ['jo'] });
  const post = f.messaging.post(channel, 'pat', 'Source words');
  await f.save(post.seq);
  const events = [];
  f.messaging.subscribe('pat', (event, data) => events.push({ event, data }));
  f.messaging.subscribe('jo', (event, data) => events.push({ event, data }));
  const note = 'My private work note';
  await f.complete(post.seq, true, { body: { completed: true, note, requestId: crypto.randomUUID() } });
  assert.deepEqual(events, []);
  assert.deepEqual(await f.history({ who: 'pat' }), [], 'owner cannot inspect other people’s work history');
  assert.deepEqual(await f.history({ who: 'ana' }), []);
  const [entry] = await f.history();
  for (const sql of [
    "UPDATE saved_message_completions SET note = ''",
    'UPDATE saved_message_completions SET completed_at = 0',
    'DELETE FROM saved_message_completions',
    'UPDATE saved_completion_requests SET request_id = request_id',
    'DELETE FROM saved_completion_requests',
  ]) assert.throws(() => f.messaging.db.exec(sql), /cannot be/);
  await f.api(`/v1/messages/${post.seq}`, { who: 'pat', method: 'PATCH', body: { text: 'Edited source words' } });
  assert.equal((await f.history())[0].message.text, 'Edited source words');
  await f.api(`/v1/conversations/${channel.id}/leave`, { method: 'POST' });
  assert.deepEqual((await f.history())[0], { ...entry, message: null, conversation: null });
  await f.complete(post.seq, false);
  assert.throws(() => f.messaging.db.exec('UPDATE saved_message_completions SET reopened_at = NULL'), /cannot be/);
  assert.throws(() => f.messaging.db.exec('UPDATE saved_message_completions SET reopened_at = reopened_at + 1'), /cannot be/);
  await f.api(`/v1/conversations/${channel.id}`, { who: 'pat', method: 'DELETE' });
  await f.remove(post.seq);
  const [remaining] = await f.history();
  assert.equal(remaining.message, null);
  assert.equal(remaining.conversation, null);
  assert.equal(remaining.note, note);
  assert.equal(remaining.completedAt, entry.completedAt);
  assert.ok(remaining.reopenedAt);
});

test('saved routes require encrypted authentication and sync the same person across devices', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-saved-http-test-'));
  const previousDirectory = process.env.SERVANT_DATA_DIR;
  process.env.SERVANT_DATA_DIR = directory;
  const { createStateStore } = await import('./state-store.mjs');
  const { testFetch } = await import('./encrypted-test-client.mjs');
  const state = createStateStore({ directory });
  const tokens = { phone: 'saved-test-phone', desktop: 'saved-test-desktop', other: 'saved-test-other-person' };
  let server;
  t.after(async () => {
    await server?.shutdown();
    state.close();
    fs.rmSync(directory, { recursive: true, force: true });
    if (previousDirectory === undefined) delete process.env.SERVANT_DATA_DIR;
    else process.env.SERVANT_DATA_DIR = previousDirectory;
  });
  state.mutate(s => {
    s.users.pat = { id: 'pat', name: 'Pat Tester', role: 'owner' };
    s.users.jo = { id: 'jo', name: 'Jo Park', role: 'member' };
    for (const [id, token] of Object.entries(tokens)) {
      s.devices[crypto.createHash('sha256').update(token).digest('hex')] = { id, userId: id === 'other' ? 'jo' : 'pat' };
    }
  });
  const { startServer } = await import('./server.mjs');
  server = await startServer({ host: '127.0.0.1', port: 0, name: 'Saved messages test' });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route, { who = 'phone', method = 'GET', body } = {}) => testFetch(directory, base + route, {
    method, headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: `Bearer ${tokens[who] ?? who}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const api = async (route, options) => {
    const response = await request(route, options);
    const data = await response.json();
    assert.ok(response.ok, `${response.status}: ${JSON.stringify(data)}`);
    return data;
  };
  assert.equal((await fetch(base + '/v1/saved-messages')).status, 426);
  assert.equal((await request('/v1/saved-messages', { who: null })).status, 401);
  assert.equal((await request('/v1/saved-messages', { who: 'invalid-device' })).status, 401);
  const { conversation } = await api('/v1/conversations', { method: 'POST', body: { name: 'follow-up-http' } });
  const { message } = await api(`/v1/conversations/${conversation.id}/messages`, { method: 'POST', body: { text: 'Check from either device' } });
  const route = `/v1/saved-messages/${message.id}`;
  await api(route, { method: 'POST', body: {} });
  assert.equal((await api('/v1/saved-messages', { who: 'desktop' })).items[0].message.text, message.text);
  await api(route, { who: 'desktop', method: 'PATCH', body: { completed: true } });
  assert.ok((await api(route)).item.completedAt);
  assert.deepEqual(await api('/v1/saved-messages', { who: 'other' }), { items: [], history: [] });
  await api(route, { who: 'desktop', method: 'DELETE' });
  assert.equal((await api(route)).item, null);
});
