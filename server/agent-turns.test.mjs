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
    assert.throws(() => worker.enqueue({ ...input(), requestId: 'request_q9', text: 'too many' }), { code: 'queue_full' });
    finish.resolve(); await run;
  } finally { finish.resolve(); await worker.whenIdle(); worker.close(); }
});

test('steer folds a waiting message into the running turn exactly once', async t => {
  const file = fixture(t), started = deferred(), finish = deferred();
  const seen = [];
  const worker = createAgentTurns({ file, execute: async (_t, hooks) => {
    started.resolve();
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
    started.resolve(); await finish.promise;
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
  const worker = createAgentTurns({ file, execute: async () => { started.resolve(); await finish.promise; return {}; } });
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
