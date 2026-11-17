#!/usr/bin/env node
// The Entitlements screen in the real Expo web UI against a temporary server: an owner makes one, a person asks and
// confirms, their manager can't grant what they don't hold, the owner grants the manager, the manager grants the
// person, and the owner takes it back. Then a built-in entitlement: the agent's first try asks the manager, who
// allows it once and then always. Saves captures to docs/shots/entitlements.
// Run after npm ci --prefix app and npm ci --prefix desktop, then: cd desktop && npx playwright install chromium.
//   node scripts/entitlements-e2e.mjs
// SERVANT_E2E_BROWSER=chrome uses installed Chrome. SERVANT_ENT_E2E_APP=<another checkout's app directory> with
// SERVANT_ENT_E2E_BEFORE=1 captures only You in that checkout, for a "before" picture. No live data is used.
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
import { createEgressStore } from '../server/egress.mjs';
import { testFetch } from '../server/encrypted-test-client.mjs';
import { TERMS_VERSION, TERMS_ITEMS } from '../server/terms.mjs';
import { ACCOUNTS_KEY, accountId, accountStorageKey } from '../app/src/lib/accounts-store.ts';

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(path.join(repository, 'desktop/package.json'));
const { chromium } = require('playwright');
const run = promisify(execFile);
const before = process.env.SERVANT_ENT_E2E_BEFORE === '1';
const appDir = process.env.SERVANT_ENT_E2E_APP || path.join(repository, 'app');
const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'servant-entitlements-e2e-'));
const shots = path.join(repository, 'docs/shots/entitlements');
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
  const door = await freePort();
  // Built-in entitlements are checked; the network gate stays off. The agent's bridge asks at this local port.
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ name: 'Example team', publicUrl: apiUrl, discovery: 'off', discoveryUrl: '', upstreams: {},
    agentCapabilities: { mode: 'ask', waitSeconds: 0 }, agentEgress: { port: door } }));
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
  // Ana (owner) > Jo > Pat.
  const ana = await pair('Ana Ruiz', 'owner');
  const jo = await pair('Jo Park', 'member');
  const pat = await pair('Pat Tester', 'member');
  await api('PUT', `/v1/people/${pat.user.id}/manager`, { managerId: jo.user.id }, ana.token);

  const webUrl = `http://127.0.0.1:${await freePort()}`;
  webServer = spawn(process.execPath, [path.join(appDir, 'node_modules/expo/bin/cli'), 'start', '--web', '--localhost', '--port', new URL(webUrl).port], {
    cwd: appDir, env: { ...env, CI: '1', EXPO_NO_TELEMETRY: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  webServer.stdout.on('data', chunk => { webOutput += chunk; });
  webServer.stderr.on('data', chunk => { webOutput += chunk; });
  await waitFor(webUrl, webServer, 'Expo web');
  browser = await chromium.launch({ ...(process.env.SERVANT_E2E_BROWSER ? { channel: process.env.SERVANT_E2E_BROWSER } : {}) });
  const newPage = async (who, viewport, route = '/entitlements') => {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
    const id = accountId(who);
    await context.addInitScript(({ saved, key, indexKey, id }) => {
      localStorage.setItem(key, JSON.stringify(saved));
      localStorage.setItem(indexKey, JSON.stringify({ version: 1, ids: [id], activeId: id }));
    }, { saved: who, key: accountStorageKey(id), indexKey: ACCOUNTS_KEY, id });
    const opened = await context.newPage();
    opened.setDefaultTimeout(60000);
    opened.on('pageerror', error => pageErrors.push(error.message));
    await opened.goto(`${webUrl}${route}`);
    return opened;
  };
  const shot = (page, name) => page.screenshot({ path: path.join(shots, name), animations: 'disabled' });
  const phone = { width: 390, height: 844 }, desktop = { width: 1280, height: 900 };
  const text = (page, id) => page.getByTestId(id).innerText();

  if (before) {
    const you = await newPage(pat, phone, '/you');
    await you.getByText('Agent usage', { exact: true }).first().waitFor();
    await you.getByText('Agent usage', { exact: true }).first().scrollIntoViewIfNeeded();
    await shot(you, 'before-you-phone.png');
    console.log(`entitlements-e2e: before capture saved in ${path.relative(repository, shots)}`);
  } else {
    // You lists Entitlements.
    const you = await newPage(pat, phone, '/you');
    await you.getByRole('link', { name: /Entitlements/ }).or(you.getByRole('button', { name: /Entitlements/ })).first().scrollIntoViewIfNeeded();
    await shot(you, 'you-phone.png');

    // The owner makes one. With nothing yet, the page says so, and says the gate is off.
    const owner = await newPage(ana, desktop);
    await owner.getByTestId('gate-state').waitFor();
    assert.match(await text(owner, 'gate-state'), /^The network gate is off, so nothing is blocked yet\./);
    assert.match(await text(owner, 'checks-state'), /^Built-in entitlements are checked/);
    await owner.getByTestId('none-of-your-own').waitFor();
    for (const [key, name] of [['fs-read', 'Filesystem read'], ['fs-write', 'Filesystem write'], ['github-read', 'GitHub read'], ['github-write', 'GitHub write']]) {
      assert.match(await text(owner, `entitlement-native-${key}`), new RegExp(`^${name} · Built in`));
    }
    assert.equal(await owner.getByTestId('retire-native-github-write').count(), 0, "a built-in entitlement can't be retired");
    await shot(owner, 'owner-empty-desktop.png');
    await owner.getByTestId('new-entitlement').click();
    await owner.getByTestId('draft-save').click();
    await owner.getByText('Give the entitlement a name', { exact: true }).waitFor();
    await owner.getByTestId('draft-name').fill('Tax data API');
    await owner.getByTestId('draft-description').fill('Read-only tax data for the example app');
    await owner.getByTestId('draft-hosts').fill('https://API.example.gov/v1\n*.data.example.gov');
    await shot(owner, 'owner-new-desktop.png');
    await owner.getByTestId('draft-save').click();
    await owner.getByText('Opens api.example.gov, *.data.example.gov', { exact: true }).waitFor();
    const made = (await api('GET', '/v1/entitlements', undefined, ana.token)).entitlements.find(e => e.name === 'Tax data API');
    const id = made.id;
    assert.deepEqual(made.hosts, ['api.example.gov', '*.data.example.gov'], 'a pasted address is saved as its host');

    // Pat asks: the confirmation has to be ticked.
    const person = await newPage(pat, phone);
    await person.getByTestId(`ask-${id}`).click();
    await person.getByTestId('ask-send').click();
    await person.getByText('Tick the box to confirm before you ask', { exact: true }).waitFor();
    await person.getByTestId('ask-confirm').click();
    await person.getByTestId('ask-note').fill('I work on the example app');
    await shot(person, 'ask-phone.png');
    await person.getByTestId('ask-send').click();
    await person.getByTestId(`standing-${id}`).waitFor();
    assert.equal(await text(person, `standing-${id}`), 'Waiting for Jo Park');
    assert.equal(await person.getByTestId(`ask-${id}`).count(), 0, 'no asking twice');
    await shot(person, 'waiting-phone.png');

    // Jo is Pat's manager and sees the request, but can't hand on what Jo doesn't hold.
    const manager = await newPage(jo, phone);
    await manager.getByTestId(`request-${id}-${pat.user.id}`).waitFor();
    await manager.getByText('"I work on the example app"', { exact: true }).waitFor();
    await manager.getByTestId(`grant-${id}-${pat.user.id}`).click();
    await manager.getByText('You can only grant what you hold yourself. Ask for Tax data API first, or leave this one to an owner', { exact: true }).waitFor();
    await shot(manager, 'manager-not-held-phone.png');
    await manager.getByTestId(`ask-${id}`).click();
    await manager.getByTestId('ask-confirm').click();
    await manager.getByTestId('ask-send').click();
    await manager.getByTestId(`standing-${id}`).waitFor();

    // The owner sees both requests (an owner can decide for anyone) and grants Jo's.
    await owner.reload();
    await owner.getByText('Waiting on you (2)', { exact: true }).waitFor();
    await shot(owner, 'owner-waiting-desktop.png');
    await owner.getByTestId(`grant-${id}-${jo.user.id}`).click();
    await owner.getByText('Waiting on you (1)', { exact: true }).waitFor();
    await owner.getByText('Jo Park has this', { exact: true }).waitFor();

    // Now Jo can grant Pat, and Pat has it.
    await manager.reload();
    await manager.getByTestId(`grant-${id}-${pat.user.id}`).click();
    await manager.getByText('Pat Tester has this', { exact: true }).waitFor();
    assert.equal(await text(manager, `standing-${id}`), 'You have this');
    await shot(manager, 'manager-granted-phone.png');
    await person.reload();
    await person.getByText('You have this', { exact: true }).waitFor();
    await shot(person, 'granted-phone.png');

    // The owner takes it back from Pat, after a confirmation.
    await owner.reload();
    await owner.getByTestId(`revoke-${id}-${pat.user.id}`).click();
    await owner.getByText('Take Tax data API back from Pat Tester?', { exact: true }).waitFor();
    await owner.getByRole('button', { name: 'Take back', exact: true }).last().click();
    await owner.getByText('Pat Tester has this', { exact: true }).waitFor({ state: 'detached' });
    await person.reload();
    await person.getByTestId(`standing-${id}`).waitFor();
    assert.equal(await text(person, `standing-${id}`), 'Taken back');
    assert.equal(await text(person, `ask-${id}`), 'Ask again');
    const after = (await api('GET', '/v1/entitlements', undefined, ana.token)).entitlements.find(e => e.id === id).people;
    assert.deepEqual(after.map(p => [p.name, p.status]).sort(), [['Jo Park', 'granted'], ['Pat Tester', 'revoked']]);

    // A built-in entitlement. What the agent's bridge does before a tool call: ask the server's local listener, with
    // the turn's token. Pat's agent is about to push.
    const tokens = createEgressStore(path.join(data, 'egress.db'));
    const patToken = tokens.tokenFor(pat.user.id, 'chat_e2e');
    tokens.close();
    const tries = async (needs, detail) => (await fetch(`http://127.0.0.1:${door}/use`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: patToken, needs, detail }) })).json();
    const github = 'native-github-write';
    assert.equal((await tries(['github-write'], 'Run: git push origin main')).verdict, 'wait', "the agent is told to wait for Pat's manager");
    // Jo is Pat's manager and doesn't hold GitHub write, so it falls to the owner.
    await owner.reload();
    await owner.getByTestId(`request-${github}-${pat.user.id}`).waitFor();
    await owner.getByText("Pat Tester's agent needs GitHub write", { exact: true }).waitFor();
    assert.equal(await text(owner, `detail-${github}-${pat.user.id}`), 'Run: git push origin main');
    await shot(owner, 'built-in-request-desktop.png');
    await owner.getByTestId(`once-${github}-${pat.user.id}`).click();
    await owner.getByTestId(`request-${github}-${pat.user.id}`).waitFor({ state: 'detached' });
    assert.equal((await tries(['github-write'], 'Run: git push origin main')).verdict, 'allow', 'allowed once: this push goes ahead');
    assert.equal((await tries(['github-write'], 'Run: gh pr merge 12')).verdict, 'wait', 'the next one asks again');
    const manager2 = await newPage(ana, phone);
    await manager2.getByTestId(`request-${github}-${pat.user.id}`).waitFor();
    assert.equal(await text(manager2, `detail-${github}-${pat.user.id}`), 'Run: gh pr merge 12');
    await manager2.getByTestId(`request-${github}-${pat.user.id}`).scrollIntoViewIfNeeded();
    await shot(manager2, 'built-in-request-phone.png');
    await manager2.getByTestId(`grant-${github}-${pat.user.id}`).click();
    await manager2.getByText('Pat Tester has this', { exact: true }).waitFor();
    for (const detail of ['Run: gh pr merge 12', 'Run: git push']) assert.equal((await tries(['github-write'], detail)).verdict, 'allow', 'allowed always');
    assert.equal((await tries(['github-read'], 'Run: gh pr list')).verdict, 'allow', 'write covers read');
    await person.reload();
    await person.getByTestId(`standing-${github}`).waitFor();
    assert.equal(await text(person, `standing-${github}`), 'You have this');
    await person.getByTestId(`standing-${github}`).scrollIntoViewIfNeeded();
    await shot(person, 'built-in-granted-phone.png');
    const record = (await api('GET', `/v1/entitlements/${github}/history`, undefined, ana.token)).history.filter(h => h.userId === pat.user.id).reverse();
    assert.deepEqual(record.map(h => h.action), ['requested', 'once', 'used', 'requested', 'granted'], 'every step is on the record');
    // The owner's page lists what the agent did and was stopped from doing.
    await owner.reload();
    await owner.getByText('Agent activity', { exact: true }).waitFor();
    const lines = await owner.locator('[data-testid^="action-"]').allInnerTexts();
    assert.match(lines[0], /^Pat Tester: Run: gh pr list\nAllowed · GitHub read · /, 'newest first');
    assert.ok(lines.some(l => /^Pat Tester: Run: git push origin main\nAllowed once · GitHub write · /.test(l)), 'the single allowance is on the list');
    assert.ok(lines.some(l => /^Pat Tester: Run: git push origin main\nWaiting for an answer · GitHub write · /.test(l)), 'so is the try that had to wait');
    await owner.getByText('Agent activity', { exact: true }).scrollIntoViewIfNeeded();
    await shot(owner, 'agent-activity-desktop.png');
    assert.deepEqual(pageErrors, [], 'no page errors');
    console.log(`entitlements-e2e: OK, captures saved in ${path.relative(repository, shots)}`);
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
