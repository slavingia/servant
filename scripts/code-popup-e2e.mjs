#!/usr/bin/env node
// Code request pop-up, end to end (docs/code-requests.md): real Expo UI -> pinned encrypted API -> the project's exported app
// served sandboxed at /a/<project>/ -> Comment and Edit in the page -> an ask waiting in a new agent chat.
//   npm ci --prefix app && npm ci --prefix desktop && (cd desktop && npx playwright install chromium)
//   node scripts/app-preview-e2e.mjs
// SERVANT_APP_PREVIEW_EXPORT=<dir> uses a real export (built with base path /a/example-app) instead of the built-in
// sample page. SERVANT_APP_PREVIEW_PATH opens that page first. Screenshots go to desktop/dist/code-popup-e2e/.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { testFetch } from '../server/encrypted-test-client.mjs';
import { serverIdentity } from '../server/secure-transport.mjs';
import { TERMS_VERSION, TERMS_ITEMS } from '../server/terms.mjs';

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(path.join(repository, 'desktop/package.json'));
const { chromium } = require('playwright');
const run = promisify(execFile);
const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'servant-code-popup-e2e-'));
const artifacts = path.join(repository, 'desktop/dist/code-popup-e2e');
fs.mkdirSync(artifacts, { recursive: true });
const data = path.join(scratch, 'data');
const runtime = path.join(scratch, 'runtime');
for (const directory of [data, runtime]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const freePort = () => new Promise((resolve, reject) => {
  const listener = net.createServer();
  listener.on('error', reject);
  listener.listen(0, '127.0.0.1', () => { const port = listener.address().port; listener.close(() => resolve(port)); });
});
const waitFor = async (url, child, label) => {
  for (let attempt = 0; attempt < 240; attempt++) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`${label} exited with ${child.exitCode}`);
    if (await fetch(url, { signal: AbortSignal.timeout(1000) }).then(r => r.ok).catch(() => false)) return;
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

let browser, apiServer, webServer, hermes;
let serverOutput = '', webOutput = '';
const pageErrors = [];
try {
  hermes = http.createServer((req, res) => res.writeHead(404).end('{}'));
  await new Promise(r => hermes.listen(0, '127.0.0.1', r));
  const port = await freePort();
  const apiUrl = `http://127.0.0.1:${port}`;
  const pushConfig = path.join(scratch, 'push-disabled.json');
  fs.writeFileSync(pushConfig, '{}\n', { mode: 0o600 });
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ host: '127.0.0.1', port, name: 'Code test', publicUrl: apiUrl, discovery: 'off', discoveryUrl: '', defaultAgentTier: 3,
    upstreams: { owner: { url: `http://127.0.0.1:${hermes.address().port}`, key: 'synthetic-local-key' } } }), { mode: 0o600 });
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(SERVANT_|HERMES_|API_SERVER_KEY$)/.test(k))),
    SERVANT_DATA_DIR: data, SERVANT_RUNTIME_DIR: runtime, SERVANT_HOST: '127.0.0.1', SERVANT_PORT: String(port), SERVANT_PUBLIC_URL: apiUrl,
    SERVANT_DISCOVERY_URL: '', SERVANT_PUSH_CONFIG: pushConfig, SERVANT_WORKER_MODE: 'internal', SERVANT_SHUTDOWN_TIMEOUT_MS: '1000' };
  const serverEntry = path.join(repository, 'server/server.mjs');
  apiServer = spawn(process.execPath, [serverEntry], { cwd: repository, env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const s of [apiServer.stdout, apiServer.stderr]) s.on('data', c => { serverOutput = (serverOutput + c).slice(-6000); });
  await waitFor(`${apiUrl}/health`, apiServer, 'API server');
  const api = async (method, route, body, token) => {
    const r = await testFetch(data, apiUrl + route, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
    const j = await r.json(); assert.ok(r.ok, `${method} ${route}: ${r.status} ${JSON.stringify(j)}`); return j;
  };
  const out = await run(process.execPath, [serverEntry, 'invite', '--name', 'Pat Tester', '--role', 'owner'], { env });
  const code = out.stdout.match(/Invite code:\s*(\S+)/)?.[1];
  const paired = await api('POST', '/v1/pair', { code, device: 'Browser E2E', terms: { version: TERMS_VERSION, items: TERMS_ITEMS } });
  const owner = { ...paired, serverUrl: apiUrl, serverKey: serverIdentity(data).publicKey, serverName: 'Code test' };
  const webUrl = `http://127.0.0.1:${await freePort()}`;
  webServer = spawn(process.execPath, [path.join(repository, 'app/node_modules/expo/bin/cli'), 'start', '--web', '--localhost', '--port', new URL(webUrl).port], {
    cwd: path.join(repository, 'app'), env: { ...env, CI: '1', EXPO_NO_TELEMETRY: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const s of [webServer.stdout, webServer.stderr]) s.on('data', c => { webOutput = (webOutput + c).slice(-6000); });
  await waitFor(webUrl, webServer, 'Expo web');
  browser = await chromium.launch({ ...(process.env.SERVANT_E2E_BROWSER ? { channel: process.env.SERVANT_E2E_BROWSER } : {}) });
  const shotAt = async (page, name) => page.screenshot({ path: path.join(artifacts, `${name}.png`) });
  for (const [label, viewport] of [['wide', { width: 1280, height: 800 }], ['phone', { width: 390, height: 844 }]]) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 2 });
    await context.addInitScript(saved => { if (!localStorage.getItem('servant.accounts')) localStorage.setItem('servant.account', JSON.stringify(saved)); }, owner);
    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    page.on('pageerror', e => pageErrors.push(e.message));
    await page.goto(`${webUrl}/todos`);
    await page.getByText('To-dos', { exact: true }).first().waitFor();
    await delay(2500); // the live connection is up
    await shotAt(page, `${label}-1-before`);
    // An automation signed in as Pat asks for a code while Servant is open on another screen.
    const made = await api('POST', '/v1/code-requests', { label: 'Login.gov sign-in', hint: 'Texted to the number ending 0000', length: 6 }, owner.token);
    const field = page.locator('[data-testid="code-request-code"]:visible');
    const t0 = Date.now();
    await field.waitFor({ timeout: 10000 });
    const tookMs = Date.now() - t0;
    assert.match(page.url(), new RegExp(`/code/${made.request.id}`), 'the Enter code screen for that request');
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'code-request-code', null, { timeout: 3000 });
    await page.keyboard.type('12');
    assert.equal(await field.inputValue(), '12', 'typing goes straight into the box, no click');
    await shotAt(page, `${label}-2-popped-up`);
    console.log(`${label}: popped up in ${tookMs} ms, box focused, typed without a click`);
    await api('POST', `/v1/code-requests/${made.request.id}/cancel`, {}, owner.token);
    // The same request never pops up twice.
    await page.goto(`${webUrl}/todos`);
    await page.getByText('To-dos', { exact: true }).first().waitFor();
    await delay(1500);
    assert.doesNotMatch(page.url(), /\/code\//, 'a finished request does not come back');
    await context.close();
  }
  assert.deepEqual(pageErrors, [], 'no page errors');
  console.log(`code-popup-e2e: OK (${artifacts})`);
} catch (error) {
  console.error(error);
  console.error('--- server ---\n' + serverOutput + '\n--- web ---\n' + webOutput.slice(-2000) + '\n--- page errors ---\n' + pageErrors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await stop(webServer); await stop(apiServer);
  hermes?.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
