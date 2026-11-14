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

// How long is left (docs/agent-turns.md): a reply that starts with enough history behind it carries how long
// replies like it usually work. These tests move the clock themselves: each reply works for the next number in
// `work`, and the turn as it was when it began is read back from the journal.
const MIN = 60_000;
const minutes = (...list) => list.map(m => m * MIN);
const began = (turns, id) => turns.events(id).find(e => e.event === 'turn' && e.payload.turn.status === 'running').payload.turn;
const ask = (chatId, n, extra = {}) => ({ ...input(chatId), requestId: `request_${chatId}_${n}`, ...extra });

test('a reply carries how long replies like it usually work once the history can say; before that, nothing new', async t => {
  let now = 1_000_000;
  // Quick answers come and go between the long ones.
  const work = [...minutes(4, 0.2, 6, 8, 0.5, 10, 12)];
  const started = deferred(), finish = deferred();
  const worker = createAgentTurns({ file: fixture(t), clock: () => now, execute: async () => {
    if (work.length) { now += work.shift(); return {}; }
    started.resolve(); await finish.promise; return {};
  } });
  try {
    for (let i = 0; i < 7; i++) {
      const past = worker.enqueue(ask('chat', i));
      await worker.processNext();
      assert.equal('usualMs' in began(worker, past.id), false, 'too little to go on: the turn is what it always was');
      assert.equal('pausedMs' in began(worker, past.id), false);
    }
    const turn = worker.enqueue(ask('chat', 'live'));
    const run = worker.processNext(); await started.promise;
    // Of the five that ran past a minute (4, 6, 8, 10 and 12 minutes), three in four finished within 10.
    assert.deepEqual([worker.get(turn.id).usualMs, worker.get(turn.id).pausedMs, worker.get(turn.id).pausedAt], [10 * MIN, 0, null]);
    assert.equal(worker.latest('chat')[0].usualMs, 10 * MIN, 'the list every device reads has it');
    assert.equal(began(worker, turn.id).usualMs, 10 * MIN, 'and so does the stream, from the moment it starts');
    // Made once, as the reply starts: it holds still however long this one runs.
    now += 45 * MIN;
    assert.equal(worker.get(turn.id).usualMs, 10 * MIN);
    finish.resolve(); await run;
    assert.equal('usualMs' in worker.get(turn.id), false, 'a finished reply has nothing left to estimate');
  } finally { finish.resolve(); await worker.whenIdle(); worker.close(); }
});

test("an estimate is built only from the same person's own replies on the same agent, and only from ones that completed", async t => {
  let now = 1_000_000;
  const work = [];
  const worker = createAgentTurns({ file: fixture(t), clock: () => now, execute: async turn => {
    now += work.shift() ?? 0;
    if (turn.text === 'This one fails') throw new Error('upstream went away');
    return turn.text === 'This one is stopped' ? { status: 'cancelled' } : {};
  } });
  const reply = async (request, ms) => { work.push(ms); const turn = worker.enqueue(request); await worker.processNext(); return began(worker, turn.id); };
  try {
    // Ana builds prototypes in one chat. A reply that failed after an hour and one she stopped say nothing about how long a reply takes.
    for (const [i, m] of [4, 6, 8, 10, 12].entries()) await reply(ask('prototype', i), m * MIN);
    await reply(ask('prototype', 'failed', { text: 'This one fails' }), 60 * MIN);
    await reply(ask('prototype', 'stopped', { text: 'This one is stopped' }), 90 * MIN);
    assert.equal((await reply(ask('prototype', 'next'), 5 * MIN)).usualMs, 10 * MIN);
    // Her new chat has nothing of its own yet, so it goes by her other chats (now 4, 5, 6, 8, 10 and 12 minutes).
    assert.equal((await reply(ask('fresh', 0), 2 * MIN)).usualMs, 9.5 * MIN);
    // Jo is on the member agent. Ana's replies say nothing about Jo's, so Jo's estimate waits for Jo's own five
    // (3, 3, 4, 4 and 5 minutes) and then comes from those.
    const member = (userId, chatId) => ({ user: { id: userId }, chat: { id: chatId, role: 'member', hermesSessionId: `session_${chatId}` } });
    for (const [i, m] of [3, 3, 4, 4, 5].entries()) assert.equal('usualMs' in await reply(ask('jo-chat', i, member('jo', 'jo-chat')), m * MIN), false);
    assert.equal((await reply(ask('jo-chat', 'next', member('jo', 'jo-chat')), 3 * MIN)).usualMs, 4 * MIN);
    // Cy starts a first chat on the same member agent: Jo's replies are not Cy's to be measured by.
    assert.equal('usualMs' in await reply(ask('cy-chat', 0, member('cy', 'cy-chat')), 3 * MIN), false);
    // Ana on the member agent: what the full agent takes her says nothing about this one, and neither does Jo.
    assert.equal('usualMs' in await reply(ask('restricted', 0, member('owner', 'restricted')), 3 * MIN), false);
    // Once the new chat has five long replies of its own (2, 2, 3, 3 and 3 minutes) it is judged by those alone.
    for (const [i, m] of [2, 3, 3, 3].entries()) await reply(ask('fresh', i + 1), m * MIN);
    assert.equal((await reply(ask('fresh', 'own'), MIN)).usualMs, 3 * MIN);
  } finally { await worker.whenIdle(); worker.close(); }
});

test('waiting for an OK is timed apart from the work: while it waits, when it is answered and in the history', async t => {
  let now = 1_000_000;
  const work = [...minutes(4, 6, 8, 10, 12)];
  // Two replies ask for an OK, in this order. Each is held at the ask, and again after the answer.
  const waits = [1, 2].map(n => ({ n, asked: deferred(), answered: deferred(), resumed: deferred(), finish: deferred() }));
  let asks = 0;
  const file = fixture(t);
  const worker = createAgentTurns({ file, clock: () => now, execute: async (turn, hooks) => {
    if (work.length) { now += work.shift(); return {}; }
    if (!turn.text.startsWith('Approve')) return {};
    const wait = waits[asks++];
    wait.hooks = hooks;
    hooks.checkpoint(`run_${wait.n}`);
    now += 2 * MIN;
    hooks.emit('approval', { approval: { id: `approval_${wait.n}`, command: 'fixture', choices: ['once', 'deny'] } });
    wait.asked.resolve(); await wait.answered.promise;
    if (hooks.controls().stop) return { status: 'cancelled' };
    hooks.emit('approval_resolved', {});
    wait.resumed.resolve(); await wait.finish.promise; return {};
  } });
  const times = id => { const { status, usualMs, pausedMs, pausedAt } = worker.get(id); return { status, usualMs, pausedMs, pausedAt }; };
  try {
    for (let i = 0; i < 5; i++) { worker.enqueue(ask('chat', i)); await worker.processNext(); }
    const turn = worker.enqueue(ask('chat', 'approve', { text: 'Approve this' }));
    const run = worker.processNext(); await waits[0].asked.promise;
    const asked = now;
    // Two minutes in, it asks. The clock on the wall moves on; the wait is counted from the ask.
    assert.deepEqual(times(turn.id), { status: 'waiting_for_approval', usualMs: 10 * MIN, pausedMs: 0, pausedAt: asked });
    now += 3 * MIN;
    // A stream that reconnects repeats the ask. It is the same wait.
    waits[0].hooks.emit('approval', { approval: { id: 'approval_1', command: 'fixture', choices: ['once', 'deny'] } });
    assert.equal(times(turn.id).pausedAt, asked);
    now += 15 * MIN;
    waits[0].answered.resolve(); await waits[0].resumed.promise;
    assert.deepEqual(times(turn.id), { status: 'running', usualMs: 10 * MIN, pausedMs: 18 * MIN, pausedAt: null });
    now += 3 * MIN;
    waits[0].finish.resolve(); await run;
    // 23 minutes passed on the wall and it worked for five of them. The history has the five: with 4, 5, 6, 8, 10
    // and 12 minutes the usual time is 9.5; had the wait counted it would be 11.5.
    const next = worker.enqueue(ask('chat', 'after'));
    await worker.processNext();
    assert.equal(began(worker, next.id).usualMs, 9.5 * MIN);

    // A reply stopped while it waits closes that wait too.
    const stopped = worker.enqueue(ask('chat', 'stopped', { text: 'Approve and stop' }));
    const second = worker.processNext(); await waits[1].asked.promise;
    now += 7 * MIN;
    assert.equal(worker.requestStop(stopped.id).status, 'stopping');
    waits[1].answered.resolve(); await second;
    assert.equal(worker.get(stopped.id).status, 'cancelled');
    const db = new DatabaseSync(file);
    t.after(() => db.close());
    assert.deepEqual({ ...db.prepare('SELECT waited_ms, waiting_since FROM private_turns WHERE id=?').get(stopped.id) }, { waited_ms: 7 * MIN, waiting_since: null });
  } finally { for (const wait of waits) { wait.answered.resolve(); wait.finish.resolve(); } await worker.whenIdle(); worker.close(); }
});

test('a reply picked up again after a restart keeps the start and the estimate it had, or the lack of one', async t => {
  const file = fixture(t);
  let now = 1_000_000;
  const work = [...minutes(4, 6, 8, 10, 12)];
  const seed = createAgentTurns({ file, clock: () => now, execute: async () => { now += work.shift() ?? 0; return {}; } });
  for (let i = 0; i < 5; i++) { seed.enqueue(ask('prototype', i)); await seed.processNext(); }
  const estimated = seed.enqueue(ask('estimated', 0)), unestimated = seed.enqueue(ask('unestimated', 0));
  await seed.whenIdle(); seed.close();
  // As a stopped worker leaves them: both running since three minutes ago with a known run. One began with an
  // estimate of seven minutes; the other began when there was nothing to go on.
  const startedAt = now - 3 * MIN;
  const db = new DatabaseSync(file);
  db.prepare("UPDATE private_turns SET status='running',accepted=1,run_id='run_estimated',started_at=?,usual_ms=? WHERE id=?").run(startedAt, 7 * MIN, estimated.id);
  db.prepare("UPDATE private_turns SET status='running',accepted=1,run_id='run_unestimated',started_at=? WHERE id=?").run(startedAt, unestimated.id);
  db.close();
  const resumed = [], finish = deferred();
  const replacement = createAgentTurns({ file, clock: () => now, execute: async turn => { resumed.push(turn.run_id); await finish.promise; return {}; } });
  try {
    assert.equal(replacement.recoverInterrupted(), 2);
    const runs = [replacement.processNext(), replacement.processNext()];
    for (let i = 0; i < 50 && resumed.length < 2; i++) await new Promise(r => setTimeout(r, 5));
    assert.deepEqual(resumed.sort(), ['run_estimated', 'run_unestimated']);
    // The history now says ten minutes. A reply already under way is not measured again halfway through.
    assert.deepEqual([replacement.get(estimated.id).startedAt, replacement.get(estimated.id).usualMs], [startedAt, 7 * MIN]);
    assert.equal(replacement.get(unestimated.id).startedAt, startedAt);
    assert.equal('usualMs' in replacement.get(unestimated.id), false);
    finish.resolve(); await Promise.all(runs);
  } finally { finish.resolve(); await replacement.whenIdle(); replacement.close(); }
});

test('a journal from before replies were estimated opens unchanged, and the replies it timed count', async t => {
  const file = fixture(t);
  let now = 1_000_000;
  const work = [...minutes(4, 6, 8, 10, 12)];
  const execute = async () => { now += work.shift() ?? 0; return {}; };
  const earlier = createAgentTurns({ file, clock: () => now, execute });
  for (let i = 0; i < 5; i++) { earlier.enqueue(ask('chat', i)); await earlier.processNext(); }
  await earlier.whenIdle(); earlier.close();
  const db = new DatabaseSync(file);
  for (const column of ['usual_ms', 'waiting_since', 'waited_ms']) db.exec(`ALTER TABLE private_turns DROP COLUMN ${column}`);
  db.close();
  const upgraded = createAgentTurns({ file, clock: () => now, execute });
  try {
    assert.equal(upgraded.latest('chat').length, 5);
    const turn = upgraded.enqueue(ask('chat', 'after'));
    await upgraded.processNext();
    assert.equal(began(upgraded, turn.id).usualMs, 10 * MIN);
  } finally { await upgraded.whenIdle(); upgraded.close(); }
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
