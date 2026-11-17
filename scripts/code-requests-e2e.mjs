#!/usr/bin/env node
// Code requests (docs/code-requests.md) end to end: an automation signed in as Pat asks for a one-time code, the
// alert names the request but not the code, Pat types the code in the real Expo web app, and the automation picks it
// up once. Synthetic data on a throwaway server; no live account is used.
// npm ci --prefix app && npm ci --prefix desktop && (cd desktop && npx playwright install chromium)
// node scripts/code-requests-e2e.mjs        (SERVANT_E2E_BEFORE=1 only captures the base build's screens)
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
const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'servant-code-requests-e2e-'));
const artifacts = path.join(repository, 'desktop/dist/code-requests-e2e');
fs.mkdirSync(artifacts, { recursive: true });
const data = path.join(scratch, 'data');
fs.mkdirSync(data, { mode: 0o700 });
const freePort = () => new Promise((resolve, reject) => {
  const listener = net.createServer();
  listener.on('error', reject);
  listener.listen(0, '127.0.0.1', () => { const port = listener.address().port; listener.close(() => resolve(port)); });
});
const waitUntil = async (check, label) => {
  for (let i = 0; i < 120; i++) {
    if (await check()) return;
    await delay(250);
  }
  throw new Error(`Timed out: ${label}`);
};
const waitFor = async (url, child, label) => waitUntil(async () => {
  if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`${label} exited with ${child.exitCode}`);
  try { return (await fetch(url, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
}, `${label} starts`);
const stop = async child => {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(1500)]);
  if (child.exitCode === null) child.kill('SIGKILL');
};
let browser, apiServer, webServer, page;
let serverOutput = '', webOutput = '';
const pageErrors = [];
const hermes = http.createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ object: 'list', data: [] })); });
const before = process.env.SERVANT_E2E_BEFORE === '1';
try {
  await new Promise(resolve => hermes.listen(0, '127.0.0.1', resolve));
  const port = await freePort();
  const apiUrl = `http://127.0.0.1:${port}`;
  const config = { name: 'Example team', publicUrl: apiUrl, discovery: 'off', discoveryUrl: '',
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
  const pair = async device => {
    const output = await run(process.execPath, [serverEntry, 'invite', '--name', 'Pat Tester', '--role', 'owner'], { env });
    const code = output.stdout.match(/Invite code:\s*(\S+)/)?.[1];
    assert.ok(code, 'fixture invite created');
    const response = await testFetch(data, `${apiUrl}/v1/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, device, terms: { version: TERMS_VERSION, items: TERMS_ITEMS } }) });
    assert.ok(response.ok, `${device} paired`);
    return response.json();
  };
  const phone = await pair('Browser E2E');
  const call = async (token, method, route, body) => {
    const response = await testFetch(data, `${apiUrl}/v1/${route}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  // The runner signs in as the same person, the way the MCP client does: a device link the phone approves.
  const link = (await call(null, 'POST', 'device-links', { device: 'QA runner', agent: true })).body;
  assert.equal((await call(phone.token, 'POST', `device-links/${link.id}/approve`, {})).status, 200);
  const runner = (await call(null, 'POST', `device-links/${link.id}/poll`, { secret: link.secret })).body;
  assert.equal(runner.status, 'approved', 'runner linked to Pat');
  const account = { token: phone.token, user: phone.user, features: phone.features, theme: phone.theme, serverUrl: apiUrl, serverKey: serverIdentity(data).publicKey, serverName: config.name };
  const webUrl = `http://127.0.0.1:${await freePort()}`;
  webServer = spawn(process.execPath, [path.join(repository, 'app/node_modules/expo/bin/cli'), 'start', '--web', '--localhost', '--port', new URL(webUrl).port], {
    cwd: path.join(repository, 'app'), env: { ...env, CI: '1', EXPO_NO_TELEMETRY: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  webServer.stdout.on('data', chunk => { webOutput += chunk; });
  webServer.stderr.on('data', chunk => { webOutput += chunk; });
  await waitFor(webUrl, webServer, 'Expo web');
  browser = await chromium.launch({ ...(process.env.SERVANT_E2E_BROWSER ? { channel: process.env.SERVANT_E2E_BROWSER } : {}) });
  const shoot = async (viewport, name, route) => {
    const context = await browser.newContext({ viewport, colorScheme: 'light', deviceScaleFactor: 2 });
    const id = accountId(account);
    await context.addInitScript(({ saved, key, indexKey, id }) => {
      if (localStorage.getItem(indexKey) !== null) return;
      localStorage.setItem(key, JSON.stringify(saved));
      localStorage.setItem(indexKey, JSON.stringify({ version: 1, ids: [id], activeId: id }));
    }, { saved: account, key: accountStorageKey(id), indexKey: ACCOUNTS_KEY, id });
    page = await context.newPage();
    page.setDefaultTimeout(60000);
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(`${webUrl}${route}`);
    return context;
  };

  const made = await call(runner.token, 'POST', 'code-requests', { label: 'Login.gov sign-in', hint: 'Texted to the number ending 0000' });
  if (before) {
    assert.equal(made.status, 404, 'the base build has no code requests');
    for (const [label, viewport] of [['phone', { width: 390, height: 844 }], ['desktop', { width: 1280, height: 900 }]]) {
      const context = await shoot(viewport, label, '/code/code_abcdefghijkl');
      await delay(6000);
      await page.screenshot({ path: path.join(artifacts, `before-${label}.png`), animations: 'disabled' });
      await context.close();
    }
    console.log(`code requests e2e (before): POST /v1/code-requests -> ${made.status} ${made.body?.error?.code}; screenshots in ${artifacts}`);
  } else {
    assert.equal(made.status, 201);
    const id = made.body.request.id;
    for (const [label, viewport] of [['phone', { width: 390, height: 844 }], ['desktop', { width: 1280, height: 900 }]]) {
      const context = await shoot(viewport, label, `/code/${id}`);
      const field = page.getByRole('textbox', { name: 'Code', exact: true });
      await field.waitFor();
      await page.getByText('QA runner is waiting for this code.', { exact: true }).waitFor();
      await page.getByText('Texted to the number ending 0000', { exact: true }).waitFor();
      await page.screenshot({ path: path.join(artifacts, `after-${label}.png`), animations: 'disabled' });
      if (label === 'desktop') {
        assert.equal((await call(runner.token, 'POST', `code-requests/${id}/claim`)).body.status, 'pending');
        // A complete six-digit code sends itself: no tap on Send code (lib/code-autosend.ts).
        await field.pressSequentially('554 10');
        await delay(800);
        assert.equal((await call(runner.token, 'POST', `code-requests/${id}/claim`)).body.status, 'pending', 'five digits wait');
        await field.pressSequentially('0');
        await page.getByText('Code sent', { exact: true }).waitFor();
        await page.screenshot({ path: path.join(artifacts, 'after-desktop-sent.png'), animations: 'disabled' });
        assert.deepEqual((await call(runner.token, 'POST', `code-requests/${id}/claim`)).body, { status: 'answered', code: '554100' }, 'the runner gets the code once');
        assert.deepEqual((await call(runner.token, 'POST', `code-requests/${id}/claim`)).body, { status: 'claimed' });
      }
      await context.close();
    }
    console.log('code requests e2e: OK — runner asked, web app showed the request, the complete code sent itself, runner picked it up once');
    console.log(`Screenshots: ${artifacts}`);
  }
  assert.deepEqual(pageErrors, [], 'no uncaught browser errors');
} catch (error) {
  if (page) await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {});
  console.error(error);
  if (pageErrors.length) console.error('Browser errors:', pageErrors);
  console.error('Server output:', serverOutput.slice(-2000));
  if (webOutput) console.error('Expo output:', webOutput.slice(-2000));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await stop(webServer);
  await stop(apiServer);
  hermes.closeAllConnections();
  await new Promise(resolve => hermes.close(resolve));
  fs.rmSync(scratch, { recursive: true, force: true });
}
