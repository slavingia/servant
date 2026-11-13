import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { tunnelOptions, superviseTunnel } from './tunnel.mjs';

async function eventually(check) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await delay(10);
  }
  assert.ok(check(), 'condition was not reached');
}

function fixture(t, { hanging = false, stubborn = false, named = false, check = async () => true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-tunnel-test-'));
  const tunnelScript = path.join(dir, 'fake-cloudflared.mjs');
  const publishScript = path.join(dir, 'fake-publish.mjs');
  const records = path.join(dir, 'published');
  const pids = path.join(dir, 'publisher-pids.json');
  fs.writeFileSync(tunnelScript, `
    process.stderr.write('New address https://first-test.');
    setTimeout(() => process.stderr.write('trycloudflare.com |\\n'), 10);
    setInterval(() => {}, 10000);
  `);
  fs.writeFileSync(publishScript, `
    import fs from 'node:fs';
    import { spawn } from 'node:child_process';
    fs.appendFileSync(${JSON.stringify(records)}, process.argv[2] + '\\n');
    ${hanging ? `
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(`${stubborn ? "process.on('SIGTERM', () => {});" : ''} process.send('ready'); setInterval(() => {}, 10000);`)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      child.once('message', () => fs.writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid, child.pid])));
      setInterval(() => {}, 10000);
    ` : ''}
  `);
  const service = superviseTunnel({ executable: process.execPath, args: [tunnelScript],
    dataDir: dir, publishScript, check, retryMs: 20, refreshMs: 30, shutdownMs: 100,
    publicUrl: named ? 'https://servant.example.org' : '', log: { error() {} } });
  t.after(async () => { await service.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, service, pids, records, published: () => fs.existsSync(records) ? fs.readFileSync(records, 'utf8').trim().split('\n') : [] };
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

test('tunnel options honor shared data, config port and explicit named-tunnel settings', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-tunnel-options-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port: 9898 }));
  const quick = tunnelOptions({ SERVANT_DATA_DIR: dir });
  assert.deepEqual(quick.args, ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--url', 'http://127.0.0.1:9898']);
  assert.equal(quick.dataDir, dir);
  const config = path.join(dir, 'tunnel.yml');
  fs.writeFileSync(config, 'tunnel: example\n');
  const named = tunnelOptions({ SERVANT_DATA_DIR: dir, CF: '/example/cloudflared',
    SERVANT_TUNNEL_ID: 'example', SERVANT_TUNNEL_CONFIG: config, SERVANT_PUBLIC_URL: 'https://servant.example.org/' });
  assert.deepEqual(named.args, ['tunnel', '--no-autoupdate', '--protocol', 'http2', '--config', config, 'run', 'example']);
  assert.equal(named.publicUrl, 'https://servant.example.org');
  assert.equal(named.executable, '/example/cloudflared');
  assert.throws(() => tunnelOptions({ SERVANT_DATA_DIR: dir, SERVANT_TUNNEL_ID: 'example' }), /require/);
  assert.throws(() => tunnelOptions({ SERVANT_DATA_DIR: dir, SERVANT_TUNNEL_CONFIG: config }), /requires/);
  assert.throws(() => tunnelOptions({ SERVANT_DATA_DIR: dir, SERVANT_PORT: '0' }), /valid TCP port/);
  assert.deepEqual(tunnelOptions({ SERVANT_DATA_DIR: dir, SERVANT_TUNNEL_PROTOCOL: 'auto' }).args.slice(0, 4), ['tunnel', '--no-autoupdate', '--protocol', 'auto']);
  assert.throws(() => tunnelOptions({ SERVANT_DATA_DIR: dir, SERVANT_TUNNEL_PROTOCOL: 'udp' }), /http2, quic or auto/);
});

test('API downtime and restart leave the tunnel process and quick URL unchanged', async t => {
  const api = http.createServer((req, res) => res.end('{"ok":true}'));
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const port = api.address().port;
  t.after(() => new Promise(resolve => { api.closeAllConnections(); api.close(resolve); }));
  let attempts = 0;
  const { service, published } = fixture(t, { check: async (_url, signal) => {
    attempts++;
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal });
    return response.ok && (await response.json()).ok;
  } });
  await eventually(() => published().length > 0);
  const originalPid = service.pid;
  await new Promise(resolve => { api.closeAllConnections(); api.close(resolve); });
  const before = attempts;
  await eventually(() => attempts > before + 1);
  assert.equal(service.pid, originalPid);
  assert.ok(alive(originalPid));
  const count = published().length;
  await new Promise(resolve => api.listen(port, '127.0.0.1', resolve));
  await eventually(() => published().length > count);
  assert.deepEqual([...new Set(published())], ['https://first-test.trycloudflare.com']);
  assert.ok(alive(originalPid));
});

test('named mode publishes the configured address, ignoring incidental quick URLs', async t => {
  const { published } = fixture(t, { named: true });
  await eventually(() => published().length > 0);
  assert.deepEqual([...new Set(published())], ['https://servant.example.org']);
});

test('stopping the service terminates tunnel, publisher and publisher descendants', async t => {
  const { service, pids } = fixture(t, { hanging: true });
  await eventually(() => fs.existsSync(pids));
  const publisherPids = JSON.parse(fs.readFileSync(pids, 'utf8'));
  await service.stop();
  assert.equal(await service.exited, 0);
  await eventually(() => [service.pid, ...publisherPids].every(pid => !alive(pid)));
});

test('a failed tunnel exits nonzero and cleans up its active publisher', async t => {
  const { service, pids } = fixture(t, { hanging: true });
  await eventually(() => fs.existsSync(pids));
  const publisherPids = JSON.parse(fs.readFileSync(pids, 'utf8'));
  process.kill(service.pid, 'SIGTERM');
  assert.equal(await service.exited, 1);
  await eventually(() => publisherPids.every(pid => !alive(pid)));
});

test('shutdown kills a publisher descendant even if it ignores SIGTERM after the publisher exits', async t => {
  const { service, pids } = fixture(t, { hanging: true, stubborn: true });
  await eventually(() => fs.existsSync(pids));
  const publisherPids = JSON.parse(fs.readFileSync(pids, 'utf8'));
  await service.stop();
  await eventually(() => publisherPids.every(pid => !alive(pid)));
});

test('shutdown is safe immediately after spawn and is idempotent', async t => {
  const { service } = fixture(t);
  await Promise.all([service.stop(), service.stop()]);
  assert.equal(await service.exited, 0);
  assert.equal(alive(service.pid), false);
});

test('a missing cloudflared executable fails without leaving the publisher running', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-tunnel-missing-'));
  const service = superviseTunnel({ executable: path.join(dir, 'missing'), args: [], dataDir: dir, log: { error() {} } });
  t.after(async () => { await service.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  assert.equal(await service.exited, 1);
});
