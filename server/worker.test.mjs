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
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ upstreams: { member: { url: `http://127.0.0.1:${upstream.address().port}`, key: 'fake-key' } } }));
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
