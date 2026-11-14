// To-dos as a tracker: a key, a kind, a priority, an estimate, a description, comments, and epics.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createTodos, keyPrefix } from './todos.mjs';
import { csvCell, jiraCsv, jiraTime } from './jira-export.mjs';

const pat = { id: 'pat', name: 'Pat Tester', role: 'member' };
const jo = { id: 'jo', name: 'Jo Park', role: 'member' };
const ana = { id: 'ana', name: 'Ana Ruiz', role: 'member' };
const people = { pat, jo, ana };
const cleanup = [];
after(() => { for (const close of cleanup) close(); });
// Project "example-app" ("Example app"): Pat writes, Jo reads, Ana is not in it.
function setup(over = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'servant-tracker-')), 'todos.db');
  let clock = 1_000_000;
  const todos = createTodos({
    file, log: { error() {} }, now: () => ++clock,
    users: () => people,
    project: (user, pid) => pid === 'example-app' && ['pat', 'jo'].includes(user.id) ? { projectName: 'Example app', releaseName: '', releaseDate: '', canWrite: user.id === 'pat' } : null,
    channel: () => null, announce: () => {}, canReadChat: () => true,
    ...over,
  });
  cleanup.push(() => { try { todos.close(); } catch {} fs.rmSync(path.dirname(file), { recursive: true, force: true }); });
  return { todos, file };
}

test('every to-do has a number that never changes, shown with its project initials', () => {
  assert.deepEqual(['Example app', 'Prototypes', 'example-app 2', '', null, '!!'].map(keyPrefix), ['EA', 'PROT', 'EA2', 'TODO', 'TODO', 'TODO']);
  const { todos } = setup();
  const first = todos.create(pat, { text: 'First' });
  const second = todos.create(pat, { text: 'Second', projectId: 'example-app' });
  assert.deepEqual([first.number, first.key, second.number, second.key], [1, 'TODO-1', 2, 'EA-2']);
  // Tagging it with a project changes the letters, never the number; deleting one does not hand its number on.
  assert.equal(todos.update(pat, first.id, { projectId: 'example-app' }).key, 'EA-1');
  todos.remove(pat, second.id);
  todos.remove(pat, first.id);
  assert.equal(todos.create(pat, { text: 'Third' }).number, 1, 'with nothing left the count starts again');
  assert.equal(todos.create(pat, { text: 'Fourth' }).number, 2);
});

test('a to-do list from before the tracker is numbered in the order it was written', () => {
  const { todos, file } = setup();
  const ids = ['One', 'Two', 'Three'].map(text => todos.create(pat, { text }).id);
  todos.close();
  const db = new DatabaseSync(file);
  db.exec('DROP INDEX todos_number; UPDATE todos SET number = NULL, type = NULL');
  db.close();
  const again = createTodos({ file, log: { error() {} }, users: () => people, project: () => null, channel: () => null, announce: () => {} });
  cleanup.push(() => again.close());
  assert.deepEqual(again.list(pat).map(todo => [todo.id, todo.key, todo.type]), ids.map((id, index) => [id, `TODO-${index + 1}`, 'task']));
});

test('kind, priority, estimate and description are checked and saved', () => {
  const { todos } = setup();
  const plain = todos.create(pat, { text: 'Plain' });
  assert.deepEqual([plain.type, plain.priority, plain.estimate, plain.description, plain.commentCount, plain.jiraKey], ['task', null, null, '', 0, null]);
  const bug = todos.create(pat, { text: 'Login fails', type: 'bug', priority: 'high', estimate: '3', description: 'Steps:\r\n1. Open the page\n2. Sign in' });
  assert.deepEqual([bug.type, bug.priority, bug.estimate, bug.description], ['bug', 'high', 3, 'Steps:\n1. Open the page\n2. Sign in']);
  const changed = todos.update(pat, bug.id, { type: 'story', priority: null, estimate: 0.5, description: '' });
  assert.deepEqual([changed.type, changed.priority, changed.estimate, changed.description], ['story', null, 0.5, '']);
  for (const patch of [{ type: 'chore' }, { priority: 'urgent' }, { estimate: 'big' }, { estimate: -1 }, { estimate: 5000 }, { jiraKey: 'not a key' }]) {
    assert.throws(() => todos.update(pat, bug.id, patch), e => e.status === 400, JSON.stringify(patch));
    if (!patch.jiraKey) assert.throws(() => todos.create(pat, { text: 'Bad', ...patch }), e => e.status === 400, JSON.stringify(patch));
  }
  assert.equal(todos.list(pat).some(todo => todo.text === 'Bad'), false, 'a refused to-do is not created');
  assert.equal(todos.update(pat, bug.id, { description: 'x'.repeat(6000) }).description.length, 5000);
  assert.equal(todos.update(pat, bug.id, { jiraKey: 'app-42' }).jiraKey, 'APP-42');
  assert.equal(todos.update(pat, bug.id, { jiraKey: '' }).jiraKey, null);
  // Someone who cannot change the to-do cannot change these either.
  const shared = todos.create(pat, { text: 'Shared', projectId: 'example-app' });
  assert.throws(() => todos.update(jo, shared.id, { priority: 'high' }));
  assert.equal(todos.list(jo).find(todo => todo.id === shared.id).priority, null);
});

test('an epic holds other to-dos; only an epic you can see can be chosen', () => {
  const { todos } = setup();
  const epic = todos.create(pat, { text: 'Guest mode', type: 'epic', projectId: 'example-app' });
  const child = todos.create(pat, { text: 'Guest sign-in', projectId: 'example-app', parentId: epic.id });
  assert.deepEqual([child.parentId, child.parentText], [epic.id, 'Guest mode']);
  const other = todos.create(pat, { text: 'Unrelated' });
  assert.deepEqual(todos.list(pat, { epic: epic.id, status: 'all' }).map(todo => todo.text), ['Guest mode', 'Guest sign-in']);
  // Not itself, not a to-do that is not an epic, not an epic under an epic, not one that does not exist.
  assert.throws(() => todos.update(pat, epic.id, { parentId: epic.id }), e => e.status === 400);
  assert.throws(() => todos.update(pat, other.id, { parentId: child.id }), e => e.status === 400 && /Choose an epic/.test(e.message));
  assert.throws(() => todos.update(pat, other.id, { parentId: 'todo_missing' }), e => e.status === 404);
  assert.throws(() => todos.create(pat, { text: 'Nested', type: 'epic', parentId: epic.id }), e => e.status === 400);
  // An epic with to-dos under it stays an epic until they are moved.
  assert.throws(() => todos.update(pat, epic.id, { type: 'task' }), e => e.status === 409);
  // A private epic is not offered to, or named for, someone who cannot see it.
  const mine = todos.create(pat, { text: 'Private epic', type: 'epic' });
  const jos = todos.create(jo, { text: "Jo's own" });
  assert.throws(() => todos.update(jo, jos.id, { parentId: mine.id }), e => e.status === 404);
  const hidden = todos.create(pat, { text: 'In the project, under a private epic', projectId: 'example-app', parentId: mine.id });
  assert.deepEqual([todos.list(jo).find(todo => todo.id === hidden.id).parentId, todos.list(pat).find(todo => todo.id === hidden.id).parentId], [null, mine.id]);
  // Deleting an epic leaves its to-dos, no longer under it.
  todos.remove(pat, epic.id);
  assert.deepEqual([todos.list(pat).find(todo => todo.id === child.id).parentId, todos.list(pat).some(todo => todo.id === epic.id)], [null, false]);
  assert.equal(todos.update(pat, child.id, { parentId: null }).parentId, null);
});

test('anyone who can see a to-do can comment on it, and nobody else', () => {
  const { todos } = setup();
  const shared = todos.create(pat, { text: 'Shared', projectId: 'example-app' });
  const first = todos.comment(pat, shared.id, { text: '  Waiting on the vendor.\r\nBack Monday.  ' });
  assert.deepEqual([first.text, first.author], ['Waiting on the vendor.\nBack Monday.', { id: 'pat', name: 'Pat Tester' }]);
  todos.comment(jo, shared.id, { text: 'I can take it.' });
  assert.deepEqual(todos.comments(jo, shared.id).map(comment => [comment.author.name, comment.text]), [['Pat Tester', 'Waiting on the vendor.\nBack Monday.'], ['Jo Park', 'I can take it.']]);
  assert.equal(todos.list(pat).find(todo => todo.id === shared.id).commentCount, 2);
  assert.throws(() => todos.comment(pat, shared.id, { text: '   ' }), e => e.status === 400);
  assert.throws(() => todos.comment(ana, shared.id, { text: 'Let me in' }));
  assert.throws(() => todos.comments(ana, shared.id));
  assert.equal(todos.comment(pat, shared.id, { text: 'y'.repeat(3000) }).text.length, 2000);
  assert.equal(todos.comments(pat, shared.id).length, 3);
});

// Records preservation: tracker fields are edits like any other, and a deleted to-do's comments go with its copy.
test('records preservation keeps the earlier fields and a deleted to-do with its comments, and fails closed', () => {
  const { todos } = setup({ recordsPreservation: () => true });
  const epic = todos.create(pat, { text: 'Epic', type: 'epic' });
  const todo = todos.create(pat, { text: 'Tracked', priority: 'high', description: 'First words', parentId: epic.id });
  todos.update(pat, todo.id, { priority: 'low', description: 'Second words' });
  todos.comment(pat, todo.id, { text: 'Keep this comment' });
  const archived = () => todos.db.prepare('SELECT event, conversation_id, detail FROM records_archive ORDER BY rowid').all().map(row => ({ ...row, detail: JSON.parse(row.detail) }));
  assert.deepEqual(archived().map(row => [row.event, row.detail.priority, row.detail.description]), [['todo_changed', 'high', 'First words']]);
  todos.db.exec("CREATE TRIGGER refuse_tracker_record BEFORE INSERT ON records_archive BEGIN SELECT RAISE(ABORT, 'test archive failure'); END");
  for (const work of [
    () => todos.update(pat, todo.id, { description: 'Third words' }),
    () => todos.update(pat, todo.id, { type: 'bug' }),
    () => todos.update(pat, todo.id, { parentId: null }),
    () => todos.remove(pat, todo.id),
    () => todos.remove(pat, epic.id),
  ]) assert.throws(work, e => e.status === 503 && e.code === 'records_preservation_failed');
  const kept = todos.list(pat).find(item => item.id === todo.id);
  assert.deepEqual([kept.description, kept.type, kept.parentId, kept.commentCount, todos.list(pat).length], ['Second words', 'task', epic.id, 1, 2], 'nothing changes when the copy cannot be saved');
  todos.db.exec('DROP TRIGGER refuse_tracker_record');
  // Deleting the epic archives it and the change to its to-do; deleting the to-do archives it with its comment.
  todos.remove(pat, epic.id);
  todos.remove(pat, todo.id);
  const after = archived().slice(1);
  assert.deepEqual(after.map(row => [row.event, row.conversation_id]), [['todo_deleted', epic.id], ['todo_changed', todo.id], ['todo_deleted', todo.id]]);
  assert.equal(after[1].detail.parent_id, epic.id, 'the to-do as it was while under the epic');
  assert.deepEqual(after[2].detail.comments.map(comment => [comment.author_id, comment.text]), [['pat', 'Keep this comment']]);
  assert.equal(todos.db.prepare('SELECT COUNT(*) AS n FROM todo_comments').get().n, 0);
});

// The copy for Jira: one CSV its importer reads. Servant is where the work is done.
test('the Jira export has one row per to-do the person can see, with epics linked and comments in their own columns', () => {
  const { todos } = setup();
  const epic = todos.create(pat, { text: 'Guest mode', type: 'epic', projectId: 'example-app' });
  const bug = todos.create(pat, { text: 'Sign-in fails, "sometimes"', type: 'bug', priority: 'high', estimate: 3, projectId: 'example-app', parentId: epic.id,
    description: 'Steps:\n1. Open the page', dueDate: '2026-11-20', assigneeName: 'Jo Park' });
  todos.update(pat, bug.id, { stage: 'doing', jiraKey: 'APP-42' });
  todos.comment(jo, bug.id, { text: 'Seen it; on a phone only' });
  todos.comment(pat, bug.id, { text: 'Thanks' });
  const own = todos.create(pat, { text: 'Private note' });
  todos.update(pat, own.id, { status: 'done' });
  const out = todos.jiraExport(pat);
  const lines = out.csv.split('\r\n');
  assert.equal(lines[0], 'Issue Key,Issue Id,Parent Id,Summary,Issue Type,Status,Priority,Description,Assignee,Reporter,Due Date,Created,Resolved,Story Points,Fix Version,Labels,Comment,Comment');
  assert.equal(lines[1], `,1,,Guest mode,Epic,To Do,,,,Pat Tester,,${jiraTime(1_000_001)},,,,servant-1,,`);
  assert.match(out.csv, /\r\nAPP-42,2,1,"Sign-in fails, ""sometimes""",Bug,In Progress,High,"Steps:\n1\. Open the page",Jo Park,Pat Tester,2026-11-20,1970-01-01 00:16,,3,,servant-2,1970-01-01 00:16; Jo Park; Seen it; on a phone only,1970-01-01 00:16; Pat Tester; Thanks\r\n/);
  assert.match(lines.at(-2), /^,3,,Private note,Task,Done,,,,Pat Tester,,1970-01-01 00:16,1970-01-01 00:16,,,servant-3,,$/);
  assert.equal(lines.at(-1), '', 'the file ends with a line break');
  assert.deepEqual([out.count, out.dateFormat, out.issues.map(issue => [issue.number, issue.key, issue.jiraKey])], [3, 'yyyy-MM-dd HH:mm', [[1, 'EA-1', null], [2, 'EA-2', 'APP-42'], [3, 'TODO-3', null]]]);
  // Only what the person can see: Jo is in the project but not in Pat's private to-do; Ana sees nothing.
  assert.deepEqual(todos.jiraExport(jo).issues.map(issue => issue.number), [1, 2]);
  assert.equal(todos.jiraExport(ana).count, 0);
  assert.deepEqual(todos.jiraExport(pat, { project: 'example-app' }).issues.map(issue => issue.number), [1, 2]);
  assert.throws(() => todos.jiraExport(ana, { project: 'example-app' }), e => e.status === 404);
  assert.deepEqual([csvCell('plain'), csvCell('a,b'), csvCell('say "hi"'), csvCell('two\nlines'), csvCell(null), csvCell(0)], ['plain', '"a,b"', '"say ""hi"""', '"two\nlines"', '', '0']);
  assert.equal(jiraCsv([]), 'Issue Key,Issue Id,Parent Id,Summary,Issue Type,Status,Priority,Description,Assignee,Reporter,Due Date,Created,Resolved,Story Points,Fix Version,Labels\r\n');
});
