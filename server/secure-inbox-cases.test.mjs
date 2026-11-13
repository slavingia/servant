import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSecureInbox } from './secure-inbox.mjs';

const staff = { id: 'owner', name: 'Pat Tester', role: 'owner' };
const member = { id: 'member', name: 'Jo Park', role: 'member' };
const people = () => ({ owner: staff, member });
const request = extra => ({ requestId: crypto.randomUUID(), ...extra });
const startInput = extra => request({ name: 'Ana Ruiz', email: 'ana@example.gov', subject: 'Private question', text: 'Hello team', ...extra });
const attachment = { name: 'private.txt', data: Buffer.from('Internal document').toString('base64') };
function setup(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-cases-'));
  let inbox = createSecureInbox({ directory, users: people, ...options });
  t.after(() => { inbox?.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { get inbox() { return inbox; }, directory, close() { inbox.close(); inbox = null; }, reopen() { inbox = createSecureInbox({ directory, users: people, ...options }); return inbox; }, restart() { this.close(); return this.reopen(); } };
}
const view = (inbox, id) => inbox.caseDetail(staff, id);

test('private notes, files, task work, and case references never change any guest JSON, including start replay', t => {
  let at = Date.UTC(2026, 10, 11, 10);
  const { inbox } = setup(t, { now: () => at });
  const original = startInput();
  const a = inbox.start(original);
  const id = a.conversation.id;
  const guestBefore = inbox.guestDetail(a.token);
  const publicReplay = inbox.start(original);
  assert.equal(view(inbox, id).reference, 'CASE-000001');
  assert.equal('reference' in guestBefore.conversation, false);
  const noteInput = request({ text: 'Internal discussion only', attachments: [attachment] });
  at += 1000;
  const note = inbox.addNote(staff, id, noteInput).note;
  assert.equal(inbox.addNote(staff, id, noteInput).note.id, note.id);
  assert.equal(inbox.noteFile(member, id, note.attachments[0].id).file.data, attachment.data);
  assert.throws(() => inbox.guestFile(a.token, note.attachments[0].id), { status: 404 });
  assert.throws(() => inbox.staffFile(staff, id, note.attachments[0].id), { status: 404 });
  at += 1000;
  const task = inbox.addTask(staff, id, request({ text: 'Review the evidence', assigneeId: member.id, dueDate: '2026-11-11' })).task;
  at += 1000;
  inbox.changeTask(member, id, task.id, request({ status: 'done', dueDate: '2026-11-12' }));
  at += 1000;
  inbox.changeTask(staff, id, task.id, request({ status: 'open', assigneeId: null }));
  at += 1000;
  inbox.update(staff, id, { assigneeId: member.id });
  at += 1000;
  inbox.visitorLink(staff, id, 'https://chat.example.gov');
  assert.deepEqual(inbox.guestDetail(a.token), guestBefore);
  assert.deepEqual(inbox.start(original), publicReplay);
  assert.equal(inbox.staffDetail(staff, id).conversation.updatedAt, at);
  assert.equal(view(inbox, id).openTaskCount, 1);
  assert.equal(view(inbox, id).nextAction.id, task.id);
  assert.deepEqual(inbox.notes(member, id).notes.map(n => n.text), ['Internal discussion only']);
  assert.deepEqual(inbox.activity(staff, id).activity.map(a => a.kind), ['case.created', 'note.added', 'task.created', 'task.completed', 'task.reopened', 'case.assigned', 'case.link-created']);
});

test('task next action, UTC due scope, ownership scopes, reference search and completion follow the case workflow', t => {
  const { inbox } = setup(t, { now: () => Date.UTC(2026, 10, 11, 23, 59) });
  const a = inbox.start(startInput()), id = a.conversation.id;
  const b = inbox.start(startInput({ subject: 'Second request' }));
  const undated = inbox.addTask(staff, id, request({ text: 'No date yet' })).task;
  const future = inbox.addTask(staff, id, request({ text: 'Later', dueDate: '2026-11-12' })).task;
  const today = inbox.addTask(staff, id, request({ text: 'Today', dueDate: '2026-11-11', assigneeId: member.id })).task;
  const overdue = inbox.addTask(staff, id, request({ text: 'Overdue', dueDate: '2026-11-10' })).task;
  assert.deepEqual(view(inbox, id).tasks.map(task => task.id), [overdue.id, today.id, future.id, undated.id]);
  assert.equal(view(inbox, id).nextAction.id, overdue.id);
  assert.deepEqual(inbox.list(member, { scope: 'mine' }).conversations.map(c => c.id), [id]);
  assert.equal(inbox.list(staff, { scope: 'mine' }).conversations.length, 0);
  assert.equal(inbox.list(staff, { scope: 'unassigned' }).conversations.length, 2);
  assert.deepEqual(inbox.list(staff, { scope: 'due' }).conversations.map(c => c.id), [id]);
  assert.deepEqual(inbox.list(staff, { q: 'case-000001' }).conversations.map(c => c.id), [id]);
  inbox.changeTask(staff, id, overdue.id, request({ status: 'done' }));
  inbox.changeTask(staff, id, today.id, request({ status: 'done' }));
  assert.equal(view(inbox, id).nextAction.id, future.id);
  assert.equal(inbox.list(staff, { scope: 'due' }).conversations.length, 0);
  assert.equal(inbox.list(member, { scope: 'mine' }).conversations.length, 0);
  inbox.update(staff, b.conversation.id, { assigneeId: member.id, status: 'resolved' });
  assert.deepEqual(inbox.list(member, { scope: 'mine', status: 'resolved' }).conversations.map(c => c.id), [b.conversation.id]);
  assert.throws(() => inbox.list(staff, { scope: 'invalid' }), { code: 'scope' });
});

test('case status and ownership changes and guest reopen append immutable activity', t => {
  const { inbox } = setup(t);
  const a = inbox.start(startInput()), id = a.conversation.id;
  inbox.update(staff, id, { assigneeId: member.id, status: 'resolved' });
  inbox.guestPost(a.token, request({ text: 'One more question' }));
  inbox.update(member, id, { assigneeId: null });
  assert.deepEqual(inbox.activity(staff, id).activity.map(a => a.kind), ['case.created', 'case.resolved', 'case.assigned', 'case.reopened', 'case.assigned']);
  assert.equal(inbox.guestDetail(a.token).conversation.status, 'open');
});

test('notes and task receipts survive restart, preserve exactly-once semantics and reject different operations reusing IDs', t => {
  const fixture = setup(t);
  const a = fixture.inbox.start(startInput()), id = a.conversation.id;
  const noteInput = request({ text: 'Internal record', attachments: [attachment] });
  const note = fixture.inbox.addNote(staff, id, noteInput).note;
  const taskInput = request({ text: 'Check the case', assigneeId: member.id, dueDate: '2026-11-12' });
  const task = fixture.inbox.addTask(staff, id, taskInput).task;
  const update = request({ status: 'done', assigneeId: null });
  const completed = fixture.inbox.changeTask(staff, id, task.id, update).task;
  fixture.restart();
  assert.equal(view(fixture.inbox, id).reference, 'CASE-000001');
  assert.deepEqual(fixture.inbox.addTask(staff, id, taskInput).task, task);
  assert.deepEqual(fixture.inbox.changeTask(staff, id, task.id, update).task, completed);
  assert.equal(fixture.inbox.addNote(staff, id, noteInput).note.id, note.id);
  assert.equal(fixture.inbox.activity(staff, id).activity.length, 4);
  assert.throws(() => fixture.inbox.addTask(staff, id, { ...taskInput, text: 'Changed' }), { status: 409 });
  assert.throws(() => fixture.inbox.changeTask(staff, id, task.id, { ...update, status: 'open' }), { status: 409 });
  assert.throws(() => fixture.inbox.addTask(staff, id, { ...taskInput, requestId: update.requestId }), { status: 409 });
  assert.throws(() => fixture.inbox.addNote(staff, id, { ...noteInput, text: 'Changed' }), { status: 409 });
});

test('unknown or foreign note files/tasks and malformed dates, owners or fields are rejected', t => {
  const { inbox } = setup(t);
  const a = inbox.start(startInput()), b = inbox.start(startInput());
  const note = inbox.addNote(staff, a.conversation.id, request({ attachments: [attachment] })).note;
  const task = inbox.addTask(staff, a.conversation.id, request({ text: 'Private task' })).task;
  assert.throws(() => inbox.noteFile(staff, b.conversation.id, note.attachments[0].id), { status: 404 });
  assert.throws(() => inbox.changeTask(staff, b.conversation.id, task.id, request({ status: 'done' })), { status: 404 });
  assert.throws(() => inbox.caseDetail({ id: a.token }, a.conversation.id), { status: 403 });
  assert.throws(() => inbox.notes(staff, a.conversation.id, -1), { code: 'cursor' });
  assert.throws(() => inbox.activity(staff, a.conversation.id, 0.5), { code: 'cursor' });
  for (const dueDate of ['', '2026-02-30', '2026-11-31', '2026-1-1', '2026-11-11T00:00:00Z', 0, {}, '0001-01-01']) assert.throws(() => inbox.addTask(staff, a.conversation.id, request({ text: 'Task', dueDate })), { code: 'due_date' });
  for (const extra of [{ text: '' }, { text: 'x'.repeat(2001) }, { text: 'Task', assigneeId: 'missing' }, { text: 'Task', assigneeId: { toString: 'broken' } }]) assert.throws(() => inbox.addTask(staff, a.conversation.id, request(extra)), e => e.status === 400);
  assert.throws(() => inbox.changeTask(staff, a.conversation.id, task.id, request({ text: 'replace text' })), { code: 'invalid_task' });
  assert.throws(() => inbox.changeTask(staff, a.conversation.id, task.id, request({ status: 'deleted' })), { code: 'status' });
});

test('audit append failure rolls back notes/files, task creation and edits, case metadata, guest reopen and receipts', t => {
  const { inbox, directory } = setup(t);
  const a = inbox.start(startInput()), id = a.conversation.id;
  const task = inbox.addTask(staff, id, request({ text: 'Keep original', assigneeId: member.id, dueDate: '2026-11-10' })).task;
  inbox.update(staff, id, { status: 'resolved' });
  const original = view(inbox, id);
  const guestBefore = inbox.guestDetail(a.token);
  const db = new DatabaseSync(path.join(directory, 'inbox.db'));
  t.after(() => db.close());
  const usage = { ...db.prepare('SELECT * FROM inbox_usage').get() };
  db.exec("CREATE TRIGGER refuse_case_audit BEFORE INSERT ON inbox_activity BEGIN SELECT RAISE(ABORT,'Audit unavailable'); END");
  const note = request({ text: 'Cannot save', attachments: [attachment] });
  const addition = request({ text: 'Cannot create' });
  const patch = request({ status: 'done', assigneeId: null, dueDate: null });
  for (const mutation of [() => inbox.addNote(staff, id, note), () => inbox.addTask(staff, id, addition), () => inbox.changeTask(staff, id, task.id, patch), () => inbox.update(staff, id, { status: 'open', assigneeId: member.id }), () => inbox.guestPost(a.token, request({ text: 'Cannot reopen' }))]) assert.throws(mutation, /Audit unavailable/);
  assert.deepEqual(view(inbox, id), original);
  assert.deepEqual(inbox.guestDetail(a.token), guestBefore);
  assert.equal(inbox.notes(staff, id).notes.length, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM inbox_note_files').get().n, 0);
  assert.deepEqual({ ...db.prepare('SELECT * FROM inbox_usage').get() }, usage);
  assert.equal(db.prepare('SELECT count(*) AS n FROM inbox_case_requests').get().n, 1);
  db.exec('DROP TRIGGER refuse_case_audit');
  inbox.addNote(staff, id, note);
  inbox.addTask(staff, id, addition);
  assert.equal(inbox.changeTask(staff, id, task.id, patch).task.status, 'done');
});

test('authored case content is append-only and task audit keeps complete before/after snapshots', t => {
  const { inbox, directory } = setup(t);
  const a = inbox.start(startInput()), id = a.conversation.id;
  inbox.addNote(staff, id, request({ text: 'Keep this note', attachments: [attachment] }));
  const text = 'A detailed task. '.repeat(100);
  const task = inbox.addTask(staff, id, request({ text, assigneeId: member.id, dueDate: '2026-11-10' })).task;
  const changed = inbox.changeTask(staff, id, task.id, request({ status: 'done', assigneeId: staff.id, dueDate: '2026-11-12' })).task;
  const db = new DatabaseSync(path.join(directory, 'inbox.db'));
  t.after(() => db.close());
  const audit = JSON.parse(db.prepare("SELECT details FROM inbox_activity WHERE kind='task.completed'").get().details);
  assert.deepEqual(audit.before, task);
  assert.deepEqual(audit.after, changed);
  assert.equal(audit.before.text, text.trim());
  const description = inbox.activity(staff, id).activity.find(event => event.kind === 'task.completed').text;
  assert.ok(description.includes('Jo Park → Pat Tester'));
  assert.ok(description.includes('2026-11-10 → 2026-11-12'));
  for (const sql of ['DELETE FROM inbox_cases', 'UPDATE inbox_cases SET sequence=99', 'DELETE FROM inbox_notes', "UPDATE inbox_notes SET text='changed'", 'DELETE FROM inbox_note_files', "UPDATE inbox_note_files SET name='changed'", 'DELETE FROM inbox_tasks', "UPDATE inbox_tasks SET text='changed'", 'DELETE FROM inbox_activity', "UPDATE inbox_activity SET text='changed'", 'DELETE FROM inbox_case_requests', "UPDATE inbox_case_requests SET result='{}'"]) assert.throws(() => db.exec(sql), /permanent/);
});

test('private notes share durable authored-content quotas and bounded pages without consuming public read sequences', t => {
  const fixture = setup(t, { limits: { messagesPerMinute: 1000, messagesPerConversation: 103 } });
  const a = fixture.inbox.start(startInput()), id = a.conversation.id;
  for (let i = 0; i < 102; i++) fixture.inbox.addNote(staff, id, request({ text: `Note ${i}` }));
  const first = fixture.inbox.notes(staff, id);
  assert.equal(first.notes.length, 100);
  assert.equal(first.hasMore, true);
  assert.equal(fixture.inbox.notes(staff, id, first.notes.at(-1).sequence).notes.length, 2);
  assert.throws(() => fixture.inbox.addNote(staff, id, request({ text: 'One more' })), { code: 'conversation_full' });
  assert.throws(() => fixture.inbox.guestPost(a.token, request({ text: 'Also full' })), { code: 'conversation_full' });
  const events = fixture.inbox.activity(staff, id);
  assert.equal(events.activity.length, 100);
  assert.equal(events.hasMore, true);
  assert.equal(fixture.inbox.activity(staff, id, events.activity.at(-1).sequence).activity.length, 3);
  fixture.restart();
  assert.equal(fixture.inbox.notes(staff, id).notes[0].text, 'Note 0');
  assert.equal(fixture.inbox.guestDetail(a.token).messages.length, 1);
});

test('task and activity caps refuse atomically, retain completed tasks and survive restart', t => {
  const fixture = setup(t, { limits: { tasksPerConversation: 1, totalTasks: 2, eventsPerConversation: 4 } });
  const a = fixture.inbox.start(startInput()), id = a.conversation.id;
  const task = fixture.inbox.addTask(staff, id, request({ text: 'Only task' })).task;
  fixture.inbox.changeTask(staff, id, task.id, request({ status: 'done' }));
  assert.throws(() => fixture.inbox.addTask(staff, id, request({ text: 'Another' })), { code: 'tasks_full' });
  fixture.inbox.changeTask(staff, id, task.id, request({ status: 'open' }));
  const patch = request({ status: 'done' });
  assert.throws(() => fixture.inbox.changeTask(staff, id, task.id, patch), { code: 'case_history_full' });
  assert.equal(view(fixture.inbox, id).tasks[0].status, 'open');
  fixture.restart();
  assert.throws(() => fixture.inbox.changeTask(staff, id, task.id, patch), { code: 'case_history_full' });
  const b = fixture.inbox.start(startInput());
  fixture.inbox.addTask(staff, b.conversation.id, request({ text: 'Second global task' }));
  const c = fixture.inbox.start(startInput());
  assert.throws(() => fixture.inbox.addTask(staff, c.conversation.id, request({ text: 'Global full' })), { code: 'tasks_full' });
  assert.equal(view(fixture.inbox, c.conversation.id).tasks.length, 0);
});

test('staff create empty cases with stable actor-scoped retries and explicit stable private visitor links', t => {
  const fixture = setup(t);
  const input = request({ name: 'Ana Ruiz', email: 'ana@example.gov', subject: 'An existing case' });
  const a = fixture.inbox.staffStart(staff, input).conversation;
  assert.equal(a.reference, 'CASE-000001');
  assert.equal(a.assigneeId, staff.id);
  assert.equal(a.lastMessage, null);
  assert.equal(fixture.inbox.staffDetail(staff, a.id).messages.length, 0);
  assert.equal(fixture.inbox.staffStart(staff, input).conversation.id, a.id);
  assert.notEqual(fixture.inbox.staffStart(member, input).conversation.id, a.id);
  assert.throws(() => fixture.inbox.staffStart(staff, { ...input, subject: 'changed' }), { status: 409 });
  assert.deepEqual(fixture.inbox.visitorLink(staff, a.id, 'https://relay.example.gov/hubs/example-app'), { url: null });
  fixture.inbox.addNote(staff, a.id, request({ text: 'Private case history', attachments: [attachment] }));
  fixture.inbox.addTask(staff, a.id, request({ text: 'Internal follow-up' }));
  const link = fixture.inbox.visitorLink(staff, a.id, 'https://chat.example.gov').url;
  assert.match(link, /^https:\/\/chat\.example\.gov\/contact#resume=[A-Za-z0-9_-]{43}$/);
  const token = new URLSearchParams(new URL(link).hash.slice(1)).get('resume');
  assert.equal(fixture.inbox.guestDetail(token).messages.length, 0);
  assert.equal('reference' in fixture.inbox.guestDetail(token).conversation, false);
  const eventCount = fixture.inbox.activity(staff, a.id).activity.length;
  assert.equal(fixture.inbox.visitorLink(member, a.id, 'https://chat.example.gov').url, link);
  assert.equal(fixture.inbox.activity(staff, a.id).activity.length, eventCount);
  fixture.restart();
  assert.equal(fixture.inbox.staffStart(staff, input).conversation.id, a.id);
  assert.equal(fixture.inbox.visitorLink(staff, a.id, 'https://chat.example.gov').url, link);
  assert.equal(fixture.inbox.guestPost(token, request({ text: 'Hello from visitor' })).message.conversationId, a.id);
  const publicCase = fixture.inbox.start(startInput());
  const second = fixture.inbox.visitorLink(staff, publicCase.conversation.id, 'https://chat.example.gov').url;
  const secondToken = new URLSearchParams(new URL(second).hash.slice(1)).get('resume');
  assert.deepEqual(fixture.inbox.guestDetail(publicCase.token), fixture.inbox.guestDetail(secondToken));
  const db = new DatabaseSync(path.join(fixture.directory, 'inbox.db'));
  t.after(() => db.close());
  assert.equal(db.prepare('SELECT token_hash FROM inbox_guest_links WHERE conversation_id=?').get(a.id).token_hash, crypto.createHash('sha256').update(token).digest('hex'));
});

test('upgrading existing conversations assigns references without altering public content and repeats safely', t => {
  const fixture = setup(t);
  const one = fixture.inbox.start(startInput({ attachments: [attachment] }));
  const two = fixture.inbox.start(startInput());
  const original = fixture.inbox.guestDetail(one.token);
  fixture.close();
  // Build a pre-case database from the unchanged public tables; schema removal
  // here is test fixture construction, not an application migration.
  const db = new DatabaseSync(path.join(fixture.directory, 'inbox.db'));
  for (const trigger of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND (tbl_name='inbox_cases' OR tbl_name='inbox_activity')").all()) db.exec(`DROP TRIGGER ${trigger.name}`);
  db.exec('DROP TABLE inbox_cases; DROP TABLE inbox_activity; DROP TABLE inbox_case_usage');
  db.close();
  fixture.reopen();
  const firstReference = view(fixture.inbox, one.conversation.id).reference;
  const secondReference = view(fixture.inbox, two.conversation.id).reference;
  assert.notEqual(firstReference, secondReference);
  assert.deepEqual(fixture.inbox.guestDetail(one.token), original);
  assert.deepEqual(fixture.inbox.activity(staff, one.conversation.id).activity.map(a => a.kind), ['case.migrated']);
  fixture.restart();
  assert.equal(view(fixture.inbox, one.conversation.id).reference, firstReference);
  assert.equal(view(fixture.inbox, two.conversation.id).reference, secondReference);
  assert.equal(fixture.inbox.activity(staff, one.conversation.id).activity.length, 1);
  assert.equal(fixture.inbox.guestFile(one.token, original.messages[0].attachments[0].id).file.data, attachment.data);
});

test('rolling upgrades discover a conversation inserted by the older API without restarting', t => {
  const { inbox, directory } = setup(t);
  const db = new DatabaseSync(path.join(directory, 'inbox.db'));
  t.after(() => db.close());
  db.prepare('INSERT INTO inbox_conversations (id,name,email,subject,token_hash,start_id,start_fingerprint,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run('inbox_legacy', 'Ana Ruiz', '', 'Rolling deployment', crypto.randomBytes(32).toString('hex'), 'legacy-start', 'legacy-body', 1000, 1000);
  assert.equal(db.prepare('SELECT count(*) AS n FROM inbox_cases').get().n, 0);
  const found = inbox.list(staff).conversations;
  assert.equal(found.length, 1);
  assert.equal(found[0].reference, 'CASE-000001');
  assert.equal(found[0].id, 'inbox_legacy');
  assert.equal(inbox.caseDetail(staff, 'inbox_legacy').reference, 'CASE-000001');
  assert.equal(inbox.activity(staff, 'inbox_legacy').activity.length, 1);
  assert.equal(db.prepare("SELECT updated_at FROM inbox_conversations WHERE id='inbox_legacy'").get().updated_at, 1000);
});

test('committed task retries still return their receipt when an original assignee has since left', t => {
  let current = people();
  const { inbox } = setup(t, { users: () => current });
  const a = inbox.start(startInput()), id = a.conversation.id;
  const input = request({ text: 'Follow up', assigneeId: member.id, dueDate: '2026-11-12' });
  const created = inbox.addTask(staff, id, input);
  const patch = request({ status: 'done', assigneeId: member.id });
  const changed = inbox.changeTask(staff, id, created.task.id, patch);
  current = { owner: staff };
  assert.deepEqual(inbox.addTask(staff, id, input), created);
  assert.deepEqual(inbox.changeTask(staff, id, created.task.id, patch), changed);
  assert.throws(() => inbox.addTask(staff, id, { ...input, requestId: crypto.randomUUID() }), { code: 'assignee' });
});

test('a concurrent resolution is audited on guest reopening and failed reopen audit rolls back the message', t => {
  const { inbox, directory } = setup(t);
  const other = createSecureInbox({ directory, users: people });
  const db = new DatabaseSync(path.join(directory, 'inbox.db'));
  const a = inbox.start(startInput()), id = a.conversation.id;
  const originalExec = DatabaseSync.prototype.exec;
  let interleave = true, refuseAudit = false;
  // Schedule a real second SQLite connection's committed change exactly after
  // guest authentication but before its transaction acquires the write lock.
  t.mock.method(DatabaseSync.prototype, 'exec', function(sql) {
    if (interleave && sql === 'BEGIN IMMEDIATE') {
      interleave = false;
      other.update(staff, id, { status: 'resolved' });
      if (refuseAudit) db.exec("CREATE TRIGGER refuse_concurrent_reopen BEFORE INSERT ON inbox_activity BEGIN SELECT RAISE(ABORT,'Reopen audit unavailable'); END");
    }
    return originalExec.call(this, sql);
  });
  try {
    inbox.guestPost(a.token, request({ text: 'Concurrent follow-up' }));
    assert.equal(inbox.guestDetail(a.token).conversation.status, 'open');
    assert.deepEqual(inbox.activity(staff, id).activity.map(event => event.kind), ['case.created', 'case.resolved', 'case.reopened']);
    const retry = request({ text: 'Retry after the audit recovers' });
    const beforeCount = inbox.guestDetail(a.token).messages.length;
    const beforeUsage = { ...db.prepare('SELECT * FROM inbox_usage').get() };
    interleave = true; refuseAudit = true;
    assert.throws(() => inbox.guestPost(a.token, retry), /Reopen audit unavailable/);
    assert.equal(inbox.guestDetail(a.token).conversation.status, 'resolved');
    assert.equal(inbox.guestDetail(a.token).messages.length, beforeCount);
    assert.deepEqual({ ...db.prepare('SELECT * FROM inbox_usage').get() }, beforeUsage);
    assert.deepEqual(inbox.activity(staff, id).activity.map(event => event.kind), ['case.created', 'case.resolved', 'case.reopened', 'case.resolved']);
    db.exec('DROP TRIGGER refuse_concurrent_reopen');
    inbox.guestPost(a.token, retry);
    inbox.guestPost(a.token, retry);
    assert.equal(inbox.guestDetail(a.token).conversation.status, 'open');
    assert.equal(inbox.guestDetail(a.token).messages.length, beforeCount + 1);
    assert.equal(inbox.activity(staff, id).activity.at(-1).kind, 'case.reopened');
  } finally { db.close(); other.close(); }
});
