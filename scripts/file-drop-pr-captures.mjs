#!/usr/bin/env node
// Synthetic before/after captures for File drop: the sidebar, the screen, a file being dragged over it and two files
// saved. On a checkout without File drop the same steps show what was there before (no place, no screen).
// Usage: node scripts/file-drop-pr-captures.mjs <output-dir>
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
import { setTimeout as delay } from 'node:timers/promises';
import { testFetch } from '../server/encrypted-test-client.mjs';
import { serverIdentity } from '../server/secure-transport.mjs';
import { TERMS_VERSION, TERMS_ITEMS } from '../server/terms.mjs';

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = path.resolve(process.argv[2] || 'file-drop-captures');
const require = createRequire(path.join(repository, 'desktop/package.json'));
const { chromium } = require('playwright');
const run = promisify(execFile);
const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'servant-file-drop-capture-'));
const data = path.join(scratch, 'data');
const runtime = path.join(scratch, 'runtime');
// Stands in for the owner's Desktop.
const folder = path.join(scratch, 'Desktop');
for (const directory of [output, data, runtime, folder]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
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
    SERVANT_PUBLIC_URL: apiUrl, SERVANT_DISCOVERY_URL: '', SERVANT_PUSH_CONFIG: pushConfig, SERVANT_WORKER_MODE: 'internal', SERVANT_FILE_DROP_DIR: folder,
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
    // A signed-in app learns File drop from the server's /v1/me; the saved account starts without it.
    const page = await context.newPage();
    await page.goto(webUrl + '/file-drop', { waitUntil: 'domcontentloaded' });
    const zone = page.getByTestId('file-drop-zone');
    const present = await zone.waitFor({ timeout: 30000 }).then(() => true, () => false);
    // Without File drop there is no such screen: show the places that were there instead (the sidebar, or You on a phone).
    if (!present) { await page.goto(webUrl + (name === 'phone' ? '/you' : '/todos'), { waitUntil: 'domcontentloaded' }); await page.getByText('To-dos').first().waitFor({ timeout: 30000 }); if (name === 'phone') await page.getByText('To-dos').first().scrollIntoViewIfNeeded(); }
    await page.screenshot({ path: path.join(output, `${name}.png`), animations: 'disabled' });
    if (present) {
      // Drag two synthetic files over the window, then let go.
      const fire = type => page.evaluate(kind => {
        const transfer = new DataTransfer();
        transfer.items.add(new File(['Launch plan for the example app.\n'], 'Launch plan.txt', { type: 'text/plain' }));
        transfer.items.add(new File([new Uint8Array(4 * 1024 * 1024)], 'Design review.fig'));
        window.dispatchEvent(new DragEvent(kind, { dataTransfer: transfer, bubbles: true, cancelable: true }));
      }, type);
      await fire('dragenter');
      await page.getByText('Drop to send').waitFor({ timeout: 10000 });
      await page.screenshot({ path: path.join(output, `${name}-over.png`), animations: 'disabled' });
      const before = fs.readdirSync(folder).length;
      await fire('drop');
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="file-drop-item"]').length === 2 && [...document.querySelectorAll('[data-testid="file-drop-item"]')].every(row => /Saved/.test(row.textContent)), null, { timeout: 60000 });
      await page.screenshot({ path: path.join(output, `${name}-saved.png`), animations: 'disabled' });
      // The files really are in the folder, whole, and the second pass (phone) sits beside the first.
      const names = fs.readdirSync(folder).sort();
      assert.equal(names.length, before + 2, names.join(', '));
      assert.equal(fs.statSync(path.join(folder, 'Design review.fig')).size, 4 * 1024 * 1024);
      assert.equal(fs.readFileSync(path.join(folder, 'Launch plan.txt'), 'utf8'), 'Launch plan for the example app.\n');
      console.log(`${name}: folder now holds ${names.join(', ')}`);
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
