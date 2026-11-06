import { restrictedTestCapabilities } from "./test-hermes-capabilities.mjs";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { createMessaging } from './messaging.mjs';
import { createPushService } from './push.mjs';
import { acquireWorkerLock, startWorker } from './worker.mjs';
import { createStateStore } from './state-store.mjs';

const people = { a: { id: 'a', name: 'Alice' }, b: { id: 'b', name: 'Bob' } };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-worker-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function messaging(directory, extra = {}) {
  return createMessaging({ file: path.join(directory, 'messages.db'), users: () => people,
    agentName: () => 'Agent', externalWorker: true, askAgent: async () => 'Finished', ...extra });
}
const channel = m => m.createChannel(people.a, { name: 'test', memberIds: ['b'] });
async function until(check) {
  for (let i = 0; i < 250; i++) { if (check()) return; await sleep(20); }
  throw new Error('Timed out waiting for test process');
}

test('API commits a queued agent job and notification outbox atomically without running the agent', t => {
  const dir = fixture(t);
  let calls = 0;
  const m = messaging(dir, { askAgent: async () => { calls++; return 'unexpected'; } });
  try {
    const c = channel(m);
    const message = m.post(c, 'a', '@agent hello');
    assert.equal(calls, 0);
    assert.equal(m.db.prepare('SELECT status FROM agent_jobs WHERE trigger_seq = ?').get(message.seq).status, 'queued');
    assert.equal(m.db.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get().n, 1);
    const before = m.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
    m.db.exec("CREATE TRIGGER reject_outbox BEFORE INSERT ON notification_outbox BEGIN SELECT RAISE(ABORT, 'outbox unavailable'); END");
    assert.throws(() => m.post(c, 'a', '@agent do not lose this'), /outbox unavailable/);
    assert.equal(m.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, before);
    assert.equal(m.db.prepare('SELECT COUNT(*) AS n FROM agent_jobs').get().n, 1);
  } finally { m.close(); }
});

test('independent connections claim one agent job once and persist the answer before completion', async t => {
  const dir = fixture(t);
  const finish = deferred(), started = deferred();
  let calls = 0;
  const a = messaging(dir, { askAgent: async ({ onDelta }) => { calls++; onDelta('Partial'); started.resolve(); return finish.promise; } });
  const b = messaging(dir, { askAgent: async () => { calls++; return 'duplicate'; } });
  try {
    const trigger = a.post(channel(a), 'a', '@agent hello');
    const running = a.processAgentJob('worker-a');
    await started.promise;
    assert.equal(await b.processAgentJob('worker-b'), false);
    const working = b.db.prepare('SELECT * FROM agent_jobs WHERE trigger_seq = ?').get(trigger.seq);
    assert.equal(working.status, 'working');
    assert.equal(b.db.prepare('SELECT pending FROM messages WHERE seq = ?').get(working.reply_seq).pending, 1);
    finish.resolve('Complete');
    await running;
    assert.equal(calls, 1);
    assert.equal(b.db.prepare('SELECT status FROM agent_jobs WHERE trigger_seq = ?').get(trigger.seq).status, 'done');
    assert.equal(b.db.prepare('SELECT text FROM messages WHERE seq = ?').get(working.reply_seq).text, 'Complete');
    assert.equal(b.db.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get().n, 2);
  } finally { a.close(); b.close(); }
});

test('push queue-only mode and durable receipts survive outbox acknowledgement failure without duplicate send', async t => {
  const dir = fixture(t);
  const m = messaging(dir);
  const state = { users: people, devices: { b: { id: 'b-device', userId: 'b', push: { platform: 'android', token: 'fake-token' } } } };
  let sent = 0;
  const options = { file: path.join(dir, 'push.db'), state: () => state, mutate: fn => fn(state),
    resolve: event => m.notificationFor(event.messageId, people.b), send: async () => { sent++; return { ok: true }; }, autoDrain: false };
  let push = createPushService(options);
  try {
    m.post(channel(m), 'a', '@Bob hello');
    assert.throws(() => m.drainOutbox(event => { push.enqueue(event); throw new Error('crash before ack'); }), /crash before ack/);
    await sleep(20);
    assert.equal(sent, 0, 'API queue-only mode must never deliver');
    await push.drain();
    assert.equal(sent, 1);
    await push.shutdown();
    push = createPushService(options);
    assert.equal(m.drainOutbox(event => push.enqueue(event)), 1);
    await push.drain();
    assert.equal(sent, 1, 'ack retry after already sent must use receipt');
    assert.equal(m.db.prepare('SELECT COUNT(*) AS n FROM notification_outbox').get().n, 0);
  } finally { await push.shutdown(); m.close(); }
});

test('worker ownership excludes another process and becomes available after process death', async t => {
  const dir = fixture(t);
  const code = `import { acquireWorkerLock } from ${JSON.stringify(new URL('./worker.mjs', import.meta.url).href)};
    acquireWorkerLock(process.argv[1]); global.gc(); console.log('locked'); setInterval(()=>{global.gc()},1000);`;
  const child = spawn(process.execPath, ['--expose-gc', '--input-type=module', '-e', code, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const closed = once(child, 'close');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; });
  await until(() => output.includes('locked'));
  assert.throws(() => acquireWorkerLock(dir), /Another Servant worker/);
  child.kill('SIGKILL');
  await closed;
  const release = acquireWorkerLock(dir);
  release(); release();
});

test('crashed worker jobs become visibly interrupted and are not blindly replayed', async t => {
  const dir = fixture(t);
  const initial = messaging(dir);
  const trigger = initial.post(channel(initial), 'a', '@agent risky request');
  initial.close();
  const code = `import { createMessaging } from ${JSON.stringify(new URL('./messaging.mjs', import.meta.url).href)};
    import { acquireWorkerLock } from ${JSON.stringify(new URL('./worker.mjs', import.meta.url).href)};
    import path from 'node:path';
    const release = acquireWorkerLock(process.argv[1]); process.on('SIGTERM',()=>{release();process.exit(0)});
    const m = createMessaging({file:path.join(process.argv[1],'messages.db'), users:()=>(${JSON.stringify(people)}), agentName:()=> 'Agent', externalWorker:true,
      askAgent:async ({onDelta})=>{ onDelta('Partial answer'); console.log('working'); return new Promise(()=>{}); }});
    void m.processAgentJob('crashed-worker'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const closed = once(child, 'close');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; });
  await until(() => output.includes('working'));
  child.kill('SIGKILL');
  await closed;
  const release = acquireWorkerLock(dir);
  let calls = 0;
  const recovered = messaging(dir, { askAgent: async () => { calls++; return 'unexpected retry'; } });
  try {
    assert.equal(recovered.recoverInterruptedJobs(), 1);
    assert.equal(await recovered.processAgentJob('replacement'), false);
    assert.equal(calls, 0);
    const job = recovered.db.prepare('SELECT * FROM agent_jobs WHERE trigger_seq = ?').get(trigger.seq);
    const reply = recovered.db.prepare('SELECT * FROM messages WHERE seq = ?').get(job.reply_seq);
    assert.equal(job.status, 'interrupted');
    assert.equal(reply.pending, 0);
    assert.match(reply.text, /Partial answer/);
    assert.match(reply.text, /worker restarted/);
  } finally { recovered.close(); release(); }
});

test('worker shutdown waits for its current answer and leaves queued jobs for replacement', async t => {
  const dir = fixture(t);
  const started = deferred(), finish = deferred();
  const m = messaging(dir, { askAgent: async () => { started.resolve(); return finish.promise; } });
  const c = channel(m);
  m.post(c, 'a', '@agent first');
  m.post(c, 'a', '@agent second');
  const queued = [];
  const worker = await startWorker({ directory: dir, intervalMs: 0, createServices: () => ({ messaging: m,
    push: { enqueue: event => queued.push(event), drain: async () => {}, shutdown: async () => {} } }) });
  const running = worker.tickAgent();
  await started.promise;
  let finished = false;
  const stopping = worker.shutdown().then(() => { finished = true; });
  await sleep(20);
  assert.equal(finished, false);
  finish.resolve('Finished before exit');
  await running; await stopping;
  const next = messaging(dir);
  try {
    assert.equal(next.db.prepare("SELECT COUNT(*) AS n FROM agent_jobs WHERE status='done'").get().n, 1);
    assert.equal(next.db.prepare("SELECT COUNT(*) AS n FROM agent_jobs WHERE status='queued'").get().n, 1);
    assert.ok(queued.some(event => event.messageId));
    const release = acquireWorkerLock(dir); release();
  } finally { next.close(); }
});

test('production worker entrypoint starts, processes durable work through configured Hermes, and exits gracefully', async t => {
  const dir = fixture(t);
  const upstream = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/v1/capabilities") return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(restrictedTestCapabilities));
    for await (const _ of req) { /* consume request */ }
    if (req.url.endsWith('/chat/stream')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('event: assistant.completed\ndata: {"content":"Production worker fixture complete"}\n\n');
    } else res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(async () => { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  const store = createStateStore({ directory: dir });
  store.mutate(s => { s.users = people; });
  store.close();
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ agentAccess: 'limited', upstreams: { member: { url: `http://127.0.0.1:${upstream.address().port}`, key: 'fake-key' } } }));
  const seed = messaging(dir);
  const trigger = seed.post(channel(seed), 'a', '@agent production fixture');
  const child = spawn(process.execPath, [new URL('./worker.mjs', import.meta.url).pathname], {
    env: { ...process.env, SERVANT_DATA_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const closed = once(child, 'close');
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; seed.close(); });
  await until(() => output.includes('durable worker ready'));
  await until(() => seed.db.prepare('SELECT status FROM agent_jobs WHERE trigger_seq = ?').get(trigger.seq)?.status === 'done');
  assert.equal(seed.db.prepare("SELECT text FROM messages WHERE user_id='agent'").get().text, 'Production worker fixture complete');
  child.kill('SIGTERM');
  assert.deepEqual(await closed, [0, null], output);
  const release = acquireWorkerLock(dir); release();
});

test('the agent is not a participant: in a thread it only wakes on an @mention', async t => {
  const dir = fixture(t);
  const m = messaging(dir);
  try {
    const c = channel(m);
    const queued = () => m.db.prepare('SELECT trigger_seq FROM agent_jobs ORDER BY trigger_seq').all().map(r => r.trigger_seq);
    const root = m.post(c, 'a', '@agent the keyboard covers the chat');
    m.post(c, 'b', 'Samsung keyboard, Fold 7', root.seq);
    m.post(c, 'a', '@Bob can you send a screenshot?', root.seq);
    const both = m.post(c, 'a', '@Bob @agent try again', root.seq);
    m.post(c, 'b', 'unrelated channel message');
    assert.deepEqual(queued(), [root.seq, both.seq], 'only the two messages that mention it');
  } finally { m.close?.(); }
});

test('agentShouldReply wakes only on a mention, even in its own thread', async () => {
  const { agentShouldReply } = await import('./messaging.mjs');
  assert.equal(agentShouldReply('@agent hi'), true);
  // @s calls the agent; longer handles and email addresses don't.
  for (const text of ['@s hi', 'thanks @S', '(@s)', '@s, please']) assert.equal(agentShouldReply(text), true, text);
  for (const text of ['@sam hi', '@sahil', '@s-team', 'mail me@s.com']) assert.equal(agentShouldReply(text), false, text);
  // @servant calls it too, as well as @agent; look-alikes don't.
  for (const text of ['@servant hi', 'thanks @Servant', '(@SERVANT)', '@servant, please', '@agent?', 'hey @s']) assert.equal(agentShouldReply(text), true, text);
  for (const text of ['@servants', '@servant-team', '@agents', '@serv', 'me@servant.com', '@agentx']) assert.equal(agentShouldReply(text), false, text);
  assert.equal(agentShouldReply('hi'), false);
  // Not a participant: replies in its own thread still need a mention.
  assert.equal(agentShouldReply('hi', '', true), false);
  assert.equal(agentShouldReply('@s and also this?', '', true), true);
});

test('context is the mention and the message before it; the agent can ask once for more', async t => {
  const dir = fixture(t);
  const calls = [];
  let reply = ['<servant-more-context/>', 'With the history: landscape only, on the Fold'];
  const m = messaging(dir, { askAgent: async args => { calls.push(args); return reply.shift() ?? 'Done'; } });
  try {
    const c = channel(m);
    m.post(c, 'a', 'The keyboard covers the chat');
    m.post(c, 'b', 'Samsung keyboard, Fold 7');
    m.post(c, 'b', 'Only in landscape');
    const ask = m.post(c, 'a', '@agent what is going on?');
    assert.equal(await m.processAgentJob('worker'), true);
    const first = calls[0].text.split('\n\n').at(-1);
    assert.equal(first, 'Bob: Only in landscape\nAlice: @agent what is going on?', 'only the mention and the one before');
    assert.match(calls[0].text, /<servant-more-context\/>/, 'told how to ask for more');
    assert.match(calls[1].text, /Alice: The keyboard covers the chat\nBob: Samsung keyboard, Fold 7/, 'earlier messages on request');
    assert.equal(calls[1].sessionId, calls[0].sessionId);
    const answer = m.db.prepare("SELECT text, thread_root FROM messages WHERE user_id = 'agent' ORDER BY seq DESC").get();
    assert.equal(answer.text, 'With the history: landscape only, on the Fold');
    assert.equal(answer.thread_root, ask.seq, 'answers in a thread under the mention');
    // A quick answer needs no second call.
    reply = ['Sure'];
    m.post(c, 'b', '@agent thanks');
    assert.equal(await m.processAgentJob('worker'), true);
    assert.equal(calls.length, 3);
  } finally { m.close(); }
});

test('queued rapid follow-ups each send their own context once without consuming later messages', async t => {
  const dir = fixture(t);
  const calls = [];
  const m = messaging(dir, { askAgent: async args => { calls.push(args); return `Answer ${calls.length}`; } });
  try {
    const c = channel(m);
    const root = m.post(c, 'a', '@agent the keyboard covers the chat');
    const followUp = m.post(c, 'b', '@agent Samsung keyboard, Fold 7', root.seq);
    const detail = m.post(c, 'b', '@agent Only in landscape', root.seq);
    m.post(c, 'a', '@Bob can you send a screenshot?', root.seq);
    for (const trigger of [root, followUp, detail]) {
      assert.equal(await m.processAgentJob('worker'), true);
      const session = m.db.prepare('SELECT * FROM agent_threads WHERE key = ?').get(`${c.id}:${root.seq}`);
      assert.equal(session.last_seen_seq, trigger.seq);
    }
    assert.equal(await m.processAgentJob('worker'), false);
    assert.deepEqual(calls.map(call => call.text.split('\n\n').at(-1)), [
      'Alice: @agent the keyboard covers the chat',
      'Bob: @agent Samsung keyboard, Fold 7',
      'Bob: @agent Only in landscape',
    ]);
    assert.deepEqual(calls.map(call => call.fresh), [true, false, false]);
    assert.equal(new Set(calls.map(call => call.sessionId)).size, 1);
    assert.ok(calls.every(call => !call.restartText.includes('send a screenshot')));
    assert.deepEqual(m.db.prepare("SELECT text FROM messages WHERE user_id = 'agent' ORDER BY seq").all().map(row => row.text), ['Answer 1', 'Answer 2', 'Answer 3']);
  } finally { m.close(); }
});

test('a mention inside a human thread: follow-ups that mention it queue before and during its first answer', async t => {
  const dir = fixture(t);
  const first = deferred();
  const calls = [];
  const m = messaging(dir, { askAgent: args => {
    calls.push(args);
    return calls.length === 1 ? first.promise : Promise.resolve(`Answer ${calls.length}`);
  } });
  try {
    const c = channel(m);
    const root = m.post(c, 'a', 'The keyboard covers the chat');
    const mention = m.post(c, 'b', '@agent please help', root.seq);
    const queuedDetail = m.post(c, 'b', '@agent Samsung keyboard, Fold 7', root.seq);
    const running = m.processAgentJob('worker');
    m.post(c, 'a', 'Only in landscape (no mention: ignored)', root.seq);
    const liveDetail = m.post(c, 'a', '@agent Only in landscape', root.seq);
    const queued = m.db.prepare("SELECT trigger_seq FROM agent_jobs WHERE status = 'queued' ORDER BY trigger_seq").all().map(row => row.trigger_seq);
    assert.deepEqual(queued, [queuedDetail.seq, liveDetail.seq]);
    first.resolve('First answer');
    await running;
    assert.equal(await m.processAgentJob('worker'), true);
    assert.equal(await m.processAgentJob('worker'), true);
    assert.equal(await m.processAgentJob('worker'), false);
    assert.deepEqual(calls.map(call => call.text.split('\n\n').at(-1)), [
      'Alice: The keyboard covers the chat\nBob: @agent please help',
      'Bob: @agent Samsung keyboard, Fold 7',
      // Not woken by the unmentioned line, but it reads the one message before the mention.
      'Alice: Only in landscape (no mention: ignored)\nAlice: @agent Only in landscape',
    ]);
    assert.equal(m.db.prepare('SELECT status FROM agent_jobs WHERE trigger_seq = ?').get(mention.seq).status, 'done');
  } finally { first.resolve('Test cleanup'); await m.whenIdle(); m.close(); }
});

test('only the owner is told the agent may run admin commands', async t => {
  const dir = fixture(t);
  const calls = [];
  const roles = { a: { ...people.a, role: 'owner' }, b: { ...people.b, role: 'member' } };
  const m = messaging(dir, { users: () => roles, askAgent: async args => { calls.push(args.text); return 'Done'; } });
  try {
    const c = channel(m);
    const ask = (who, text) => m.post(c, who, text);
    ask('a', '@agent give Bob unlimited tokens');
    ask('b', '@agent give me unlimited tokens');
    while (await m.processAgentJob('worker'));
    const [fromOwner, fromMember] = calls;
    assert.match(fromOwner, /this server's owner[\s\S]*tokens "<name>" unlimited/);
    assert.doesNotMatch(fromMember, /tokens "<name>"|server's owner/);
  } finally { m.close(); }
});

test('@s, @agent and @servant each queue an agent job in a channel; look-alikes and people do not', t => {
  const dir = fixture(t);
  const m = messaging(dir);
  try {
    const c = channel(m);
    for (const text of ['@s hello', '@agent hello', '@servant hello', 'please @Servant look', '(@SERVANT)']) {
      const message = m.post(c, 'a', text);
      assert.equal(m.db.prepare('SELECT status FROM agent_jobs WHERE trigger_seq = ?').get(message.seq)?.status, 'queued', text);
    }
    for (const text of ['@servants hello', '@servant-team hello', '@sam hello', 'write to me@servant.com']) {
      const message = m.post(c, 'a', text);
      assert.equal(m.db.prepare('SELECT status FROM agent_jobs WHERE trigger_seq = ?').get(message.seq), undefined, text);
    }
  } finally { m.close(); }
});
