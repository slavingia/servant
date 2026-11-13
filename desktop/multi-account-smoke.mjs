#!/usr/bin/env node
// No screenshots or live servers. Exercises the actual isolated Electron IPC
// bridge and Keychain encryption with the same account store as the app.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { accountId, accountStorageKey, createAccountsStore } from '../app/src/lib/accounts-store.ts';
import { accountFileName } from './policy.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-multi-account-'));
const appPath = path.join(scratch, 'app');
const profile = path.join(scratch, 'profile');
fs.mkdirSync(path.join(appPath, 'web'), { recursive: true });
for (const name of ['main.mjs', 'preload.cjs', 'policy.mjs', 'updates.mjs', 'ota.mjs']) fs.copyFileSync(path.join(here, name), path.join(appPath, name));
fs.writeFileSync(path.join(appPath, 'package.json'), JSON.stringify({ name: 'servant-account-smoke', version: '1.0.0', type: 'module', main: 'main.mjs' }));
fs.writeFileSync(path.join(appPath, 'workspace.json'), 'null');
fs.writeFileSync(path.join(appPath, 'web/index.html'), '<!doctype html><title>Account storage check</title><main>Account storage check</main>');
fs.symlinkSync(path.join(here, 'node_modules'), path.join(appPath, 'node_modules'), 'dir');
const env = { ...process.env, SERVANT_DESKTOP_TEST_PROFILE: profile };
delete env.ELECTRON_RUN_AS_NODE;
let launched;
let page;
async function launch() {
  launched = await electron.launch({ executablePath: electronPath, args: [appPath], env });
  page = await launched.firstWindow();
  await page.waitForFunction(() => !!window.servantDesktop?.storage);
  return createAccountsStore({
    getItem: key => page.evaluate(key => window.servantDesktop.storage.getItem(key), key),
    setItem: (key, value) => page.evaluate(([key, value]) => window.servantDesktop.storage.setItem(key, value), [key, value]),
    removeItem: key => page.evaluate(key => window.servantDesktop.storage.removeItem(key), key),
  });
}
const account = n => ({ token: `test-only-token-${n}`, serverUrl: `https://server${n}.example.gov`, serverKey: '02' + String(n).repeat(64), serverName: `Example ${n}`, user: { id: `u_${n}`, name: 'Pat Tester', role: 'member' } });
try {
  let store = await launch();
  const first = account(1), second = account(2);
  assert.equal(await page.evaluate(() => window.servantDesktop.storage.version), 2);
  await page.evaluate(a => window.servantDesktop.storage.setItem('servant.account', JSON.stringify(a)), first);
  const migrated = await store.load();
  assert.equal(migrated.accounts.length, 1);
  assert.equal(migrated.activeId, accountId(first));
  assert.equal(await page.evaluate(() => window.servantDesktop.storage.getItem('servant.account')), null);
  await store.add(second);
  const both = await store.load();
  assert.equal(both.accounts.length, 2);
  assert.equal(both.activeId, accountId(second));
  for (const a of both.accounts) {
    const encrypted = fs.readFileSync(path.join(profile, accountFileName(accountStorageKey(accountId(a)))));
    assert.equal(encrypted.includes(a.token), false);
    assert.equal(encrypted.includes(a.user.name), false);
  }
  await assert.rejects(page.evaluate(() => window.servantDesktop.storage.setItem('../outside', 'forbidden')));
  await assert.rejects(page.evaluate(() => window.servantDesktop.notifications.show({ accountId: 'x', data: { conversationId: 'https://evil.test' } })));
  await page.evaluate(() => window.servantDesktop.notifications.setBadge(10));
  assert.equal(await launched.evaluate(({ app }) => app.getBadgeCount()), 10);
  await launched.close(); launched = null;
  store = await launch();
  assert.deepEqual((await store.load()).accounts.map(accountId), [accountId(first), accountId(second)]);
  await store.activate(accountId(first));
  await store.remove(accountId(first));
  const retained = await store.load();
  assert.equal(retained.activeId, accountId(second));
  assert.equal(retained.accounts[0].token, second.token);
  assert.equal(fs.existsSync(path.join(profile, accountFileName(accountStorageKey(accountId(first))))), false);
  assert.equal(fs.existsSync(path.join(profile, accountFileName(accountStorageKey(accountId(second))))), true);
  console.log('PASS: Mac migration, two encrypted accounts, restart, switch, scoped sign-out, badge and IPC validation');
} finally {
  if (launched) await launched.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
