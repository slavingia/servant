import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSecureTransport, serverIdentity } from './secure-transport.mjs';
import { sealRequest } from '../app/src/lib/tunnel-crypto.ts';
import { encryptedFetch } from '../app/src/lib/tunnel-client.ts';

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-encryption-'));
  let transport = createSecureTransport(dir);
  let calls = 0;
  const server = http.createServer((req, res) => {
    transport.handle(req, res, async (inner, output) => {
      calls++;
      let body = '';
      for await (const chunk of inner) body += chunk;
      output.writeHead(201, { 'Content-Type': 'application/json' });
      output.end(JSON.stringify({ path: inner.url, method: inner.method, token: inner.headers.authorization, admin: inner.headers['x-servant-admin'], ip: inner.headers['cf-connecting-ip'], body }));
    }).catch(error => { res.destroy(error); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    transport.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir, base: `http://127.0.0.1:${server.address().port}`, key: transport.publicKey,
    calls: () => calls,
    reopen: () => { transport.close(); transport = createSecureTransport(dir); },
  };
}

test('real app crypto interoperates with Node; proxy sees neither token, content, files nor response', async t => {
  const f = await fixture(t);
  const sensitive = 'private-file-name.pdf private message 💙 ';
  const body = JSON.stringify({ text: sensitive, data: crypto.randomBytes(1024 * 1024).toString('base64') });
  let outgoing, incoming;
  const spy = async (url, options) => {
    outgoing = options;
    const response = await fetch(url, options);
    incoming = await response.clone().text();
    return response;
  };
  const response = await encryptedFetch(f.base, f.key, '/v1/conversations/private/messages', {
    method: 'POST', headers: { Authorization: 'Bearer private-device-token', 'x-servant-admin': 'forged', 'cf-connecting-ip': 'forged' }, body,
  }, spy);
  const result = await response.json();
  assert.equal(response.status, 201);
  assert.equal(result.body, body);
  assert.equal(result.token, 'Bearer private-device-token');
  assert.equal(result.admin, undefined);
  assert.notEqual(result.ip, 'forged');
  for (const secret of [sensitive, 'private-device-token', '/v1/conversations/private/messages', JSON.parse(body).data]) {
    assert.ok(!JSON.stringify(outgoing).includes(secret));
    assert.ok(!incoming.includes(secret));
  }
  assert.equal(outgoing.headers.Authorization, undefined);
  assert.equal(fs.statSync(path.join(f.dir, 'transport-key')).mode & 0o777, 0o600);
  assert.equal(serverIdentity(f.dir).publicKey, f.key);
});

test('modified, expired, wrong-server and replayed requests never execute, including after restart', async t => {
  const f = await fixture(t);
  const make = (key = f.key, at = Date.now()) => sealRequest(key, { method: 'POST', path: '/v1/messages', headers: {}, body: '{}', at }, crypto.randomBytes(32), crypto.randomBytes(32)).envelope;
  const send = envelope => fetch(f.base + '/v1/secure', { method: 'POST', body: JSON.stringify(envelope) });
  const valid = make();
  const bad = { ...valid, data: 'AAAA' + valid.data.slice(4) };
  assert.equal((await send(bad)).status, 400);
  assert.equal((await send(make(f.key, Date.now() - 300000))).status, 400);
  const other = crypto.createECDH('prime256v1'); other.generateKeys();
  assert.equal((await send(make(other.getPublicKey('hex', 'compressed')))).status, 400);
  assert.equal(f.calls(), 0);
  const first = await send(valid);
  assert.equal(first.status, 200); await first.text();
  assert.equal((await send(valid)).status, 400);
  f.reopen();
  assert.equal((await send(valid)).status, 400);
  assert.equal(f.calls(), 1);
});

test('bad pins and plaintext responses fail closed without fallback', async t => {
  const f = await fixture(t);
  await assert.rejects(encryptedFetch(f.base, undefined, '/v1/me'), /Encryption setup required/);
  const plaintext = async () => new Response('{"secret":"must not accept"}', { headers: { 'Content-Type': 'application/json' } });
  await assert.rejects(encryptedFetch(f.base, f.key, '/v1/me', {}, plaintext), /Encrypted connection unavailable/);
  assert.equal(f.calls(), 0);
});

test('response tampering, reordering and truncation are detected', async t => {
  const f = await fixture(t);
  for (const damage of ['tamper', 'reorder', 'truncate']) {
    const proxy = async (url, options) => {
      const response = await fetch(url, options);
      const frames = (await response.text()).trimEnd().split('\n');
      if (damage === 'tamper') frames[1] = 'AAAA' + frames[1].slice(4);
      if (damage === 'reorder') [frames[0], frames[1]] = [frames[1], frames[0]];
      if (damage === 'truncate') frames.pop();
      return new Response(frames.join('\n') + '\n', { headers: response.headers });
    };
    await assert.rejects(async () => { const response = await encryptedFetch(f.base, f.key, '/v1/me', {}, proxy); await response.json(); });
  }
});

test('encrypted requests cannot reach local admin or recursively tunnel', async t => {
  const f = await fixture(t);
  for (const route of ['/admin/releases', '/v1/secure', '/v1/../admin/releases']) {
    await assert.rejects(encryptedFetch(f.base, f.key, route, { method: 'POST' }), /Encrypted connection unavailable/);
  }
  assert.equal(f.calls(), 0);
});

test('expanded media envelope remains bounded before decryption or route execution', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-envelope-limit-'));
  const transport = createSecureTransport(dir);
  t.after(() => { transport.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const chunk = Buffer.alloc(1024 * 1024, 65);
  let consumed = 0, status, response, called = false;
  const request = { async *[Symbol.asyncIterator]() { for (let i = 0; i < 100; i++) { consumed++; yield chunk; } } };
  const output = { writeHead(code) { status = code; }, end(body) { response = body; } };
  await transport.handle(request, output, () => { called = true; });
  assert.equal(status, 400);
  assert.equal(consumed, 57);
  assert.equal(called, false);
  assert.match(response, /encrypted_request_invalid/);
});

// Before anything is authenticated the server buffers the whole body, so it also bounds how long a client may
// take and how many bytes all clients may hold at once (a stalled or flooding caller must not exhaust memory).
function capture() { const o = { status: 0, body: '' }; o.writeHead = code => { o.status = code; }; o.end = body => { o.body = body; }; return o; }
const makeTransport = (t, options) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-envelope-bounds-'));
  const transport = createSecureTransport(dir, options);
  t.after(() => { transport.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return transport;
};

test('a declared size over the cap is refused without reading the body', async t => {
  const transport = makeTransport(t);
  let consumed = 0, called = false;
  const request = { headers: { 'content-length': String(57 * 1024 * 1024) }, async *[Symbol.asyncIterator]() { consumed++; yield Buffer.alloc(10); } };
  const out = capture();
  await transport.handle(request, out, () => { called = true; });
  assert.equal(out.status, 413);
  assert.equal(consumed, 0, 'nothing was read');
  assert.equal(called, false);
});

test('a body that stalls is cut off instead of holding memory and a socket forever', async t => {
  const transport = makeTransport(t, { idleMs: 60, totalMs: 5000 });
  const request = { async *[Symbol.asyncIterator]() { yield Buffer.alloc(1024); await new Promise(() => {}); } };
  const out = capture(); const started = Date.now();
  await transport.handle(request, out, () => {});
  assert.equal(out.status, 408);
  assert.ok(Date.now() - started < 2000);
});

test('a body trickled slowly is cut off at the total deadline', async t => {
  const transport = makeTransport(t, { idleMs: 1000, totalMs: 150 });
  const request = { async *[Symbol.asyncIterator]() { for (;;) { await new Promise(r => setTimeout(r, 20)); yield Buffer.alloc(1); } } };
  const out = capture(); const started = Date.now();
  await transport.handle(request, out, () => {});
  assert.equal(out.status, 408);
  assert.ok(Date.now() - started < 2000);
});

test('bytes buffered across all requests are capped, and freed when a request ends', async t => {
  const transport = makeTransport(t, { maxInFlightBytes: 3 * 1024 * 1024 });
  const chunk = Buffer.alloc(1024 * 1024, 65);
  let release; const gate = new Promise(r => { release = r; });
  const slow = { async *[Symbol.asyncIterator]() { yield chunk; yield chunk; await gate; } };
  const first = capture();
  const firstDone = transport.handle(slow, first, () => {});
  await new Promise(r => setTimeout(r, 30));
  const second = capture();
  await transport.handle({ async *[Symbol.asyncIterator]() { yield chunk; yield chunk; } }, second, () => {});
  assert.equal(second.status, 429, 'a second large body is refused while the first holds most of the budget');
  assert.match(second.body, /encrypted_request_busy/);
  release(); await firstDone;
  const third = capture();
  await transport.handle({ async *[Symbol.asyncIterator]() { yield chunk; } }, third, () => {});
  assert.equal(third.status, 400, 'budget is free again: read fully, then rejected as not a valid envelope');
});

test('the shared byte budget neither leaks nor goes negative across many valid, invalid and aborted requests', async t => {
  const transport = makeTransport(t, { maxInFlightBytes: 2 * 1024 * 1024, idleMs: 50, totalMs: 1000 });
  const body = Buffer.alloc(900 * 1024, 66);
  const bodies = [
    { async *[Symbol.asyncIterator]() { yield body; } },                              // not JSON: parse error after reading
    { async *[Symbol.asyncIterator]() { yield Buffer.from('{"v":1}'); } },            // JSON but not an envelope
    { async *[Symbol.asyncIterator]() { yield body; throw new Error('socket reset'); } }, // aborted mid-body
    { async *[Symbol.asyncIterator]() { yield body; await new Promise(() => {}); } }, // stalled mid-body
  ];
  for (let round = 0; round < 6; round++) for (const b of bodies) { const out = capture(); await transport.handle(b, out, () => {}); assert.ok([400, 408].includes(out.status), `round ${round}: ${out.status}`); }
  // If the counter had leaked, 24 requests of ~0.9 MiB would have exhausted 2 MiB long ago; if it had gone negative,
  // this over-budget body would be let through instead of refused.
  const over = capture();
  await transport.handle({ async *[Symbol.asyncIterator]() { yield Buffer.alloc(1024 * 1024); yield Buffer.alloc(1024 * 1024 + 1); } }, over, () => {});
  assert.equal(over.status, 429, 'a body over the whole budget is refused: the counter is not negative');
  const fine = capture();
  await transport.handle({ async *[Symbol.asyncIterator]() { yield body; } }, fine, () => {});
  assert.equal(fine.status, 400, 'a normal body is still read: the counter did not leak');
});
