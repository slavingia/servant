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
