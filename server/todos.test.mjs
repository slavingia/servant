import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createTodos, agentBrief, readDoneTag, EDIT_POST_GAP_MS } from './todos.mjs';
import { createMessaging } from './messaging.mjs';
import { ensureRecordsSchema, verifyChain } from './records-preserve.mjs';

const pat = { id: 'pat', name: 'Pat Tester', role: 'member' };
const jo = { id: 'jo', name: 'Jo Park', role: 'member' };
const ana = { id: 'ana', name: 'Ana Ruiz', role: 'member' };
const owner = { id: 'owner', name: 'Owner', role: 'owner' };
const people = { pat, jo, ana, owner };

// Project "example-app" has Pat and Jo (Jo can only read); release r1 belongs to it. Channel c1 has Pat and Jo.
const projects = {
  "example-app": { projectName: 'Example app', releases: { r1: 'Nov 17' }, access: { pat: 'write', jo: 'read', owner: 'write' } },
};
const cleanup = [];
after(() => { for (const close of cleanup) close(); });
function setup(over = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'servant-todos-')), 'todos.db');
  const posts = [], started = [];
  let clock = 1_000_000;
  const todos = createTodos({
    file, log: { error() {} }, now: () => clock,
    users: () => people,
    project: (user, pid, rid) => {
      const p = projects[pid], level = p?.access[user.id];
      if (!p || !level) return null;
      if (rid && !p.releases[rid]) return null;
      return { projectName: p.projectName, releaseName: rid ? p.releases[rid] : '', canWrite: level === 'write' };
    },
    channel: (userId, cid) => cid === 'c1' && ['pat', 'jo', 'owner'].includes(userId) ? { name: 'example-team' } : null,
    announce: (channelId, userId, text) => posts.push({ channelId, userId, text }),
    canReadChat: () => true,
    startWork: async o => { await new Promise(r => setTimeout(r, 20)); started.push(o); const chat = { id: `cht_${started.length}` }; o.beforeEnqueue(chat); return chat; },
    ...over,
  });
  cleanup.push(() => { try { todos.close(); } catch {} fs.rmSync(path.dirname(file), { recursive: true, force: true }); });
  return { todos, file, posts, started, tick: ms => { clock += ms; } };
}

test('a to-do is private until it is tagged with a project; then the project sees it', () => {
  const { todos } = setup();
  const t = todos.create(pat, { text: 'Draft the post' });
  assert.equal(todos.list(jo).length, 0, 'untagged: only the author');
  assert.equal(todos.list(pat).length, 1);
  const tagged = todos.update(pat, t.id, { projectId: 'example-app', releaseId: 'r1' });
  assert.deepEqual([tagged.projectName, tagged.releaseName], ['Example app', 'Nov 17']);
  assert.equal(todos.list(jo).length, 1, 'a project member sees it');
  assert.equal(todos.list(ana).length, 0, 'someone outside the project does not');
  assert.equal(todos.list(owner).length, 1, 'the owner sees everything');
  assert.throws(() => todos.update(jo, t.id, { text: 'x' }), /can't change/, 'read access is read only');
  assert.throws(() => todos.update(ana, t.id, { text: 'x' }), /gone/);
});

test('tags are checked: a release needs its project, and a project you cannot see is refused', () => {
  const { todos } = setup();
  assert.throws(() => todos.create(pat, { text: 'a', releaseId: 'r1' }), /project before a release/);
  assert.throws(() => todos.create(pat, { text: 'a', projectId: 'example-app', releaseId: 'nope' }), /isn't in this project/);
  assert.throws(() => todos.create(ana, { text: 'a', projectId: 'example-app' }), /No such project/);
  assert.throws(() => todos.create(pat, { text: '   ' }), /Write what needs doing/);
  // Moving to another project clears the release.
  const t = todos.create(pat, { text: 'b', projectId: 'example-app', releaseId: 'r1' });
  assert.equal(todos.update(pat, t.id, { projectId: null }).releaseId, null);
});

test('the person it is for is matched to a Servant user by name', () => {
  const { todos } = setup();
  assert.equal(todos.create(pat, { text: 'a', assigneeName: 'Jo' }).assignee.id, 'jo');
  assert.equal(todos.create(pat, { text: 'b', assigneeName: 'Zed' }).assignee.id, undefined, 'an unknown name is kept as text');
  assert.equal(todos.list(jo).length, 1, 'whoever it is for can see and edit it');
  const mineOnly = todos.list(jo, { mine: true });
  assert.equal(mineOnly[0].canEdit, true);
});

test('drag order: reorder re-deals positions among just those to-dos', () => {
  const { todos } = setup();
  const [a, b, c] = ['one', 'two', 'three'].map(text => todos.create(pat, { text }));
  assert.deepEqual(todos.list(pat).map(t => t.text), ['one', 'two', 'three']);
  todos.reorder(pat, [c.id, a.id, b.id]);
  assert.deepEqual(todos.list(pat).map(t => t.text), ['three', 'one', 'two']);
  assert.throws(() => todos.reorder(pat, [a.id, a.id]), /each to-do once/);
  assert.throws(() => todos.reorder(jo, [a.id]), /gone/);
});

test('new, edited and completed to-dos are posted to their channel; reopening too; typos are not spammy', () => {
  const { todos, posts, tick } = setup();
  const t = todos.create(pat, { text: 'Draft the post', projectId: 'example-app', releaseId: 'r1', channelId: 'c1', assigneeName: 'Jo' });
  assert.deepEqual(posts.map(p => p.text), ['Pat Tester added a to-do: Draft the post · Example app · Nov 17 for Jo Park']);
  todos.update(pat, t.id, { text: 'Draft the launch post' });
  assert.equal(posts.length, 1, 'an edit right after is held back');
  tick(EDIT_POST_GAP_MS + 1);
  todos.update(pat, t.id, { text: 'Draft the launch post today' });
  assert.match(posts.at(-1).text, /^Pat Tester edited a to-do: Draft the launch post today/);
  todos.update(jo, t.id, { status: 'done' });
  assert.match(posts.at(-1).text, /^Jo Park completed a to-do: /);
  todos.update(pat, t.id, { status: 'open' });
  assert.match(posts.at(-1).text, /^Pat Tester reopened a to-do: /);
  // Nothing posts for a to-do with no channel, and the channel must be one you are in.
  const quiet = todos.create(pat, { text: 'no channel' });
  todos.update(pat, quiet.id, { status: 'done' });
  assert.equal(posts.filter(p => /no channel/.test(p.text)).length, 0);
  assert.throws(() => todos.create(ana, { text: 'x', channelId: 'c1' }), /Join that channel/);
});

test('linking a channel after the fact posts it as new, once; bulk tagging posts one summary line', () => {
  const { todos, posts } = setup();
  const [a, b, c] = ['one', 'two', 'three'].map(text => todos.create(pat, { text }, { source: { kind: 'recording', id: 'rec1', title: 'Launch sync' } }));
  assert.equal(posts.length, 0);
  const out = todos.bulk(pat, [a.id, b.id, c.id], { projectId: 'example-app', releaseId: 'r1', channelId: 'c1' });
  assert.equal(out.length, 3);
  assert.ok(out.every(t => t.channelName === 'example-team' && t.projectName === 'Example app' && t.releaseName === 'Nov 17'));
  assert.equal(posts.length, 1, 'one line, not three');
  assert.match(posts[0].text, /^Pat Tester added 3 to-dos from Launch sync: one; two; three/);
  todos.bulk(pat, [a.id], { channelId: 'c1' });
  assert.equal(posts.length, 1, 'already linked: not announced again');
  assert.throws(() => todos.bulk(pat, [a.id], { nonsense: 1 }), /Nothing to change/);
  assert.throws(() => todos.bulk(jo, [a.id], { status: 'done' }), /can't change/);
});

test('send to agent starts one chat however often it is tapped, and carries the project, release and the done instruction', async () => {
  const { todos, started } = setup();
  const t = todos.create(pat, { text: 'Fix the footer', projectId: 'example-app', releaseId: 'r1', assigneeName: 'Jo' });
  const [x, y] = await Promise.all([todos.sendToAgent(pat, { id: 'dev1' }, t.id), todos.sendToAgent(pat, { id: 'dev1' }, t.id)]);
  assert.equal(started.length, 1, 'one work chat');
  assert.deepEqual([x.started, y.started].sort(), [false, true]);
  assert.equal(x.chatId, y.chatId, 'both taps get the same chat, even while it is still starting');
  assert.ok(x.chatId, 'and it is a real chat id, not empty');
  assert.equal(started[0].projectId, 'example-app');
  assert.match(started[0].transcript, /Fix the footer \(for Jo Park\)/);
  assert.match(started[0].transcript, /the Example app project, the Nov 17 release/);
  assert.match(started[0].transcript, /<servant-todo-done\/>/);
  const again = await todos.sendToAgent(pat, { id: 'dev1' }, t.id);
  assert.deepEqual([again.started, again.chatId], [false, 'cht_1']);
  assert.equal(todos.list(pat)[0].withAgent, true);
  await assert.rejects(todos.sendToAgent(ana, null, t.id), /gone/);
});

test('a failed hand-off frees the to-do so it can be tried again', async () => {
  let fail = true;
  const { todos, started } = setup({ startWork: async o => { if (fail) throw new Error('agent is down'); started.push(o); const chat = { id: 'cht_ok' }; o.beforeEnqueue(chat); return chat; } });
  const t = todos.create(pat, { text: 'Try me' });
  await assert.rejects(todos.sendToAgent(pat, null, t.id), /agent is down/);
  assert.equal(todos.list(pat)[0].chatId, null);
  fail = false;
  assert.equal((await todos.sendToAgent(pat, null, t.id)).started, true);
});

test('the work chat is linked before a fast worker can complete it', async () => {
  const { todos } = setup({ startWork: async options => {
    const chat = { id: 'cht_fast' };
    options.beforeEnqueue(chat);
    assert.equal(todos.agentDone(chat.id, 'turn_fast'), 1, 'the first worker tick can already find the task');
    return chat;
  } });
  const todo = todos.create(pat, { text: 'Finish the example' });
  const sent = await todos.sendToAgent(pat, null, todo.id);
  assert.equal(sent.todo.status, 'done');
  assert.equal(sent.chatId, 'cht_fast');
  assert.equal(todos.workLog(pat).length, 1);
  assert.deepEqual(todos.workLog(pat)[0].completedBy, { kind: 'agent' });
});

test('failure after linking releases only this handoff and lets the task be retried', async () => {
  let fail = true;
  const { todos } = setup({ startWork: async options => {
    const chat = { id: 'cht_retry' };
    options.beforeEnqueue(chat);
    if (fail) throw new Error('enqueue failed');
    return chat;
  } });
  const todo = todos.create(pat, { text: 'Retry the example' });
  await assert.rejects(todos.sendToAgent(pat, null, todo.id), /enqueue failed/);
  assert.equal(todos.list(pat)[0].chatId, null);
  assert.equal(todos.list(pat)[0].withAgent, false);
  fail = false;
  assert.equal((await todos.sendToAgent(pat, null, todo.id)).chatId, 'cht_retry');

  const other = setup({ startWork: async options => {
    const chat = { id: 'cht_old' };
    options.beforeEnqueue(chat);
    other.todos.db.prepare('UPDATE todos SET chat_id = ?').run('cht_new');
    throw new Error('old enqueue failed');
  } });
  const changed = other.todos.create(pat, { text: 'Another handoff' });
  await assert.rejects(other.todos.sendToAgent(pat, null, changed.id), /old enqueue failed/);
  assert.equal(other.todos.list(pat)[0].chatId, 'cht_new', 'late failure must not erase a different handoff');
});

test('a task deleted or completed while the chat is starting is never enqueued', async () => {
  for (const change of ['delete', 'complete']) {
    let resume, enqueued = false;
    const ready = new Promise(resolve => { resume = resolve; });
    const { todos } = setup({ startWork: async options => {
      await ready;
      const chat = { id: 'cht_delayed' };
      options.beforeEnqueue(chat);
      enqueued = true;
      return chat;
    } });
    const todo = todos.create(pat, { text: 'Delayed example' });
    const flight = todos.sendToAgent(pat, null, todo.id);
    if (change === 'delete') todos.remove(pat, todo.id);
    else todos.update(pat, todo.id, { status: 'done' });
    resume();
    await assert.rejects(flight, error => error.status === 404 || error.code === 'todo_changed');
    assert.equal(enqueued, false);
    if (change === 'complete') assert.equal(todos.list(pat, { status: 'done' })[0].chatId, null);
  }
});

test('when the agent says it finished, the to-do is marked off and the channel is told', async () => {
  const { todos, posts } = setup();
  const t = todos.create(pat, { text: 'Fix the footer', channelId: 'c1' });
  await todos.sendToAgent(pat, null, t.id);
  posts.length = 0;
  assert.equal(todos.agentDone('cht_unknown'), 0);
  assert.equal(todos.agentDone('cht_1'), 1);
  const done = todos.list(pat, { status: 'done' })[0];
  assert.deepEqual([done.status, done.doneBy, done.withAgent], ['done', 'agent', false]);
  assert.equal(posts.length, 1);
  assert.match(posts[0].text, /^The agent completed a to-do for Pat Tester: Fix the footer/);
  assert.equal(todos.agentDone('cht_1'), 0, 'only once');
  await assert.rejects(todos.sendToAgent(pat, null, t.id), /already done/);
});

test('the done tag is read from a reply and removed from what people see', () => {
  assert.deepEqual(readDoneTag('All fixed and pushed.\n<servant-todo-done/>'), { done: true, text: 'All fixed and pushed.' });
  assert.deepEqual(readDoneTag('Still working on it.'), { done: false, text: 'Still working on it.' });
  assert.equal(readDoneTag('ok <servant-todo-done />').done, false);
  assert.match(agentBrief({ todo: { text: 'x' } }), /^x\n\nThis is a to-do\. Start on it/);
});

test('next steps from a recording become to-dos once, with the owner matched; deleting the recording deletes them', () => {
  const { todos } = setup();
  const made = todos.fromRecording(pat, 'rec1', 'Launch sync', [{ text: 'Draft the post', owner: 'Jo' }, { text: 'Book the room', owner: '' }]);
  assert.equal(made.length, 2);
  assert.equal(made[0].assignee.id, 'jo');
  assert.deepEqual(made[0].source, { kind: 'recording', id: 'rec1', title: 'Launch sync' });
  assert.equal(todos.fromRecording(pat, 'rec1', 'Launch sync', [{ text: 'again' }]).length, 0, 'not made twice');
  assert.equal(todos.forSource(pat, 'recording', 'rec1').length, 2);
  assert.equal(todos.forSource(ana, 'recording', 'rec1').length, 0);
  todos.removeSource('recording', 'rec1');
  assert.equal(todos.forSource(pat, 'recording', 'rec1').length, 0);
  assert.deepEqual(todos.fromRecording(pat, 'rec1', 'Launch sync', [{ text: 'again' }]), [], 'removing the source retains its import receipt');
});

test('recording import receipts survive task deletion and restart without resurrecting removed work', () => {
  const { todos, file } = setup({ recordsPreservation: () => true });
  const steps = [{ text: 'First follow-up' }, { text: 'Second follow-up' }];
  const tasks = todos.fromRecording(pat, 'rec_once', 'Example memo', steps);
  todos.remove(pat, tasks[0].id);
  assert.deepEqual(todos.fromRecording(pat, 'rec_once', 'Example memo', steps), []);
  assert.deepEqual(todos.forSource(pat, 'recording', 'rec_once').map(todo => todo.id), [tasks[1].id], 'partial removal stays removed');
  todos.remove(pat, tasks[1].id);
  assert.deepEqual(todos.fromRecording(pat, 'rec_once', 'Example memo', steps), []);
  assert.deepEqual(todos.forSource(pat, 'recording', 'rec_once'), []);
  assert.deepEqual(todos.db.prepare('SELECT text FROM records_archive ORDER BY rowid').all().map(row => row.text), steps.map(step => step.text));
  todos.close();
  const reopened = createTodos({ file, users: () => people, project: () => null, channel: () => null, announce: () => {} });
  try {
    assert.deepEqual(reopened.fromRecording(pat, 'rec_once', 'Example memo', steps), []);
    assert.deepEqual(reopened.forSource(pat, 'recording', 'rec_once'), []);
    reopened.db.exec("CREATE TRIGGER fail_recording_task BEFORE INSERT ON todos WHEN NEW.text = 'Second follow-up' BEGIN SELECT RAISE(ABORT, 'failed import'); END");
    assert.throws(() => reopened.fromRecording(pat, 'rec_retry', 'Example memo', steps), /failed import/);
    assert.deepEqual(reopened.forSource(pat, 'recording', 'rec_retry'), []);
    reopened.db.exec('DROP TRIGGER fail_recording_task');
    assert.equal(reopened.fromRecording(pat, 'rec_retry', 'Example memo', steps).length, 2, 'a failed import rolls back its receipt and can be retried');
  } finally { reopened.close(); }
});

test('the HTTP routes enforce the same rules', async () => {
  const { todos } = setup();
  // The server turns a thrown fault into its status and message, so the test does the same.
  const call = async (user, method, parts, body, query = '') => {
    let out;
    try {
      await todos.handle({}, {}, { user, device: null, method, parts: ['v1', 'todos', ...parts], url: new URL('http://x/v1/todos' + query),
        send: (_r, status, json) => { out = { status, json }; }, fail: (_r, status, code, message) => { out = { status, json: { code, message } }; }, readBody: async () => body });
    } catch (e) { out = { status: e.status, json: { code: e.code, message: e.message } }; }
    return out;
  };
  const made = await call(pat, 'POST', [], { text: 'Over HTTP', projectId: 'example-app' });
  assert.equal(made.status, 201);
  const id = made.json.todo.id;
  assert.equal((await call(jo, 'GET', [], undefined, '?project=example-app')).json.todos.length, 1);
  assert.equal((await call(ana, 'GET', [], undefined, '?project=example-app')).json.todos.length, 0);
  assert.equal((await call(jo, 'PATCH', [id], { text: 'no' })).json.message, "You can't change this to-do");
  assert.equal((await call(pat, 'PATCH', [id], { status: 'done' })).json.todo.status, 'done');
  assert.equal((await call(pat, 'GET', [], undefined, '?status=done')).json.todos.length, 1);
  assert.equal((await call(pat, 'DELETE', [id])).json.ok, true);
  assert.equal((await call(pat, 'GET', [id])).status, 404, 'a deleted to-do is gone');
  assert.equal((await call(pat, 'PUT', [])).status, 405);
});

test('a to-do whose project was deleted or lost to someone keeps working: no names, and only its people see it', () => {
  const { todos } = setup();
  const t = todos.create(pat, { text: 'Orphan', projectId: 'example-app', releaseId: 'r1', assigneeName: 'Jo' });
  assert.equal(todos.list(jo).length, 1);
  delete projects["example-app"];                                         // the project is gone
  try {
    const mineNow = todos.list(pat)[0];
    assert.deepEqual([mineNow.projectName, mineNow.releaseName], [null, null], 'no stale names');
    assert.equal(mineNow.projectId, null, 'inaccessible project references are masked');
    assert.equal(todos.db.prepare('SELECT project_id FROM todos WHERE id = ?').get(t.id).project_id, 'example-app', 'the stored tag stays in case the project comes back');
    assert.equal(todos.list(jo).length, 1, 'whoever it is for still sees it');
    assert.equal(todos.list(ana).length, 0);
    assert.equal(todos.update(pat, t.id, { text: 'Orphan edited' }).text, 'Orphan edited', 'the author can still edit it');
  } finally {
    projects["example-app"] = { projectName: 'Example app', releases: { r1: 'Nov 17' }, access: { pat: 'write', jo: 'read', owner: 'write' } };
  }
});

test('only a standalone terminal done marker outside quoted or fenced text signals completion', () => {
  for (const text of [
    'The instructions mention <servant-todo-done/> here.',
    '<servant-todo-done/>\nStill working.',
    '> <servant-todo-done/>',
    '`<servant-todo-done/>`',
    '\\<servant-todo-done/>',
    '```text\n<servant-todo-done/>\n```',
    '```text\n<servant-todo-done/>',
    '~~~\n<servant-todo-done/>',
    '    <servant-todo-done/>',
    '<unknown-done/>',
    agentBrief({ todo: { text: 'Finish the task' } }),
  ]) assert.deepEqual(readDoneTag(text), { done: false, text });
  assert.deepEqual(readDoneTag('Finished the checks.\n<servant-todo-done/>\n  '), { done: true, text: 'Finished the checks.' });
  assert.deepEqual(readDoneTag('```\nExample\n```\n<servant-todo-done/>'), { done: true, text: '```\nExample\n```' });
});

test('work logs capture exact completion times and actor provenance for only the people involved', () => {
  const { todos, tick } = setup();
  projects['example-app'].access.ana = 'write';
  try {
    const todo = todos.create(pat, { text: 'Check the release', projectId: 'example-app', releaseId: 'r1', assigneeId: jo.id, channelId: 'c1' });
    tick(1234);
    todos.update(ana, todo.id, { status: 'done' });
    const [entry] = todos.workLog(pat);
    assert.deepEqual(entry, {
      kind: 'todo', id: entry.id, at: 1_001_234, todoId: todo.id, createdAt: 1_000_000, reopenedAt: null, originKind: null, startedAt: null, due: null,
      completedBy: { kind: 'person', id: ana.id, name: ana.name },
      source: { text: todo.text, projectId: 'example-app', projectName: 'Example app', releaseId: 'r1', releaseName: 'Nov 17', channelId: 'c1', channelName: 'example-team' },
    });
    assert.ok(entry.id.startsWith('todo:done_'));
    assert.equal(todos.workLog(jo)[0].id, entry.id, 'assignee at completion gets the event');
    assert.equal(todos.workLog(ana)[0].id, entry.id, 'actual completer gets the event');
    assert.deepEqual(todos.workLog(owner), [], 'project visibility or server-owner role is not personal work');
    tick(2);
    todos.update(ana, todo.id, { status: 'done' });
    assert.deepEqual(todos.workLog(pat), [entry], 'repeating done preserves the completion time');
    tick(7);
    todos.update(pat, todo.id, { status: 'open' });
    assert.equal(todos.workLog(pat)[0].reopenedAt, 1_001_243);
    todos.update(pat, todo.id, { status: 'done' });
    assert.equal(todos.workLog(pat).length, 2);
    assert.equal(todos.workLog(pat)[0].completedBy.id, pat.id);
  } finally { delete projects['example-app'].access.ana; }
});

test('agent completions are explicit and replaying the same turn never re-completes reopened work', async () => {
  const { todos, tick } = setup();
  const todo = todos.create(pat, { text: 'Fix the example', assigneeId: jo.id });
  await todos.sendToAgent(pat, null, todo.id);
  tick(111);
  assert.equal(todos.agentDone('cht_1', 'turn_first'), 1);
  const first = todos.workLog(pat)[0];
  assert.deepEqual(first.completedBy, { kind: 'agent' });
  assert.equal(first.at, 1_000_111);
  assert.equal(todos.agentDone('cht_1', 'turn_first'), 0);
  tick(222);
  todos.update(pat, todo.id, { status: 'open' });
  assert.equal(todos.agentDone('cht_1', 'turn_first'), 0);
  assert.equal(todos.list(pat)[0].status, 'open');
  assert.equal(todos.workLog(pat).length, 1);
  assert.equal(todos.agentDone('cht_1', 'turn_second'), 1);
  assert.equal(todos.workLog(pat).length, 2);
  assert.equal(todos.workLog(jo).length, 2);
  const oldName = jo.name;
  jo.name = 'Agent';
  try {
    todos.update(jo, todo.id, { status: 'open' });
    todos.update(jo, todo.id, { status: 'done' });
    assert.equal(todos.workLog(pat)[0].completedBy.kind, 'person', 'a person named Agent is still a person');
  } finally { jo.name = oldName; }
});

test('work history survives removal and source deletion while content and permission changes stay live', () => {
  let allowed = true;
  const flags = { channels: true };
  const { todos } = setup({ project: (_user, _pid, rid) => allowed ? { projectName: 'Example app', releaseName: rid ? 'Release' : '', canWrite: true } : null, features: () => flags });
  const [todo] = todos.fromRecording(pat, 'rec_example', 'Planning', [{ text: 'First wording', owner: 'Jo' }]);
  todos.update(pat, todo.id, { projectId: 'example-app', channelId: 'c1', status: 'done' });
  const first = todos.workLog(jo)[0];
  assert.equal(first.originKind, 'recording');
  todos.update(pat, todo.id, { text: 'Current wording', assigneeId: ana.id });
  assert.equal(todos.workLog(jo)[0].source.text, 'Current wording');
  allowed = false;
  assert.equal(todos.workLog(jo)[0].source, null, 'past involvement never grants current source access');
  const creator = todos.workLog(pat)[0];
  assert.equal(creator.source.projectId, null);
  assert.equal(creator.source.projectName, null);
  flags.channels = false;
  assert.equal(todos.workLog(pat)[0].source.channelName, null);
  assert.equal(todos.workLog(pat)[0].source.channelId, null);
  assert.ok(todos.workLog(pat)[0].source, 'voice memo follow-ups no longer depend on a meetings flag');
  todos.removeSource('recording', 'rec_example', pat.id);
  const removed = todos.workLog(pat)[0];
  assert.equal(removed.id, first.id);
  assert.equal(removed.source, null);
  assert.equal(removed.originKind, 'recording');
  assert.equal(todos.workLog(ana).length, 0, 'a later assignee does not inherit old personal history');
  const separate = todos.create(pat, { text: 'Another task' });
  todos.update(pat, separate.id, { status: 'done' });
  todos.remove(pat, separate.id);
  assert.equal(todos.workLog(pat).length, 2);
  assert.ok(todos.workLog(pat).every(entry => entry.source === null));
});

test('todo routes hide legacy call tasks and mask disabled or inaccessible source references', async () => {
  const flags = { channels: true };
  let projectVisible = true;
  const { todos, posts } = setup({ features: () => flags,
    project: () => projectVisible ? { projectName: 'Example app', releaseName: 'Example release', canWrite: true } : null });
  const manual = todos.create(pat, { text: 'Independent work', channelId: 'c1', projectId: 'example-app', releaseId: 'r1' });
  const [recording] = todos.fromRecording(pat, 'rec_hidden', 'Private planning title', [{ text: 'Private recorded follow-up' }]);
  const call = todos.create(pat, { text: 'Private call follow-up' }, { source: { kind: 'call', id: 'call_hidden', title: 'Private call title' } });
  todos.update(pat, recording.id, { status: 'done' });
  const get = async (pathname, viewer = pat) => {
    let result;
    await todos.handle({}, {}, { user: viewer, method: 'GET', parts: pathname.split('/').filter(Boolean), url: new URL(pathname, 'http://localhost'),
      send: (_res, status, body) => { result = { status, body }; }, fail: () => assert.fail('unexpected route'), readBody: async () => ({}) });
    return result;
  };
  flags.channels = false;
  projectVisible = false;
  const listed = await get('/v1/todos');
  assert.deepEqual(listed.body.todos.map(todo => todo.id), [manual.id]);
  const item = (await get(`/v1/todos/${manual.id}`)).body.todo;
  assert.equal(item.channelId, null); assert.equal(item.channelName, null);
  assert.equal(item.projectId, null); assert.equal(item.projectName, null);
  assert.equal(item.releaseId, null); assert.equal(item.releaseName, null);
  assert.equal((await get(`/v1/todos/${recording.id}`)).body.todo.source.title, 'Private planning title');
  for (const task of [call]) {
    await assert.rejects(get(`/v1/todos/${task.id}`), error => error.status === 404);
    await assert.rejects(get(`/v1/todos/${task.id}`, owner), error => error.status === 404);
    await assert.rejects(todos.sendToAgent(pat, null, task.id), error => error.status === 404);
    assert.throws(() => todos.update(pat, task.id, { text: 'Cannot change hidden work' }), error => error.status === 404);
  }
  assert.equal(todos.forSource(pat, 'recording', 'rec_hidden').length, 1);
  assert.ok(todos.workLog(pat)[0].source);
  posts.length = 0;
  todos.update(pat, manual.id, { status: 'done' });
  assert.deepEqual(posts, [], 'disabled channels do not receive task content');
  assert.throws(() => todos.create(pat, { text: 'No disabled channel', channelId: 'c1' }), error => error.status === 403);
  flags.channels = true;
  projectVisible = true;
  assert.equal((await get(`/v1/todos/${recording.id}`)).body.todo.source.title, 'Private planning title');
  assert.equal((await get(`/v1/todos/${manual.id}`)).body.todo.channelId, 'c1', 'flags preserve the stored reference');
});

test('sharing a task does not share its private recording or Agent chat', async () => {
  const chatOwners = new Map(), prompts = [];
  const { todos, posts } = setup({ canReadChat: (user, chatId) => chatOwners.get(chatId) === user.id,
    startWork: async options => {
      const chat = { id: `cht_private_${chatOwners.size}` };
      chatOwners.set(chat.id, options.userId);
      prompts.push(options.transcript);
      options.beforeEnqueue(chat);
      return chat;
    } });
  const [first, second, third] = todos.fromRecording(pat, 'rec_private', 'Private budget discussion', [
    { text: 'Prepare the example', owner: 'Jo' }, { text: 'Review the example', owner: 'Jo' }, { text: 'Send the example', owner: 'Jo' },
  ]);
  todos.update(pat, first.id, { projectId: 'example-app' });
  const own = await todos.sendToAgent(pat, null, first.id);
  assert.ok(own.chatId);
  assert.match(prompts[0], /Private budget discussion/);
  const shared = todos.list(jo).find(todo => todo.id === first.id);
  assert.equal(shared.text, first.text, 'assigned task text stays available');
  assert.equal(shared.source, null);
  assert.equal(shared.chatId, null);
  assert.equal(shared.withAgent, true, 'Agent status does not reveal its private chat');
  const repeated = await todos.sendToAgent(jo, null, first.id);
  assert.equal(repeated.chatId, null);
  assert.equal(repeated.todo.chatId, null);
  assert.equal(repeated.started, false);
  assert.equal(todos.list(owner).find(todo => todo.id === first.id).source, null, 'server role does not grant access to a private recording');

  const delegated = await todos.sendToAgent(jo, null, second.id);
  assert.ok(delegated.chatId);
  assert.doesNotMatch(prompts[1], /Private budget discussion|rec_private/);
  assert.equal(todos.list(pat).find(todo => todo.id === second.id).chatId, null, 'task authors do not inherit the assignee’s private chat');
  todos.bulk(jo, [second.id, third.id], { channelId: 'c1' });
  assert.equal(posts.length, 1);
  assert.doesNotMatch(posts[0].text, /Private budget discussion/);
  todos.agentDone(delegated.chatId, 'turn_private');
  const completed = todos.list(pat, { status: 'done' }).find(todo => todo.id === second.id);
  assert.equal(completed.doneBy, 'agent');
  assert.equal(completed.withAgent, false);
  assert.equal(completed.chatId, null);

  const closed = setup({ canReadChat: undefined });
  const task = closed.todos.create(pat, { text: 'No permission adapter' });
  const sent = await closed.todos.sendToAgent(pat, null, task.id);
  assert.equal(sent.chatId, null, 'missing chat authorization fails closed');
  assert.equal(sent.todo.withAgent, true);
});

test('shared database transactions preserve authored changes and fail closed before deleting anything', () => {
  const messaging = createMessaging({ file: ':memory:', users: () => people, agentName: () => 'Agent' });
  const room = messaging.createChannel(pat, { name: 'example-app' });
  const { todos } = setup({ db: messaging.db, recordsPreservation: () => true,
    channel: () => ({ name: room.name }), announce: (_channelId, userId, text) => messaging.post(room, userId, text) });
  try {
    const todo = todos.create(pat, { text: 'Original wording', channelId: room.id });
    todos.update(pat, todo.id, { text: 'Edited wording' });
    const archived = messaging.db.prepare('SELECT * FROM records_archive').all();
    assert.equal(archived.length, 1);
    assert.equal(archived[0].text, 'Original wording');
    assert.equal(archived[0].actor_id, pat.id);
    assert.equal(JSON.parse(archived[0].detail).channel_id, room.id);
    assert.equal(verifyChain(messaging.db).ok, true);
    messaging.db.exec("CREATE TRIGGER refuse_todo_record BEFORE INSERT ON records_archive BEGIN SELECT RAISE(ABORT, 'test archive failure'); END");
    for (const work of [
      () => todos.update(pat, todo.id, { text: 'Must not replace' }),
      () => todos.update(pat, todo.id, { status: 'done' }),
      () => todos.remove(pat, todo.id),
    ]) assert.throws(work, e => e.status === 503 && e.code === 'records_preservation_failed');
    assert.equal(todos.list(pat)[0].text, 'Edited wording');
    assert.equal(todos.list(pat)[0].status, 'open');
    assert.deepEqual(todos.workLog(pat), []);
    messaging.db.exec('DROP TRIGGER refuse_todo_record');
    todos.update(pat, todo.id, { status: 'done' });
    assert.equal(todos.workLog(pat).length, 1);
    todos.remove(pat, todo.id);
    assert.equal(todos.workLog(pat)[0].source, null);
    assert.equal(verifyChain(messaging.db).ok, true);
    todos.close();
    assert.equal(messaging.db.prepare('SELECT COUNT(*) AS n FROM records_archive').get().n, 3, 'closing the todo service leaves its injected database open');
  } finally { messaging.close(); }
});

test('history insertion and bulk/source changes are atomic, with announcements only after commit', () => {
  const { todos, posts } = setup({ recordsPreservation: () => true });
  const [first, second] = todos.fromRecording(pat, 'rec_atomic', 'Atomic notes', [{ text: 'One' }, { text: 'Two' }]);
  todos.bulk(pat, [first.id, second.id], { channelId: 'c1' });
  posts.length = 0;
  todos.db.exec("CREATE TRIGGER refuse_todo_completion BEFORE INSERT ON todo_completions BEGIN SELECT RAISE(ABORT, 'test completion failure'); END");
  assert.throws(() => todos.bulk(pat, [first.id, second.id], { status: 'done' }), /test completion failure/);
  assert.equal(todos.list(pat).length, 2);
  assert.equal(todos.workLog(pat).length, 0);
  assert.equal(posts.length, 0);
  todos.db.exec('DROP TRIGGER refuse_todo_completion');
  ensureRecordsSchema(todos.db);
  const before = todos.db.prepare('SELECT COUNT(*) AS n FROM records_archive').get().n;
  todos.db.exec(`CREATE TRIGGER refuse_second_todo BEFORE INSERT ON records_archive WHEN NEW.conversation_id = '${second.id}' BEGIN SELECT RAISE(ABORT, 'second record failed'); END`);
  assert.throws(() => todos.removeSource('recording', 'rec_atomic', pat.id), e => e.code === 'records_preservation_failed');
  assert.equal(todos.forSource(pat, 'recording', 'rec_atomic').length, 2);
  assert.equal(todos.db.prepare('SELECT COUNT(*) AS n FROM records_archive').get().n, before, 'partial archive copies roll back too');
  todos.db.exec('DROP TRIGGER refuse_second_todo');
  todos.bulk(pat, [first.id, second.id], { status: 'done' });
  assert.equal(todos.workLog(pat).length, 2);
  assert.throws(() => todos.db.exec("UPDATE todo_completions SET actor_kind = 'agent'"), /cannot be rewritten/);
  assert.throws(() => todos.db.exec('DELETE FROM todo_completions'), /cannot be deleted/);
});

test('legacy standalone tasks migrate once with completion provenance and the source database remains untouched', () => {
  const legacy = setup();
  const todo = legacy.todos.create(pat, { text: 'Legacy completed task', assigneeId: jo.id }, { source: { kind: 'recording', id: 'rec_legacy', title: 'Legacy memo' } });
  // Reproduce the old store before completion history and its current link existed.
  legacy.todos.db.prepare("UPDATE todos SET status = 'done', done_at = 987654321, done_by = 'agent' WHERE id = ?").run(todo.id);
  const unknown = legacy.todos.create(pat, { text: 'Legacy actor unknown' });
  legacy.todos.db.prepare("UPDATE todos SET status = 'done', done_at = 987654322 WHERE id = ?").run(unknown.id);
  const noTime = legacy.todos.create(pat, { text: 'Legacy time unknown' });
  legacy.todos.db.prepare("UPDATE todos SET status = 'done' WHERE id = ?").run(noTime.id);
  const target = new DatabaseSync(':memory:');
  let adopted = setup({ db: target, legacyFile: legacy.file }).todos;
  try {
    assert.equal(adopted.list(pat, { status: 'done' }).length, 3);
    const history = adopted.workLog(pat);
    assert.equal(history.length, 2, 'no completion time is invented for an unknown legacy date');
    assert.equal(history.find(entry => entry.todoId === todo.id).at, 987654321);
    assert.deepEqual(history.find(entry => entry.todoId === todo.id).completedBy, { kind: 'agent' });
    assert.deepEqual(history.find(entry => entry.todoId === unknown.id).completedBy, { kind: 'unknown' });
    adopted.remove(pat, todo.id);
    assert.deepEqual(adopted.fromRecording(pat, 'rec_legacy', 'Legacy memo', [{ text: 'Legacy completed task' }]), [], 'existing source tasks get import receipts during migration');
    adopted.close();
    adopted = setup({ db: target, legacyFile: legacy.file }).todos;
    assert.equal(adopted.list(pat, { status: 'done' }).length, 2, 'the import marker prevents resurrection');
    assert.equal(adopted.workLog(pat).length, 2, 'history is never backfilled twice');
    assert.equal(adopted.workLog(pat).find(entry => entry.todoId === todo.id).source, null);
    assert.equal(legacy.todos.db.prepare('SELECT text FROM todos WHERE id = ?').get(todo.id).text, todo.text);
  } finally { adopted.close(); target.close(); }
});
