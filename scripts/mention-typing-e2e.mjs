#!/usr/bin/env node
// Issue #82: in a group DM, pick an @mention from the list, then keep typing.
// Real Expo web UI -> encrypted API on a temporary server. No live data.
// npm ci --prefix app && npm ci --prefix desktop; node scripts/mention-typing-e2e.mjs
// SERVANT_E2E_BROWSER=msedge or chrome picks an installed browser. SERVANT_MENTION_WEB_URL reuses an Expo server.
// SERVANT_MENTION_SHOTS=<dir> saves screenshots there.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { serverIdentity } from '../server/secure-transport.mjs';
import { testFetch } from '../server/encrypted-test-client.mjs';
import { TERMS_VERSION, TERMS_ITEMS } from '../server/terms.mjs';
import { ACCOUNTS_KEY, accountId, accountStorageKey } from '../app/src/lib/accounts-store.ts';

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(path.join(repository, 'desktop/package.json'));
const { chromium } = require('playwright');
const run = promisify(execFile);
const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'servant-mention-e2e-'));
const shots = process.env.SERVANT_MENTION_SHOTS || path.join(repository, 'desktop/dist/mention-e2e');
fs.mkdirSync(shots, { recursive: true });
const data = path.join(scratch, 'data');
fs.mkdirSync(data, { mode: 0o700 });
const freePort = () => new Promise((resolve, reject) => {
  const listener = net.createServer();
  listener.on('error', reject);
  listener.listen(0, '127.0.0.1', () => { const port = listener.address().port; listener.close(() => resolve(port)); });
});
const waitFor = async (url, child, label) => {
  for (let i = 0; i < 480; i++) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`${label} exited with ${child.exitCode}`);
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* not yet */ }
    await delay(250);
  }
  throw new Error(`Timed out: ${label}`);
};
const stop = async child => {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(1500)]);
  if (child.exitCode === null) child.kill('SIGKILL');
};
let browser, apiServer, webServer, page;
let serverOutput = '';
const pageErrors = [];
const hermes = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ object: 'list', data: [] })); });

try {
  await new Promise(resolve => hermes.listen(0, '127.0.0.1', resolve));
  const port = await freePort();
  const apiUrl = `http://127.0.0.1:${port}`;
  const config = { name: 'Mention test server', publicUrl: apiUrl, discovery: 'off', discoveryUrl: '',
    upstreams: { owner: { url: `http://127.0.0.1:${hermes.address().port}`, key: 'fixture-key' } } };
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify(config));
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SERVANT_|HERMES_|API_SERVER_KEY$)/.test(key))),
    SERVANT_DATA_DIR: data, SERVANT_PORT: String(port), SERVANT_HOST: '127.0.0.1', SERVANT_PUBLIC_URL: apiUrl, SERVANT_DISCOVERY_URL: '',
  };
  const serverEntry = path.join(repository, 'server/server.mjs');
  apiServer = spawn(process.execPath, [serverEntry], { cwd: repository, env, stdio: ['ignore', 'pipe', 'pipe'] });
  apiServer.stdout.on('data', chunk => { serverOutput += chunk; });
  apiServer.stderr.on('data', chunk => { serverOutput += chunk; });
  await waitFor(`${apiUrl}/health`, apiServer, 'API server');
  const pair = async (name, role) => {
    const output = await run(process.execPath, [serverEntry, 'invite', '--name', name, ...(role ? ['--role', role] : [])], { env });
    const code = output.stdout.match(/Invite code:\s*(\S+)/)?.[1];
    assert.ok(code, `invite for ${name}`);
    const response = await testFetch(data, `${apiUrl}/v1/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, device: `${name} E2E`, terms: { version: TERMS_VERSION, items: TERMS_ITEMS } }) });
    assert.ok(response.ok, `${name} paired`);
    return response.json();
  };
  const ana = await pair('Ana Ruiz', 'owner');
  const pat = await pair('Pat Tester');
  const jo = await pair('Jo Park');
  const created = await testFetch(data, `${apiUrl}/v1/conversations`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ana.token}` },
    body: JSON.stringify({ kind: 'dm', userIds: [pat.user.id, jo.user.id] }) });
  assert.ok(created.ok, 'group DM created');
  const group = (await created.json()).conversation;
  const account = { token: ana.token, user: ana.user, features: ana.features, theme: ana.theme, serverUrl: apiUrl, serverKey: serverIdentity(data).publicKey, serverName: config.name, tourDue: false, tourClosed: true };
  const webUrl = process.env.SERVANT_MENTION_WEB_URL || `http://127.0.0.1:${await freePort()}`;
  if (!process.env.SERVANT_MENTION_WEB_URL) {
    webServer = spawn(process.execPath, [path.join(repository, 'app/node_modules/expo/bin/cli'), 'start', '--web', '--localhost', '--port', new URL(webUrl).port],
      { cwd: path.join(repository, 'app'), env: { ...env, CI: '1', EXPO_NO_TELEMETRY: '1' }, stdio: 'ignore' });
  }
  await waitFor(webUrl, webServer, 'Expo web');
  browser = await chromium.launch({ ...(process.env.SERVANT_E2E_BROWSER ? { channel: process.env.SERVANT_E2E_BROWSER } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
  const id = accountId(account);
  await context.addInitScript(({ saved, key, indexKey, id }) => {
    if (localStorage.getItem(indexKey) !== null) return;
    localStorage.setItem(key, JSON.stringify(saved));
    localStorage.setItem(indexKey, JSON.stringify({ version: 1, ids: [id], activeId: id }));
  }, { saved: account, key: accountStorageKey(id), indexKey: ACCOUNTS_KEY, id });
  page = await context.newPage();
  page.setDefaultTimeout(60000);
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`${webUrl}/c/${group.id}`);
  const box = page.locator('[data-testid="composer-input"]:visible').first();
  await box.click();
  await page.keyboard.type('@Pa', { delay: 40 });
  const option = page.getByTestId(`mention-${pat.user.id}`);
  await option.waitFor();
  await page.screenshot({ path: path.join(shots, '1-list-open.png') });
  const how = process.env.SERVANT_MENTION_PICK || 'click';
  if (how === 'tap') await option.tap(); else if (how === 'tab') await page.keyboard.press('Tab'); else await option.click();
  await delay(30);
  // People often click back into the box to place the caret after picking a name (Windows, Edge in #82).
  if (process.env.SERVANT_MENTION_CLICK_BACK !== '0') {
    await delay(300);
    const at = await box.boundingBox();
    const x = at.x + at.width - 40, y = at.y + at.height / 2;
    if (process.env.SERVANT_MENTION_DEBUG) console.log('top element:', await page.evaluate(([x, y]) => { const n = document.elementFromPoint(x, y); return n ? `${getComputedStyle(n).pointerEvents} ${n.tagName} ${n.getAttribute('data-testid') || ''} ${n.className}`.slice(0, 900) : null; }, [x, y]), JSON.stringify(at));
    await page.mouse.click(x, y);
  }
  await page.keyboard.type('can you look', { delay: 40 });
  await delay(300);
  const value = await box.inputValue();
  const state = await box.evaluate(node => ({ focused: document.activeElement === node, start: node.selectionStart, end: node.selectionEnd }));
  await page.screenshot({ path: path.join(shots, '2-after-typing.png') });
  console.log(JSON.stringify({ how, value, ...state }));
  assert.match(value, /^@(Pat-Tester|Jo-Park) can you look$/, 'typing after a picked mention lands in the box');
  assert.ok(state.focused, 'the box keeps focus');
  assert.deepEqual(pageErrors, [], 'no uncaught browser errors');
  console.log(`mention typing e2e (${how}): OK`);
} catch (error) {
  if (page) await page.screenshot({ path: path.join(shots, 'failure.png') }).catch(() => {});
  console.error(error);
  if (pageErrors.length) console.error('Browser errors:', pageErrors);
  if (!/OK/.test(String(error))) console.error('Server output:', serverOutput.slice(-1500));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await stop(webServer);
  await stop(apiServer);
  hermes.closeAllConnections();
  await new Promise(resolve => hermes.close(resolve));
  fs.rmSync(scratch, { recursive: true, force: true });
}
