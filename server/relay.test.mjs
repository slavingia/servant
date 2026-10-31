import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { RelaySession } from '../relay/session.mjs';
import worker, { hubRegistry } from '../relay/worker.mjs';
import { decodeChunk, encodeChunk, ENVELOPE_BYTES, FRAME_BYTES, parseFrame } from './relay-protocol.mjs';
import { RelayHostSession } from './relay-client.mjs';
import { publishRelayAddress, relayOptions } from './relay.mjs';
import { createSecureTransport } from './secure-transport.mjs';
import { encryptedFetch } from '../app/src/lib/tunnel-client.ts';

function bridge(t, options = {}) {
  const observed = [];
  let host;
  const relay = new RelaySession({ ...options, send: frame => {
    observed.push(frame);
    queueMicrotask(() => host.receive(parseFrame(JSON.stringify(frame))));
  } });
  host = new RelayHostSession({ ...options, send: frame => {
    observed.push(frame);
    queueMicrotask(() => { void relay.receive(parseFrame(JSON.stringify(frame))); });
  } });
  t.after(() => { relay.close(); host.close(); });
  return { relay, host, observed };
}
const encryptedResponse = body => new Response(body, { headers: { 'content-type': 'application/x-servant-encrypted' } });
const request = body => new Request('https://relay.example/hubs/test/v1/secure', { method: 'POST', body });
async function until(fn) { for (let i = 0; i < 200 && !fn(); i++) await delay(5); assert.ok(fn()); }

test('relay roundtrip uses actual pinned app encryption, keeps secrets opaque and preserves streaming bytes', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-relay-'));
  const transport = createSecureTransport(directory);
  let received;
  const local = http.createServer((req, res) => {
    assert.equal(req.url, '/v1/secure');
    void transport.handle(req, res, async (inner, output) => {
      received = inner.headers.authorization;
      let body = '';
      for await (const chunk of inner) body += chunk;
      output.writeHead(201, { 'content-type': 'application/json' });
      output.end(JSON.stringify({ privateReply: 'reply-secret', body }));
    });
  });
  await new Promise(resolve => local.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    local.closeAllConnections(); await new Promise(resolve => local.close(resolve));
    transport.close(); fs.rmSync(directory, { recursive: true, force: true });
  });
  const { relay, observed } = bridge(t, { port: local.address().port });
  const body = 'private-content ' + crypto.randomBytes(256_000).toString('base64');
  const response = await encryptedFetch('https://relay.example/hubs/a-stable-id', transport.publicKey, '/v1/private-route', {
    method: 'POST', headers: { Authorization: 'Bearer device-secret' }, body,
  }, (url, options) => relay.forward(new Request(url, options)));
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { privateReply: 'reply-secret', body });
  assert.equal(received, 'Bearer device-secret');
  const wire = observed.map(frame => frame.data ? Buffer.from(frame.data, 'base64').toString() : JSON.stringify(frame)).join('');
  for (const secret of ['private-content', 'reply-secret', 'device-secret', '/v1/private-route']) assert.equal(wire.includes(secret), false);
  assert.ok(observed.filter(frame => frame.type === 'upload').length > 1);
  assert.equal(relay.pending.size, 0);
});

test('multiplexed responses remain associated with the right request', async t => {
  const { relay } = bridge(t, { fetcher: async (_url, init) => {
    const body = await init.body.text();
    await delay(body === 'first' ? 15 : 1);
    return encryptedResponse(body);
  } });
  const replies = await Promise.all(['first', 'second', 'third'].map(async text => (await relay.forward(request(text))).text()));
  assert.deepEqual(replies, ['first', 'second', 'third']);
});

test('host refuses relay-selected origin, route, headers and plaintext local errors', async t => {
  let selected;
  const { relay } = bridge(t, { fetcher: async (url, init) => {
    selected = { url, method: init.method, headers: init.headers, redirect: init.redirect };
    return new Response('private internal diagnostics', { status: 500 });
  } });
  const response = await relay.forward(request('opaque'));
  assert.equal(response.status, 502);
  assert.deepEqual(selected, { url: 'http://127.0.0.1:8787/v1/secure', method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/x-servant-encrypted' }, redirect: 'error' });
  assert.equal((await response.text()).includes('private'), false);
});

test('backpressure bounds response frames until the phone consumes them', async t => {
  const bytes = crypto.randomBytes(FRAME_BYTES * 4);
  const { relay, observed } = bridge(t, { fetcher: async () => encryptedResponse(bytes) });
  const response = await relay.forward(request('opaque'));
  await delay(20);
  assert.equal(observed.filter(frame => frame.type === 'download').length, 1);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
});

test('host disconnect errors an in-progress stream instead of a successful truncated response', async t => {
  const { relay } = bridge(t, { fetcher: async () => encryptedResponse(crypto.randomBytes(FRAME_BYTES * 3)) });
  const response = await relay.forward(request('opaque'));
  const reader = response.body.getReader();
  assert.equal((await reader.read()).done, false);
  relay.close();
  await assert.rejects(reader.read(), /interrupted/);
  assert.equal(relay.pending.size, 0);
});

test('client cancellation releases both relay and host request state', async t => {
  const { relay, host } = bridge(t, { fetcher: async () => encryptedResponse(crypto.randomBytes(FRAME_BYTES * 4)) });
  const response = await relay.forward(request('opaque'));
  await response.body.cancel();
  await until(() => !relay.pending.size && !host.pending.size);
  assert.equal(host.bufferedBytes, 0);
});

test('requests are bounded by size, aggregate host memory, concurrency and idle time', async t => {
  const r = new RelaySession({ send() {}, maxRequests: 1, idleMs: 20 }); t.after(() => r.close());
  assert.equal((await r.forward(new Request('https://relay.example', { method: 'POST', body: 'x', headers: { 'content-length': String(ENVELOPE_BYTES + 1) } }))).status, 413);
  const waiting = r.forward(request('x'));
  assert.equal((await r.forward(request('x'))).status, 429);
  assert.equal((await waiting).status, 504);
  const { relay, host } = bridge(t, { maxBufferedBytes: 1 });
  assert.equal((await relay.forward(request('too big'))).status, 502);
  await until(() => !host.pending.size);
  assert.equal(host.bufferedBytes, 0);
});

test('worker only exposes registered hub transport routes and preflight', async () => {
  const hub = 'a'.repeat(24), hash = 'b'.repeat(64);
  const calls = [];
  const env = { SERVANT_RELAY_HUBS: JSON.stringify({ [hub]: hash }), HUBS: { idFromName: value => value, get: id => ({ fetch: async req => { calls.push([id, req.method]); return new Response('forwarded'); } }) } };
  for (const suffix of ['/v1/messages', '/v1/secure?token=secret', '/admin', '/v1/server']) {
    assert.equal((await worker.fetch(new Request(`https://relay.example/hubs/${hub}${suffix}`), env)).status, 404);
  }
  assert.equal((await worker.fetch(new Request(`https://relay.example/hubs/${'c'.repeat(24)}/health`), env)).status, 404);
  assert.equal((await worker.fetch(new Request(`https://relay.example/hubs/${hub}/v1/secure`, { method: 'OPTIONS' }), env)).status, 204);
  assert.equal(calls.length, 0);
  assert.equal(await (await worker.fetch(new Request(`https://relay.example/hubs/${hub}/health`), env)).text(), 'forwarded');
  assert.deepEqual(hubRegistry({ SERVANT_RELAY_HUBS: '["invalid"]' }), {});
});

test('relay config requires TLS, a private file and valid hub credentials; stable publication preserves the encryption pin', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-relay-config-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'relay.json');
  const config = { relay: 'https://relay.example', hubId: 'h'.repeat(24), hostToken: 't'.repeat(43) };
  fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({ port: 9797, name: 'My server', discoveryUrl: 'https://old-gist', gistId: 'old-id' }));
  fs.writeFileSync(path.join(directory, 'transport-key'), 'unchanged-private-key');
  const env = { SERVANT_DATA_DIR: directory, SERVANT_RELAY_CONFIG: file };
  const options = relayOptions(env);
  assert.equal(options.port, 9797);
  assert.throws(() => relayOptions({ ...env, SERVANT_DISCOVERY_URL: 'https://old-gist' }), /Remove SERVANT_DISCOVERY_URL/);
  assert.throws(() => relayOptions({ ...env, SERVANT_PUBLIC_URL: 'https://old-tunnel' }), /conflicts/);
  assert.equal(options.url, `wss://relay.example/hubs/${config.hubId}/connect`);
  publishRelayAddress(directory, options.publicUrl);
  const saved = JSON.parse(fs.readFileSync(path.join(directory, 'config.json')));
  assert.equal(saved.discovery, 'off'); assert.equal(saved.discoveryUrl, undefined); assert.equal(saved.gistId, 'old-id');
  assert.equal(fs.readFileSync(path.join(directory, 'transport-key'), 'utf8'), 'unchanged-private-key');
  assert.equal(fs.statSync(path.join(directory, 'config.json')).mode & 0o777, 0o600);
  fs.chmodSync(file, 0o644); assert.throws(() => relayOptions(env), /0600/); fs.chmodSync(file, 0o600);
  for (const relay of ['http://relay.example', 'https://user:secret@relay.example', 'https://relay.example/path', 'https://relay.example?secret']) {
    fs.writeFileSync(file, JSON.stringify({ ...config, relay })); assert.throws(() => relayOptions(env), /HTTPS origin/);
  }
});

test('invalid and oversized relay frames fail closed', () => {
  assert.throws(() => parseFrame(JSON.stringify({ type: 'request', id: '../admin' })));
  assert.throws(() => decodeChunk('=bad='));
  assert.throws(() => encodeChunk(new Uint8Array(FRAME_BYTES + 1)));
});
