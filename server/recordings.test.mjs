import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRecordings } from './recordings.mjs';

const ann = { id: 'ann', name: 'Ann' }, bo = { id: 'bo', name: 'Bo' };
function setup(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-rec-'));
  const started = [];
  const rec = createRecordings({ dir, log: { error() {} }, users: () => ({ ann, bo }),
    transcribe: async () => [{ fromMs: 0, text: 'Bo drafts the post by Friday' }],
    summarize: async () => JSON.stringify({ title: 'Launch sync', summary: 'Planned the launch', notes: ['Ship Friday'], steps: [{ text: 'Draft the post', owner: 'Bo' }, { text: 'Book review' }] }),
    startWork: async o => { started.push(o); return { id: `cht_${started.length}` }; }, ...over });
  const upload = (user = ann, bytes = Buffer.alloc(2048, 1)) => {
    const { id } = rec.create(user, { size: bytes.length, durationMs: 5000, ext: 'm4a' });
    rec.chunk(user, id, { offset: 0, data: bytes.toString('base64') });
    return id;
  };
  const settled = async id => { for (let i = 0; i < 50 && ['processing', 'uploading'].includes(rec.detail(id, ann).status); i++) await new Promise(r => setTimeout(r, 10)); return rec.detail(id, ann); };
  return { rec, started, upload, settled, dir };
}

test('a recording becomes notes and next steps, kept as a voice memo', async () => {
  const { rec, upload, settled } = setup();
  const id = upload();
  rec.finish(ann, id);
  const m = await settled(id);
  assert.equal(m.status, 'done');
  assert.equal(m.title, 'Launch sync');
  assert.deepEqual(m.notes, ['Ship Friday']);
  assert.equal(m.steps.length, 2);
  assert.match(m.transcript, /Bo drafts the post/);
  await rec.close();
});

test('voice memos are private to the person who recorded them', async () => {
  const { rec, upload } = setup();
  const id = upload();
  assert.throws(() => rec.detail(id, bo), /gone/);
  assert.throws(() => rec.chunk(bo, id, { offset: 0, data: 'AA==' }), /gone/);
  await rec.close();
});

test('uploads resume at the right offset and reject overruns', async () => {
  const { rec } = setup();
  const { id } = rec.create(ann, { size: 6, ext: 'm4a' });
  rec.chunk(ann, id, { offset: 0, data: Buffer.from('abc').toString('base64') });
  assert.throws(() => rec.chunk(ann, id, { offset: 0, data: 'AA==' }), e => e.code === 'upload_offset');
  assert.throws(() => rec.finish(ann, id), e => e.code === 'upload_offset');
  assert.deepEqual(rec.workLog(ann), [], 'an incomplete upload cannot create a recording event');
  assert.throws(() => rec.chunk(ann, id, { offset: 3, data: Buffer.from('abcd').toString('base64') }), /didn't fit/);
  await rec.close();
});

test('a failed transcript can be retried', async () => {
  let fail = true;
  const { rec, upload, settled } = setup({ transcribe: async () => { if (fail) throw new Error('nope'); return [{ fromMs: 0, text: 'hello there' }]; } });
  const id = upload();
  rec.finish(ann, id);
  assert.equal((await settled(id)).status, 'failed');
  fail = false;
  await rec.retry(ann, id);
  assert.equal((await settled(id)).status, 'done');
  await rec.close();
});

test('sending a step to the agent starts one work chat, once', async () => {
  const { rec, started, upload, settled } = setup();
  const id = upload();
  rec.finish(ann, id);
  await settled(id);
  await Promise.all([rec.act(ann, { id: 'd1' }, id, '0', 'send'), rec.act(ann, { id: 'd1' }, id, '0', 'send')]);
  assert.equal(started.length, 1);
  assert.match(started[0].transcript, /Draft the post/);
  const m = await rec.act(ann, { id: 'd1' }, id, 'all', 'send');
  assert.equal(started.length, 2);
  assert.ok(m.steps.every(s => s.status === 'accepted' && s.chatId));
  await rec.close();
});

test('deleting a recording removes it and its audio', async () => {
  const { rec, upload } = setup();
  const id = upload();
  rec.remove(ann, id);
  assert.throws(() => rec.detail(id, ann), /gone/);
  await rec.close();
});

test('with records preservation on, deleting a recording hides it but keeps the audio, transcript and notes', async () => {
  const { rec, dir, upload, settled } = setup({ config: () => ({ recordsPreservation: true }) });
  const id = upload();
  rec.finish(ann, id);
  assert.equal((await settled(id)).status, 'done');
  const audio = fs.readdirSync(path.join(dir, id));
  assert.ok(audio.length > 0, 'there is audio on disk');
  rec.remove(ann, id);
  assert.throws(() => rec.detail(id, ann), /gone/, 'the person no longer sees it');
  assert.throws(() => rec.detail(id, ann), e => e.status === 404, 'and it behaves as deleted');
  assert.deepEqual(fs.readdirSync(path.join(dir, id)), audio, 'the audio is still on disk');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dir, 'recordings.db'));
  const row = db.prepare('SELECT transcript, notes, hidden_at FROM recordings WHERE id = ?').get(id);
  db.close();
  assert.match(row.transcript, /Bo drafts the post by Friday/, 'the transcript is kept');
  assert.ok(row.hidden_at, 'marked hidden, not removed');
  await rec.close();
});

test('without records preservation, deleting a recording removes it as before', async () => {
  const { rec, dir, upload, settled } = setup();
  const id = upload();
  rec.finish(ann, id);
  assert.equal((await settled(id)).status, 'done');
  rec.remove(ann, id);
  assert.equal(fs.existsSync(path.join(dir, id)), false);
  await rec.close();
});

test('automatic recording work log starts at upload finish, survives notes failure and deletion, and stays private', async () => {
  let current = 1_800_000_000_000;
  const { rec, upload, settled, dir } = setup({ now: () => current, transcribe: async () => { throw new Error('notes unavailable'); } });
  let restarted;
  try {
    const id = upload();
    assert.deepEqual(rec.workLog(ann), [], 'uploading alone is not a completed recording');
    current += 500;
    rec.finish(ann, id);
    assert.equal((await settled(id)).status, 'failed');
    const [event] = rec.workLog(ann);
    assert.deepEqual(event, { kind: 'recording', id: `recording:${id}`, at: current,
      recordingId: id, durationMs: 5000, source: { title: null, summary: null } });
    assert.deepEqual(rec.workLog(bo), [], 'only the recorder receives the event');
    current += 1000;
    rec.finish(ann, id);
    await rec.retry(ann, id);
    await settled(id);
    assert.deepEqual(rec.workLog(ann), [event], 'retrying notes never changes the physical recording event');
    assert.throws(() => rec.db.exec('UPDATE recording_work_log SET added_at = 1'), /immutable/);
    assert.throws(() => rec.db.exec('DELETE FROM recording_work_log'), /immutable/);
    rec.remove(ann, id);
    assert.deepEqual(rec.workLog(ann), [{ ...event, source: null }]);
    await rec.close();
    restarted = createRecordings({ dir });
    assert.deepEqual(restarted.workLog(ann), [{ ...event, source: null }], 'deletion cannot erase history across restarts');
    assert.deepEqual(restarted.workLog(bo), []);
  } finally { await (restarted || rec).close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('recording work log hides preserved sources and uses current summary without transcript content', async () => {
  const { rec, upload, settled, dir } = setup({ config: () => ({ recordsPreservation: true }) });
  try {
    const id = upload();
    rec.finish(ann, id);
    await settled(id);
    const [event] = rec.workLog(ann);
    assert.deepEqual(event.source, { title: 'Launch sync', summary: 'Planned the launch' });
    rec.db.prepare('UPDATE recordings SET title = ?, summary = ? WHERE id = ?').run('Updated title', 'Updated summary', id);
    assert.deepEqual(rec.workLog(ann)[0].source, { title: 'Updated title', summary: 'Updated summary' });
    rec.remove(ann, id);
    assert.deepEqual(rec.workLog(ann), [{ ...event, source: null }]);
    assert.ok(rec.db.prepare('SELECT transcript FROM recordings WHERE id = ?').get(id).transcript);
    assert.ok(fs.existsSync(path.join(dir, id)), 'records preservation still keeps the audio');
  } finally { await rec.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the list returns only finished uploads under recordings', async () => {
  const { rec, upload } = setup();
  const done = upload();
  rec.finish(ann, done);
  upload();
  const sent = [];
  await rec.handle({}, {}, { user: ann, method: 'GET', parts: ['v1', 'recordings'], send: (_res, status, body) => sent.push({ status, body }), fail: assert.fail });
  assert.deepEqual(sent[0].body.recordings.map(r => r.id), [done]);
  assert.equal('meetings' in sent[0].body, false);
  await rec.close();
});

test('legacy finished recordings backfill once without a recent-list cap or invented capture times', async () => {
  const { rec, dir } = setup();
  let restarted;
  try {
    const insert = rec.db.prepare("INSERT INTO recordings (id, user_id, status, created_at, duration_ms, size, received, ext) VALUES (?, ?, ?, ?, 1000, 2048, 2048, 'm4a')");
    for (let n = 0; n < 205; n++) insert.run(`rec_old_${n}`, 'ann', n % 2 ? 'done' : 'failed', 10000 + n);
    insert.run('rec_still_uploading', 'ann', 'uploading', 20000);
    insert.run('rec_someone_else', 'bo', 'done', 20000);
    await rec.close();
    restarted = createRecordings({ dir });
    const events = restarted.workLog(ann);
    assert.equal(events.length, 205);
    assert.ok(events.every(event => event.kind === "recording" && event.durationMs === 1000));
    assert.equal(events[0].at, 10204);
    await restarted.close();
    restarted = createRecordings({ dir });
    assert.deepEqual(restarted.workLog(ann), events, 'migration is idempotent');
  } finally { await (restarted || rec).close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

for (const recordsPreservation of [false, true]) test(`to-do archival failure refuses recording deletion (preservation ${recordsPreservation})`, async () => {
  const { rec, upload, dir } = setup({ config: () => ({ recordsPreservation }), todos: () => ({ removeSource() { throw new Error('archive unavailable'); } }) });
  try {
    const id = upload();
    assert.throws(() => rec.remove(ann, id), /archive unavailable/);
    assert.equal(rec.detail(id, ann).id, id, 'recording remains visible');
    assert.ok(fs.existsSync(path.join(dir, id)), 'audio remains intact');
  } finally { await rec.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

for (const recordsPreservation of [false, true]) for (const failSummary of [false, true]) test(`a removed recording stays removed when a pending summary ${failSummary ? 'fails' : 'finishes'} (preservation ${recordsPreservation})`, async () => {
  let finishSummary, rejectSummary, enteredSummary, closed = false;
  const ready = new Promise(resolve => { enteredSummary = resolve; });
  const summary = new Promise((resolve, reject) => { finishSummary = resolve; rejectSummary = reject; });
  const generated = [];
  const { rec, upload, dir } = setup({ config: () => ({ recordsPreservation }),
    summarize: async () => { enteredSummary(); return summary; },
    todos: () => ({ fromRecording(...args) { generated.push(args); }, removeSource() {}, forSource() { return []; } }) });
  try {
    const id = upload();
    rec.finish(ann, id);
    await ready;
    const [event] = rec.workLog(ann);
    rec.remove(ann, id);
    if (failSummary) rejectSummary(new Error('Synthetic summary failure'));
    else finishSummary(JSON.stringify({ title: 'Example planning', summary: 'Ready', notes: ['Review'], steps: [{ text: 'Review the example plan' }] }));
    // close waits for the in-flight processor, so assertions observe its final writes.
    await rec.close();
    closed = true;
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(dir, 'recordings.db'));
    try {
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM recording_steps WHERE recording_id = ?').get(id).n, 0);
      const source = db.prepare('SELECT status, notes, hidden_at FROM recordings WHERE id = ?').get(id);
      if (recordsPreservation) {
        assert.ok(source.hidden_at);
        assert.equal(source.status, 'processing', 'the hidden record is not rewritten after removal');
        assert.equal(source.notes, null);
      } else assert.equal(source, undefined);
    } finally { db.close(); }
    assert.deepEqual(generated, [], 'no late to-dos are created');
    const reopened = createRecordings({ dir });
    try { assert.deepEqual(reopened.workLog(ann), [{ ...event, source: null }]); }
    finally { await reopened.close(); }
  } finally { finishSummary?.('{}'); if (!closed) await rec.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

import { createTodos } from './todos.mjs';
function withTodos() {
  const posts = [];
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'servant-rec-todos-')), 'todos.db');
  const todos = createTodos({ file, log: { error() {} }, users: () => ({ ann, bo }),
    project: () => null, channel: () => null, announce: (c, u, t) => posts.push(t), startWork: async () => ({ id: 'cht_x' }) });
  return { todos, posts };
}

test('finished notes make to-dos for the person who recorded, and the recording shows them', async () => {
  const { todos } = withTodos();
  const { rec, upload, settled } = setup({ todos: () => todos });
  const id = upload();
  rec.finish(ann, id);
  const m = await settled(id);
  assert.equal(m.status, 'done');
  assert.deepEqual(m.todos.map(t => t.text), ['Draft the post', m.steps[1].text]);
  assert.equal(m.todos[0].assignee.id, 'bo', 'the owner named in the notes is matched');
  assert.deepEqual(m.todos[0].source, { kind: 'recording', id, title: 'Launch sync' });
  assert.equal(rec.detail(id, ann).todos.length, 2, 'opening it again does not make more');
  assert.throws(() => rec.detail(id, bo), /gone/, 'still private to the person who recorded it');
  rec.remove(ann, id);
  assert.equal(todos.list(ann).length, 0, 'deleting the recording deletes its to-dos');
  await rec.close();
});

test('a recording that finished before to-dos existed gets its open steps as to-dos the first time it is opened', async () => {
  const { todos } = withTodos();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-rec-old-'));
  const build = extra => createRecordings({ dir, log: { error() {} }, users: () => ({ ann, bo }),
    transcribe: async () => [{ fromMs: 0, text: 'Bo drafts the post by Friday' }],
    summarize: async () => JSON.stringify({ title: 'Launch sync', summary: 'Planned', notes: ['n'], steps: [{ text: 'Draft the post', owner: 'Bo' }, { text: 'Book the room' }] }),
    startWork: async () => ({ id: 'cht_1' }), ...extra });
  const before = build();                                    // the old server: no to-dos
  const { id } = before.create(ann, { size: 2048, durationMs: 1000, ext: 'm4a' });
  before.chunk(ann, id, { offset: 0, data: Buffer.alloc(2048, 1).toString('base64') });
  before.finish(ann, id);
  for (let i = 0; i < 50 && before.detail(id, ann).status !== 'done'; i++) await new Promise(r => setTimeout(r, 10));
  assert.equal(before.detail(id, ann).todos.length, 0);
  await before.close();
  const after = build({ todos: () => todos });               // the same data, a newer server
  const opened = after.detail(id, ann);
  assert.deepEqual(opened.todos.map(t => t.text), ['Draft the post', 'Book the room']);
  assert.equal(after.detail(id, ann).todos.length, 2, 'once only');
  await after.close();
});

test('a step already sent to the agent or skipped under the old way is not turned into a to-do', async () => {
  const { todos } = withTodos();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-rec-old2-'));
  const build = extra => createRecordings({ dir, log: { error() {} }, users: () => ({ ann, bo }),
    transcribe: async () => [{ fromMs: 0, text: 'hello there everyone' }],
    summarize: async () => JSON.stringify({ title: 'Sync', summary: 's', notes: [], steps: [{ text: 'Sent step' }, { text: 'Skipped step' }, { text: 'Open step' }] }),
    startWork: async () => ({ id: 'cht_1' }), ...extra });
  const before = build();
  const { id } = before.create(ann, { size: 2048, durationMs: 1000, ext: 'm4a' });
  before.chunk(ann, id, { offset: 0, data: Buffer.alloc(2048, 1).toString('base64') });
  before.finish(ann, id);
  for (let i = 0; i < 50 && before.detail(id, ann).status !== 'done'; i++) await new Promise(r => setTimeout(r, 10));
  await before.act(ann, { id: 'd1' }, id, 0, 'send');
  await before.act(ann, { id: 'd1' }, id, 1, 'skip');
  await before.close();
  const after = build({ todos: () => todos });
  assert.deepEqual(after.detail(id, ann).todos.map(t => t.text), ['Open step']);
  await after.close();
});
