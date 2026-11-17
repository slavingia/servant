#!/usr/bin/env node
// App preview, end to end (docs/app-preview.md): real Expo UI -> pinned encrypted API -> the project's exported app
// served sandboxed at /a/<project>/ -> Comment and Edit in the page -> an ask waiting in a new agent chat.
//   npm ci --prefix app && npm ci --prefix desktop && (cd desktop && npx playwright install chromium)
//   node scripts/app-preview-e2e.mjs
// SERVANT_APP_PREVIEW_EXPORT=<dir> uses a real export (built with base path /a/example-app) instead of the built-in
// sample page. SERVANT_APP_PREVIEW_PATH opens that page first. Screenshots go to desktop/dist/app-preview-e2e/.
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
const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'servant-app-preview-e2e-'));
const artifacts = path.join(repository, 'desktop/dist/app-preview-e2e');
fs.mkdirSync(artifacts, { recursive: true });
const data = path.join(scratch, 'data');
const runtime = path.join(scratch, 'runtime');
for (const directory of [data, runtime]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
const PROJECT = process.env.SERVANT_APP_PREVIEW_PROJECT || 'example-app';
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

// A sample "app": two screens, a button, and client-side navigation like Expo Router's.
function sampleExport(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const shell = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font:16px system-ui;margin:0;padding:24px}h1{font-size:28px;margin:0 0 16px}button{font:600 16px system-ui;padding:12px 16px}</style></head><body>${body}
<script>document.getElementById("next")&&document.getElementById("next").addEventListener("click",function(e){e.preventDefault();history.pushState({},"","/a/${PROJECT}/refund-status");document.querySelector("h1").textContent="Refund status"});</script></body></html>`;
  fs.writeFileSync(path.join(dir, 'index.html'), shell('Home', '<h1>What do you need?</h1><p>You owe $40</p><button id="pay">Make a payment</button> <a id="next" href="/a/' + PROJECT + '/refund-status">Refund status</a>'));
  fs.writeFileSync(path.join(dir, 'refund-status.html'), shell('Refund', '<h1>Refund status</h1>'));
  fs.writeFileSync(path.join(dir, '+not-found.html'), shell('Not found', '<h1>Not found</h1>'));
  fs.writeFileSync(path.join(dir, 'deployment-environment.json'), JSON.stringify({ commit: '0123456789abcdef', builtAt: new Date().toISOString() }));
}

let browser, apiServer, webServer, hermes;
let serverOutput = '', webOutput = '';
const pageErrors = [];
try {
  const sessions = new Map();
  hermes = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const json = (s, v) => res.writeHead(s, { 'Content-Type': 'application/json' }).end(JSON.stringify(v));
    if (req.method === 'POST' && req.url === '/api/sessions') { sessions.set(body.id, []); return json(201, { session: { id: body.id } }); }
    const m = req.url.match(/^\/api\/sessions\/([^/]+)(\/.*)?$/); const id = m && decodeURIComponent(m[1]);
    if (!sessions.has(id)) return json(404, {});
    return json(200, m[2] === '/messages' ? { data: sessions.get(id) } : { session: { id } });
  });
  await new Promise(r => hermes.listen(0, '127.0.0.1', r));
  const port = await freePort();
  const apiUrl = `http://127.0.0.1:${port}`;
  const pushConfig = path.join(scratch, 'push-disabled.json');
  fs.writeFileSync(pushConfig, '{}\n', { mode: 0o600 });
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({
    host: '127.0.0.1', port, name: 'App preview test', publicUrl: apiUrl, discovery: 'off', discoveryUrl: '', defaultAgentTier: 3,
    upstreams: { owner: { url: `http://127.0.0.1:${hermes.address().port}`, key: 'synthetic-local-key' } },
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(data, 'projects.json'), JSON.stringify({ projects: [{ id: PROJECT, name: 'Example app', repo: 'example-org/example-app', path: '', workflow: 'main', rules: [], owners: [], access: {}, files: [], stages: [], releases: [] }] }));
  const exportDir = path.join(data, 'app-previews', PROJECT);
  if (process.env.SERVANT_APP_PREVIEW_EXPORT) fs.cpSync(process.env.SERVANT_APP_PREVIEW_EXPORT, exportDir, { recursive: true });
  else sampleExport(exportDir);
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(SERVANT_|HERMES_|API_SERVER_KEY$)/.test(k))),
    SERVANT_DATA_DIR: data, SERVANT_RUNTIME_DIR: runtime, SERVANT_HOST: '127.0.0.1', SERVANT_PORT: String(port), SERVANT_PUBLIC_URL: apiUrl,
    SERVANT_DISCOVERY_URL: '', SERVANT_PUSH_CONFIG: pushConfig, SERVANT_WORKER_MODE: 'internal', SERVANT_SHUTDOWN_TIMEOUT_MS: '1000',
  };
  const serverEntry = path.join(repository, 'server/server.mjs');
  apiServer = spawn(process.execPath, [serverEntry], { cwd: repository, env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const s of [apiServer.stdout, apiServer.stderr]) s.on('data', c => { serverOutput = (serverOutput + c).slice(-6000); });
  await waitFor(`${apiUrl}/health`, apiServer, 'API server');
  const api = async (method, route, body, token) => {
    const r = await testFetch(data, apiUrl + route, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
    const j = await r.json(); assert.ok(r.ok, `${method} ${route}: ${r.status} ${JSON.stringify(j)}`); return j;
  };
  const out = await run(process.execPath, [serverEntry, 'invite', '--name', 'Pat Tester', '--role', 'owner'], { env });
  const code = out.stdout.match(/Invite code:\s*(\S+)/)?.[1];
  const paired = await api('POST', '/v1/pair', { code, device: 'Browser E2E', terms: { version: TERMS_VERSION, items: TERMS_ITEMS } });
  const owner = { ...paired, serverUrl: apiUrl, serverKey: serverIdentity(data).publicKey, serverName: 'App preview test' };
  const detail = await api('GET', `/v1/projects/${PROJECT}`, undefined, owner.token);
  assert.equal(detail.appPreview.path, `/a/${PROJECT}/`, 'the project says where its preview is');


  const webUrl = `http://127.0.0.1:${await freePort()}`;
  webServer = spawn(process.execPath, [path.join(repository, 'app/node_modules/expo/bin/cli'), 'start', '--web', '--localhost', '--port', new URL(webUrl).port], {
    cwd: path.join(repository, 'app'), env: { ...env, CI: '1', EXPO_NO_TELEMETRY: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const s of [webServer.stdout, webServer.stderr]) s.on('data', c => { webOutput = (webOutput + c).slice(-6000); });
  await waitFor(webUrl, webServer, 'Expo web');
  browser = await chromium.launch({ ...(process.env.SERVANT_E2E_BROWSER ? { channel: process.env.SERVANT_E2E_BROWSER } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2 });
  await context.addInitScript(saved => { try { if (window.top === window && !localStorage.getItem('servant.accounts')) localStorage.setItem('servant.account', JSON.stringify(saved)); } catch { /* the sandboxed preview has no storage */ } }, owner);
  const page = await context.newPage();
  page.setDefaultTimeout(60000);
  page.on('pageerror', e => pageErrors.push(e.message));
  const shot = name => page.screenshot({ path: path.join(artifacts, `${name}.png`) });
  // The ask's chat exists in the project while it's open (an unsent new chat goes away when it's left).
  const inProject = async chatId => {
    for (let n = 0; n < 40; n++) {
      const r = await testFetch(data, `${apiUrl}/v1/chats/${chatId}`, { headers: { Authorization: `Bearer ${owner.token}` } });
      if (r.ok) { const { chat } = await r.json(); assert.equal(chat.projectId, PROJECT, `chat ${chatId} is in the project`); return; }
      await delay(250);
    }
    assert.fail(`chat ${chatId} was never made`);
  };

  await page.goto(`${webUrl}/project?id=${PROJECT}&tab=chats`);
  const open = page.locator('[data-testid="open-app-preview"]:visible');
  await open.waitFor();
  await shot('1-project');
  await open.click();
  const frame = page.frameLocator('iframe[title="Example app preview"]');
  if (process.env.SERVANT_APP_PREVIEW_PATH) {
    await page.getByLabel('Go to a page in the app').filter({ visible: true }).fill(process.env.SERVANT_APP_PREVIEW_PATH);
    await page.getByLabel('Go to a page in the app').filter({ visible: true }).press('Enter');
  }
  const first = process.env.SERVANT_APP_PREVIEW_TEXT || 'Make a payment';
  await frame.getByText(first, { exact: true }).first().waitFor({ timeout: 90000 });
  await delay(1500);
  await shot('2-preview-use');

  // Comment mode: click the button; the box opens beside it; the ask lands in a new chat in this project.
  await page.locator('[data-testid="preview-mode-comment"]:visible').click();
  await delay(300);
  await frame.getByText(first, { exact: true }).first().click();
  const box = page.locator('[data-testid="preview-comment"]:visible');
  await box.waitFor();
  assert.match(await box.innerText(), new RegExp(`About "${first}"`), 'the box names what was clicked');
  assert.match(page.url(), /\/app-preview/, 'clicking in Comment mode does not use the app');
  await page.locator('[data-testid="preview-comment-text"]:visible').fill('Make this say Pay now');
  await shot('3-comment');
  await page.locator('[data-testid="preview-comment-send"]:visible').click();
  await page.waitForURL(/\/chat\//);
  await inProject(page.url().match(/\/chat\/(cht_[A-Za-z0-9_-]+)/)[1]);
  const composer = page.locator('textarea:visible').last();
  await composer.waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('textarea')].some(t => t.value.includes('Make this say Pay now')));
  const asked = await page.evaluate(() => [...document.querySelectorAll('textarea')].map(t => t.value).find(v => v.includes('Pay now')));
  assert.match(asked, /^Make this say Pay now\n/);
  assert.match(asked, new RegExp(`I pointed at (the [a-z ]+ )?"${first}"`));
  assert.match(asked, new RegExp(`Preview: ${apiUrl}/a/${PROJECT}/`));
  await delay(800);
  const box2 = await page.evaluate(() => { const t = [...document.querySelectorAll('textarea')].find(x => x.value.includes('Pay now')); return { client: t.clientHeight, scroll: t.scrollHeight }; });
  assert.ok(box2.client >= 120, `the message box grows to show the ask (${JSON.stringify(box2)})`);
  await shot('4-ask-in-chat');
  console.log('COMMENT ASK:\n' + asked + '\n');

  // Right-click works in Use mode too.
  await page.goBack();
  await frame.getByText(first, { exact: true }).first().waitFor({ timeout: 90000 });
  await page.locator('[data-testid="preview-mode-use"]:visible').click();
  await frame.getByText(first, { exact: true }).first().click({ button: 'right' });
  await box.waitFor();
  await page.getByRole('button', { name: 'Cancel', exact: true }).filter({ visible: true }).click();

  // Edit mode: change the words in place; the tray counts it; Send writes it out.
  await page.locator('[data-testid="preview-mode-edit"]:visible').click();
  await delay(300);
  await frame.getByText(first, { exact: true }).first().click();
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.type('Pay now');
  const tray = page.locator('[data-testid="preview-changes"]:visible');
  await tray.waitFor();
  assert.match(await tray.innerText(), /1 change/);
  await frame.getByText('Pay now', { exact: true }).first().waitFor({ timeout: 5000 }); // a space typed inside a button stays a space
  await delay(500);
  await shot('5-edit'); // still selected: the style bar shows above it
  await page.keyboard.press('Enter');
  await page.locator('[data-testid="preview-changes-send"]:visible').click();
  await page.waitForURL(/\/chat\//);
  await inProject(page.url().match(/\/chat\/(cht_[A-Za-z0-9_-]+)/)[1]);
  await page.waitForFunction(() => [...document.querySelectorAll('textarea')].some(t => t.value.includes('→ "Pay now"')));
  const edited = await page.evaluate(() => [...document.querySelectorAll('textarea')].map(t => t.value).find(v => v.includes('→ "Pay now"')));
  assert.match(edited, new RegExp(`- Words( \\([a-z ]+\\))?: "${first}" → "Pay now"`));
  await delay(800);
  await shot('6-edit-ask');
  console.log('EDIT ASK:\n' + edited + '\n');

  assert.deepEqual(pageErrors.filter(e => !/localStorage|sessionStorage/.test(e)), [], 'no page errors');
  console.log(`app-preview-e2e: OK (${artifacts})`);
} catch (error) {
  console.error(error);
  for (const p of browser?.contexts().flatMap(c => c.pages()) ?? []) {
    const f = p.frames()[1];
    if (f) console.error('FRAME ' + f.url() + ' :: ' + (await f.evaluate(() => document.body.innerText.slice(0, 400)).catch(e => 'ERR ' + e.message)).replace(/\n/g, ' | '));
    await p.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {});
    console.error('URL at failure: ' + p.url());
    console.error('Inputs: ' + JSON.stringify(await p.evaluate(() => [...document.querySelectorAll('textarea,input,[contenteditable]')].map(t => `${t.tagName}:${t.getAttribute('aria-label')}:${(t.value ?? t.textContent ?? '').slice(0, 80)}`)).catch(() => [])));
  }
  console.error('--- server ---\n' + serverOutput + '\n--- web ---\n' + webOutput.slice(-2000) + '\n--- page errors ---\n' + pageErrors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await stop(webServer); await stop(apiServer);
  hermes?.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
