import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { stageRelease, controlRequest } from './deploy.mjs';
import { startSupervisor } from './supervisor.mjs';
import { createStateStore } from './state-store.mjs';
import { testFetch } from './encrypted-test-client.mjs';

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const token = 'isolated-deployment-owner-token';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

async function until(check, description) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const value = await check();
    if (value) return value;
    await sleep(20);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function removeFixture(directory) {
  const writable = folder => {
    fs.chmodSync(folder, 0o700);
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.isDirectory()) writable(path.join(folder, entry.name));
    }
  };
  writable(directory);
  fs.rmSync(directory, { recursive: true, force: true });
}

async function fixture(t) {
  // Resolve macOS /var -> /private/var so the real CLI entrypoint check matches.
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'servant-real-deploy-')));
  const dataDir = path.join(directory, 'data');
  const runtimeDir = path.join(directory, 'runtime');
  fs.mkdirSync(dataDir);
  // Never use the workstation's push credentials, configuration, or real Hermes.
  const pushConfig = path.join(directory, 'push.json');
  fs.writeFileSync(pushConfig, '{}');
  const turns = [];
  const sessions = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (req.method === 'POST' && req.url === '/api/sessions') {
      sessions.push(body.id);
      res.writeHead(201, { 'Content-Type': 'application/json' }).end('{}');
    } else if (req.method === 'POST' && req.url.endsWith('/chat/stream')) {
      const kind = body.message === 'direct request across deployment' ? 'direct' : 'channel';
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: assistant.delta\ndata: {"delta":"Still working"}\n\n');
      turns.push({ kind, finish: () => {
        if (!res.writableEnded) res.end(`event: assistant.completed\ndata: ${JSON.stringify({ content: `Finished ${kind} safely` })}\n\n`);
      } });
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
    }
  });
  let service, worker, workerDone;
  let workerOutput = '';
  const diagnostics = [];
  t.after(async () => {
    for (const turn of turns) turn.finish();
    if (worker && worker.exitCode === null && worker.signalCode === null) worker.kill('SIGTERM');
    const force = setTimeout(() => {
      if (worker && worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
    }, 6000);
    try {
      await workerDone;
      await service?.close();
    } finally {
      clearTimeout(force);
      upstream.closeAllConnections();
      await new Promise(resolve => upstream.close(resolve));
      removeFixture(directory);
    }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const up = { url: `http://127.0.0.1:${upstream.address().port}`, key: 'isolated-upstream-key' };
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    host: '127.0.0.1', port: 0, name: 'Isolated deployment', upstreams: { owner: up, member: up },
  }));
  const store = createStateStore({ directory: dataDir });
  store.mutate(state => {
    state.users.owner = { id: 'owner', name: 'Owner', role: 'owner' };
    state.devices[hash(token)] = { id: 'owner-device', userId: 'owner' };
  });
  store.close();
  const first = stageRelease({ sourceDir, runtimeDir, id: 'first' });
  stageRelease({ sourceDir, runtimeDir, id: 'second' });
  const env = { SERVANT_PUSH_CONFIG: pushConfig };
  try {
    service = await startSupervisor({
      runtimeDir, dataDir, port: 0, initialRelease: 'first', candidateTimeoutMs: 5000,
      childEnv: env, log: { log() {}, error: (...args) => diagnostics.push(args.join(' ')) },
    });
  } catch (error) {
    const logfile = path.join(runtimeDir, 'logs', 'first.log');
    throw new Error(`${error.message}\n${fs.existsSync(logfile) ? fs.readFileSync(logfile, 'utf8') : ''}`, { cause: error });
  }
  worker = spawn(process.execPath, [path.join(first.directory, 'worker.mjs')], {
    env: { ...process.env, ...env, SERVANT_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  worker.stdout.on('data', chunk => { workerOutput += chunk; });
  worker.stderr.on('data', chunk => { workerOutput += chunk; });
  workerDone = once(worker, 'close').then(([code, signal]) => ({ code, signal }));
  await until(() => {
    if (worker.exitCode !== null) throw new Error(workerOutput);
    return workerOutput.includes('durable worker ready');
  }, 'durable worker startup');
  const base = `http://127.0.0.1:${service.proxy.address().port}`;
  const fetchApi = (route, { method = 'GET', body } = {}) => testFetch(dataDir, base + route, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15000), ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const api = async (route, options, status = 200) => {
    const response = await fetchApi(route, options);
    const body = await response.json();
    assert.equal(response.status, status, JSON.stringify(body));
    return body;
  };
  return { directory, dataDir, runtimeDir, base, service, worker, workerDone, turns, sessions, api, fetchApi, diagnostics };
}

test('real encrypted APIs preserve reads, writes, direct streams and durable jobs through deploy and rollback', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const firstPid = f.service.status().active.pid;
  const workerPid = f.worker.pid;
  const conversations = (await f.api('/v1/conversations')).conversations;
  const general = conversations.find(conversation => conversation.name === 'general');
  assert.ok(general);
  const messagesRoute = `/v1/conversations/${general.id}/messages`;
  const chat = (await f.api('/v1/chats', { method: 'POST', body: {} }, 201)).chat;
  const direct = await f.fetchApi(`/v1/chats/${chat.id}/messages`, {
    method: 'POST', body: { text: 'direct request across deployment' },
  });
  assert.equal(direct.status, 200);
  let directFinished = false;
  const directBody = direct.text().then(body => { directFinished = true; return body; });
  // Register a rejection handler immediately while the controlled stream is held.
  directBody.catch(() => {});
  const trigger = (await f.api(messagesRoute, {
    method: 'POST', body: { text: '@agent isolated durable job across deployment' },
  }, 201)).message;
  await until(() => f.turns.length === 2, 'both upstream turns to start');
  assert.deepEqual(f.turns.map(turn => turn.kind).sort(), ['channel', 'direct']);

  let running = true, phase = 'before';
  const reads = [], writes = [], failures = [];
  const load = Promise.all([
    (async () => {
      while (running) {
        const started = phase;
        try {
          const me = await f.api('/v1/me');
          assert.equal(me.user.id, 'owner');
          reads.push(started);
        } catch (error) { failures.push(error); }
        await sleep(5);
      }
    })(),
    (async () => {
      let sequence = 0;
      while (running) {
        const started = phase;
        const text = `Deployment message ${sequence++}`;
        try {
          const result = await f.api(messagesRoute, { method: 'POST', body: { text } }, 201);
          writes.push({ phase: started, id: result.message.id, text });
        } catch (error) { failures.push(error); }
        await sleep(5);
      }
    })(),
  ]);
  try {
    await until(() => reads.length >= 3 && writes.length >= 3, 'baseline authenticated traffic');
    phase = 'deploy';
    const deployed = await controlRequest(f.runtimeDir, '/deploy', { release: 'second' });
    assert.equal(deployed.active.release, 'second');
    assert.notEqual(deployed.active.pid, firstPid);
    assert.ok(deployed.retiring.some(record => record.pid === firstPid && record.inFlight > 0 && !record.signaled));
    assert.equal(directFinished, false);
    assert.equal((await (await fetch(f.base + '/ready')).json()).release, 'second');
    phase = 'second';
    await until(() => reads.filter(value => value === phase).length >= 3 && writes.filter(value => value.phase === phase).length >= 3, 'traffic on second release');

    phase = 'rollback';
    const rolledBack = await controlRequest(f.runtimeDir, '/rollback', {});
    assert.equal(rolledBack.active.release, 'first');
    assert.notEqual(rolledBack.active.pid, firstPid);
    assert.ok(rolledBack.retiring.some(record => record.pid === firstPid && record.inFlight > 0 && !record.signaled));
    assert.equal(directFinished, false);
    assert.equal(f.worker.pid, workerPid);
    assert.equal(f.worker.exitCode, null);
    phase = 'after';
    await until(() => reads.filter(value => value === phase).length >= 3 && writes.filter(value => value.phase === phase).length >= 3, 'traffic after rollback');
  } finally {
    running = false;
    await load;
    for (const turn of f.turns) turn.finish();
  }
  assert.deepEqual(failures.map(error => error.message), []);
  for (const phase of ['before', 'deploy', 'second', 'rollback', 'after']) {
    assert.ok(reads.includes(phase), `No authenticated read observed during ${phase}`);
    assert.ok(writes.some(write => write.phase === phase), `No authenticated write observed during ${phase}`);
  }
  assert.match(await directBody, /Finished direct safely/);
  const thread = await until(async () => {
    const result = await f.api(`/v1/conversations/${general.id}/threads/${trigger.id}`);
    return result.replies.some(reply => reply.user.id === 'agent' && !reply.pending) && result;
  }, 'durable channel completion after both handoffs');
  assert.equal(thread.replies.length, 1);
  assert.equal(thread.replies[0].text, 'Finished channel safely');
  assert.equal(thread.root.replyCount, 1);
  assert.equal(f.turns.length, 2, 'Neither deployment may repeat an upstream agent turn');
  assert.equal(f.sessions.length, 2, 'Neither deployment may create duplicate upstream sessions');

  const retained = new Map();
  let before;
  while (true) {
    const page = await f.api(messagesRoute + (before ? `?before=${before}` : ''));
    for (const message of page.messages) retained.set(message.id, message);
    if (!page.more) break;
    before = page.messages[0].id;
  }
  for (const write of writes) assert.equal(retained.get(write.id)?.text, write.text);
  assert.equal(new Set(writes.map(write => write.id)).size, writes.length);
  assert.ok((await f.api('/v1/chats')).chats.some(value => value.id === chat.id));
  const db = new DatabaseSync(path.join(f.dataDir, 'messages.db'), { readOnly: true });
  try {
    const jobs = db.prepare('SELECT status, reply_seq FROM agent_jobs').all();
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].status, 'done');
    assert.equal(String(jobs[0].reply_seq), thread.replies[0].id);
  } finally { db.close(); }
  await until(() => f.service.status().retiring.length === 0, 'accepted old-generation requests to drain');
  assert.deepEqual(f.diagnostics, []);
  t.diagnostic(`${reads.length} encrypted reads and ${writes.length} durable writes succeeded across deployment and rollback; both held agent turns finished once.`);
});
