#!/usr/bin/env node
// Selecting text across messages in the real Expo web UI, which is also what the Mac app shows.
// Run after npm ci --prefix app and npm ci --prefix desktop, then install a
// Playwright browser: cd desktop && npx playwright install chromium.
//   node scripts/select-text-e2e.mjs
// Optional: SERVANT_E2E_BROWSER=chrome uses installed Chrome; set
// SERVANT_SELECT_WEB_URL to reuse a development server. No live data is used.
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
const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'servant-select-text-e2e-'));
const artifacts = path.join(repository, 'desktop/dist/select-text-e2e');
fs.mkdirSync(artifacts, { recursive: true });
const data = path.join(scratch, 'data');
fs.mkdirSync(data, { mode: 0o700 });
const freePort = () => new Promise((resolve, reject) => {
  const listener = net.createServer();
  listener.on('error', reject);
  listener.listen(0, '127.0.0.1', () => { const port = listener.address().port; listener.close(() => resolve(port)); });
});
const waitFor = async (url, child, label) => {
  for (let i = 0; i < 120; i++) {
    if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error(`${label} exited with ${child.exitCode}`);
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1000) })).ok) return; } catch { /* starting */ }
    await delay(250);
  }
  throw new Error(`${label} did not become ready`);
};
const stop = async child => {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(1500)]);
  if (child.exitCode === null) child.kill('SIGKILL');
};
const waitUntil = async (check, label) => {
  for (let i = 0; i < 120; i++) {
    if (await check()) return;
    await delay(250);
  }
  throw new Error(`Timed out: ${label}`);
};
let browser, apiServer, webServer, page;
let serverOutput = '';
let webOutput = '';
const pageErrors = [];
// Only the agent is a fixture: UI messages still cross the real encrypted API.
// Keep the received body so submit assertions verify what reaches the agent.
const sessions = new Map();
const submissions = [];
const upstreamRequests = [];
const hermes = http.createServer(async (req, res) => {
  upstreamRequests.push(`${req.method} ${req.url}`);
  let raw = '';
  for await (const part of req) raw += part;
  const body = raw ? JSON.parse(raw) : {};
  const route = req.url.match(/^\/api\/sessions(?:\/([^/]+))?(\/.*)?$/);
  const id = route?.[1] && decodeURIComponent(route[1]);
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'POST' && req.url === '/api/sessions') {
    sessions.set(body.id, []);
    res.writeHead(201).end(JSON.stringify({ object: 'hermes.session', session: { id: body.id } }));
  } else if (sessions.has(id) && req.method === 'GET' && !route[2]) {
    res.end(JSON.stringify({ object: 'hermes.session', session: { id } }));
  } else if (sessions.has(id) && req.method === 'GET' && route[2] === '/messages') {
    res.end(JSON.stringify({ object: 'list', data: sessions.get(id) }));
  } else if (sessions.has(id) && req.method === 'POST' && route[2] === '/chat/stream') {
    submissions.push({ id, body });
    const messages = sessions.get(id);
    const reply = `Fixture reply ${submissions.length}.`;
    messages.push({ id: messages.length + 1, role: 'user', content: body.message });
    messages.push({ id: messages.length + 1, role: 'assistant', content: reply });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const event = (name, payload) => res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
    event('run.started', {});
    event('assistant.delta', { delta: reply });
    event('assistant.completed', { content: reply });
    event('run.completed', { usage: { input_tokens: body.message.length, output_tokens: reply.length } });
    event('done', {});
    res.end();
  } else { res.writeHead(404); res.end(JSON.stringify({ error: 'Fixture endpoint not implemented' })); }
});

try {
  await new Promise(resolve => hermes.listen(0, '127.0.0.1', resolve));
  const port = await freePort();
  const apiUrl = `http://127.0.0.1:${port}`;
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({
    name: 'Selection test server', publicUrl: apiUrl, discovery: 'off', discoveryUrl: '',
    upstreams: { owner: { url: `http://127.0.0.1:${hermes.address().port}`, key: 'fixture-key' } },
  }));
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SERVANT_|HERMES_|API_SERVER_KEY$)/.test(key))),
    SERVANT_DATA_DIR: data, SERVANT_PORT: String(port), SERVANT_HOST: '127.0.0.1', SERVANT_PUBLIC_URL: apiUrl, SERVANT_DISCOVERY_URL: '',
  };
  const serverEntry = path.join(repository, 'server/server.mjs');
  apiServer = spawn(process.execPath, [serverEntry], { cwd: repository, env, stdio: ['ignore', 'pipe', 'pipe'] });
  apiServer.stdout.on('data', chunk => { serverOutput += chunk; });
  apiServer.stderr.on('data', chunk => { serverOutput += chunk; });
  await waitFor(`${apiUrl}/health`, apiServer, 'API server');
  const api = async (method, route, body, token) => {
    const response = await testFetch(data, apiUrl + route, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = await response.json();
    assert.ok(response.ok, `${method} ${route}: ${response.status} ${JSON.stringify(json)}`);
    return json;
  };
  const pair = async (name, role) => {
    const output = await run(process.execPath, [serverEntry, 'invite', '--name', name, '--role', role], { env });
    const code = output.stdout.match(/Invite code:\s*(\S+)/)?.[1];
    assert.ok(code, 'Fixture invite was created');
    const paired = await api('POST', '/v1/pair', { code, device: 'Browser E2E', terms: { version: TERMS_VERSION, items: TERMS_ITEMS } });
    return { ...paired, serverUrl: apiUrl, serverKey: serverIdentity(data).publicKey, serverName: 'Selection test server' };
  };
  const owner = await pair('Pat Tester', 'owner');
  const reader = await pair('Jo Park', 'member');
  const { project } = await api('POST', '/v1/projects', { name: 'Example app', description: 'Synthetic selection test', repo: 'example-org/example-app' }, owner.token);
  await api('POST', `/v1/projects/${project.id}/people`, { userId: reader.user.id, level: 'read' }, owner.token);

  const webUrl = process.env.SERVANT_SELECT_WEB_URL || `http://127.0.0.1:${process.env.SERVANT_SELECT_WEB_PORT || await freePort()}`;
  if (!process.env.SERVANT_SELECT_WEB_URL) {
    webServer = spawn(process.execPath, [path.join(repository, 'app/node_modules/expo/bin/cli'), 'start', '--web', '--localhost', '--port', new URL(webUrl).port], {
      cwd: path.join(repository, 'app'), env: { ...env, CI: '1', EXPO_NO_TELEMETRY: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    webServer.stdout.on('data', chunk => { webOutput += chunk; });
    webServer.stderr.on('data', chunk => { webOutput += chunk; });
  }
  await waitFor(webUrl, webServer, 'Expo web');
  browser = await chromium.launch({ ...(process.env.SERVANT_E2E_BROWSER ? { channel: process.env.SERVANT_E2E_BROWSER } : {}) });
  const newPage = async (account, viewport) => {
    const context = await browser.newContext({ viewport });
    const id = accountId(account);
    await context.addInitScript(({ saved, key, indexKey, id }) => {
      localStorage.setItem(key, JSON.stringify(saved));
      localStorage.setItem(indexKey, JSON.stringify({ version: 1, ids: [id], activeId: id }));
    }, { saved: account, key: accountStorageKey(id), indexKey: ACCOUNTS_KEY, id });
    const opened = await context.newPage();
    opened.setDefaultTimeout(30000);
    opened.on('pageerror', error => pageErrors.push(error.message));
    return opened;
  };

  page = await newPage(owner, { width: 1280, height: 900 });
  // Drag from inside one message to inside the next and read what the browser selected: the text between
  // the two points, in reading order, the way any web page selects.
  const drag = async (from, to) => {
    const a = await from.boundingBox();
    const b = await to.boundingBox();
    await page.evaluate(() => window.getSelection().removeAllRanges());
    await page.mouse.move(a.x + 40, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + 120, b.y + b.height / 2, { steps: 15 });
    await page.mouse.up();
    return page.evaluate(() => window.getSelection().toString());
  };
  const { conversation: channel } = await api('POST', '/v1/conversations', { name: 'select-demo', topic: 'Selection', memberIds: [reader.user.id] }, owner.token);
  await api('POST', `/v1/conversations/${channel.id}/messages`, { text: 'The quick brown fox jumps over the lazy dog in the channel' }, owner.token);
  await api('POST', `/v1/conversations/${channel.id}/messages`, { text: 'Second message with **bold words** and more plain text here' }, reader.token);
  await page.goto(`${webUrl}/c/${channel.id}`);
  const first = page.getByText('The quick brown fox', { exact: false }).first();
  const second = page.getByText('Second message with', { exact: false }).first();
  await first.waitFor();
  const channelSelection = await drag(first, second);
  await page.screenshot({ path: path.join(artifacts, 'channel-selection.png') });
  assert.match(channelSelection, /^\S*\s?\S*brown fox jumps over the lazy dog in the channel[\s\S]*Jo Park[\s\S]*Second message/, `channel: ${JSON.stringify(channelSelection)}`);
  assert.doesNotMatch(channelSelection, /joined the channel/, 'the drag does not run up into what is above the first message');

  const { chat } = await api('POST', '/v1/chats', { projectId: project.id, title: 'Selection' }, owner.token);
  await page.goto(`${webUrl}/chat/${chat.id}`);
  const composer = page.getByTestId('composer-input');
  await composer.fill('Hello agent please answer in a long sentence');
  await composer.press('Enter');
  const reply = page.getByText('Fixture reply 1.', { exact: true });
  await reply.waitFor();
  const chatSelection = await drag(page.getByText('Hello agent please answer', { exact: false }).first(), reply);
  await page.screenshot({ path: path.join(artifacts, 'chat-selection.png') });
  assert.match(chatSelection, /^\S*\s?\S*please answer in a long sentence[\s\S]*Agent[\s\S]*Fixture r/, `chat: ${JSON.stringify(chatSelection)}`);
  console.log('Selecting across messages works in a channel and in an agent chat. Screenshots:', artifacts);
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {});
    console.error('Page:', (await page.locator('body').innerText().catch(() => '')).slice(-5000));
    console.error('Composer:', JSON.stringify(await page.getByTestId('composer-input').inputValue().catch(() => 'unavailable')));
  }
  console.error(error);
  console.error('Fixture upstream requests:', upstreamRequests);
  if (pageErrors.length) console.error('Browser errors:', pageErrors);
  console.error('Server output:', serverOutput.slice(-3000));
  if (webOutput) console.error('Expo output:', webOutput.slice(-3000));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await stop(webServer);
  await stop(apiServer);
  hermes.closeAllConnections();
  await new Promise(resolve => hermes.close(resolve));
  fs.rmSync(scratch, { recursive: true, force: true });
}
