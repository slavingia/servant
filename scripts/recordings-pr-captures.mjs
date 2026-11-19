#!/usr/bin/env node
// Synthetic before/after captures for Notetaker (the recordings screens): the list, the recorder and one note.
// Usage: node scripts/recordings-pr-captures.mjs <output-dir> <path>
// Run from the checkout being captured after npm ci --prefix app and --prefix desktop.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { testFetch } from '../server/encrypted-test-client.mjs';
import { serverIdentity } from '../server/secure-transport.mjs';
import { TERMS_VERSION, TERMS_ITEMS } from '../server/terms.mjs';

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = path.resolve(process.argv[2] || 'recordings-captures');
const route = process.argv[3] || '/recordings';
const require = createRequire(path.join(repository, 'desktop/package.json'));
const { chromium } = require('playwright');
const run = promisify(execFile);
const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'servant-recordings-capture-'));
const data = path.join(scratch, 'data');
const runtime = path.join(scratch, 'runtime');
for (const directory of [output, data, runtime]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const freePort = () => new Promise((resolve, reject) => {
  const listener = net.createServer();
  listener.on('error', reject);
  listener.listen(0, '127.0.0.1', () => { const port = listener.address().port; listener.close(() => resolve(port)); });
});
const waitFor = async (url, child, label) => {
  for (let attempt = 0; attempt < 160; attempt++) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`${label} exited with ${child.exitCode}`);
    if (await fetch(url, { signal: AbortSignal.timeout(1000) }).then(response => response.ok).catch(() => false)) return;
    await delay(250);
  }
  throw new Error(`${label} did not become ready`);
};
const stop = async child => {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(3000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
};

let apiServer, webServer, browser, serverOutput = '', webOutput = '';
try {
  const port = await freePort();
  const apiUrl = `http://127.0.0.1:${port}`;
  const pushConfig = path.join(scratch, 'push-disabled.json');
  fs.writeFileSync(pushConfig, '{}\n', { mode: 0o600 });
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ host: '127.0.0.1', port, name: 'Example server', publicUrl: apiUrl, discovery: 'off', discoveryUrl: '', upstreams: {} }), { mode: 0o600 });
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SERVANT_|HERMES_|API_SERVER_KEY$)/.test(key))),
    SERVANT_DATA_DIR: data, SERVANT_RUNTIME_DIR: runtime, SERVANT_HOST: '127.0.0.1', SERVANT_PORT: String(port),
    SERVANT_PUBLIC_URL: apiUrl, SERVANT_DISCOVERY_URL: '', SERVANT_PUSH_CONFIG: pushConfig, SERVANT_WORKER_MODE: 'internal',
  };
  const serverEntry = path.join(repository, 'server/server.mjs');
  apiServer = spawn(process.execPath, [serverEntry], { cwd: repository, env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [apiServer.stdout, apiServer.stderr]) stream.on('data', chunk => { serverOutput = (serverOutput + chunk).slice(-6000); });
  await waitFor(`${apiUrl}/health`, apiServer, 'API server');
  const api = async (method, pathname, body, token) => {
    const response = await testFetch(data, apiUrl + pathname, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const json = await response.json();
    assert.ok(response.ok, `${method} ${pathname}: ${response.status} ${JSON.stringify(json)}`);
    return json;
  };
  const invite = await run(process.execPath, [serverEntry, 'invite', '--name', 'Pat Tester', '--role', 'owner'], { env });
  const code = invite.stdout.match(/Invite code:\s*(\S+)/)?.[1];
  assert.ok(code);
  const paired = await api('POST', '/v1/pair', { code, device: 'Capture browser', terms: { version: TERMS_VERSION, items: TERMS_ITEMS } });
  const account = { ...paired, serverUrl: apiUrl, serverKey: serverIdentity(data).publicKey, serverName: 'Example server' };
  const created = await api('POST', '/v1/recordings', { size: 2048, durationMs: 18 * 60_000, ext: 'm4a' }, account.token);
  await api('POST', `/v1/recordings/${created.id}/chunk`, { offset: 0, data: Buffer.alloc(2048, 1).toString('base64') }, account.token);
  await stop(apiServer);
  const db = new DatabaseSync(path.join(data, 'recordings', 'recordings.db'));
  db.prepare("UPDATE recordings SET status = 'done', title = ?, summary = ?, notes = ?, transcript = ?, received = size WHERE id = ?")
    .run('Launch planning memo', 'Pat outlined launch checks and next steps.', JSON.stringify(['Confirm the release checklist', 'Share the plan with Jo Park']), '[0:00] Speaker: Confirm the release checklist.', created.id);
  db.prepare('INSERT OR REPLACE INTO recording_steps (recording_id, n, text, owner) VALUES (?, 0, ?, ?)').run(created.id, 'Confirm the release checklist', 'Pat Tester');
  db.close();
  apiServer = spawn(process.execPath, [serverEntry], { cwd: repository, env, stdio: ['ignore', 'pipe', 'pipe'] });
  await waitFor(`${apiUrl}/health`, apiServer, 'API server');
  const webUrl = `http://127.0.0.1:${await freePort()}`;
  webServer = spawn(process.execPath, [path.join(repository, 'app/node_modules/expo/bin/cli'), 'start', '--web', '--localhost', '--port', new URL(webUrl).port], { cwd: path.join(repository, 'app'), env: { ...env, CI: '1', EXPO_NO_TELEMETRY: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [webServer.stdout, webServer.stderr]) stream.on('data', chunk => { webOutput = (webOutput + chunk).slice(-6000); });
  await waitFor(webUrl, webServer, 'Expo web');
  browser = await chromium.launch(process.env.SERVANT_CAPTURE_BROWSER ? { channel: process.env.SERVANT_CAPTURE_BROWSER } : {});
  for (const [name, viewport] of [['desktop', { width: 1280, height: 800 }], ['phone', { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport, colorScheme: 'light' });
    await context.route(/^https?:\/\//, request => {
      const origin = new URL(request.request().url()).origin;
      return origin === apiUrl || origin === new URL(webUrl).origin ? request.continue() : request.abort('blockedbyclient');
    });
    await context.addInitScript(saved => localStorage.setItem('servant.account', JSON.stringify(saved)), account);
    const page = await context.newPage();
    await page.goto(webUrl + route, { waitUntil: 'domcontentloaded' });
    await page.getByText(/Launch planning memo|Recorded meeting/).first().waitFor({ timeout: 30000 });
    await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' });
    if (route === '/recordings') {
      // The same screen with the recorder open, then the note it made.
      await page.getByRole('button', { name: /^(Take notes|Record a voice memo)$/ }).first().click();
      await page.getByTestId('voice-recorder').or(page.getByRole('button', { name: 'Close' })).first().waitFor({ timeout: 30000 });
      await page.screenshot({ path: path.join(output, `${name}-recorder.png`), animations: 'disabled' });
      await page.goto(`${webUrl}/recordings/${created.id}`, { waitUntil: 'domcontentloaded' });
      await page.getByText('Pat outlined launch checks and next steps.').first().waitFor({ timeout: 30000 });
      await page.screenshot({ path: path.join(output, `${name}-detail.png`), animations: 'disabled' });
    }
    await context.close();
  }
  console.log(`Captured ${output}`);
} catch (error) {
  console.error(error);
  console.error(serverOutput);
  console.error(webOutput);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await stop(webServer);
  await stop(apiServer);
  fs.rmSync(scratch, { recursive: true, force: true });
}
