#!/usr/bin/env node
// Run after `npm run prepare:web` on macOS with Xcode command-line tools.
// Exercises the bundled Electron UI and real encrypted API in a fresh local
// test instance. No production workspace, identity, account, or data is copied.
// macOS Vision decodes the displayed QR image. A second isolated Electron
// profile renders the phone approval route; native phone camera hardware and
// OS deep-link delivery still require device QA.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { serverIdentity } from '../server/secure-transport.mjs';
import { testFetch } from '../server/encrypted-test-client.mjs';
import { parseDeviceLink } from '../app/src/lib/device-link.ts';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.dirname(here);
assert.equal(process.platform, 'darwin', 'The desktop smoke test requires macOS');
assert.ok(fs.existsSync(path.join(here, 'web/index.html')), 'Bundle the app with npm run prepare:web first');
const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'servant-desktop-smoke-'));
const artifacts = path.join(here, 'dist/smoke');
fs.mkdirSync(artifacts, { recursive: true, mode: 0o700 });
const instances = new Set();
const uiErrors = [];
const unexpectedRequests = [];
let server;
let desktop;
let phone;

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolve); });
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  assert.notEqual(port, 8787, 'Never use the production port');
  return port;
}

async function stopServer() {
  if (!server?.pid || server.exitCode !== null || server.signalCode !== null) return;
  const child = server;
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 15000);
  await exited;
  clearTimeout(timeout);
}

try {
  const port = await freePort();
  const instance = { data: path.join(scratch, 'instance/data'), runtime: path.join(scratch, 'instance/runtime'), url: `http://127.0.0.1:${port}` };
  for (const directory of [instance.data, instance.runtime]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Match automated server-suite isolation: fresh config and transport identity,
  // no host upstreams, no push/discovery/tunnel, and no inherited live settings.
  const pushConfig = path.join(scratch, 'push-disabled.json');
  fs.writeFileSync(pushConfig, '{}\n', { mode: 0o600, flag: 'wx' });
  fs.writeFileSync(path.join(instance.data, 'config.json'), JSON.stringify({
    host: '127.0.0.1', port, name: 'Servant Test', agentName: 'Test Agent', publicUrl: instance.url,
    discovery: 'off', discoveryUrl: '', upstreams: {},
  }), { mode: 0o600, flag: 'wx' });
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SERVANT_|HERMES_|API_SERVER_KEY$)/.test(key)));
  const env = { ...inherited, SERVANT_DATA_DIR: instance.data, SERVANT_RUNTIME_DIR: instance.runtime,
    SERVANT_HOST: '127.0.0.1', SERVANT_PORT: String(port), SERVANT_PUBLIC_URL: instance.url,
    SERVANT_DISCOVERY_URL: '', SERVANT_PUSH_CONFIG: pushConfig, SERVANT_WORKER_MODE: 'external', SERVANT_SHUTDOWN_TIMEOUT_MS: '10000' };
  delete env.ELECTRON_RUN_AS_NODE;
  const serverEntry = path.join(repository, 'server/server.mjs');
  server = spawn(process.execPath, [serverEntry], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverOutput = '';
  for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => { serverOutput = (serverOutput + chunk).slice(-6000); });
  server.on('error', error => { serverOutput += error.message; });
  let healthy = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(`Isolated server exited before readiness: ${serverOutput}`);
    const response = await fetch(instance.url + '/health', { signal: AbortSignal.timeout(1000) }).catch(() => null);
    if (response?.ok && (await response.json()).name === 'Servant Test') { healthy = true; break; }
    await delay(100);
  }
  assert.ok(healthy, 'Isolated test server did not become healthy');

  const serverKey = serverIdentity(instance.data).publicKey;
  const api = async (method, route, body, token) => {
    const response = await testFetch(instance.data, instance.url + route, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000),
    });
    return { status: response.status, body: await response.json() };
  };
  const invite = await run(process.execPath, [serverEntry, 'invite', '--name', 'Desktop Smoke Teammate'], { env });
  const code = invite.stdout.match(/Invite code:\s*(\S+)/)?.[1];
  assert.ok(code, 'Isolated invite command did not return a code');
  const paired = await api('POST', '/v1/pair', { code, device: 'iPhone' });
  assert.equal(paired.status, 201);
  const phoneAccount = { ...paired.body, serverUrl: instance.url, serverKey, serverName: 'Servant Test' };

  // Copy runtime code only, and share the existing web bundle without duplicating
  // its assets or Electron binaries. Production workspace.json is never touched.
  const testApp = path.join(scratch, 'app');
  fs.mkdirSync(testApp, { mode: 0o700 });
  for (const name of ['main.mjs', 'preload.cjs', 'policy.mjs', 'updates.mjs', 'ota.mjs', 'ota-certificate.pem']) fs.copyFileSync(path.join(here, name), path.join(testApp, name));
  fs.writeFileSync(path.join(testApp, 'package.json'), JSON.stringify({ name: 'servant-desktop-smoke', version: '1.0.0', type: 'module', main: 'main.mjs' }));
  fs.writeFileSync(path.join(testApp, 'workspace.json'), JSON.stringify({ server: instance.url, serverKey }));
  fs.symlinkSync(path.join(here, 'web'), path.join(testApp, 'web'), 'dir');
  fs.symlinkSync(path.join(here, 'node_modules'), path.join(testApp, 'node_modules'), 'dir'); // electron-updater
  const launch = async profile => {
    const app = await electron.launch({ executablePath: electronPath, args: [testApp], env: { ...env, SERVANT_DESKTOP_TEST_PROFILE: profile } });
    instances.add(app);
    const page = await app.firstWindow();
    page.setDefaultTimeout(20000);
    page.on('pageerror', error => uiErrors.push(error.message));
    await page.route(/^https?:\/\//, route => {
      const url = new URL(route.request().url());
      if (url.origin === instance.url) return route.continue();
      unexpectedRequests.push(url.origin);
      return route.abort('blockedbyclient');
    });
    return { app, page };
  };
  const close = async launched => { if (launched) { await launched.app.close(); instances.delete(launched.app); } };
  const desktopProfile = path.join(scratch, 'desktop-profile');
  desktop = await launch(desktopProfile);
  await desktop.page.getByText('Match this code on your phone', { exact: true }).waitFor();
  const matchingCode = (await desktop.page.locator('body').innerText()).match(/\b\d{3} \d{3}\b/)?.[0];
  assert.ok(matchingCode, 'Desktop must display the matching confirmation code');
  const qrImage = path.join(artifacts, 'qr.png');
  await desktop.page.getByLabel('Computer sign-in QR code', { exact: true }).screenshot({ path: qrImage });
  const decoder = path.join(scratch, 'decode-qr.swift');
  fs.writeFileSync(decoder, `import Foundation
import Vision
let request = VNDetectBarcodesRequest()
request.symbologies = [.qr]
try VNImageRequestHandler(url: URL(fileURLWithPath: CommandLine.arguments[1])).perform([request])
guard let value = request.results?.first?.payloadStringValue else { fatalError("No QR code detected") }
print(value)
`);
  const decoded = (await run('xcrun', ['swift', decoder, qrImage], { timeout: 60000 })).stdout.trim();
  const link = parseDeviceLink(decoded);
  assert.ok(link, 'The displayed QR image must decode as a valid device link');
  assert.equal(link.serverKey, serverKey);
  assert.deepEqual([...new URL(decoded).searchParams.keys()].sort(), ['id', 'key']);

  phone = await launch(path.join(scratch, 'phone-profile'));
  await phone.page.waitForURL('**/welcome');
  await phone.page.getByText('Your workspace, on your Mac', { exact: true }).waitFor();
  await phone.page.evaluate(async account => { await window.servantDesktop.storage.setItem('servant.account', JSON.stringify(account)); }, phoneAccount);
  await phone.page.goto('servant-ux-app://app/link-device?' + new URLSearchParams({ id: link.id, key: link.serverKey }));
  await phone.page.getByRole('button', { name: 'Sign in on Mac', exact: true }).waitFor();
  assert.ok((await phone.page.locator('body').innerText()).includes(matchingCode), 'Phone and desktop confirmation numbers must match');
  await phone.page.screenshot({ path: path.join(artifacts, 'phone-approval.png') });
  await phone.page.getByRole('button', { name: 'Sign in on Mac', exact: true }).click();
  await desktop.page.waitForURL('**/channels');
  await desktop.page.getByRole('button', { name: 'Create a channel', exact: true }).waitFor();
  const linked = await desktop.page.evaluate(async () => JSON.parse(await window.servantDesktop.storage.getItem('servant.account')));
  assert.equal(linked.user.id, phoneAccount.user.id);
  assert.ok(linked.token !== phoneAccount.token, 'Linked Mac must receive a separate device token');
  assert.equal(await desktop.page.evaluate(() => localStorage.getItem('servant.account')), null);
  const encrypted = fs.readFileSync(path.join(desktopProfile, 'account.enc'));
  assert.ok(!encrypted.includes(linked.token) && !encrypted.includes(phoneAccount.user.name), 'Account file must not contain plaintext credentials or account identity');
  const nativeIsolation = await desktop.app.evaluate(({ BrowserWindow }) => {
    const preferences = BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return { nodeIntegration: preferences.nodeIntegration, contextIsolation: preferences.contextIsolation, sandbox: preferences.sandbox };
  });
  assert.deepEqual(nativeIsolation, { nodeIntegration: false, contextIsolation: true, sandbox: true });

  // Check usable app content, not just a successful URL/account transition.
  await desktop.page.getByRole('button', { name: 'Create a channel', exact: true }).click();
  await desktop.page.getByLabel('Channel name', { exact: true }).fill('desktop-smoke');
  await desktop.page.getByRole('button', { name: 'Create channel', exact: true }).click();
  // Return sends on the Mac, Shift+Return adds a line, and web links are links.
  const composer = desktop.page.getByLabel('Message #desktop-smoke', { exact: true });
  await composer.fill('first line');
  await composer.press('Shift+Enter');
  assert.match(await composer.inputValue(), /^first line\n/, 'Shift+Return must add a line');
  await composer.fill('');
  await composer.pressSequentially('QR sign-in smoke message');
  await composer.press('Enter');
  await desktop.page.getByText('QR sign-in smoke message', { exact: true }).waitFor();
  assert.equal(await composer.inputValue(), '', 'Return must send and clear the composer');
  const smokeLink = 'https://github.com/slavingia/servant/issues/25';
  await composer.pressSequentially(`See ${smokeLink}`);
  await composer.press('Enter');
  await desktop.page.getByRole('link', { name: smokeLink, exact: true }).waitFor();
  const conversationId = new URL(desktop.page.url()).pathname.split('/').at(-1);
  const messages = await api('GET', `/v1/conversations/${conversationId}/messages`, undefined, phoneAccount.token);
  assert.equal(messages.status, 200);
  assert.ok(messages.body.messages.some(message => message.text === 'QR sign-in smoke message' && message.user.id === phoneAccount.user.id), 'Phone account must read the Mac message from the encrypted API');
  assert.ok(messages.body.messages.every(message => !Object.hasOwn(message, 'sourceDevice')), 'Member history must not expose device metadata');
  await desktop.page.screenshot({ path: path.join(artifacts, 'mac-message.png') });

  // Owner-only preview: two devices belonging to the same teammate send
  // consecutive messages. The owner sees each source; the teammate does not.
  const ownerInvite = await run(process.execPath, [serverEntry, 'invite', '--name', 'Device Preview Owner', '--role', 'owner'], { env });
  const ownerCode = ownerInvite.stdout.match(/Invite code:\s*(\S+)/)?.[1];
  assert.ok(ownerCode);
  const ownerPair = await api('POST', '/v1/pair', { code: ownerCode, device: 'Mac' });
  assert.equal(ownerPair.status, 201);
  const ownerAccount = { ...ownerPair.body, serverUrl: instance.url, serverKey, serverName: 'Servant Test' };
  assert.equal((await api('POST', `/v1/conversations/${conversationId}/join`, {}, ownerAccount.token)).status, 200);
  const owner = await launch(path.join(scratch, 'owner-profile'));
  await owner.page.waitForURL('**/welcome');
  await owner.page.getByText('Your workspace, on your Mac', { exact: true }).waitFor();
  await owner.page.evaluate(async account => { await window.servantDesktop.storage.setItem('servant.account', JSON.stringify(account)); }, ownerAccount);
  await owner.page.goto(`servant-ux-app://app/c/${conversationId}`);
  const computerMessage = messages.body.messages.find(message => message.text === 'QR sign-in smoke message');
  await owner.page.getByTestId(`message-device-${computerMessage.id}`).waitFor();
  assert.equal(await owner.page.getByTestId(`message-device-${computerMessage.id}`).getAttribute('aria-label'), 'Sent from Computer');
  const mobilePost = await api('POST', `/v1/conversations/${conversationId}/messages`, { text: 'Sent from my phone' }, phoneAccount.token);
  assert.equal(mobilePost.status, 201);
  assert.ok(!Object.hasOwn(mobilePost.body.message, 'sourceDevice'));
  await owner.page.getByText('Sent from my phone', { exact: true }).waitFor();
  await owner.page.getByTestId(`message-device-${mobilePost.body.message.id}`).waitFor();
  assert.equal(await owner.page.getByTestId(`message-device-${mobilePost.body.message.id}`).getAttribute('aria-label'), 'Sent from Mobile');
  const compactPost = await api('POST', `/v1/conversations/${conversationId}/messages`, { text: 'Another message from my phone' }, phoneAccount.token);
  assert.equal(compactPost.status, 201);
  await owner.page.getByTestId(`message-device-${compactPost.body.message.id}`).waitFor();
  assert.equal(await owner.page.getByTestId(`message-device-${compactPost.body.message.id}`).getAttribute('aria-label'), 'Sent from Mobile');
  const ownerHistory = await api('GET', `/v1/conversations/${conversationId}/messages`, undefined, ownerAccount.token);
  assert.equal(ownerHistory.body.messages.find(message => message.id === computerMessage.id).sourceDevice.kind, 'computer');
  assert.equal(ownerHistory.body.messages.find(message => message.id === mobilePost.body.message.id).sourceDevice.kind, 'mobile');
  await owner.page.screenshot({ path: path.join(artifacts, 'owner-device-indicators.png') });
  await desktop.page.getByText('Another message from my phone', { exact: true }).waitFor();
  assert.equal(await desktop.page.locator('[data-testid^="message-device-"]').count(), 0, 'Members must not see source indicators');
  await desktop.page.screenshot({ path: path.join(artifacts, 'member-no-device-indicators.png') });
  await close(owner);

  await close(desktop);
  desktop = await launch(desktopProfile);
  await desktop.page.waitForURL('**/channels');
  await desktop.page.getByRole('button', { name: 'Create a channel', exact: true }).waitFor();
  const restored = await desktop.page.evaluate(async () => JSON.parse(await window.servantDesktop.storage.getItem('servant.account')));
  assert.ok(restored.token === linked.token, 'Restart must restore the existing Mac device');
  await desktop.page.goto('servant-ux-app://app/you');
  await desktop.page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await desktop.page.getByText('Sign out of Servant?', { exact: true }).waitFor();
  await desktop.page.getByRole('button', { name: 'Sign out', exact: true }).last().click();
  await desktop.page.waitForURL('**/welcome');
  assert.equal(await desktop.page.evaluate(() => window.servantDesktop.storage.getItem('servant.account')), null);
  assert.equal(fs.existsSync(path.join(desktopProfile, 'account.enc')), false);
  assert.equal((await api('GET', '/v1/me', undefined, linked.token)).status, 401, 'Sign-out must revoke the Mac token');
  assert.equal((await api('GET', '/v1/me', undefined, phoneAccount.token)).status, 200, 'Phone stays signed in');
  assert.deepEqual(uiErrors, []);
  assert.deepEqual(unexpectedRequests, []);
  console.log(JSON.stringify({ qrImageDecoded: true, explicitPhoneApproval: true, sameUser: true, separateDeviceToken: true, encryptedStorage: true, usableChannelsAndMessaging: true, ownerOnlyDeviceIndicators: true, compactMessageDeviceIndicator: true, persistsRestart: true, signOutRevokesOnlyMac: true, nativeIsolation, uiErrors: 0, externalRequests: 0, artifacts }, null, 2));
} catch (error) {
  await desktop?.page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await Promise.allSettled([...instances].map(app => app.close()));
  await stopServer();
  fs.rmSync(scratch, { recursive: true, force: true });
}
