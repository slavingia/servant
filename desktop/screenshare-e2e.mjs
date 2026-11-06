#!/usr/bin/env node
// End to end: the real Electron shell joins a call, the person clicks "Share screen", and a second
// participant (a real WebRTC client) receives the screen as live video and can see it listed apart
// from the camera. Then "Stop sharing" ends it. Throwaway server, data and profile; macOS only.
// The macOS screen picker and Screen Recording permission can't be driven headlessly, so the test
// stands in a synthetic video source for that one step; everything after it is the real code.
//
//   npm run prepare:web --prefix desktop && node desktop/screenshare-e2e.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { serverIdentity } from '../server/secure-transport.mjs';
import { testFetch } from '../server/encrypted-test-client.mjs';
import { TERMS_VERSION, TERMS_ITEMS } from '../server/terms.mjs';

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repository = path.dirname(here);
assert.equal(process.platform, 'darwin', 'Run on macOS');
assert.ok(fs.existsSync(path.join(here, 'web/index.html')), 'Run npm run prepare:web first');
const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'servant-screenshare-'));
const artifacts = path.join(here, 'dist/smoke'); fs.mkdirSync(artifacts, { recursive: true });
const port = await new Promise(resolve => { const l = net.createServer(); l.listen(0, '127.0.0.1', () => { const p = l.address().port; l.close(() => resolve(p)); }); });
assert.notEqual(port, 8787);
const url = `http://127.0.0.1:${port}`;
const data = path.join(scratch, 'data'); fs.mkdirSync(data, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ name: 'Share E2E', agentName: 'Agent', publicUrl: url, discovery: 'off', discoveryUrl: '', upstreams: {} }));
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(SERVANT_|HERMES_|API_SERVER_KEY$)/.test(k))), SERVANT_DATA_DIR: data, SERVANT_PORT: String(port), SERVANT_HOST: '127.0.0.1', SERVANT_PUBLIC_URL: url, SERVANT_DISCOVERY_URL: '' };
delete env.ELECTRON_RUN_AS_NODE;
const serverEntry = path.join(repository, 'server/server.mjs');
const server = spawn(process.execPath, [serverEntry], { env, stdio: 'ignore' });
let app, bob;
const cleanup = async () => { try { await app?.close(); } catch { /* closed */ } try { await bob?.close(); } catch { /* closed */ } server.kill('SIGTERM'); await delay(500); fs.rmSync(scratch, { recursive: true, force: true }); };
process.on('exit', () => server.kill('SIGKILL'));
const failed = async e => { console.error(e); await cleanup(); process.exit(1); };

// macOS asks for camera and microphone permission per binary, and that prompt can't be clicked in an
// unattended run. Stand in synthetic devices (a moving canvas, a tone) for the pickers; the call,
// sharing and viewing code after them is the real thing.
const FAKE_DEVICES = () => {
  const md = navigator.mediaDevices;
  md.getUserMedia = async (c = {}) => {
    const tracks = [];
    if (c.audio) { const ctx = new AudioContext(); const o = ctx.createOscillator(); const d = ctx.createMediaStreamDestination(); o.connect(d); o.start(); tracks.push(...d.stream.getAudioTracks()); }
    if (c.video) { const cv = document.createElement('canvas'); cv.width = 640; cv.height = 480; const g = cv.getContext('2d'); let n = 0; setInterval(() => { g.fillStyle = `hsl(${(n += 3) % 360} 40% 30%)`; g.fillRect(0, 0, 640, 480); g.fillStyle = '#fff'; g.fillText('camera ' + n, 20, 40); }, 66); tracks.push(...cv.captureStream(15).getVideoTracks()); }
    return new MediaStream(tracks);
  };
};

try {
  for (let i = 0; i < 80; i++) { try { if ((await fetch(`${url}/health`)).ok) break; } catch { /* starting */ } await delay(200); }
  const serverKey = serverIdentity(data).publicKey;
  const api = async (method, route, body, token) => {
    const r = await testFetch(data, url + route, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: await r.json() };
  };
  const pair = async (name, role) => {
    const out = await run(process.execPath, [serverEntry, 'invite', '--name', name, '--role', role], { env });
    const code = out.stdout.match(/Invite code:\s*(\S+)/)[1];
    const r = await api('POST', '/v1/pair', { code, device: 'Test', terms: { version: TERMS_VERSION, items: TERMS_ITEMS } });
    assert.equal(r.status, 201);
    return { ...r.body, serverUrl: url, serverKey, serverName: 'Share E2E' };
  };
  const ann = await pair('Ann Presenter', 'owner');
  const boAccount = await pair('Bo Viewer', 'member');
  const general = (await api('GET', '/v1/conversations', undefined, ann.token)).body.conversations.find(c => c.name === 'general');
  const meeting = (await api('POST', '/v1/meetings', { conversationId: general.id }, ann.token)).body.meeting;

  // ---- Ann: the real Mac app ----
  const testApp = path.join(scratch, 'app'); fs.mkdirSync(testApp, { mode: 0o700 });
  for (const name of ['main.mjs', 'preload.cjs', 'policy.mjs', 'updates.mjs', 'ota.mjs', 'ota-certificate.pem']) fs.copyFileSync(path.join(here, name), path.join(testApp, name));
  fs.writeFileSync(path.join(testApp, 'package.json'), JSON.stringify({ name: 'servant-desktop-share', version: '1.0.0', type: 'module', main: 'main.mjs' }));
  fs.writeFileSync(path.join(testApp, 'workspace.json'), JSON.stringify({ server: url, serverKey }));
  fs.symlinkSync(path.join(here, 'web'), path.join(testApp, 'web'), 'dir');
  fs.symlinkSync(path.join(here, 'node_modules'), path.join(testApp, 'node_modules'), 'dir');
  app = await electron.launch({ executablePath: electronPath, args: [testApp, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'], env: { ...env, SERVANT_DESKTOP_TEST_PROFILE: path.join(scratch, 'profile') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(30000);
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.waitForURL('**/welcome');
  await page.evaluate(async a => { await window.servantDesktop.storage.setItem('servant.account', JSON.stringify(a)); }, ann);
  // The macOS picker and permission aren't drivable headlessly: hand the page a synthetic screen.
  await page.addInitScript(FAKE_DEVICES);
  await page.goto(`servant-ux-app://app/meeting/${meeting.id}`);
  await page.evaluate(() => {
    const original = navigator.mediaDevices.getDisplayMedia?.bind(navigator.mediaDevices);
    window.__displayRequests = 0;
    navigator.mediaDevices.getDisplayMedia = async () => {
      window.__displayRequests++;
      const c = document.createElement('canvas'); c.width = 1280; c.height = 720;
      const g = c.getContext('2d'); let n = 0;
      setInterval(() => { g.fillStyle = `hsl(${(n += 7) % 360} 70% 40%)`; g.fillRect(0, 0, 1280, 720); g.fillStyle = '#fff'; g.font = '96px sans-serif'; g.fillText('SHARED SCREEN ' + n, 80, 380); }, 66);
      return c.captureStream(15);
    };
    window.__realGetDisplayMedia = original;
  });
  await page.getByRole('button', { name: 'Leave' }).waitFor().catch(async e => { console.error('PAGE SHOWS:', (await page.locator('body').innerText()).slice(0, 300), '| url', page.url(), '| errors', errors.join(' || ')); throw e; });
  const share = page.getByRole('button', { name: 'Share screen' });
  await share.waitFor().catch(async e => { console.error('CALL SCREEN SAYS:', (await page.locator('body').innerText()).replace(/\n+/g, ' | ').slice(0, 300), '| errors:', errors.join(' || ')); throw e; });

  // ---- Bo: a second real browser peer, receiving over the same server ----
  bob = await electron.launch({ executablePath: electronPath, args: [testApp, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'], env: { ...env, SERVANT_DESKTOP_TEST_PROFILE: path.join(scratch, 'profile-bo') } });
  const bp = await bob.firstWindow(); bp.setDefaultTimeout(30000);
  await bp.waitForURL('**/welcome');
  await bp.evaluate(async a => { await window.servantDesktop.storage.setItem('servant.account', JSON.stringify(a)); }, boAccount);
  await bp.addInitScript(FAKE_DEVICES);
  await bp.goto(`servant-ux-app://app/meeting/${meeting.id}`);
  await bp.getByRole('button', { name: 'Leave' }).waitFor();
  await bp.getByRole('button', { name: 'Share screen' }).waitFor();   // offered once the call is live, on the Mac app too
  assert.equal(await bp.getByTestId('screen-stage').count(), 0, 'no screen yet');

  // Ann shares.
  await share.click();
  await page.getByRole('button', { name: 'Stop sharing' }).waitFor();
  await page.getByText("You're sharing your screen", { exact: false }).waitFor();
  assert.equal(await page.evaluate(() => window.__displayRequests), 1);
  // Bo gets the screen on the stage, with real, changing video.
  const stage = bp.getByTestId('screen-stage');
  await stage.waitFor();
  assert.match(await stage.getAttribute('aria-label'), /Ann Presenter's screen/);
  const sample = () => bp.evaluate(() => {
    const v = document.querySelector('[data-testid="screen-stage"] video');
    if (!v || v.videoWidth < 2) return null;
    const c = document.createElement('canvas'); c.width = 32; c.height = 18; const g = c.getContext('2d'); g.drawImage(v, 0, 0, 32, 18);
    return { w: v.videoWidth, h: v.videoHeight, px: Array.from(g.getImageData(0, 0, 32, 18).data).join(',') };
  });
  let first = null; for (let i = 0; i < 60 && !first; i++) { first = await sample(); if (!first) await delay(250); }
  assert.ok(first, 'Bo never received video frames for the shared screen');
  assert.ok(first.w >= 640, `the screen arrives at readable size (${first.w}x${first.h})`);
  let changed = false; for (let i = 0; i < 20 && !changed; i++) { await delay(250); const next = await sample(); changed = !!next && next.px !== first.px; }
  assert.ok(changed, 'the shared screen is live, not a frozen frame');
  await bp.screenshot({ path: path.join(artifacts, 'screenshare-viewer.png') });
  await page.screenshot({ path: path.join(artifacts, 'screenshare-presenter.png') });
  // The server lists it apart from the camera and doesn't count it as a person.
  const during = (await api('GET', `/v1/meetings/${meeting.id}`, undefined, boAccount.token)).body.meeting.participants;
  assert.equal(during.filter(p => p.screen).length, 1);
  assert.equal(during.filter(p => !p.screen).length, 2);

  // Ann stops; the stage clears for Bo and the call carries on.
  await page.getByRole('button', { name: 'Stop sharing' }).click();
  await page.getByRole('button', { name: 'Share screen' }).waitFor();
  await bp.getByTestId('screen-stage').waitFor({ state: 'detached' });
  const after = (await api('GET', `/v1/meetings/${meeting.id}`, undefined, boAccount.token)).body.meeting.participants;
  assert.equal(after.filter(p => p.screen).length, 0);
  assert.equal(after.filter(p => !p.screen).length, 2, 'both still in the call');
  // And she can share again.
  await page.getByRole('button', { name: 'Share screen' }).click();
  await bp.getByTestId('screen-stage').waitFor();
  assert.deepEqual(errors, [], 'no page errors');
  console.log('screen share e2e: ok');
  await cleanup();
} catch (e) { await failed(e); }
