import { restrictedTestCapabilities } from "./test-hermes-capabilities.mjs";
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
import { createStateStore } from './state-store.mjs';
import { testFetch } from './encrypted-test-client.mjs';
import { TERMS_VERSION, TERMS_ITEMS } from "./terms.mjs";
const ACCEPT = { version: TERMS_VERSION, items: TERMS_ITEMS };

const serverFile = new URL('./server.mjs', import.meta.url).pathname;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const inviteHash = value => hash(value.toUpperCase().replace(/[^0-9A-Z]/g, ''));
const ownerToken = 'state-integration-owner-token';

async function until(check, description) {
  for (let attempt = 0; attempt < 250; attempt++) {
    const value = check();
    if (value) return value;
    await sleep(20);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function command(args, dir) {
  const child = spawn(process.execPath, [serverFile, ...args], {
    env: { ...process.env, SERVANT_DATA_DIR: dir, SERVANT_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const done = once(child, 'close').then(([code, signal]) => ({ code, signal, stdout, stderr }));
  return { child, done, output: () => stdout + stderr };
}

async function fixture(t, { count = 2, delaySession = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-state-integration-'));
  const sessions = [], turns = [];
  const children = [];
  const upstream = http.createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/v1/capabilities") return res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(restrictedTestCapabilities));
    for await (const _ of req) { /* consume request */ }
    if (delaySession && req.method === 'POST' && req.url === '/api/sessions') {
      sessions.push(() => res.writeHead(201, { 'Content-Type': 'application/json' }).end('{}'));
      return;
    }
    if (req.method === 'POST' && req.url.endsWith('/chat/stream')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: assistant.delta\ndata: {"delta":"Working"}\n\n');
      turns.push(() => res.end('event: assistant.completed\ndata: {"content":"Finished safely"}\n\n'));
      return;
    }
    if (req.method === 'GET' && req.url.endsWith('/messages')) {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"data":[]}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const up = { url: `http://127.0.0.1:${upstream.address().port}`, key: 'test-upstream-key' };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    host: '127.0.0.1', port: 0, upstreams: { owner: up, member: up },
  }));
  const store = createStateStore({ directory: dir });
  store.mutate(state => {
    state.users.owner = { id: 'owner', name: 'Owner', role: 'owner' };
    state.devices[hash(ownerToken)] = { id: 'owner-device', userId: 'owner' };
  });
  t.after(async () => {
    for (const entry of children) {
      if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill('SIGTERM');
    }
    const force = setTimeout(() => {
      for (const entry of children) {
        if (entry.child.exitCode === null && entry.child.signalCode === null) entry.child.kill('SIGKILL');
      }
    }, 6000);
    try { await Promise.all(children.map(entry => entry.done)); }
    finally { clearTimeout(force); }
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const bases = [];
  // Startup is deliberately sequential: this suite tests concurrent state
  // mutations, not compatibility of every separate database's migrations.
  for (let i = 0; i < count; i++) {
    const entry = command([], dir);
    children.push(entry);
    const base = await until(() => {
      if (entry.child.exitCode !== null) throw new Error(entry.output());
      return entry.output().match(/listening on (http:\/\/127.0.0.1:\d+)/)?.[1];
    }, 'isolated API startup');
    bases.push(base);
  }
  const fetchApi = (index, route, { method = 'GET', body, token = ownerToken } = {}) =>
    testFetch(dir, bases[index] + route, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const api = async (index, route, options) => {
    const response = await fetchApi(index, route, options);
    return { status: response.status, body: await response.json() };
  };
  const cli = async args => {
    const entry = command(args, dir);
    children.push(entry);
    const result = await entry.done;
    assert.equal(result.code, 0, result.stderr);
    return result.stdout;
  };
  return { dir, store, api, fetchApi, cli, sessions, turns };
}

test('two API processes consume one single-use invite once and both see CLI revocation', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const code = 'ABCDE-23456';
  f.store.mutate(state => {
    state.invites[inviteHash(code)] = {
      name: 'New member', role: 'member', createdAt: Date.now(), expiresAt: Date.now() + 60000,
    };
  });
  const paired = await Promise.all([0, 1].map(index => f.api(index, '/v1/pair', {
    method: 'POST', body: { terms: ACCEPT, code, device: `Test phone ${index}` },
  })));
  assert.deepEqual(paired.map(result => result.status).sort(), [201, 403]);
  const token = paired.find(result => result.status === 201).body.token;
  const snapshot = f.store.read();
  assert.ok(snapshot.invites[inviteHash(code)].usedAt);
  assert.equal(Object.keys(snapshot.devices).length, 2);
  const device = snapshot.devices[hash(token)];
  for (const index of [0, 1]) assert.equal((await f.api(index, '/v1/me', { token })).status, 200);
  await f.cli(['revoke', device.id]);
  for (const index of [0, 1]) assert.equal((await f.api(index, '/v1/me', { token })).status, 401);
  assert.ok(f.store.read().devices[hash(token)].revokedAt);
});

test('concurrent CLI invites and API pairings retain every independently created record', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const codes = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
    const output = await f.cli(['invite', '--name', `Member ${index}`]);
    const code = output.match(/Invite code:\s+(\S+)/)?.[1];
    assert.ok(code, output);
    return code;
  }));
  assert.equal(new Set(codes).size, 8);
  assert.equal(Object.keys(f.store.read().invites).length, 8);
  const results = await Promise.all(codes.map((code, index) => f.api(index % 2, '/v1/pair', {
    method: 'POST', body: { terms: ACCEPT, code, device: `Phone ${index}` },
  })));
  for (const result of results) assert.equal(result.status, 201, JSON.stringify(result.body));
  const snapshot = f.store.read();
  assert.equal(Object.keys(snapshot.invites).length, 8);
  assert.equal(Object.keys(snapshot.devices).length, 9);
  assert.equal(Object.keys(snapshot.users).length, 9);
  for (const result of results) assert.ok(snapshot.devices[hash(result.body.token)]);
});

test('revocation while Hermes creates a session prevents committing the new chat', { timeout: 15000 }, async t => {
  const f = await fixture(t, { count: 1, delaySession: true });
  const creating = f.api(0, '/v1/chats', { method: 'POST', body: { title: 'Delayed chat' } });
  await until(() => f.sessions.length, 'delayed upstream session creation');
  await f.cli(['revoke', 'owner-device']);
  f.sessions[0]();
  const result = await creating;
  assert.equal(result.status, 401, JSON.stringify(result.body));
  assert.deepEqual(f.store.read().chats, {});
  assert.ok(f.store.read().devices[hash(ownerToken)].revokedAt);
});

test('finishing an agent stream preserves deletion and preferences written by the other API', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const created = await f.api(0, '/v1/chats', { method: 'POST', body: {} });
  assert.equal(created.status, 201);
  const chatId = created.body.chat.id;
  const response = await f.fetchApi(0, `/v1/chats/${chatId}/messages`, {
    method: 'POST', body: { text: 'Please keep working during this update' },
  });
  assert.equal(response.status, 200);
  const streamed = response.text();
  await until(() => f.turns.length, 'active upstream agent stream');
  const preferences = { mode: 'all', contentPreviews: false, previews: false };
  assert.equal((await f.api(1, '/v1/notifications', { method: 'PATCH', body: preferences })).status, 200);
  assert.equal((await f.api(1, `/v1/chats/${chatId}`, { method: 'DELETE' })).status, 200);
  const deleted = f.store.read().chats[chatId];
  assert.ok(deleted.deletedAt);
  f.turns[0]();
  // The chat was deleted, so its turn is gone with it (nothing of the conversation is kept): the open stream just ends
  // and must not hang. It used to keep delivering the rest of the answer to a chat that no longer exists.
  assert.doesNotMatch(await streamed, /Finished safely/, 'the deleted conversation is not delivered');
  const state = f.store.read();
  assert.deepEqual(state.chats[chatId], deleted, 'completion must not rewrite deleted chat metadata');
  assert.equal(state.users.owner.notifications.mode, preferences.mode);
  assert.equal(state.users.owner.notifications.previews, preferences.previews);
  const chats = await f.api(1, '/v1/chats');
  assert.equal(chats.body.chats.some(chat => chat.id === chatId), false);
});
