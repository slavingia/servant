#!/usr/bin/env node
// The org chart in People, in the real Expo web UI against a temporary server: managers, "Invite your manager",
// and an owner handing someone to another manager. Saves captures to docs/shots/org-chart.
// Run after npm ci --prefix app and npm ci --prefix desktop, then: cd desktop && npx playwright install chromium.
//   node scripts/org-chart-e2e.mjs
// SERVANT_E2E_BROWSER=chrome uses installed Chrome. SERVANT_ORG_E2E_APP=<another checkout's app directory> with
// SERVANT_ORG_E2E_BEFORE=1 captures only the People list of that checkout, for a "before" picture. No live data is used.
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
import { serverIdentity } from '../server/secure-transport.mjs';
import { testFetch } from '../server/encrypted-test-client.mjs';
import { TERMS_VERSION, TERMS_ITEMS } from '../server/terms.mjs';
import { ACCOUNTS_KEY, accountId, accountStorageKey } from '../app/src/lib/accounts-store.ts';

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(path.join(repository, 'desktop/package.json'));
const { chromium } = require('playwright');
const run = promisify(execFile);
const before = process.env.SERVANT_ORG_E2E_BEFORE === '1';
const appDir = process.env.SERVANT_ORG_E2E_APP || path.join(repository, 'app');
const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'servant-org-e2e-'));
const shots = path.join(repository, 'docs/shots/org-chart');
fs.mkdirSync(shots, { recursive: true });
const data = path.join(scratch, 'data');
fs.mkdirSync(data, { mode: 0o700 });
const freePort = () => new Promise((resolve, reject) => {
  const listener = net.createServer();
  listener.on('error', reject);
  listener.listen(0, '127.0.0.1', () => { const port = listener.address().port; listener.close(() => resolve(port)); });
});
const waitFor = async (url, child, label) => {
  for (let i = 0; i < 240; i++) {
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
let browser, apiServer, webServer;
let serverOutput = '', webOutput = '';
const pageErrors = [];
try {
  const port = await freePort();
  const apiUrl = `http://127.0.0.1:${port}`;
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ name: 'Example team', publicUrl: apiUrl, discovery: 'off', discoveryUrl: '', upstreams: {} }));
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
  const account = paired => ({ ...paired, serverUrl: apiUrl, serverKey: serverIdentity(data).publicKey, serverName: 'Example team' });
  const pair = async (name, role) => {
    const output = await run(process.execPath, [serverEntry, 'invite', '--name', name, '--role', role], { env });
    const code = output.stdout.match(/Invite code:\s*(\S+)/)?.[1];
    assert.ok(code, 'Fixture invite was created');
    return account(await api('POST', '/v1/pair', { code, device: 'Browser E2E', terms: { version: TERMS_VERSION, items: TERMS_ITEMS } }));
  };
  // Ana (owner) > Jo > Pat and Sam; Riley reports straight to Ana.
  const ana = await pair('Ana Ruiz', 'owner');
  const jo = await pair('Jo Park', 'member');
  const pat = await pair('Pat Tester', 'member');
  const sam = await pair('Sam Lee', 'member');
  await pair('Riley Kim', 'member');
  for (const person of [pat, sam]) await api('PUT', `/v1/people/${person.user.id}/manager`, { managerId: jo.user.id }, ana.token);

  const webUrl = `http://127.0.0.1:${await freePort()}`;
  webServer = spawn(process.execPath, [path.join(appDir, 'node_modules/expo/bin/cli'), 'start', '--web', '--localhost', '--port', new URL(webUrl).port], {
    cwd: appDir, env: { ...env, CI: '1', EXPO_NO_TELEMETRY: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  webServer.stdout.on('data', chunk => { webOutput += chunk; });
  webServer.stderr.on('data', chunk => { webOutput += chunk; });
  await waitFor(webUrl, webServer, 'Expo web');
  browser = await chromium.launch({ ...(process.env.SERVANT_E2E_BROWSER ? { channel: process.env.SERVANT_E2E_BROWSER } : {}) });
  const newPage = async (who, viewport) => {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
    const id = accountId(who);
    await context.addInitScript(({ saved, key, indexKey, id }) => {
      localStorage.setItem(key, JSON.stringify(saved));
      localStorage.setItem(indexKey, JSON.stringify({ version: 1, ids: [id], activeId: id }));
    }, { saved: who, key: accountStorageKey(id), indexKey: ACCOUNTS_KEY, id });
    const opened = await context.newPage();
    opened.setDefaultTimeout(60000);
    opened.on('pageerror', error => pageErrors.push(error.message));
    await opened.goto(`${webUrl}/members`);
    await opened.getByText('Riley Kim', { exact: true }).first().waitFor();
    return opened;
  };
  const shot = (page, name) => page.screenshot({ path: path.join(shots, name), animations: 'disabled' });
  const phone = { width: 390, height: 844 }, desktop = { width: 1280, height: 900 };

  if (before) {
    await shot(await newPage(pat, phone), 'before-people-phone.png');
    await shot(await newPage(ana, desktop), 'before-people-desktop.png');
    console.log(`org-chart-e2e: before captures saved in ${path.relative(repository, shots)}`);
  } else {
    // A member on a phone: the chart, who they report to, and inviting a manager who isn't here yet.
    const member = await newPage(sam, phone);
    await member.getByRole('tab', { name: 'Org chart', exact: true }).click();
    await member.getByTestId('my-manager').waitFor();
    assert.equal(await member.getByTestId('my-manager').innerText(), 'You report to Jo Park. They decide what your agent may reach.');
    assert.equal(await member.getByTestId(`org-line-${jo.user.id}`).innerText(), 'Reports to Ana Ruiz · 2 reports');
    assert.equal(await member.getByTestId(`org-line-${pat.user.id}`).innerText(), 'Reports to Jo Park');
    const names = await member.locator('[data-testid^="org-line-"]').evaluateAll(nodes => nodes.map(n => n.getAttribute('data-testid')));
    assert.deepEqual(names, [ana, jo, pat, sam].map(p => `org-line-${p.user.id}`).concat(names.slice(4)), 'each manager is followed by their reports');
    assert.equal(await member.getByRole('button', { name: 'Actions for Pat Tester' }).count(), 0, 'a member who manages nobody has no sheet for anyone');
    await shot(member, 'org-chart-phone.png');
    await member.getByTestId('invite-manager').click();
    await shot(member, 'invite-manager-name-phone.png');
    await member.getByTestId('make-manager-invite').click();
    await member.getByText("Enter your manager's name", { exact: true }).waitFor();
    await member.getByTestId('manager-name').fill('Lee Chen');
    await member.getByTestId('make-manager-invite').click();
    const link = await member.getByTestId('manager-link').innerText();
    assert.match(link, /^https?:\/\//, 'the dialog shows a link to send');
    // No capture of this step: the link carries an invite code, and codes stay out of the repository even when they are fixtures.
    // Lee joins with that link and is Sam's manager at once, reporting to the owner.
    const code = new URL(link).searchParams.get('code') || new URL(link).hash.match(/code=([^&]+)/)?.[1] || link.match(/[?&#]code=([^&]+)/)?.[1];
    assert.ok(code, `the link carries an invite code: ${link}`);
    const lee = account(await api('POST', '/v1/pair', { code: decodeURIComponent(code), device: 'Browser E2E', terms: { version: TERMS_VERSION, items: TERMS_ITEMS } }));
    assert.equal(lee.user.name, 'Lee Chen');
    await member.getByRole('button', { name: 'Done', exact: true }).click();
    await member.reload();
    await member.getByRole('tab', { name: 'Org chart', exact: true }).click();
    await member.getByText('You report to Lee Chen. They decide what your agent may reach.', { exact: true }).waitFor();
    await shot(member, 'org-chart-after-invite-phone.png');

    // A manager who isn't an owner: a sheet for their report with the manager choice and nothing else.
    const manager = await newPage(jo, phone);
    await manager.getByRole('tab', { name: 'Org chart', exact: true }).click();
    await manager.getByRole('button', { name: 'Actions for Pat Tester', exact: true }).click();
    await manager.getByRole('radio', { name: 'Jo Park manages Pat Tester', exact: true }).waitFor();
    assert.equal(await manager.getByText('What their agent can do', { exact: true }).count(), 0, "a manager can't change the role");
    assert.equal(await manager.getByRole('button', { name: 'Remove Pat Tester' }).count(), 0, "or remove anyone");
    await shot(manager, 'manager-sheet-phone.png');

    // The owner on a wide screen: the whole chart, then Pat handed from Jo to Riley.
    const owner = await newPage(ana, desktop);
    await owner.getByRole('tab', { name: 'Org chart', exact: true }).click();
    await owner.getByTestId(`org-line-${jo.user.id}`).waitFor();
    await shot(owner, 'org-chart-desktop.png');
    await owner.getByRole('button', { name: 'Actions for Pat Tester', exact: true }).click();
    await owner.getByRole('button', { name: /^Manager/ }).click();
    assert.equal(await owner.getByRole('radio', { name: 'Jo Park manages Pat Tester', exact: true }).getAttribute('aria-checked'), 'true');
    await shot(owner, 'manager-sheet-desktop.png');
    await owner.getByRole('radio', { name: 'Riley Kim manages Pat Tester', exact: true }).click();
    await owner.getByRole('radio', { name: 'Riley Kim manages Pat Tester', exact: true, checked: true }).waitFor();
    await owner.getByRole('button', { name: 'Done', exact: true }).click();
    await owner.getByText('Reports to Riley Kim', { exact: true }).waitFor();
    const list = (await api('GET', '/v1/people', undefined, ana.token)).people;
    assert.equal(list.find(p => p.name === 'Pat Tester').managerId, list.find(p => p.name === 'Riley Kim').id, 'the server has the new manager');
    assert.deepEqual(pageErrors, [], 'no page errors');
    console.log(`org-chart-e2e: OK, captures saved in ${path.relative(repository, shots)}`);
  }
} catch (error) {
  console.error(error);
  if (serverOutput) console.error('--- server ---\n' + serverOutput.slice(-2000));
  if (webOutput) console.error('--- web ---\n' + webOutput.slice(-1500));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await stop(webServer); await stop(apiServer);
  fs.rmSync(scratch, { recursive: true, force: true });
}
