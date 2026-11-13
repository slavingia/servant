#!/usr/bin/env node
// Real Expo UI -> pinned encrypted API -> temporary server config -> UI.
// npm ci --prefix app && npm ci --prefix desktop
// cd desktop && npx playwright install chromium
// node scripts/theme-e2e.mjs
// SERVANT_E2E_BROWSER=chrome uses installed Chrome. SERVANT_THEME_WEB_URL
// reuses an Expo development server. No live account or server data is used.
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
import { createColors, DEFAULT_PRIMARY_COLOR } from '../app/src/lib/theme-colors.ts';

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(path.join(repository, 'desktop/package.json'));
const { chromium } = require('playwright');
const run = promisify(execFile);
const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'servant-theme-e2e-'));
const artifacts = path.join(repository, 'desktop/dist/theme-e2e');
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
const rgb = hex => `rgb(${[1, 3, 5].map(offset => parseInt(hex.slice(offset, offset + 2), 16)).join(', ')})`;
const css = (locator, property) => locator.evaluate((node, key) => getComputedStyle(node)[key], property);
const checkCss = async (locator, property, expected, label) => {
  await locator.waitFor();
  await waitUntil(async () => await css(locator, property) === expected, label);
  assert.equal(await css(locator, property), expected, label);
};
let browser, apiServer, webServer, page;
let serverOutput = '';
let webOutput = '';
const pageErrors = [];
let encryptedRequests = 0;
// The app may list agent chats in its sidebar; no agent work is performed.
const hermes = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ object: 'list', data: [] }));
});

try {
  await new Promise(resolve => hermes.listen(0, '127.0.0.1', resolve));
  const port = await freePort();
  const apiUrl = `http://127.0.0.1:${port}`;
  const config = {
    name: 'Theme test server', publicUrl: apiUrl, discovery: 'off', discoveryUrl: '',
    upstreams: { owner: { url: `http://127.0.0.1:${hermes.address().port}`, key: 'fixture-key' } },
    theme: { primaryColor: '#7C3AED' },
  };
  const writeConfig = () => fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify(config));
  writeConfig();
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SERVANT_|HERMES_|API_SERVER_KEY$)/.test(key))),
    SERVANT_DATA_DIR: data, SERVANT_PORT: String(port), SERVANT_HOST: '127.0.0.1', SERVANT_PUBLIC_URL: apiUrl, SERVANT_DISCOVERY_URL: '',
  };
  const serverEntry = path.join(repository, 'server/server.mjs');
  apiServer = spawn(process.execPath, [serverEntry], { cwd: repository, env, stdio: ['ignore', 'pipe', 'pipe'] });
  apiServer.stdout.on('data', chunk => { serverOutput += chunk; });
  apiServer.stderr.on('data', chunk => { serverOutput += chunk; });
  await waitFor(`${apiUrl}/health`, apiServer, 'API server');
  const output = await run(process.execPath, [serverEntry, 'invite', '--name', 'Pat Tester', '--role', 'owner'], { env });
  const code = output.stdout.match(/Invite code:\s*(\S+)/)?.[1];
  assert.ok(code, 'fixture invite created');
  const response = await testFetch(data, `${apiUrl}/v1/pair`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code, device: 'Browser E2E', terms: { version: TERMS_VERSION, items: TERMS_ITEMS } }),
  });
  assert.ok(response.ok, 'fixture account paired through the encrypted API');
  const paired = await response.json();
  assert.deepEqual(paired.theme, { primaryColor: '#7C3AED' });
  const account = { token: paired.token, user: paired.user, features: paired.features, theme: paired.theme,
    serverUrl: apiUrl, serverKey: serverIdentity(data).publicKey, serverName: config.name };
  const webUrl = process.env.SERVANT_THEME_WEB_URL || `http://127.0.0.1:${process.env.SERVANT_THEME_WEB_PORT || await freePort()}`;
  if (!process.env.SERVANT_THEME_WEB_URL) {
    webServer = spawn(process.execPath, [path.join(repository, 'app/node_modules/expo/bin/cli'), 'start', '--web', '--localhost', '--port', new URL(webUrl).port], {
      cwd: path.join(repository, 'app'), env: { ...env, CI: '1', EXPO_NO_TELEMETRY: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    webServer.stdout.on('data', chunk => { webOutput += chunk; });
    webServer.stderr.on('data', chunk => { webOutput += chunk; });
  }
  await waitFor(webUrl, webServer, 'Expo web');
  browser = await chromium.launch({ ...(process.env.SERVANT_E2E_BROWSER ? { channel: process.env.SERVANT_E2E_BROWSER } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, colorScheme: 'light' });
  const id = accountId(account);
  const storageKey = accountStorageKey(id);
  await context.addInitScript(({ saved, key, indexKey, id }) => {
    // Seed once. Reloads must use the profile actually persisted by the app.
    if (localStorage.getItem(indexKey) !== null) return;
    localStorage.setItem(key, JSON.stringify(saved));
    localStorage.setItem(indexKey, JSON.stringify({ version: 1, ids: [id], activeId: id }));
  }, { saved: account, key: storageKey, indexKey: ACCOUNTS_KEY, id });
  page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.on('pageerror', error => pageErrors.push(error.message));
  page.on('request', request => { if (request.url() === `${apiUrl}/v1/secure`) encryptedRequests++; });
  await page.goto(`${webUrl}/new-channel`);
  const channelName = page.getByRole('textbox', { name: 'Channel name', exact: true });
  const create = page.getByRole('button', { name: 'Create channel', exact: true });
  const switcher = page.getByRole('button', { name: 'Switch server, Theme test server', exact: true });
  const inspectTheme = async (seed, scheme, label) => {
    const colors = createColors(scheme, seed);
    await page.emulateMedia({ colorScheme: scheme });
    await channelName.fill('example-app');
    await checkCss(create, 'backgroundColor', rgb(colors.primary), `${label}: primary button`);
    await checkCss(create.getByText('Create channel', { exact: true }), 'color', rgb(colors.onPrimary), `${label}: primary label`);
    // Find the actual opaque sidebar behind its transparent server trigger.
    const sidebarColor = () => switcher.evaluate(node => {
      for (let current = node; current; current = current.parentElement) {
        const color = getComputedStyle(current).backgroundColor;
        if (color.startsWith('rgb(')) return color;
      }
      return null;
    });
    await waitUntil(async () => await sidebarColor() === rgb(colors.navy), `${label}: brand navigation`);
    assert.equal(await sidebarColor(), rgb(colors.navy), `${label}: brand navigation`);
    await page.screenshot({ path: path.join(artifacts, `${label}.png`), animations: 'disabled' });
    await switcher.click();
    const done = page.getByRole('button', { name: 'Done', exact: true });
    await checkCss(done.getByText('Done', { exact: true }), 'color', rgb(colors.blue), `${label}: link action`);
    await done.click();
    assert.equal(await channelName.inputValue(), 'example-app', `${label}: appearance changes retain the draft`);
  };
  await inspectTheme('#7C3AED', 'light', 'purple-light');
  await inspectTheme('#7C3AED', 'dark', 'purple-dark');

  const refreshConfig = async (theme, expected) => {
    if (theme) config.theme = theme; else delete config.theme;
    writeConfig();
    const before = encryptedRequests;
    await page.reload();
    await waitUntil(() => page.evaluate(({ key, color }) => JSON.parse(localStorage.getItem(key))?.theme?.primaryColor === color,
      { key: storageKey, color: expected }), 'refreshed server config is saved in the account');
    assert.ok(encryptedRequests > before, 'reload refreshes the account through the encrypted API');
  };
  await refreshConfig({ primaryColor: '#006B54' }, '#006B54');
  await inspectTheme('#006B54', 'light', 'green-light');
  await inspectTheme('#006B54', 'dark', 'green-dark');
  await refreshConfig(undefined, DEFAULT_PRIMARY_COLOR);
  await inspectTheme(DEFAULT_PRIMARY_COLOR, 'light', 'default-blue');
  assert.deepEqual(pageErrors, [], 'no uncaught browser errors');
  console.log('theme e2e: OK — encrypted pairing/profile refresh, primary buttons, brand navigation, links, light/dark, config update and default reset');
  console.log(`Screenshots: ${artifacts}`);
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {});
    console.error('Page:', (await page.locator('body').innerText().catch(() => '')).slice(-3000));
  }
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
