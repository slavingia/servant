#!/usr/bin/env node
// Real public browser + Expo inbox -> encrypted API -> isolated SQLite.
// npm ci --prefix app && npm ci --prefix desktop
// cd desktop && npx playwright install chromium
// node scripts/secure-inbox-e2e.mjs
// SERVANT_E2E_BROWSER=chrome uses installed Chrome.
// SERVANT_INBOX_WEB_URL reuses an Expo server from this checkout.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
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
const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'servant-inbox-e2e-'));
fs.chmodSync(scratch, 0o700);
const artifacts = path.join(repository, 'desktop/dist/secure-inbox-e2e');
fs.mkdirSync(artifacts, { recursive: true });
const data = path.join(scratch, 'data');
const runtime = path.join(scratch, 'runtime');
for (const directory of [data, runtime]) fs.mkdirSync(directory, { mode: 0o700 });
const freePort = () => new Promise((resolve, reject) => {
  const listener = net.createServer();
  listener.on('error', reject);
  listener.listen(0, '127.0.0.1', () => {
    const port = listener.address().port;
    listener.close(() => resolve(port));
  });
});
const waitFor = async (url, child, label) => {
  for (let attempt = 0; attempt < 180; attempt++) {
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
const until = async (check, label) => {
  for (let n = 0; n < 80; n++) {
    if (await check()) return;
    await delay(250);
  }
  throw new Error(label);
};
const visitorText = 'Please review the example account update';
const visitorReply = 'Here are the details for the example request';
const staffReply = 'We reviewed your example request and attached the next steps';
const visitorBytes = Buffer.from('Synthetic visitor attachment: example account details.\n');
const staffBytes = Buffer.from('Synthetic staff attachment: example next steps.\n');
const visitorFile = { name: 'example-details.txt', mimeType: 'text/plain', buffer: visitorBytes };
const staffFile = { name: 'example-next-steps.txt', mimeType: 'text/plain', buffer: staffBytes };
let browser, apiServer, webServer, page;
let serverOutput = '', webOutput = '';
const pageErrors = [];
const externalRequests = [];
const outerRequests = [];

try {
  const port = await freePort();
  const apiUrl = `http://127.0.0.1:${port}`;
  const configPath = path.join(data, 'config.json');
  const cfg = {
    host: '127.0.0.1', port, name: 'Example secure inbox', publicUrl: apiUrl,
    discovery: 'off', discoveryUrl: '', upstreams: {},
    features: { secureInbox: true },
  };
  const configure = enabled => {
    cfg.features.secureInbox = enabled;
    fs.writeFileSync(configPath, JSON.stringify(cfg), { mode: 0o600 });
  };
  configure(true);
  const pushConfig = path.join(scratch, 'push-disabled.json');
  fs.writeFileSync(pushConfig, '{}\n', { mode: 0o600 });
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SERVANT_|HERMES_|API_SERVER_KEY$)/.test(key))),
    SERVANT_DATA_DIR: data, SERVANT_RUNTIME_DIR: runtime,
    SERVANT_HOST: '127.0.0.1', SERVANT_PORT: String(port), SERVANT_PUBLIC_URL: apiUrl,
    SERVANT_DISCOVERY_URL: '', SERVANT_PUSH_CONFIG: pushConfig,
    SERVANT_WORKER_MODE: 'external', SERVANT_SHUTDOWN_TIMEOUT_MS: '1000',
  };
  const serverEntry = path.join(repository, 'server/server.mjs');
  const startApi = async () => {
    apiServer = spawn(process.execPath, [serverEntry], { cwd: repository, env, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [apiServer.stdout, apiServer.stderr]) stream.on('data', chunk => { serverOutput = (serverOutput + chunk).slice(-6000); });
    await waitFor(`${apiUrl}/health`, apiServer, 'API server');
  };
  await startApi();
  const request = (method, route, body, token) => testFetch(data, apiUrl + route, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000),
  });
  const api = async (method, route, body, token) => {
    const response = await request(method, route, body, token);
    const json = await response.json();
    assert.ok(response.ok, `${method} ${route}: ${response.status} ${JSON.stringify(json)}`);
    return json;
  };
  const pair = async (name, role) => {
    const output = await run(process.execPath, [serverEntry, 'invite', '--name', name, '--role', role], { env });
    const code = output.stdout.match(/Invite code:\s*(\S+)/)?.[1];
    assert.ok(code, 'Fixture invite was created');
    const paired = await api('POST', '/v1/pair', { code, device: 'Browser E2E', terms: { version: TERMS_VERSION, items: TERMS_ITEMS } });
    return { ...paired, serverUrl: apiUrl, serverKey: serverIdentity(data).publicKey, serverName: cfg.name };
  };
  const owner = await pair('Pat Tester', 'owner');
  const member = await pair('Jo Park', 'member');
  const webUrl = process.env.SERVANT_INBOX_WEB_URL || `http://127.0.0.1:${await freePort()}`;
  if (!process.env.SERVANT_INBOX_WEB_URL) {
    webServer = spawn(process.execPath, [path.join(repository, 'app/node_modules/expo/bin/cli'), 'start', '--web', '--localhost', '--port', new URL(webUrl).port], {
      cwd: path.join(repository, 'app'), env: { ...env, CI: '1', EXPO_NO_TELEMETRY: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [webServer.stdout, webServer.stderr]) stream.on('data', chunk => { webOutput = (webOutput + chunk).slice(-6000); });
  }
  await waitFor(webUrl, webServer, 'Expo web');
  browser = await chromium.launch({ ...(process.env.SERVANT_E2E_BROWSER ? { channel: process.env.SERVANT_E2E_BROWSER } : {}) });
  const newPage = async (account, viewport = { width: 1280, height: 900 }) => {
    const context = await browser.newContext({ viewport });
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await context.route(/^https?:\/\//, route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin !== apiUrl && url.origin !== new URL(webUrl).origin) {
        externalRequests.push(url.origin);
        return route.abort('blockedbyclient');
      }
      if (url.origin === apiUrl && url.pathname === '/v1/secure') outerRequests.push({ body: request.postData() || '', headers: request.headers() });
      return route.continue();
    });
    if (account) await context.addInitScript(saved => {
      if (!localStorage.getItem('servant.accounts')) localStorage.setItem('servant.account', JSON.stringify(saved));
    }, account);
    const opened = await context.newPage();
    opened.setDefaultTimeout(30000);
    opened.on('pageerror', error => pageErrors.push(error.message));
    return opened;
  };
  const fillStart = async (visitor, name, subject, message) => {
    await visitor.goto(`${apiUrl}/contact`);
    await visitor.getByLabel('Your name', { exact: true }).fill(name);
    await visitor.getByLabel('Email (optional)', { exact: true }).fill('visitor@example.gov');
    await visitor.getByLabel('Subject', { exact: true }).fill(subject);
    await visitor.getByLabel('Message', { exact: true }).fill(message);
    await visitor.getByRole('button', { name: 'Start conversation', exact: true }).click();
    await visitor.getByText(message, { exact: true }).waitFor();
  };
  const attach = async (target, file) => {
    const input = target.locator('input[type=file]:visible');
    if (await input.count()) { await input.setInputFiles(file); return; }
    const chosen = target.waitForEvent('filechooser');
    await target.getByRole('button', { name: 'Attach files', exact: true }).click();
    await (await chosen).setFiles(file);
    await target.getByRole('button', { name: `Remove ${file.name}`, exact: true }).filter({ visible: true }).waitFor();
  };
  const download = async (target, file, bytes) => {
    const completed = target.waitForEvent('download');
    await target.getByRole('button', { name: `Download ${file}`, exact: true }).filter({ visible: true }).last().click();
    const transfer = await completed;
    assert.equal(transfer.suggestedFilename(), file);
    assert.deepEqual(fs.readFileSync(await transfer.path()), bytes, 'download preserves exact file bytes');
  };

  page = await newPage(undefined, { width: 390, height: 844 });
  const visitor = page;
  await fillStart(visitor, 'Ana Ruiz', 'Example account question', visitorText);
  await visitor.reload();
  await visitor.getByText(visitorText, { exact: true }).waitFor();
  assert.equal(await visitor.getByRole('button', { name: 'Start conversation', exact: true }).isVisible(), false, 'browser reload resumes the private conversation');
  await attach(visitor, visitorFile);
  await visitor.getByRole('textbox', { name: 'Reply', exact: true }).fill(visitorReply);
  await visitor.getByRole('button', { name: 'Send reply', exact: true }).click();
  await visitor.getByText(visitorReply, { exact: true }).waitFor();
  await visitor.screenshot({ path: path.join(artifacts, 'visitor-phone.png'), animations: 'disabled', fullPage: true });
  assert.ok(await visitor.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'public phone screen has no horizontal overflow');

  await visitor.getByRole('button', { name: 'Copy return link', exact: true }).click();
  const returnLink = await visitor.evaluate(() => navigator.clipboard.readText());
  assert.ok(returnLink.startsWith(`${apiUrl}/contact#resume=`));
  const guestToken = await visitor.evaluate(() => localStorage.getItem('servant.inbox.session.v1'));
  assert.ok(guestToken);
  const recovered = await newPage();
  await recovered.goto(returnLink);
  await recovered.getByText(visitorReply, { exact: true }).waitFor();
  assert.equal(new URL(recovered.url()).hash, '', 'recovery credential is removed from the address bar');
  await recovered.evaluate(() => localStorage.setItem('servant.inbox.key.v1', 'unexpected-key'));
  await recovered.reload();
  await recovered.getByRole('alert').filter({ hasText: 'encryption key has changed' }).waitFor();
  assert.ok(await recovered.getByRole('button', { name: 'Start conversation', exact: true }).isDisabled(), 'unexpected server key is refused');
  await recovered.context().close();

  const other = await newPage(undefined, { width: 390, height: 844 });
  await fillStart(other, 'Jo Park', 'Separate example question', 'A different private example conversation');
  assert.equal(await other.getByText(visitorText, { exact: true }).count(), 0, 'another browser sees only its own conversation');
  assert.equal(await other.getByText(visitorReply, { exact: true }).count(), 0);
  const otherToken = await other.evaluate(() => localStorage.getItem('servant.inbox.session.v1'));
  const deniedStaff = await request('GET', '/v1/inbox', undefined, guestToken);
  assert.equal(deniedStaff.status, 401, 'visitor capability never becomes a staff credential');
  const deniedPeople = await request('GET', '/v1/people', undefined, guestToken);
  assert.equal(deniedPeople.status, 401, 'visitor cannot enumerate team members');

  page = await newPage(owner);
  await page.goto(`${webUrl}/inbox`);
  const firstRow = page.getByRole('button', { name: /^Example account question, Ana Ruiz/ });
  await firstRow.waitFor();
  await page.getByRole('button', { name: 'Copy public link', exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `${apiUrl}/contact`, 'copied public entry uses the authoritative server URL');
  await firstRow.click();
  await page.getByText(visitorText, { exact: true }).filter({ visible: true }).waitFor();
  await page.getByText(visitorReply, { exact: true }).filter({ visible: true }).waitFor();
  const conversationId = new URL(page.url()).pathname.split('/').pop();
  assert.ok(conversationId && conversationId !== 'inbox');
  await download(page, visitorFile.name, visitorBytes);
  await page.getByRole('button', { name: 'Assign to me', exact: true }).click();
  await page.getByRole('button', { name: 'Unassign', exact: true }).waitFor();
  await attach(page, staffFile);
  await page.getByRole('textbox', { name: 'Reply', exact: true }).fill(staffReply);
  await page.getByRole('button', { name: 'Send reply', exact: true }).click();
  await page.getByText(staffReply, { exact: true }).filter({ visible: true }).waitFor();
  await visitor.getByText(staffReply, { exact: true }).waitFor();
  await download(visitor, staffFile.name, staffBytes);
  await page.screenshot({ path: path.join(artifacts, 'staff-thread-desktop.png'), animations: 'disabled' });
  const retryText = 'An example reply retained through a connection failure';
  await page.getByRole('textbox', { name: 'Reply', exact: true }).fill(retryText);
  await page.route(`${apiUrl}/v1/secure`, route => route.abort('connectionrefused'));
  await page.getByRole('button', { name: 'Send reply', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Your draft is kept' }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Reply', exact: true }).inputValue(), retryText, 'failed send preserves the authored draft');
  await page.unroute(`${apiUrl}/v1/secure`);
  await page.getByRole('button', { name: 'Send reply', exact: true }).click();
  await visitor.getByText(retryText, { exact: true }).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'staff desktop screen has no horizontal overflow');
  const staffState = () => api('GET', `/v1/inbox/${conversationId}`, undefined, owner.token);
  const shared = await api('GET', `/v1/inbox/${conversationId}`, undefined, member.token);
  assert.ok(shared.messages.some(message => message.text === staffReply), 'another staff member can handle the same shared conversation');
  assert.equal((await staffState()).conversation.assigneeId, owner.user.id);
  const firstAttachment = shared.messages.flatMap(message => message.attachments).find(file => file.name === visitorFile.name);
  assert.ok(firstAttachment);
  const deniedFile = await request('GET', `/v1/inbox/guest/files/${firstAttachment.id}`, undefined, otherToken);
  assert.equal(deniedFile.status, 404, 'file ID from another conversation cannot bypass visitor scope');

  await page.getByRole('button', { name: 'Resolve conversation', exact: true }).click();
  await page.getByRole('button', { name: 'Reopen conversation', exact: true }).waitFor();
  assert.equal((await staffState()).conversation.status, 'resolved');
  await visitor.getByRole('textbox', { name: 'Reply', exact: true }).fill('One more example detail after resolution');
  await visitor.getByRole('button', { name: 'Send reply', exact: true }).click();
  await page.getByRole('button', { name: 'Resolve conversation', exact: true }).waitFor();
  assert.equal((await staffState()).conversation.status, 'open', 'a visitor reply reopens resolved work');
  assert.equal(await other.getByText(staffReply, { exact: true }).count(), 0, 'staff response never leaks to another visitor');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(artifacts, 'staff-thread-phone.png'), animations: 'disabled' });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'staff phone screen has no horizontal overflow');
  await page.goto(`${webUrl}/inbox`);
  await firstRow.waitFor();
  await page.screenshot({ path: path.join(artifacts, 'staff-inbox-phone.png'), animations: 'disabled' });

  const beforeRestart = await staffState();
  await stop(apiServer);
  await startApi();
  await visitor.reload();
  await visitor.getByText(staffReply, { exact: true }).waitFor();
  await page.reload();
  await firstRow.waitFor();
  const afterRestart = await staffState();
  assert.deepEqual(afterRestart.messages, beforeRestart.messages, 'messages and attachments persist across server restart');
  await download(visitor, staffFile.name, staffBytes);

  configure(false);
  assert.equal((await fetch(`${apiUrl}/contact`)).status, 404, 'disabled feature closes public entry');
  const disabled = await request('GET', '/v1/inbox', undefined, owner.token);
  assert.equal(disabled.status, 404);
  assert.equal((await disabled.json()).error.code, 'feature_off');
  await page.reload();
  await until(async () => !(await page.getByRole('button', { name: 'Cases', exact: true }).isVisible()), 'disabled flag hides Cases navigation');
  configure(true);
  assert.deepEqual((await staffState()).messages, beforeRestart.messages, 'turning the flag off never deletes content');

  // Older synthetic records exercise real list pagination without spending the
  // public intake quota. Only INSERT is used; authored content stays immutable.
  const fixtureDb = new DatabaseSync(path.join(data, 'inbox.db'));
  try {
    fixtureDb.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    const insert = fixtureDb.prepare('INSERT INTO inbox_conversations (id,name,email,subject,token_hash,start_id,start_fingerprint,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)');
    const earlier = Date.now() - 86400000;
    for (let n = 1; n <= 101; n++) {
      const id = `older-example-${String(n).padStart(3, '0')}`;
      insert.run(id, 'Pat Tester', '', `Older example request ${n}`, `fixture-token-${id}`, `fixture-start-${id}`, 'fixture', earlier - n, earlier - n);
    }
    fixtureDb.exec('COMMIT');
  } finally { fixtureDb.close(); }
  await page.goto(`${webUrl}/inbox`);
  const olderRow = page.getByRole('button', { name: 'Older example request 101, Pat Tester', exact: true });
  const more = page.getByRole('button', { name: 'Load more cases', exact: true });
  await more.waitFor();
  assert.equal(await olderRow.count(), 0, 'oldest conversation is outside the initial page');
  await more.click();
  // FlatList virtualizes offscreen rows; scroll the actual list as a reader would.
  await page.mouse.move(200, 600);
  for (let attempt = 0; attempt < 25 && !(await olderRow.isVisible()); attempt++) {
    await page.mouse.wheel(0, 1500);
    await delay(100);
  }
  await olderRow.waitFor();
  assert.equal(await more.count(), 0, 'loading the final page removes Load more');
  const searchBox = page.getByRole('textbox', { name: 'Search cases', exact: true });
  for (let attempt = 0; attempt < 25 && !(await searchBox.isVisible()); attempt++) {
    await page.mouse.wheel(0, -1500);
    await delay(100);
  }
  await searchBox.fill('Older example request 101');
  await olderRow.waitFor();
  await until(async () => await page.getByRole('button', { name: /^Older example request / }).count() === 1, 'search filters the shared inbox');

  assert.ok(outerRequests.length > 10, 'both real clients exercised encrypted transport');
  for (const request of outerRequests) {
    assert.equal(request.headers.authorization, undefined, 'credentials never appear in the outer transport headers');
    const envelope = JSON.parse(request.body);
    assert.equal(envelope.v, 1);
    for (const secret of [visitorText, visitorReply, staffReply, visitorBytes.toString(), staffBytes.toString(), visitorBytes.toString('base64'), staffBytes.toString('base64'), 'visitor@example.gov', owner.token, guestToken, otherToken]) {
      assert.equal(request.body.includes(secret), false, 'outer transport never exposes fixture message, file or credential plaintext');
    }
  }
  assert.deepEqual(externalRequests, [], 'public and staff clients send no fixture data to external services');
  assert.deepEqual(pageErrors, [], 'no uncaught browser errors');
  console.log('secure inbox e2e: OK — public intake, separate visitors, browser resume/recovery, key pin refusal, live two-way replies and files, staff assignment/resolution, reopen on reply, failed-send draft, pagination/search, restart, feature flag, encrypted wire, desktop and phone');
  console.log(`Screenshots: ${artifacts}`);
} catch (error) {
  if (page) await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {});
  console.error(error);
  console.error('Server output:', serverOutput);
  console.error('Expo output:', webOutput);
  process.exitCode = 1;
} finally {
  await browser?.close();
  await stop(webServer);
  await stop(apiServer);
  fs.rmSync(scratch, { recursive: true, force: true });
}
