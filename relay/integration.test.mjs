import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Miniflare } from 'miniflare';
import { connectRelay } from '../server/relay-client.mjs';
import { createSecureTransport } from '../server/secure-transport.mjs';
import { encryptedFetch } from '../app/src/lib/tunnel-client.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
async function eventually(check) { for (let i = 0; i < 100; i++) { if (await check()) return; await delay(20); } assert.fail('Condition not reached'); }

test('actual Worker runtime authenticates its host and carries pinned encrypted HTTP through WebSocket, including host reconnect', async t => {
  const hubId = crypto.randomBytes(18).toString('base64url');
  const token = crypto.randomBytes(32).toString('base64url');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-worker-'));
  const transport = createSecureTransport(directory);
  let calls = 0;
  const local = http.createServer((req, res) => {
    assert.equal(req.url, '/v1/secure');
    void transport.handle(req, res, async (inner, output) => {
      calls++;
      assert.equal(inner.headers.authorization, 'Bearer native-private-device-token');
      let body = '';
      for await (const chunk of inner) body += chunk;
      output.writeHead(200, { 'content-type': 'application/json' });
      output.end(JSON.stringify({ text: body, reply: 'private-agent-reply' }));
    });
  });
  await new Promise(resolve => local.listen(0, '127.0.0.1', resolve));
  const mf = new Miniflare({ modules: true, scriptPath: path.join(HERE, 'worker.mjs'), modulesRoot: path.dirname(HERE),
    compatibilityDate: '2026-07-30', durableObjects: { HUBS: 'Hub' },
    bindings: { SERVANT_RELAY_HUBS: JSON.stringify({ [hubId]: crypto.createHash('sha256').update(token).digest('hex') }) } });
  let controller = new AbortController(), connection;
  t.after(async () => {
    controller.abort(); await connection;
    await mf.dispose();
    local.closeAllConnections(); await new Promise(resolve => local.close(resolve));
    transport.close(); fs.rmSync(directory, { recursive: true, force: true });
  });
  const origin = (await mf.ready).origin;
  const base = `${origin}/hubs/${hubId}`;
  assert.equal((await fetch(`${base}/health`)).status, 503);
  const bad = await mf.dispatchFetch(`${base}/connect`, { headers: { upgrade: 'websocket' } });
  assert.equal(bad.status, 101);
  const invalid = bad.webSocket;
  invalid.accept();
  const rejected = new Promise(resolve => invalid.addEventListener('close', event => resolve(event.code)));
  invalid.send(JSON.stringify({ type: 'auth', token: 'w'.repeat(43) }));
  assert.equal(await rejected, 1008);
  assert.equal((await fetch(`${base}/health`)).status, 503);

  const connect = () => connectRelay({ url: base.replace(/^http:/, 'ws:') + '/connect', token,
    port: local.address().port, signal: controller.signal });
  connection = connect();
  await eventually(async () => (await fetch(`${base}/health`)).status === 200);
  const body = 'phone-private-message ' + crypto.randomBytes(120_000).toString('base64');
  const response = await encryptedFetch(base, transport.publicKey, '/v1/messages', {
    method: 'POST', headers: { Authorization: 'Bearer native-private-device-token' }, body,
  });
  assert.deepEqual(await response.json(), { text: body, reply: 'private-agent-reply' });
  assert.equal(calls, 1);
  assert.equal((await fetch(`${base}/v1/me`)).status, 404);
  assert.equal((await fetch(`${base}/v1/secure?path=/admin`, { method: 'POST', body: 'x' })).status, 404);
  await assert.rejects(encryptedFetch(base, transport.publicKey, '/v1/messages', {}, async (url, init) => {
    const envelope = JSON.parse(init.body);
    envelope.data = 'AAAA' + envelope.data.slice(4);
    return fetch(url, { ...init, body: JSON.stringify(envelope) });
  }), /Encrypted connection unavailable/);
  assert.equal(calls, 1, 'modified encrypted input never reaches the application');

  controller.abort(); await connection;
  await eventually(async () => (await fetch(`${base}/health`)).status === 503);
  controller = new AbortController(); connection = connect();
  await eventually(async () => (await fetch(`${base}/health`)).status === 200);
  const second = await encryptedFetch(base, transport.publicKey, '/v1/messages', {
    method: 'POST', headers: { Authorization: 'Bearer native-private-device-token' }, body: 'after restart',
  });
  assert.equal((await second.json()).text, 'after restart');
  assert.equal(calls, 2, 'same stable URL and same key work after reconnect');
});
