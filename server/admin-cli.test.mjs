import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-'));
  const data = path.join(directory, 'data');
  fs.mkdirSync(data);
  const notes = path.join(directory, 'notes.md');
  fs.writeFileSync(notes, 'Local CLI fixture only');
  const requests = [];
  const api = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ release: { updated: false, messageId: 'fixture' } }));
  });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const apiPort = api.address().port;
  const config = port => fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ port, adminKey: 'fixture-admin-key' }));
  config(apiPort);
  const controls = [];
  async function control(runtime, status) {
    fs.mkdirSync(runtime, { recursive: true });
    const server = http.createServer((req, res) => {
      assert.equal(req.method, 'GET');
      assert.equal(req.url, '/status');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
    });
    controls.push(server);
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path.join(runtime, 'control.sock'), resolve); });
  }
  const run = async runtime => {
    const env = { ...process.env, HOME: directory, SERVANT_DATA_DIR: data };
    delete env.SERVANT_PORT;
    delete env.SERVANT_ADMIN_KEY;
    delete env.SERVANT_RUNTIME_DIR;
    if (runtime !== undefined) env.SERVANT_RUNTIME_DIR = runtime;
    const child = spawn(process.execPath, [new URL('./server.mjs', import.meta.url).pathname, 'release', 'fixture', notes], {
      env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const [code] = await once(child, 'close');
    return { code, output };
  };
  t.after(async () => {
    for (const server of [...controls, api]) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, apiPort, requests, config, control, run };
}

test('release CLI resolves the active API through configured and default private control sockets', async t => {
  const f = await fixture(t);
  f.config(1); // The public ingress port must never receive administrative calls.
  const configured = path.join(f.directory, 'runtime');
  await f.control(configured, { active: { ready: true, port: f.apiPort }, stopping: false });
  assert.equal((await f.run(configured)).code, 0);
  const defaultRuntime = path.join(f.directory, '.local/share/servant');
  await f.control(defaultRuntime, { active: { ready: true, port: f.apiPort }, stopping: false });
  assert.equal((await f.run()).code, 0);
  assert.equal(f.requests.length, 2);
  for (const request of f.requests) {
    assert.equal(request.url, '/admin/releases');
    assert.equal(request.headers['x-servant-admin'], 'fixture-admin-key');
    assert.equal(request.headers['cf-connecting-ip'], undefined);
    assert.deepEqual(request.body, { build: 'fixture', notes: 'Local CLI fixture only' });
  }
});

test('release CLI refuses unavailable or unready configured supervisors without falling back', async t => {
  const f = await fixture(t);
  const missing = await f.run(path.join(f.directory, 'missing'));
  assert.equal(missing.code, 1);
  assert.match(missing.output, /Couldn't locate the active API/);
  const runtime = path.join(f.directory, 'runtime');
  await f.control(runtime, { active: { ready: false, port: f.apiPort }, stopping: false });
  const unready = await f.run(runtime);
  assert.equal(unready.code, 1);
  assert.match(unready.output, /No active API is ready/);
  assert.equal(f.requests.length, 0);
});

test('release CLI retains direct-port behavior when no supervisor is configured or present', async t => {
  const f = await fixture(t);
  const result = await f.run();
  assert.equal(result.code, 0, result.output);
  assert.equal(f.requests.length, 1);
});
