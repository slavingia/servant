#!/usr/bin/env node
// End to end: the real Electron shell receives an interface update from a real
// Servant server, restarts into it, and then returns to the built-in interface
// after a rollback. Run after `npm run prepare:web` (macOS). Uses a throwaway
// server, data directory and profile; production data is never touched.
//
//   SERVANT_DESKTOP_TEST=1 npm run prepare:web && node ota-e2e.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { publishRollback, publishWeb } from '../server/ota.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.dirname(here);
assert.equal(process.platform, 'darwin', 'Run on macOS');
assert.ok(fs.existsSync(path.join(here, 'web/index.html')), 'Run npm run prepare:web first');
const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'servant-desktop-ota-'));
const keyFile = path.join(os.homedir(), '.config/servant/ota-keys/private-key.pem');
assert.ok(fs.existsSync(keyFile), `No signing key at ${keyFile}`);

const port = await new Promise(resolve => { const l = net.createServer(); l.listen(0, '127.0.0.1', () => { const p = l.address().port; l.close(() => resolve(p)); }); });
assert.notEqual(port, 8787);
const data = path.join(scratch, 'data'); fs.mkdirSync(data, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ name: 'OTA E2E', discovery: 'off' }));
const env = { ...process.env, SERVANT_DATA_DIR: data, SERVANT_PORT: String(port), SERVANT_HOST: '127.0.0.1', SERVANT_OTA_KEY_FILE: keyFile };
const server = spawn(process.execPath, [path.join(repository, 'server/server.mjs')], { env, stdio: 'ignore' });
let app;
const cleanup = async () => { try { await app?.close(); } catch { /* closed */ } server.kill('SIGTERM'); await delay(500); fs.rmSync(scratch, { recursive: true, force: true }); };
process.on('exit', () => server.kill('SIGKILL'));

try {
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* starting */ } await delay(200); }
  const serverKey = JSON.parse(fs.readFileSync(path.join(data, 'config.json'), 'utf8')) && (await import('../server/secure-transport.mjs')).serverIdentity(data).publicKey;

  // A copy of the shell, with its own copy of the built-in interface that we can tell apart.
  const testApp = path.join(scratch, 'app'); fs.mkdirSync(testApp, { mode: 0o700 });
  for (const name of ['main.mjs', 'preload.cjs', 'policy.mjs', 'updates.mjs', 'ota.mjs', 'ota-certificate.pem']) fs.copyFileSync(path.join(here, name), path.join(testApp, name));
  fs.writeFileSync(path.join(testApp, 'package.json'), JSON.stringify({ name: 'servant-desktop-ota', version: '1.0.0', type: 'module', main: 'main.mjs' }));
  fs.writeFileSync(path.join(testApp, 'workspace.json'), JSON.stringify({ server: `http://127.0.0.1:${port}`, serverKey }));
  fs.cpSync(path.join(here, 'web'), path.join(testApp, 'web'), { recursive: true });
  fs.symlinkSync(path.join(here, 'node_modules'), path.join(testApp, 'node_modules'), 'dir');
  const indexFile = path.join(testApp, 'web/index.html');
  const mark = (file, text) => fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('<head>', `<head><meta name="ota-marker" content="${text}">`));
  mark(indexFile, 'built-in');

  // The interface to publish: the same bundle, marked "v2".
  const v2 = path.join(scratch, 'web-v2'); fs.cpSync(path.join(testApp, 'web'), v2, { recursive: true });
  fs.writeFileSync(path.join(v2, 'index.html'), fs.readFileSync(path.join(v2, 'index.html'), 'utf8').replace('content="built-in"', 'content="v2-from-server"'));
  publishWeb({ dir: path.join(data, 'ota'), webDir: v2, shellApi: Number(/SHELL_API = (\d+)/.exec(fs.readFileSync(path.join(here, 'ota.mjs'), 'utf8'))[1]), note: 'e2e' });

  const profile = path.join(scratch, 'profile');
  const launch = async () => {
    const launched = await electron.launch({ executablePath: electronPath, args: [testApp], env: { ...process.env, SERVANT_DESKTOP_TEST_PROFILE: profile } });
    const page = await launched.firstWindow();
    page.setDefaultTimeout(20000);
    await page.waitForLoadState('domcontentloaded');
    return { launched, page };
  };
  const marker = page => page.locator('meta[name="ota-marker"]').getAttribute('content');
  const waitForBundle = () => { const state = path.join(profile, 'ota-web', 'current.json'); return (async () => { for (let i = 0; i < 60; i++) { if (fs.existsSync(state)) return JSON.parse(fs.readFileSync(state, 'utf8')); await delay(500); } throw new Error('No interface update was installed'); })(); };

  // 1. First launch runs the built-in interface, then downloads the update in the background.
  let run = await launch(); app = run.launched;
  assert.equal(await marker(run.page), 'built-in', 'first launch is the built-in interface');
  // The shell checks shortly after start. Trigger the same check the menu uses, through the app menu.
  await app.evaluate(({ Menu }) => { Menu.getApplicationMenu().items[0].submenu.items.find(i => i.label.startsWith('Check for Updates')).click(); });
  const installed = await waitForBundle();
  assert.equal(installed.trial, true, 'a fresh bundle starts in trial');
  await app.close();

  // 2. Next launch runs the downloaded interface.
  run = await launch(); app = run.launched;
  assert.equal(await marker(run.page), 'v2-from-server', 'the update is running after restart');
  console.log('update applied: marker =', await marker(run.page));
  await app.close();

  // 3. A rollback goes back to the built-in interface after the next check and restart.
  publishRollback({ dir: path.join(data, 'ota'), runtimeVersion: `mac-shell-${/SHELL_API = (\d+)/.exec(fs.readFileSync(path.join(here, 'ota.mjs'), 'utf8'))[1]}`, now: Date.now() + 5000 });
  run = await launch(); app = run.launched;
  await app.evaluate(({ Menu }) => { Menu.getApplicationMenu().items[0].submenu.items.find(i => i.label.startsWith('Check for Updates')).click(); });
  for (let i = 0; i < 40 && fs.existsSync(path.join(profile, 'ota-web', 'current.json')); i++) await delay(500);
  assert.ok(!fs.existsSync(path.join(profile, 'ota-web', 'current.json')), 'rollback removed the downloaded interface');
  await app.close();
  run = await launch(); app = run.launched;
  assert.equal(await marker(run.page), 'built-in', 'after rollback the built-in interface runs');
  console.log('rolled back: marker =', await marker(run.page));
  await app.close();
  console.log(JSON.stringify({ firstLaunchBuiltIn: true, updateApplied: true, rolledBack: true }, null, 2));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await cleanup();
}
