import { restrictedTestCapabilities } from "./test-hermes-capabilities.mjs";
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createMessaging } from './messaging.mjs';
import { createStateStore } from './state-store.mjs';
import { testFetch } from './encrypted-test-client.mjs';
import { serverIdentity } from './secure-transport.mjs';
import { sealRequest } from '../app/src/lib/tunnel-crypto.ts';

async function until(check) {
  for (let i = 0; i < 250; i++) {
    const value = check();
    if (value) return value;
    await sleep(20);
  }
  throw new Error('Timed out waiting for server');
}

async function fixture(t, { timeout = 5000, harness = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-shutdown-'));
  const turns = [];
  const upstream = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/v1/capabilities") return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(restrictedTestCapabilities));
    for await (const _ of req) { /* consume body */ }
    if (req.url.endsWith('/chat/stream')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: assistant.delta\ndata: {"delta":"Working"}\n\n');
      turns.push(() => res.end('event: assistant.completed\ndata: {"content":"Finished safely"}\n\n'));
    } else res.writeHead(200, { 'Content-Type': 'application/json' }).end(req.url.endsWith('/messages') ? '{"data":[]}' : '{}');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const up = { url: `http://127.0.0.1:${upstream.address().port}`, key: 'fake-key' };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ host: '127.0.0.1', port: 0, upstreams: { owner: up, member: up } }));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
    users: { u: { id: 'u', name: 'Test', role: 'owner' } },
    devices: { [crypto.createHash('sha256').update('test-token').digest('hex')]: { id: 'd', userId: 'u' } },
    invites: {}, chats: { cht_test: { id: 'cht_test', userId: 'u', role: 'owner', hermesSessionId: 's', title: 'New chat', updatedAt: 0 } },
  }));
  const serverUrl = new URL('./server.mjs', import.meta.url);
  const args = harness ? ['--input-type=module', '-e', `
    import { startServer } from ${JSON.stringify(serverUrl.href)};
    const s = await startServer();
    console.log('listening on http://127.0.0.1:' + s.address().port);
    s.on('request', req => { if (req.headers['x-shutdown-test-late']) process.send('accepted'); });
    process.on('message', async m => {
      if (m === 'drain') { s.drain(); process.send('drained'); }
      if (m === 'shutdown') { await s.shutdown(); process.exit(0); }
    });
  `] : [serverUrl.pathname];
  const child = spawn(process.execPath, args, {
    env: { ...process.env, SERVANT_DATA_DIR: dir, SERVANT_PORT: '0', SERVANT_SHUTDOWN_TIMEOUT_MS: String(timeout) },
    stdio: ['ignore', 'pipe', 'pipe', ...(harness ? ['ipc'] : [])],
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = await until(() => output.match(/listening on (http:\/\/127.0.0.1:\d+)/)?.[1]);
  const api = (route, options = {}) => testFetch(dir, base + route, { ...options,
    headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' } });
  return { child, exited, api, base, turns, dir, output: () => output };
}

test('SIGTERM preserves a direct agent response through completion', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const response = await f.api('/v1/chats/cht_test/messages', { method: 'POST', body: JSON.stringify({ text: 'Hello' }) });
  const body = response.text();
  await until(() => f.turns.length);
  f.child.kill('SIGTERM');
  await until(() => f.output().includes('draining requests'));
  assert.equal(f.child.exitCode, null);
  f.turns[0]();
  assert.match(await body, /Finished safely/);
  assert.deepEqual(await f.exited, [0, null], f.output());
  const store = createStateStore({ directory: f.dir });
  try { assert.ok(store.read().chats.cht_test.updatedAt > 0); } finally { store.close(); }
});

test('disconnected direct-agent requests still finish before shutdown', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const response = await f.api('/v1/chats/cht_test/messages', { method: 'POST', body: JSON.stringify({ text: 'Hello' }) });
  await until(() => f.turns.length);
  await response.body.cancel();
  f.child.kill('SIGTERM');
  await until(() => f.output().includes('draining requests'));
  await sleep(80);
  assert.equal(f.child.exitCode, null, 'must wait even after the HTTP connection closes');
  f.turns[0]();
  assert.deepEqual(await f.exited, [0, null], f.output());
});

test('shutdown finishes detached channel agent work and closes idle event streams', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const events = await f.api('/v1/events', { method: 'POST' });
  const eventBody = events.text();
  const list = await (await f.api('/v1/conversations')).json();
  const channel = list.conversations.find(c => c.name === 'general');
  const sent = await f.api(`/v1/conversations/${channel.id}/messages`, {
    method: 'POST', body: JSON.stringify({ text: '@agent hello' }),
  });
  assert.equal(sent.status, 201);
  await sent.json();
  await until(() => f.turns.length);
  f.child.kill('SIGTERM');
  assert.match(await eventBody, /event: ready/);
  assert.equal(f.child.exitCode, null, 'detached reply must outlive HTTP server closure');
  f.turns[0]();
  assert.deepEqual(await f.exited, [0, null], f.output());
  const db = new DatabaseSync(path.join(f.dir, 'messages.db'));
  try {
    const reply = db.prepare("SELECT m.text, m.pending FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.user_id = 'agent' AND c.kind = 'channel'").get();
    assert.equal(reply.text, 'Finished safely');
    assert.equal(reply.pending, 0);
  } finally { db.close(); }
});

test('shutdown deadline exits unsuccessfully with an explicit interruption warning', { timeout: 10000 }, async t => {
  const f = await fixture(t, { timeout: 100 });
  const response = await f.api('/v1/chats/cht_test/messages', { method: 'POST', body: JSON.stringify({ text: 'Hello' }) });
  await response.body.cancel();
  f.child.kill('SIGTERM');
  assert.deepEqual(await f.exited, [1, null]);
  assert.match(f.output(), /deadline exceeded; unfinished work may be interrupted/);
});

test('readiness is withdrawn before shutdown and new writes are refused', { timeout: 10000 }, async t => {
  const f = await fixture(t, { harness: true });
  assert.equal((await f.api('/ready')).status, 200);
  const ack = once(f.child, 'message');
  f.child.send('drain');
  await ack;
  assert.equal((await f.api('/ready')).status, 503);
  assert.equal((await f.api('/health')).status, 200);
  const write = await fetch(f.base + '/v1/secure', { method: 'POST', body: '{}' });
  assert.equal(write.status, 503);
  assert.equal(write.headers.get('retry-after'), '1');
  await write.text();
  f.child.send('shutdown');
  assert.deepEqual(await f.exited, [0, null], f.output());
});

test('an encrypted event request accepted before drain cannot open a late subscription', { timeout: 10000 }, async t => {
  const f = await fixture(t, { harness: true });
  const tunnel = sealRequest(serverIdentity(f.dir).publicKey, {
    method: 'POST', path: '/v1/events', headers: { authorization: 'Bearer test-token' }, body: '', at: Date.now(),
  }, crypto.randomBytes(32), crypto.randomBytes(32));
  t.after(() => tunnel.destroy());
  const body = JSON.stringify(tunnel.envelope);
  let request;
  const accepted = once(f.child, 'message');
  const responseBody = new Promise((resolve, reject) => {
    request = http.request(f.base + '/v1/secure', { method: 'POST', headers: {
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'X-Shutdown-Test-Late': '1',
    } }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve(text));
      res.on('error', reject);
    });
    request.on('error', reject);
    request.write(body.slice(0, 10));
  });
  await accepted;
  const drained = once(f.child, 'message');
  f.child.send('drain');
  await drained;
  request.end(body.slice(10));
  const frames = (await responseBody).trim().split('\n').map(line => tunnel.openFrame(line));
  assert.equal(frames[0].status, 503);
  assert.equal(frames.at(-1).type, 'end');
  f.child.send('shutdown');
  assert.deepEqual(await f.exited, [0, null], f.output());
});

test('draining rejects late event subscriptions and removes listeners before ending streams', async () => {
  const user = { id: 'u', name: 'Test' };
  const messaging = createMessaging({ file: ':memory:', users: () => ({ u: user }), agentName: () => 'Agent' });
  const response = new EventEmitter();
  let ended = false;
  response.writeHead = () => {};
  response.write = () => { assert.equal(ended, false, 'must not write after ending a stream'); };
  response.end = () => { ended = true; }; // Deliberately delays the close event.
  let failure;
  const context = { user, method: 'POST', parts: ['v1', 'events'], url: new URL('http://local/v1/events'),
    cors: {}, fail: (_res, status) => { failure = status; } };
  try {
    const channel = messaging.createChannel(user, { name: 'test' });
    await messaging.handle({}, response, context);
    messaging.closeEvents();
    assert.equal(ended, true);
    messaging.post(channel, user.id, 'A reply finishing during drain');
    await messaging.handle({}, response, context);
    assert.equal(failure, 503);
  } finally { messaging.close(); }
});
