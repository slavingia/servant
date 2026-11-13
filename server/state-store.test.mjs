import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createStateStore } from './state-store.mjs';

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-state-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const empty = () => ({ users: {}, devices: {}, invites: {}, chats: {} });
function child(script, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--input-type=module', '-e', script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    proc.stdout.on('data', part => { stdout += part; });
    proc.stderr.on('data', part => { stderr += part; });
    proc.on('error', reject);
    proc.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(`State child failed (${code}): ${stderr}`)));
  });
}

test('state migrates once and every connection reads committed changes without rewriting legacy JSON', t => {
  const dir = directory(t);
  const legacy = JSON.stringify({ ...empty(), users: { alice: { id: 'alice', name: 'Alice' } } });
  fs.writeFileSync(path.join(dir, 'state.json'), legacy, { mode: 0o600 });
  const a = createStateStore({ directory: dir });
  const b = createStateStore({ directory: dir });
  try {
    assert.equal(a.read().users.alice.name, 'Alice');
    assert.equal(a.mutate(s => { s.users.alice.name = 'Updated'; return 'result'; }), 'result');
    assert.equal(b.read().users.alice.name, 'Updated');
    const detached = b.read();
    detached.users.alice.name = 'Not persisted';
    assert.equal(a.read().users.alice.name, 'Updated');
    assert.equal(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'), legacy);
    fs.writeFileSync(path.join(dir, 'state.json'), '{outdated, damaged snapshot');
  } finally { a.close(); b.close(); }
  const restarted = createStateStore({ directory: dir });
  try { assert.equal(restarted.read().users.alice.name, 'Updated'); }
  finally { restarted.close(); }
});

test('invalid, throwing, nested and async mutations roll back fully', async t => {
  const store = createStateStore({ directory: directory(t) });
  try {
    assert.throws(() => store.mutate(s => { s.users.a = {}; throw new Error('abort'); }), /abort/);
    assert.throws(() => store.mutate(s => { s.devices = []; }), /Invalid state/);
    assert.throws(() => store.mutate(s => { s.users.a = { value: NaN }; }), /Invalid state/);
    assert.throws(() => store.mutate(s => { s.users.a = { value: undefined }; }), /Invalid state/);
    assert.throws(() => store.mutate(s => { s.users.a = {}; store.mutate(() => {}); }), /Nested/);
    assert.throws(() => store.mutate(async s => { s.users.a = {}; await Promise.resolve(); throw new Error('async failure'); }), /synchronous/);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(store.read(), empty());
    store.mutate(s => { s.users.ok = {}; });
    assert.deepEqual(store.read().users, { ok: {} });
  } finally { store.close(); store.close(); }
  assert.throws(() => store.read(), /closed/);
  assert.throws(() => store.mutate(() => {}), /closed/);
});

test('malformed legacy state fails closed and a repaired legacy file can be imported', t => {
  const dir = directory(t);
  for (const legacy of ['{broken', 'null', '{"users":{}}', JSON.stringify({ ...empty(), devices: { bad: null } })]) {
    fs.writeFileSync(path.join(dir, 'state.json'), legacy);
    assert.throws(() => createStateStore({ directory: dir }), /Invalid state/);
    assert.equal(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'), legacy);
  }
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(empty()));
  const store = createStateStore({ directory: dir });
  try { assert.deepEqual(store.read(), empty()); }
  finally { store.close(); }
});

test('corrupt or unsupported initialized databases never fall back to legacy state', t => {
  const dir = directory(t);
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(empty()));
  createStateStore({ directory: dir }).close();
  const db = new DatabaseSync(path.join(dir, 'state.db'));
  try {
    db.exec('PRAGMA user_version=2');
    assert.throws(() => createStateStore({ directory: dir }), /Unsupported state database version/);
    db.exec('PRAGMA user_version=1');
    db.prepare('UPDATE state_document SET payload = ?').run('{bad');
    assert.throws(() => createStateStore({ directory: dir }), /Invalid state/);
    db.exec('DELETE FROM state_document');
    assert.throws(() => createStateStore({ directory: dir }), /Invalid or unsupported/);
  } finally { db.close(); }
});

test('state database and WAL are private without changing the caller umask', t => {
  const dir = directory(t);
  const before = process.umask();
  const store = createStateStore({ directory: dir });
  try {
    store.mutate(s => { s.users.a = { name: 'A' }; });
    assert.equal(process.umask(), before);
    for (const suffix of ['', '-wal', '-shm']) {
      assert.equal(fs.statSync(path.join(dir, 'state.db' + suffix)).mode & 0o777, 0o600);
    }
  } finally { store.close(); }
});

test('independent processes serialize updates, startup and single-use consumption', { timeout: 15000 }, async t => {
  const dir = directory(t);
  const moduleUrl = new URL('./state-store.mjs', import.meta.url).href;
  const script = `
    import { createStateStore } from ${JSON.stringify(moduleUrl)};
    const store = createStateStore({ directory: process.argv[1] });
    const worker = process.argv[2];
    const pause = new Int32Array(new SharedArrayBuffer(4));
    let won = false;
    for (let i = 0; i < 25; i++) store.mutate(s => {
      s.users.counter ??= { count: 0 };
      const current = s.users.counter.count;
      Atomics.wait(pause, 0, 0, 2);
      s.users.counter.count = current + 1;
      s.devices[worker + '-' + i] = { userId: worker };
      s.invites.single ??= { uses: 0 };
      if (!s.invites.single.uses) { s.invites.single.uses++; won = true; }
    });
    store.close();
    console.log(won ? 'won' : 'lost');
  `;
  const results = await Promise.all(Array.from({ length: 4 }, (_, i) => child(script, [dir, String(i)])));
  assert.equal(results.filter(result => result.trim() === 'won').length, 1);
  const store = createStateStore({ directory: dir });
  try {
    const state = store.read();
    assert.equal(state.users.counter.count, 100);
    assert.equal(Object.keys(state.devices).length, 100);
    assert.equal(state.invites.single.uses, 1);
  } finally { store.close(); }
});
