#!/usr/bin/env node
// Access tokens in the real Expo web UI against a temporary server: a person makes a token on You → Access tokens,
// the token is shown once, and it works from a shell: curl asks who it is, lists prototypes and sends one for
// review, all over plain HTTP with nothing but the token. Revoking it in the app stops it. Saves captures to
// docs/shots/access-tokens with the token itself masked.
// Run after npm ci --prefix app and npm ci --prefix desktop, then: cd desktop && npx playwright install chromium.
//   node scripts/access-tokens-e2e.mjs
// SERVANT_E2E_BROWSER=chrome uses installed Chrome. SERVANT_TOKENS_E2E_APP=<another checkout's app directory> with
// SERVANT_TOKENS_E2E_BEFORE=1 captures only You in that checkout, for a "before" picture. No live data is used.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(path.join(repository, 'desktop/package.json'));
const { chromium } = require('playwright');
const run = promisify(execFile);
const before = process.env.SERVANT_TOKENS_E2E_BEFORE === '1';
const appDir = process.env.SERVANT_TOKENS_E2E_APP || path.join(repository, 'app');
const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'servant-tokens-e2e-'));
process.env.SERVANT_DATA_DIR = scratch;
process.env.SERVANT_PUSH_CONFIG = path.join(scratch, 'push.json');
fs.writeFileSync(process.env.SERVANT_PUSH_CONFIG, '{}');
const shots = path.join(repository, 'docs/shots/access-tokens');
fs.mkdirSync(shots, { recursive: true });
const mail = [], pageErrors = [];
globalThis.__servantEmailSend = async message => { mail.push(message); };
const freePort = () => new Promise((resolve, reject) => { const l = net.createServer(); l.on('error', reject); l.listen(0, '127.0.0.1', () => { const port = l.address().port; l.close(() => resolve(port)); }); });
const FOLDER = 'proto-0123456789abcdef01';
let browser, server, webServer, webOutput = '';
try {
  const serverDir = path.join(path.dirname(appDir), 'server');
  const mod = await import(path.join(serverDir, 'server.mjs'));
  const { serverIdentity } = await import(path.join(serverDir, 'secure-transport.mjs'));
  const { TERMS_VERSION, TERMS_ITEMS } = await import(path.join(serverDir, 'terms.mjs'));
  const { ACCOUNTS_KEY, accountId, accountStorageKey } = await import(path.join(appDir, 'src/lib/accounts-store.ts'));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const config = { host: '127.0.0.1', port, name: 'Example team', agentName: 'Agent', publicUrl: base, discoveryUrl: '', adminKey: '',
    upstreams: { owner: { url: 'http://127.0.0.1:9', key: 'fixture-key' } }, emailVerification: { enabled: false, domains: ['example.gov'] }, accessTokens: { enabled: true } };
  fs.writeFileSync(path.join(scratch, 'config.json'), JSON.stringify(config));
  server = await mod.startServer(config);
  fs.mkdirSync(path.join(scratch, 'prototypes', FOLDER), { recursive: true });
  fs.writeFileSync(path.join(scratch, 'prototypes', FOLDER, 'index.html'), '<html><body><h1>Refund tracker</h1></body></html>');
  const pat = { id: 'usr_pat', name: 'Pat Tester', token: crypto.randomBytes(32).toString('base64url') };
  mod.mutateStateForTest(state => {
    state.users[pat.id] = { id: pat.id, name: pat.name, role: 'member', createdAt: Date.now(), agentTier: 2, termsAcceptances: [{ version: TERMS_VERSION, items: TERMS_ITEMS, acceptedAt: Date.now(), deviceId: 'dev_pat' }] };
    state.devices[crypto.createHash('sha256').update(pat.token).digest('hex')] = { id: 'dev_pat', userId: pat.id, label: 'Browser E2E', createdAt: Date.now(), lastSeenAt: Date.now() };
    state.chats.cht_proto = { id: 'cht_proto', userId: pat.id, title: 'Refund tracker', role: 'member', hermesSessionId: 'servant_usr_pat_cht_proto', mode: 'vibe', vibeFolder: FOLDER, hosted: 'server', createdAt: Date.now(), updatedAt: Date.now(), startedAt: Date.now() };
  });
  const webUrl = `http://127.0.0.1:${await freePort()}`;
  webServer = spawn(process.execPath, [path.join(appDir, 'node_modules/expo/bin/cli'), 'start', '--web', '--localhost', '--port', new URL(webUrl).port, ...(process.env.SERVANT_TOKENS_E2E_CLEAR === '1' ? ['--clear'] : [])], { cwd: appDir, env: { ...process.env, CI: '1', EXPO_NO_TELEMETRY: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  webServer.stdout.on('data', chunk => { webOutput += chunk; });
  webServer.stderr.on('data', chunk => { webOutput += chunk; });
  for (let i = 0; ; i++) {
    if (webServer.exitCode !== null) throw new Error(`Expo web exited with ${webServer.exitCode}`);
    try { if ((await fetch(webUrl, { signal: AbortSignal.timeout(1000) })).ok) break; } catch { /* starting */ }
    if (i > 480) throw new Error('Expo web did not become ready');
    await delay(250);
  }
  const account = { token: pat.token, user: { id: pat.id, name: pat.name, role: 'member' }, server: { name: 'Example team' }, serverUrl: base, serverKey: serverIdentity(scratch).publicKey, serverName: 'Example team' };
  browser = await chromium.launch({ ...(process.env.SERVANT_E2E_BROWSER ? { channel: process.env.SERVANT_E2E_BROWSER } : {}) });
  const open = async (viewport, route) => {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] });
    const id = accountId(account);
    await context.addInitScript(({ saved, key, indexKey, id }) => { try { localStorage.setItem(key, JSON.stringify(saved)); localStorage.setItem(indexKey, JSON.stringify({ version: 1, ids: [id], activeId: id })); } catch { /* a sandboxed frame */ } },
      { saved: account, key: accountStorageKey(id), indexKey: ACCOUNTS_KEY, id });
    const page = await context.newPage();
    page.setDefaultTimeout(90000);
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(`${webUrl}${route}`);
    return page;
  };
  const phone = { width: 390, height: 844 }, desktop = { width: 1280, height: 900 };
  if (before) {
    const you = await open(phone, '/you');
    await you.getByText('Connections', { exact: true }).first().scrollIntoViewIfNeeded();
    await you.screenshot({ path: path.join(shots, 'before-you-phone.png'), animations: 'disabled' });
    console.log(`access-tokens-e2e: before capture saved in ${path.relative(repository, shots)}`);
  } else {
    // You lists Access tokens.
    const you = await open(phone, '/you');
    await you.getByText('Access tokens', { exact: true }).first().scrollIntoViewIfNeeded();
    await you.screenshot({ path: path.join(shots, 'you-phone.png'), animations: 'disabled' });

    // Make one. It is shown once, with the lines for a shell.
    const page = await open(desktop, '/access-tokens');
    await page.getByTestId('token-create').click();
    await page.getByText('Name the token after where you will use it, for example Work laptop', { exact: true }).waitFor();
    await page.getByTestId('token-name').fill('Work laptop');
    await page.getByTestId('token-days-30').click();
    await page.screenshot({ path: path.join(shots, 'new-desktop.png'), animations: 'disabled' });
    await page.getByTestId('token-create').click();
    await page.getByTestId('token-made').waitFor();
    const token = (await page.getByTestId('token-value').innerText()).trim();
    assert.match(token, /^svt_[A-Za-z0-9_-]{43}$/);
    assert.equal(await page.getByTestId('token-setup').innerText(), `$env:SERVANT_TOKEN = "${token}"\n$Servant = "${base}/api/v1"\n$Headers = @{ Authorization = "Bearer $env:SERVANT_TOKEN" }\nInvoke-RestMethod "$Servant/me" -Headers $Headers`);
    // The captures never show the token: both places it appears are covered.
    const hidden = { mask: [page.getByTestId('token-value'), page.getByTestId('token-setup')], animations: 'disabled' };
    await page.screenshot({ path: path.join(shots, 'made-desktop.png'), ...hidden });
    await page.getByTestId('token-copy').click();
    await page.getByText('Token copied', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), token);
    await page.getByTestId('token-done').click();
    await page.getByTestId('token-made').waitFor({ state: 'detached' });
    assert.equal((await page.content()).includes(token), false, 'once put away, the token is nowhere on the page');
    await page.getByText(/Ends .* · never used/).waitFor();
    await page.screenshot({ path: path.join(shots, 'list-desktop.png'), animations: 'disabled' });

    // From a shell, with nothing but the token: who am I, what prototypes are there, send one for review.
    const curl = async (...args) => JSON.parse((await run('curl', ['-s', '-H', `Authorization: Bearer ${token}`, ...args])).stdout);
    assert.deepEqual(await curl(`${base}/api/v1/me`), { name: 'Pat Tester', role: 'member', server: 'Example team' });
    const found = await curl(`${base}/api/v1/prototypes?q=refund`);
    assert.deepEqual(found.prototypes.map(p => [p.id, p.title, p.canShare]), [['cht_proto', 'Refund tracker', true]]);
    const sent = await curl('-X', 'POST', '-H', 'Content-Type: application/json', '-d', JSON.stringify({ emails: ['jo.park@example.gov', 'sam.lee@example.gov'] }), `${base}/api/v1/prototypes/cht_proto/shares`);
    assert.deepEqual(sent.results.map(r => [r.email, r.sent]), [['jo.park@example.gov', true], ['sam.lee@example.gov', true]]);
    assert.deepEqual(mail.map(m => [m.to, m.subject]), [['jo.park@example.gov', 'Pat Tester shared a prototype with you: Refund tracker'], ['sam.lee@example.gov', 'Pat Tester shared a prototype with you: Refund tracker']]);
    const guide = (await run('curl', ['-s', `${base}/api/v1`])).stdout;
    assert.match(guide, /^# Example team: using Servant from a shell/);
    fs.writeFileSync(path.join(shots, 'shell.txt'), [`$ curl -s -H "Authorization: Bearer $SERVANT_TOKEN" ${'https://team.example.gov'}/api/v1/me`, JSON.stringify(await curl(`${base}/api/v1/me`)), '',
      `$ curl -s -H "Authorization: Bearer $SERVANT_TOKEN" "https://team.example.gov/api/v1/prototypes?q=refund"`, JSON.stringify({ prototypes: found.prototypes.map(({ url, updatedAt, ...rest }) => rest) }), '',
      `$ curl -s -X POST -H "Authorization: Bearer $SERVANT_TOKEN" -H "Content-Type: application/json" -d '{"emails":["jo.park@example.gov","sam.lee@example.gov"]}' https://team.example.gov/api/v1/prototypes/cht_proto/shares`, JSON.stringify(sent).replace(/http:\/\/127\.0\.0\.1:\d+/g, 'https://team.example.gov').replace(/\/review\/[A-Za-z0-9_-]+/g, '/review/<link>'), ''].join('\n'));

    // The app shows it was used; revoking it stops the shell at once.
    await page.reload();
    await page.getByText(/last used/).waitFor();
    const id = (await page.locator('[data-testid^="token-revoke-"]').first().getAttribute('data-testid')).replace('token-revoke-', '');
    await page.getByTestId(`token-revoke-${id}`).click();
    await page.getByRole('button', { name: 'Revoke', exact: true }).last().click();
    await page.getByText(/^svt_.* · Revoked /).waitFor();
    assert.equal((await curl(`${base}/api/v1/me`)).error.code, 'unauthorized');
    await page.screenshot({ path: path.join(shots, 'revoked-desktop.png'), animations: 'disabled' });
    assert.deepEqual(pageErrors, [], 'no page errors');
    console.log(`access-tokens-e2e: OK, captures saved in ${path.relative(repository, shots)}`);
  }
} catch (error) {
  console.error(error);
  if (webOutput) console.error('--- web ---\n' + webOutput.slice(-1200));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  if (webServer && webServer.exitCode === null) { webServer.kill('SIGTERM'); await Promise.race([new Promise(resolve => webServer.once('exit', resolve)), delay(1500)]); if (webServer.exitCode === null) webServer.kill('SIGKILL'); }
  await server?.shutdown?.().catch(() => {});
  delete globalThis.__servantEmailSend;
  fs.rmSync(scratch, { recursive: true, force: true });
}
