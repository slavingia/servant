// The board: a to-do is to do, in progress or done, and has a due date: its own, or its release's when it has none.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createTodos } from './todos.mjs';

const pat = { id: 'pat', name: 'Pat Tester', role: 'member' };
const jo = { id: 'jo', name: 'Jo Park', role: 'member' };
const people = { pat, jo };
// Release r1 ships on a date; r2 has none.
const releases = { r1: { name: 'Nov 17', date: '2026-11-17' }, r2: { name: 'Later', date: '' } };
const cleanup = [];
after(() => { for (const close of cleanup) close(); });
function setup(over = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'servant-board-')), 'todos.db');
  let clock = 1_000_000;
  const todos = createTodos({
    file, log: { error() {} }, now: () => clock,
    users: () => people,
    project: (user, pid, rid) => {
      if (pid !== 'example-app' || (rid && !releases[rid])) return null;
      return { projectName: 'Example app', releaseName: rid ? releases[rid].name : '', releaseDate: rid ? releases[rid].date : '', canWrite: user.id === 'pat' };
    },
    channel: () => null, announce: () => {}, canReadChat: () => true,
    startWork: async o => { const chat = { id: 'cht_1' }; o.beforeEnqueue(chat); return chat; },
    ...over,
  });
  cleanup.push(() => { try { todos.close(); } catch {} fs.rmSync(path.dirname(file), { recursive: true, force: true }); });
  return { todos, file, tick: ms => { clock += ms; } };
}
const due = todo => [todo.dueDate, todo.due, todo.dueFrom];

test('a to-do is due on its own date; without one, on its release date', () => {
  const { todos } = setup();
  const plain = todos.create(pat, { text: 'No date' });
  assert.deepEqual(due(plain), [null, null, null]);
  const own = todos.create(pat, { text: 'Own date', dueDate: '2026-11-20' });
  assert.deepEqual(due(own), ['2026-11-20', '2026-11-20', 'own']);
  const released = todos.create(pat, { text: 'With the release', projectId: 'example-app', releaseId: 'r1' });
  assert.deepEqual(due(released), [null, '2026-11-17', 'release']);
  // Its own date wins over the release's, and clearing it falls back to the release's again.
  assert.deepEqual(due(todos.update(pat, released.id, { dueDate: '2026-11-10' })), ['2026-11-10', '2026-11-10', 'own']);
  assert.deepEqual(due(todos.update(pat, released.id, { dueDate: null })), [null, '2026-11-17', 'release']);
  // A release without a date gives none, and so does a project on its own.
  assert.deepEqual(due(todos.update(pat, released.id, { releaseId: 'r2' })), [null, null, null]);
  assert.deepEqual(due(todos.update(pat, released.id, { releaseId: null })), [null, null, null]);
  // The list carries the same fields.
  assert.deepEqual(todos.list(pat).map(due), [[null, null, null], ['2026-11-20', '2026-11-20', 'own'], [null, null, null]]);
});

test('a due date is a real day or nothing', () => {
  const { todos } = setup();
  const todo = todos.create(pat, { text: 'Dated', dueDate: '2026-11-20' });
  for (const bad of ['tomorrow', '2026-02-30', '2026-13-01', '20261120', 20261120, '1999-01-01']) {
    assert.throws(() => todos.update(pat, todo.id, { dueDate: bad }), e => e.status === 400 && /due date/.test(e.message), String(bad));
    assert.throws(() => todos.create(pat, { text: 'Bad', dueDate: bad }), e => e.status === 400, String(bad));
  }
  assert.equal(todos.list(pat)[0].dueDate, '2026-11-20', 'a refused date changes nothing');
  assert.equal(todos.list(pat).length, 1);
  assert.equal(todos.update(pat, todo.id, { dueDate: '' }).dueDate, null);
});

test('a card moves between To do, In progress and Done; both open columns are open to-dos', () => {
  const { todos } = setup();
  const todo = todos.create(pat, { text: 'Move me' });
  assert.deepEqual([todo.stage, todo.status], ['todo', 'open']);
  const doing = todos.update(pat, todo.id, { stage: 'doing' });
  assert.deepEqual([doing.stage, doing.status], ['doing', 'open']);
  const done = todos.update(pat, todo.id, { stage: 'done' });
  assert.deepEqual([done.stage, done.status, done.doneBy], ['done', 'done', 'Pat Tester']);
  assert.equal(todos.workLog(pat).length, 1, 'dragging to Done completes it like ticking the box');
  // Back to In progress from Done reopens it there; ticking then unticking the box puts it in To do.
  assert.deepEqual([todos.update(pat, todo.id, { stage: 'doing' }).stage, todos.list(pat)[0].status], ['doing', 'open']);
  assert.equal(todos.update(pat, todo.id, { status: 'done' }).stage, 'done');
  assert.equal(todos.update(pat, todo.id, { status: 'open' }).stage, 'todo');
  assert.equal(todos.update(pat, todo.id, { stage: 'doing' }).stage, 'doing');
  assert.equal(todos.update(pat, todo.id, { stage: 'todo' }).stage, 'todo');
  assert.throws(() => todos.update(pat, todo.id, { stage: 'blocked' }), e => e.status === 400);
  assert.throws(() => todos.update(pat, todo.id, { stage: 'done', status: 'open' }), e => e.status === 400);
  // Someone who cannot change the to-do cannot move it.
  assert.throws(() => todos.update(jo, todo.id, { stage: 'doing' }));
  assert.equal(todos.list(pat)[0].stage, 'todo');
});

test('sending a to-do to the agent moves it to In progress; a failed hand-off puts it back', async () => {
  const { todos } = setup();
  const todo = todos.create(pat, { text: 'Draft the notice' });
  const sent = await todos.sendToAgent(pat, null, todo.id);
  assert.deepEqual([sent.todo.stage, sent.todo.status, sent.chatId], ['doing', 'open', 'cht_1']);
  const failing = setup({ startWork: async () => { throw new Error('agent is down'); } });
  const other = failing.todos.create(pat, { text: 'Try me' });
  await assert.rejects(failing.todos.sendToAgent(pat, null, other.id), /agent is down/);
  assert.equal(failing.todos.list(pat)[0].stage, 'todo');
});

test('a to-do list from before the board opens with every open to-do in To do', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'servant-board-old-')), 'todos.db');
  cleanup.push(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  const first = createTodos({ file, log: { error() {} }, users: () => people, project: () => null, channel: () => null, announce: () => {} });
  const id = first.create(pat, { text: 'From before' }).id;
  first.close();
  const db = new DatabaseSync(file);
  db.exec('ALTER TABLE todos DROP COLUMN due_date; ALTER TABLE todos DROP COLUMN started_at;');
  db.close();
  const again = createTodos({ file, log: { error() {} }, users: () => people, project: () => null, channel: () => null, announce: () => {} });
  cleanup.push(() => again.close());
  const [todo] = again.list(pat);
  assert.deepEqual([todo.id, todo.stage, todo.due], [id, 'todo', null]);
  assert.equal(again.update(pat, id, { stage: 'doing', dueDate: '2026-12-01' }).due, '2026-12-01');
});

// Records preservation: a due date or a move is a change to a to-do like any other.
test('records preservation keeps a copy before a due date or a move changes a to-do, and fails closed', () => {
  const { todos } = setup({ recordsPreservation: () => true });
  const todo = todos.create(pat, { text: 'Keep me', dueDate: '2026-11-20' });
  todos.update(pat, todo.id, { dueDate: '2026-11-25' });
  todos.update(pat, todo.id, { stage: 'doing' });
  const archived = todos.db.prepare('SELECT event, detail FROM records_archive ORDER BY rowid').all().map(row => [row.event, JSON.parse(row.detail).due_date, JSON.parse(row.detail).started_at]);
  assert.deepEqual(archived, [['todo_changed', '2026-11-20', null], ['todo_changed', '2026-11-25', null]]);
  todos.db.exec("CREATE TRIGGER refuse_board_record BEFORE INSERT ON records_archive BEGIN SELECT RAISE(ABORT, 'test archive failure'); END");
  for (const patch of [{ dueDate: null }, { dueDate: '2026-12-01' }, { stage: 'todo' }, { stage: 'done' }]) {
    assert.throws(() => todos.update(pat, todo.id, patch), e => e.status === 503 && e.code === 'records_preservation_failed');
  }
  const [after] = todos.list(pat);
  assert.deepEqual([after.dueDate, after.stage], ['2026-11-25', 'doing'], 'nothing changes when the copy cannot be saved');
});

// The work log: a finished to-do's entry says when work on it began and when it was due, as they were at that moment.
test('a completion carries when the to-do was started and when it was due, and neither can be rewritten', async () => {
  const { todos, tick } = setup();
  const own = todos.create(pat, { text: 'Own date', dueDate: '2026-11-20' });
  tick(100);
  todos.update(pat, own.id, { stage: 'doing' });
  tick(100);
  todos.update(pat, own.id, { stage: 'done' });
  const released = todos.create(pat, { text: 'With the release', projectId: 'example-app', releaseId: 'r1' });
  todos.update(pat, released.id, { status: 'done' });
  const plain = todos.create(pat, { text: 'Neither' });
  todos.update(pat, plain.id, { status: 'done' });
  const sent = todos.create(pat, { text: 'For the agent', dueDate: '2026-12-01' });
  tick(50);
  await todos.sendToAgent(pat, null, sent.id);
  tick(50);
  assert.equal(todos.agentDone('cht_1', 'turn_1'), 1);
  const log = Object.fromEntries(todos.workLog(pat).map(entry => [entry.source.text, [entry.startedAt, entry.due, entry.completedBy.kind]]));
  assert.deepEqual(log, {
    'Own date': [1_000_100, '2026-11-20', 'person'],
    'With the release': [null, '2026-11-17', 'person'],
    'Neither': [null, null, 'person'],
    'For the agent': [1_000_250, '2026-12-01', 'agent'],
  });
  // Changing the to-do afterwards, or reopening it, leaves the entry as it was written.
  todos.update(pat, own.id, { stage: 'todo', dueDate: '2027-01-01' });
  const entry = todos.workLog(pat).find(item => item.source.text === 'Own date');
  assert.deepEqual([entry.startedAt, entry.due, entry.reopenedAt !== null], [1_000_100, '2026-11-20', true]);
  assert.throws(() => todos.db.prepare("UPDATE todo_completions SET due_date = '2030-01-01'").run(), /cannot be rewritten/);
  assert.throws(() => todos.db.prepare('UPDATE todo_completions SET started_at = 1').run(), /cannot be rewritten/);
});
