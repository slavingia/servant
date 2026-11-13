import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAgentTurns } from './agent-turns.mjs';
import { createChatMediaStore } from './chat-media.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const input = (chatId = 'chat') => ({ chat: { id: chatId, role: 'owner', hermesSessionId: 'session' }, user: { id: 'owner' }, device: { id: 'phone' }, text: 'Hello', attachments: [], requestId: 'request_123' });
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-private-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, 'turns.db');
}

test('persisted request IDs replay one turn, reject different input and serialize each chat', async t => {
  const file = fixture(t), started = deferred(), finish = deferred();
  let calls = 0;
  const worker = createAgentTurns({ file, execute: async (_t, { emit }) => {
    calls++; emit('sent', { message: { id: 'user' } }); emit('delta', { text: 'Saved partial' }); started.resolve(); await finish.promise;
    emit('message', { id: 'answer', text: 'Complete' }); return { notification: { eventId: 'one' } };
  } });
  const api = createAgentTurns({ file });
  try {
    const turn = api.enqueue(input());
    assert.equal(api.enqueue(input()).id, turn.id);
    assert.throws(() => api.enqueue({ ...input(), text: 'Different' }), { code: 'request_conflict' });
    const running = worker.processNext(); await started.promise;
    // A second message while the first runs waits; it never starts alongside.
    const second = api.enqueue({ ...input(), requestId: 'request_456', text: 'Then this' });
    assert.equal(second.status, 'queued');
    assert.equal(await worker.processNext(), false);
    assert.equal(api.get(second.id).status, 'queued');
    assert.equal(api.get(turn.id).assistantText, 'Saved partial');
    assert.equal(api.get(turn.id).accepted, true);
    assert.equal(api.owns(turn.id, 'chat', 'stranger'), false);
    const cursor = api.events(turn.id).at(-1).seq;
    finish.resolve(); await running;
    assert.equal(api.get(turn.id).status, 'completed');
    assert.ok(api.events(turn.id, cursor).some(e => e.event === 'done'));
    assert.equal(api.enqueue(input()).id, turn.id);
    assert.equal(calls, 1);
    finish.resolve(); await worker.processNext();
    assert.equal(api.get(second.id).status, 'completed');
    assert.equal(calls, 2);
    const notifications = []; api.drainOutbox(e => notifications.push(e)); api.drainOutbox(e => notifications.push(e));
    assert.deepEqual(notifications, [{ eventId: 'one' }, { eventId: 'one' }]);
  } finally { finish.resolve(); await worker.whenIdle(); api.close(); worker.close(); }
});

test('uncertain starts become interrupted; checkpointed runs resume without another submission', async t => {
  const file = fixture(t);
  const seed = createAgentTurns({ file });
  const uncertain = seed.enqueue(input('uncertain'));
  const known = seed.enqueue(input('known'));
  seed.close();
  const db = new DatabaseSync(file);
  db.prepare("UPDATE private_turns SET status='running',accepted=1,assistant_text='Partial' WHERE id=?").run(uncertain.id);
  db.prepare("UPDATE private_turns SET status='running',accepted=1,run_id='existing_run' WHERE id=?").run(known.id);
  db.close();
  const resumed = [];
  const replacement = createAgentTurns({ file, execute: async turn => { resumed.push(turn.run_id); return {}; } });
  try {
    assert.equal(replacement.recoverInterrupted(), 2);
    assert.equal(replacement.get(uncertain.id).status, 'interrupted');
    assert.equal(replacement.get(uncertain.id).assistantText, 'Partial');
    await replacement.processNext();
    assert.deepEqual(resumed, ['existing_run']);
    assert.equal(await replacement.processNext(), false);
  } finally { replacement.close(); }
});

test('one approval never stalls another chat; exact approval ID is consumed only once', async t => {
  const file = fixture(t), waiting = deferred(), answer = deferred();
  const turns = createAgentTurns({ file, concurrency: 2, execute: async (turn, hooks) => {
    if (turn.chat_id === 'first') {
      hooks.checkpoint('run_1');
      hooks.emit('approval', { approval: { id: 'approval_1', command: 'fixture', choices: ['once', 'deny'] } });
      waiting.resolve(); await answer.promise;
      assert.equal(hooks.controls().choice, 'once');
    }
    return {};
  } });
  try {
    const first = turns.enqueue(input('first'));
    const running = turns.processNext(); await waiting.promise;
    assert.equal(turns.get(first.id).status, 'waiting_for_approval');
    const other = turns.enqueue(input('other'));
    await turns.processNext();
    assert.equal(turns.get(other.id).status, 'completed');
    assert.throws(() => turns.requestApproval(first.id, 'old_id', 'once'), { code: 'approval_stale' });
    assert.throws(() => turns.requestApproval(first.id, 'approval_1', 'always'), { code: 'invalid_choice' });
    turns.requestApproval(first.id, 'approval_1', 'once');
    assert.throws(() => turns.requestApproval(first.id, 'approval_1', 'once'), { code: 'approval_stale' });
    let idle = false; const drain = turns.whenIdle().then(() => { idle = true; });
    await Promise.resolve(); assert.equal(idle, false);
    answer.resolve(); await running; await drain;
    assert.equal(idle, true);
  } finally { answer.resolve(); await turns.whenIdle(); turns.close(); }
});

test('queued stop cancels without executing and unsupported active transport cannot pretend to stop', async t => {
  const file = fixture(t), waiting = deferred(), finish = deferred();
  let executed = 0;
  const turns = createAgentTurns({ file, execute: async () => { executed++; waiting.resolve(); await finish.promise; } });
  try {
    const queued = turns.enqueue(input('queued'));
    assert.equal(turns.requestStop(queued.id).status, 'cancelled');
    assert.equal(await turns.processNext(), false);
    const running = turns.enqueue(input('running'));
    const task = turns.processNext(); await waiting.promise;
    assert.throws(() => turns.requestStop(running.id), { code: 'stop_unavailable' });
    finish.resolve(); await task;
    assert.equal(turns.requestStop(running.id).status, 'completed');
    assert.equal(executed, 1);
  } finally { finish.resolve(); await turns.whenIdle(); turns.close(); }
});

test('stable delivery keys close the crash window between media persistence and turn journal', t => {
  const file = fixture(t);
  let cache = createChatMediaStore(file);
  const first = cache.accept('chat', 'user', 'Hello', [], 'turn_1');
  cache.close(); cache = createChatMediaStore(file);
  try {
    assert.deepEqual(cache.accept('chat', 'user', 'Hello', [], 'turn_1'), first);
    assert.equal(cache.history('chat').length, 1);
    assert.notEqual(cache.accept('chat', 'assistant', 'Reply', [], 'turn_1').id, first.id);
  } finally { cache.close(); }
});

test('queue holds at most five waiting messages per chat', async t => {
  const file = fixture(t), finish = deferred(), started = deferred();
  const worker = createAgentTurns({ file, execute: async () => { started.resolve(); await finish.promise; return {}; } });
  try {
    worker.enqueue(input()); const run = worker.processNext(); await started.promise;
    for (let i = 0; i < 5; i++) worker.enqueue({ ...input(), requestId: `request_q${i}`, text: `wait ${i}` });
    assert.throws(() => worker.enqueue({ ...input(), requestId: 'request_q9', text: 'too many' }), { code: 'queue_full', message: 'Up to five messages can wait. Remove one, or wait for the reply' });
    finish.resolve(); await run;
  } finally { finish.resolve(); await worker.whenIdle(); worker.close(); }
});

test('steer folds a waiting message into the running turn exactly once', async t => {
  const file = fixture(t), started = deferred(), finish = deferred();
  const seen = [];
  const worker = createAgentTurns({ file, execute: async (_t, hooks) => {
    hooks.steerable(true); started.resolve();
    // The run loop polls controls; deliver each steer once, like hermes-runs.
    while (true) {
      const { steers } = hooks.controls();
      for (const s of steers) { if (!seen.includes(s.id)) { seen.push(s.id); hooks.steered(s.id); } }
      if (await Promise.race([finish.promise.then(() => true), new Promise(r => setTimeout(() => r(false), 5))])) break;
    }
    return {};
  } });
  try {
    const first = worker.enqueue(input()); const run = worker.processNext(); await started.promise;
    const waiting = worker.enqueue({ ...input(), requestId: 'request_s1', text: 'Actually use the blue one' });
    assert.equal(worker.requestSteer(waiting.id).steerRequested, true);
    for (let i = 0; i < 50 && worker.get(waiting.id).status !== 'steered'; i++) await new Promise(r => setTimeout(r, 5));
    assert.equal(worker.get(waiting.id).status, 'steered');
    assert.equal(worker.get(waiting.id).steeredInto, first.id);
    assert.deepEqual(seen, [waiting.id]);
    assert.throws(() => worker.requestSteer(waiting.id), { code: 'steer_unavailable' });
    finish.resolve(); await run;
    // Steered messages never run again as their own turn.
    assert.equal(await worker.processNext(), false);
  } finally { finish.resolve(); await worker.whenIdle(); worker.close(); }
});

test('a steer the agent never read runs next, and nothing to steer leaves it queued', async t => {
  const file = fixture(t), started = deferred(), finish = deferred();
  let runs = 0;
  const worker = createAgentTurns({ file, execute: async (turn, hooks) => {
    runs++;
    if (runs > 1) return { status: 'completed' };
    hooks.steerable(true); started.resolve(); await finish.promise;
    const [s] = hooks.controls().steers; hooks.steered(s.id);
    return { status: 'completed', unreadSteers: [s.id] };
  } });
  try {
    worker.enqueue(input()); const run = worker.processNext(); await started.promise;
    const waiting = worker.enqueue({ ...input(), requestId: 'request_u1', text: 'Also check the tests' });
    worker.requestSteer(waiting.id);
    finish.resolve(); await run;
    assert.equal(worker.get(waiting.id).status, 'queued');
    assert.equal(worker.get(waiting.id).steerRequested, false);
    await worker.processNext();
    assert.equal(worker.get(waiting.id).status, 'completed');
    assert.equal(runs, 2);
    const late = worker.enqueue({ ...input(), requestId: 'request_u2', text: 'Late' });
    assert.throws(() => worker.requestSteer(late.id), { code: 'nothing_to_steer' });
  } finally { finish.resolve(); await worker.whenIdle(); worker.close(); }
});

test('messages with files cannot steer; they wait their turn', async t => {
  const file = fixture(t), started = deferred(), finish = deferred();
  const worker = createAgentTurns({ file, execute: async (_t, hooks) => { hooks.steerable(true); started.resolve(); await finish.promise; return {}; } });
  try {
    worker.enqueue(input()); const run = worker.processNext(); await started.promise;
    const withFile = worker.enqueue({ ...input(), requestId: 'request_f1', text: 'See this', attachments: [{ name: 'a.png', mime: 'image/png', data: Buffer.from('x') }] });
    assert.throws(() => worker.requestSteer(withFile.id), { code: 'steer_files' });
    finish.resolve(); await run;
  } finally { finish.resolve(); await worker.whenIdle(); worker.close(); }
});

test('upgrading never lights up replies people already had; new replies start unread', async t => {
  const file = fixture(t);
  const worker = createAgentTurns({ file, execute: async (_t, { emit }) => { emit('message', { id: `answer_${_t.id}`, text: 'Done' }); return {}; } });
  try {
    worker.enqueue(input()); await worker.processNext();
    assert.deepEqual(worker.unreadByChat('owner'), { chat: 1 });
  } finally { await worker.whenIdle(); worker.close(); }
  // Simulate a journal from before unread tracking existed.
  const db = new DatabaseSync(file);
  db.exec('DROP TABLE private_reply_reads; DROP TABLE private_turn_migrations;');
  db.close();
  const upgraded = createAgentTurns({ file, execute: async (_t, { emit }) => { emit('message', { id: `answer_${_t.id}`, text: 'Done' }); return {}; } });
  try {
    assert.deepEqual(upgraded.unreadByChat('owner'), {}, 'existing replies count as read');
    upgraded.enqueue({ ...input(), requestId: 'request_after', text: 'Again' }); await upgraded.processNext();
    upgraded.enqueue({ ...input('other'), requestId: 'request_other' }); await upgraded.processNext();
    assert.deepEqual(upgraded.unreadByChat('owner'), { chat: 1, other: 1 });
    assert.deepEqual(upgraded.unreadByChat('stranger'), {});
    assert.equal(upgraded.markChatRead('chat', 'stranger'), 0, 'only the author reads their replies');
    assert.equal(upgraded.markChatRead('chat', 'owner'), 1);
    assert.deepEqual(upgraded.unreadByChat('owner'), { other: 1 });
  } finally { await upgraded.whenIdle(); upgraded.close(); }
});

test('a reply says whether it can take a message partway, and a steer it cannot take is refused', async t => {
  const file = fixture(t), started = deferred(), asked = deferred(), finish = deferred();
  const worker = createAgentTurns({ file, execute: async (_t, hooks) => {
    started.resolve(); await asked.promise; hooks.steerable(true); await finish.promise; return {};
  } });
  try {
    const first = worker.enqueue(input()); const run = worker.processNext(); await started.promise;
    const waiting = worker.enqueue({ ...input(), requestId: 'request_c1', text: 'Use the blue one' });
    // Running, but its worker hasn't asked the agent yet (or it's a member's agent, or an older bridge).
    assert.equal(worker.get(first.id).canSteer, false);
    assert.equal(worker.get(waiting.id).canSteer, false, 'a waiting message is never the reply to steer');
    assert.throws(() => worker.requestSteer(waiting.id), { code: 'steer_unsupported' });
    assert.equal(worker.get(waiting.id).steerRequested, false);
    assert.equal(worker.get(waiting.id).status, 'queued', 'it keeps its place and runs next');
    asked.resolve(); await new Promise(r => setTimeout(r, 5));
    assert.equal(worker.get(first.id).canSteer, true);
    assert.equal(worker.latest('chat').find(t => t.id === first.id).canSteer, true);
    assert.equal(worker.events(first.id).findLast(e => e.event === 'turn').payload.turn.canSteer, true, 'viewers following the stream hear it too');
    assert.equal(worker.requestSteer(waiting.id).steerRequested, true);
    finish.resolve(); await run;
    assert.equal(worker.get(first.id).canSteer, false, 'a finished reply takes nothing');
  } finally { asked.resolve(); finish.resolve(); await worker.whenIdle(); worker.close(); }
});

test('the latest progress line rides on the turn while it runs, then clears', async t => {
  const file = fixture(t), started = deferred(), finish = deferred();
  const worker = createAgentTurns({ file, execute: async (_t, { emit }) => {
    emit('status', { text: 'Searching the web' }); started.resolve(); await finish.promise; return {};
  } });
  try {
    const turn = worker.enqueue(input()); const run = worker.processNext(); await started.promise;
    assert.equal(worker.get(turn.id).activity, 'Searching the web');
    finish.resolve(); await run;
    assert.equal(worker.get(turn.id).activity, null);
  } finally { finish.resolve(); await worker.whenIdle(); worker.close(); }
});

test('each progress step is kept on the turn while it runs; afterwards the list counts them and the turn itself has them', async t => {
  const file = fixture(t), started = deferred(), finish = deferred();
  let now = 1_000;
  const worker = createAgentTurns({ file, clock: () => now, execute: async (_t, { emit }) => {
    emit('step', { label: 'Thinking', detail: 'Check the repo first' });
    emit('step', { label: 'Running a command', detail: 'git status' });
    emit('step', { label: 'Writing' }); emit('step', { label: 'Writing' });
    started.resolve(); await finish.promise; return {};
  } });
  try {
    const turn = worker.enqueue(input()); const run = worker.processNext(); await started.promise;
    const live = worker.get(turn.id);
    assert.deepEqual(live.steps.map(s => [s.label, s.detail]), [['Thinking', 'Check the repo first'], ['Running a command', 'git status'], ['Writing', undefined]]);
    assert.equal(live.startedAt, 1_000);
    assert.equal(live.finishedAt, null, 'still working');
    assert.equal(live.stepCount, 3);
    now = 13_000;
    finish.resolve(); await run;
    // The list every device polls stays light: how long it worked and how many steps, not the steps.
    const done = worker.latest('chat')[0];
    assert.deepEqual(done.steps, []);
    assert.equal(done.stepCount, 3);
    assert.equal(done.finishedAt - done.startedAt, 12_000, 'worked for 12 seconds');
    assert.deepEqual(worker.get(turn.id).steps, []);
    // Opening "Worked for 12 seconds" asks for that one turn.
    assert.deepEqual(worker.detail(turn.id).steps.map(s => [s.label, s.detail]), [['Thinking', 'Check the repo first'], ['Running a command', 'git status'], ['Writing', undefined]]);
    assert.equal(worker.detail('turn_missing'), undefined);
    // A message that was folded into another reply is not a reply of its own.
    now = 14_000;
    const next = worker.enqueue({ ...input(), requestId: 'request_w2', text: 'Again' });
    assert.equal(worker.get(next.id).finishedAt, null, 'waiting');
  } finally { finish.resolve(); await worker.whenIdle(); worker.close(); }
});

test("other people's conversations: unread per reader, from first look, until opened or all marked read", async t => {
  const clockRef = { now: 1000 };
  const worker = createAgentTurns({ file: fixture(t), clock: () => clockRef.now, execute: async (_t, { emit }) => { emit('message', { id: `answer_${_t.id}`, text: 'Done' }); return {}; } });
  try {
    worker.enqueue(input('theirs')); await worker.processNext();
    // The reader first looks later: the reply that already existed is not unread.
    clockRef.now = 5000;
    assert.deepEqual(worker.unreadOthers('reader', ['theirs']), {});
    clockRef.now = 6000;
    worker.enqueue({ ...input('theirs'), requestId: 'request_new', text: 'More' }); await worker.processNext();
    assert.deepEqual(worker.unreadOthers('reader', ['theirs']), { theirs: 1 });
    assert.deepEqual(worker.unreadOthers('other-reader', ['theirs']), {}, 'unread is per reader');
    assert.deepEqual(worker.unreadOthers('owner', ['theirs']), {}, 'authors read their own through the existing path');
    worker.enqueue({ ...input('second'), requestId: 'request_second' }); await worker.processNext();
    assert.deepEqual(worker.unreadOthers('reader', ['theirs', 'second']), { theirs: 1, second: 1 });
    assert.equal(worker.markViewed('reader', ['theirs']), 2, 'opening reads every finished reply in it');
    assert.deepEqual(worker.unreadOthers('reader', ['theirs', 'second']), { second: 1 });
    worker.markViewed('reader', ['theirs', 'second']);
    assert.deepEqual(worker.unreadOthers('reader', ['theirs', 'second']), {});
    // Mark all as read for an author clears their own.
    assert.deepEqual(worker.unreadByChat('owner'), { theirs: 2, second: 1 });
    assert.equal(worker.markAllChatsRead('owner'), 3);
    assert.deepEqual(worker.unreadByChat('owner'), {});
  } finally { await worker.whenIdle(); worker.close(); }
});

// Deleting a chat used to soft-delete the chat record only: every prompt, reply and streamed delta stayed in this
// database for good. The turns of a deleted chat, and everything hanging off them, must go.
test('deleting a chat removes its prompts, replies, streamed events, outbox and read marks, and nothing of other chats', async t => {
  const file = fixture(t);
  const worker = createAgentTurns({ file, execute: async (_t, { emit }) => { emit('sent', { message: { id: 'u' } }); emit('delta', { text: 'secret reply' }); emit('message', { id: 'a', text: 'secret reply' }); return { notification: { eventId: 'n' } }; } });
  t.after(() => worker.close());
  const mine = worker.enqueue(input('chat-gone')), other = worker.enqueue({ ...input('chat-kept'), requestId: 'request_other' });
  await worker.processNext(); await worker.processNext(); await worker.whenIdle();
  worker.markChatRead('chat-gone', 'owner');
  const db = new DatabaseSync(file);
  t.after(() => db.close());
  const count = (table, where = '1=1', ...args) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...args).n;
  assert.ok(count('private_turn_events', 'turn_id=?', mine.id) > 0, 'there is something to delete');
  assert.equal(count('private_turns', 'chat_id=?', 'chat-gone'), 1);

  worker.deleteChat('chat-gone');

  assert.equal(count('private_turns', 'chat_id=?', 'chat-gone'), 0, 'prompt and reply text are gone');
  assert.equal(count('private_turn_events', 'turn_id=?', mine.id), 0, 'every streamed delta is gone');
  assert.equal(count('private_reply_reads', 'turn_id=?', mine.id), 0);
  assert.equal(worker.latest('chat-gone').length, 0);
  assert.equal(worker.get(mine.id), undefined);
  // The other conversation is untouched.
  assert.equal(count('private_turns', 'chat_id=?', 'chat-kept'), 1);
  assert.ok(count('private_turn_events', 'turn_id=?', other.id) > 0);
  worker.deleteChat('never-existed'); // harmless
});

test('deleting a chat while its answer is still being written does not crash the worker or bring the text back', async t => {
  const file = fixture(t), started = deferred(), release = deferred();
  const worker = createAgentTurns({ file, execute: async (_t, { emit }) => { emit('delta', { text: 'partial secret' }); started.resolve(); await release.promise; emit('delta', { text: ' more' }); emit('message', { id: 'a', text: 'partial secret more' }); return {}; } });
  t.after(() => worker.close());
  const turn = worker.enqueue(input('chat-live'));
  const running = worker.processNext(); await started.promise;
  worker.deleteChat('chat-live');
  release.resolve();
  await running; await worker.whenIdle();
  const db = new DatabaseSync(file);
  t.after(() => db.close());
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM private_turns WHERE chat_id=?').get('chat-live').n, 0, 'nothing is written back after the delete');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM private_turn_events WHERE turn_id=?').get(turn.id).n, 0);
});

test('with records preservation on, the approval decision and what was attached survive the turn ending; off, they are blanked as before', async t => {
  for (const keepRecords of [true, false]) {
    const file = fixture(t), approvalShown = deferred(), decided = deferred();
    const worker = createAgentTurns({ file, keepRecords, execute: async (_t, { emit, controls }) => {
      emit('sent', { message: { id: 'u' } });
      emit('approval', { approval: { id: 'ap1', command: 'rm -rf build/', description: 'Delete the build folder' } });
      approvalShown.resolve(); await decided.promise;
      emit('approval_resolved', {});
      emit('message', { id: 'a', text: 'Done' }); return {};
    } });
    const api = createAgentTurns({ file, keepRecords });
    t.after(() => { worker.close(); api.close(); });
    const turn = api.enqueue({ ...input(`chat-${keepRecords}`), attachments: [{ name: 'quote.pdf', mime: 'application/pdf', data: Buffer.from('PDFDATA') }] });
    const running = worker.processNext(); await approvalShown.promise;
    api.requestApproval(turn.id, 'ap1', 'once');
    decided.resolve(); await running; await worker.whenIdle();
    const db = new DatabaseSync(file);
    const events = db.prepare("SELECT event, payload FROM private_turn_events WHERE turn_id = ?").all(turn.id);
    const row = db.prepare("SELECT payload, approval FROM private_turns WHERE id = ?").get(turn.id);
    db.close();
    assert.equal(row.payload, '{}', 'the working copy is blanked either way');
    assert.equal(row.approval, null);
    const snap = events.find(e => e.event === 'record_snapshot');
    const decision = events.find(e => e.event === 'approval_decision');
    if (keepRecords) {
      assert.ok(decision, 'the allow/deny decision is kept');
      assert.deepEqual([JSON.parse(decision.payload).choice, JSON.parse(decision.payload).approvalId], ['once', 'ap1']);
      assert.deepEqual(JSON.parse(snap.payload).attachments, [{ name: 'quote.pdf', mime: 'application/pdf', bytes: 7 }], 'what was attached is kept');
    } else {
      assert.equal(snap, undefined); assert.equal(decision, undefined);
    }
  }
});
