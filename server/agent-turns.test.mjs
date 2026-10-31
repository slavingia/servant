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
    assert.throws(() => api.enqueue({ ...input(), requestId: 'request_456' }), { code: 'turn_active' });
    const running = worker.processNext(); await started.promise;
    assert.equal(api.get(turn.id).assistantText, 'Saved partial');
    assert.equal(api.get(turn.id).accepted, true);
    assert.equal(api.owns(turn.id, 'chat', 'stranger'), false);
    const cursor = api.events(turn.id).at(-1).seq;
    finish.resolve(); await running;
    assert.equal(api.get(turn.id).status, 'completed');
    assert.ok(api.events(turn.id, cursor).some(e => e.event === 'done'));
    assert.equal(api.enqueue(input()).id, turn.id);
    assert.equal(calls, 1);
    const notifications = []; api.drainOutbox(e => notifications.push(e)); api.drainOutbox(e => notifications.push(e));
    assert.deepEqual(notifications, [{ eventId: 'one' }]);
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
