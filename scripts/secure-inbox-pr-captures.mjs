#!/usr/bin/env node
// Capture real, matching PR-base and PR-head views from separate clean checkouts.
// Both checkout app/node_modules directories must be real directories (Expo Router
// resolves route context against its entry file). Install desktop Playwright here.
// node scripts/secure-inbox-pr-captures.mjs --before <checkout> --after <checkout>
// SERVANT_E2E_BROWSER=chrome selects installed Chrome.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argumentsByName = new Map();
for (let n = 2; n < process.argv.length; n += 2) argumentsByName.set(process.argv[n], process.argv[n + 1]);
assert.ok(argumentsByName.get('--before') && argumentsByName.get('--after'), 'Pass --before and --after clean source checkouts');
const output = path.resolve(argumentsByName.get('--output') || path.join(repository, 'docs/captures/secure-inbox-pr-75'));
const require = createRequire(path.join(repository, 'desktop/package.json'));
const { chromium } = require('playwright');
const run = promisify(execFile);
const viewports = { desktop: { width: 1280, height: 900 }, phone: { width: 390, height: 844 } };
const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'servant-pr-capture-data-'));
fs.chmodSync(scratch, 0o700);
const manifest = {
  purpose: 'Actual PR base versus PR head; no mockups or image edits.',
  fixture: 'Fresh isolated servers with synthetic Pat Tester, Jo Park and Ana Ruiz; visitor@example.gov; synthetic message and file content.',
  locale: 'en-US', timezone: 'America/New_York', colorScheme: 'light', deviceScaleFactor: 1,
  viewports, versions: {}, captures: [],
};
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
});
async function waitFor(url, child, label) {
  for (let attempt = 0; attempt < 180; attempt++) {
    if (child?.exitCode != null) throw new Error(`${label} exited with ${child.exitCode}`);
    if (await fetch(url, { signal: AbortSignal.timeout(1000) }).then(result => result.ok).catch(() => false)) return;
    await delay(250);
  }
  throw new Error(`${label} did not become ready`);
}
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(3000)]);
  if (child.exitCode === null) child.kill('SIGKILL');
}
const toBase64 = text => Buffer.from(text).toString('base64');
let browser;
try {
  browser = await chromium.launch({ ...(process.env.SERVANT_E2E_BROWSER ? { channel: process.env.SERVANT_E2E_BROWSER } : {}) });
  manifest.browser = { engine: 'Chromium', channel: process.env.SERVANT_E2E_BROWSER || 'bundled', version: browser.version() };
  for (const phase of ['before', 'after']) {
    const checkout = path.resolve(argumentsByName.get(`--${phase}`));
    const commit = (await run('git', ['rev-parse', 'HEAD'], { cwd: checkout })).stdout.trim();
    const dirtySource = (await run('git', ['status', '--porcelain', '--', 'app', 'server'], { cwd: checkout })).stdout.trim();
    assert.equal(dirtySource, '', `${phase} source checkout must have no app or server edits`);
    assert.equal(fs.lstatSync(path.join(checkout, 'app/node_modules')).isSymbolicLink(), false, 'Use local dependencies so Expo reads this checkout');
    manifest.versions[phase] = { commit, expo: JSON.parse(fs.readFileSync(path.join(checkout, 'app/package.json'), 'utf8')).dependencies.expo };
    const directory = path.join(output, phase);
    fs.mkdirSync(directory, { recursive: true });
    const data = path.join(scratch, phase, 'data');
    const runtime = path.join(scratch, phase, 'runtime');
    fs.mkdirSync(data, { recursive: true, mode: 0o700 });
    fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
    const port = await freePort();
    const apiUrl = `http://127.0.0.1:${port}`;
    const webUrl = `http://127.0.0.1:${await freePort()}`;
    const push = path.join(scratch, phase, 'push-disabled.json');
    fs.writeFileSync(push, '{}\n', { mode: 0o600 });
    fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({
      host: '127.0.0.1', port, name: 'Example team', publicUrl: apiUrl,
      discovery: 'off', discoveryUrl: '', upstreams: {}, features: { secureInbox: true },
    }), { mode: 0o600 });
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SERVANT_|HERMES_|API_SERVER_KEY$)/.test(key))),
      SERVANT_DATA_DIR: data, SERVANT_RUNTIME_DIR: runtime, SERVANT_HOST: '127.0.0.1', SERVANT_PORT: String(port),
      SERVANT_PUBLIC_URL: apiUrl, SERVANT_DISCOVERY_URL: '', SERVANT_PUSH_CONFIG: push,
      SERVANT_WORKER_MODE: 'external', SERVANT_SHUTDOWN_TIMEOUT_MS: '1000',
    };
    let apiServer, webServer;
    let logs = '';
    const track = child => { for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logs = (logs + chunk).slice(-6000); }); return child; };
    try {
      const entry = path.join(checkout, 'server/server.mjs');
      apiServer = track(spawn(process.execPath, [entry], { cwd: checkout, env, stdio: ['ignore', 'pipe', 'pipe'] }));
      await waitFor(`${apiUrl}/health`, apiServer, 'API server');
      const { testFetch } = await import(pathToFileURL(path.join(checkout, 'server/encrypted-test-client.mjs')).href);
      const { serverIdentity } = await import(pathToFileURL(path.join(checkout, 'server/secure-transport.mjs')).href);
      const { TERMS_VERSION, TERMS_ITEMS } = await import(pathToFileURL(path.join(checkout, 'server/terms.mjs')).href);
      const api = async (method, route, body, token) => {
        const response = await testFetch(data, apiUrl + route, {
          method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000),
        });
        const result = await response.json();
        assert.ok(response.ok, `${method} ${route}: ${response.status} ${JSON.stringify(result)}`);
        return result;
      };
      const pair = async (name, role) => {
        const invited = await run(process.execPath, [entry, 'invite', '--name', name, '--role', role], { env });
        const code = invited.stdout.match(/Invite code:\s*(\S+)/)?.[1];
        assert.ok(code);
        const account = await api('POST', '/v1/pair', { code, device: 'PR screenshot fixture', terms: { version: TERMS_VERSION, items: TERMS_ITEMS } });
        return { ...account, serverUrl: apiUrl, serverKey: serverIdentity(data).publicKey, serverName: 'Example team' };
      };
      const owner = await pair('Pat Tester', 'owner');
      const member = await pair('Jo Park', 'member');
      // The pre-existing team-message fixture is identical in both revisions.
      const dm = (await api('POST', '/v1/conversations', { kind: 'dm', userIds: [member.user.id] }, owner.token)).conversation;
      await api('POST', `/v1/conversations/${dm.id}/messages`, { text: 'Please review the example account update.' }, owner.token);
      await api('POST', `/v1/conversations/${dm.id}/messages`, { text: 'I will review the example details.' }, member.token);
      let caseId;
      if (phase === 'after') {
        const started = await api('POST', '/v1/inbox/guest/start', {
          name: 'Ana Ruiz', email: 'visitor@example.gov', subject: 'Example account review',
          text: 'I need help updating the example account.', attachments: [{ name: 'example-details.txt', data: toBase64('Synthetic example account details.\n') }], requestId: randomUUID(),
        });
        caseId = started.conversation.id;
        await api('PATCH', `/v1/inbox/${caseId}`, { assigneeId: owner.user.id }, owner.token);
        await api('POST', `/v1/inbox/${caseId}/messages`, { text: 'We received your details. Your team can reply here and share the next steps.', attachments: [{ name: 'example-next-steps.txt', data: toBase64('Synthetic example next steps.\n') }], requestId: randomUUID() }, owner.token);
        await api('POST', `/v1/inbox/${caseId}/notes`, { text: 'Review the example details before replying. Keep this assessment within the team.', attachments: [{ name: 'example-case-review.txt', data: toBase64('Synthetic private case review for the example team.\n') }], requestId: randomUUID() }, owner.token);
        await api('POST', `/v1/inbox/${caseId}/notes`, { text: 'I checked the attachment and will complete the follow-up.', requestId: randomUUID() }, member.token);
        await api('POST', `/v1/inbox/${caseId}/tasks`, { text: 'Review the example account details', assigneeId: member.user.id, dueDate: new Date(Date.now() + 86400000).toISOString().slice(0, 10), requestId: randomUUID() }, owner.token);
        await api('POST', '/v1/inbox/guest/start', { name: 'Jo Park', subject: 'Example records request', text: 'Where can I find the example records?', requestId: randomUUID() });
      }
      webServer = track(spawn(process.execPath, [path.join(checkout, 'app/node_modules/expo/bin/cli'), 'start', '--web', '--localhost', '--port', new URL(webUrl).port], {
        cwd: path.join(checkout, 'app'), env: { ...env, CI: '1', EXPO_NO_TELEMETRY: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
      }));
      await waitFor(webUrl, webServer, 'Expo web');
      const newPage = async (viewport, account) => {
        const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: manifest.locale, timezoneId: manifest.timezone, colorScheme: 'light', reducedMotion: 'reduce' });
        await context.route(/^https?:\/\//, route => {
          const origin = new URL(route.request().url()).origin;
          return origin === apiUrl || origin === webUrl ? route.continue() : route.abort('blockedbyclient');
        });
        if (account) await context.addInitScript(saved => { if (!localStorage.getItem('servant.accounts')) localStorage.setItem('servant.account', JSON.stringify(saved)); }, account);
        const page = await context.newPage();
        page.setDefaultTimeout(30000);
        return page;
      };
      const capture = async (page, name, route, viewportName, meaning, status = 200) => {
        await page.evaluate(() => document.fonts.ready);
        await delay(150);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${name} has no horizontal overflow`);
        const file = `${phase}/${name}-${viewportName}.png`;
        await page.screenshot({ path: path.join(output, file), animations: 'disabled' });
        const bytes = fs.readFileSync(path.join(output, file));
        manifest.captures.push({ file, commit, route, viewport: viewportName, httpStatus: status, meaning, capturedAt: new Date().toISOString(), sha256: createHash('sha256').update(bytes).digest('hex') });
      };
      for (const [viewportName, viewport] of Object.entries(viewports)) {
        const staff = await newPage(viewport, owner);
        if (phase === 'before') {
          await staff.goto(`${webUrl}/messages`);
          await staff.getByText('Jo Park: I will review the example details.', { exact: true }).filter({ visible: true }).first().waitFor();
          assert.equal(await staff.getByRole('button', { name: 'Cases', exact: true }).count(), 0);
          await capture(staff, 'team-workspace', '/messages', viewportName, 'Existing internal Direct messages workspace; the Cases feature does not exist at the PR base.');
        } else {
          await staff.goto(`${webUrl}/inbox`);
          await staff.getByRole('button', { name: /^Example account review, Ana Ruiz/ }).waitFor();
          await capture(staff, 'team-workspace', '/inbox', viewportName, 'New Cases queue with private references, ownership, follow-up counts and next actions.');
          await staff.goto(`${webUrl}/inbox/${caseId}`);
          await staff.getByRole('button', { name: 'Download example-next-steps.txt', exact: true }).waitFor();
          await capture(staff, 'conversation', '/inbox/:id', viewportName, 'New two-way visitor conversation with exchanged files.');
          await staff.getByRole('tab', { name: 'Team', exact: true }).click();
          await staff.getByRole('button', { name: 'Download team file example-case-review.txt', exact: true }).waitFor();
          await capture(staff, 'team-notes', '/inbox/:id (Team tab)', viewportName, 'Private notes and working files shared by two staff members.');
          await staff.getByRole('tab', { name: 'Follow-ups', exact: true }).click();
          const task = staff.getByRole('button', { name: 'Complete Review the example account details', exact: true });
          await task.waitFor();
          await task.scrollIntoViewIfNeeded();
          await capture(staff, 'case-tasks', '/inbox/:id (Follow-ups tab)', viewportName, 'Owned follow-up with due date and completion controls.');
        }
        await staff.context().close();
        const publicPage = await newPage(viewport);
        const response = await publicPage.goto(`${apiUrl}/contact`);
        if (phase === 'before') {
          assert.equal(response.status(), 404);
          await publicPage.getByText('This server has no GET /contact', { exact: false }).waitFor();
        } else {
          assert.equal(response.status(), 200);
          await publicPage.getByRole('button', { name: 'Start conversation', exact: true }).waitFor();
        }
        await capture(publicPage, 'public-entry', '/contact', viewportName,
          phase === 'before' ? 'Actual server HTTP404: no public conversation entry exists at the PR base.' : 'New public conversation entry form; no team account is required.', response.status());
        await publicPage.context().close();
      }
      console.log(`${phase} screenshot capture: OK (${commit.slice(0, 7)})`);
    } catch (error) {
      console.error(logs);
      throw error;
    } finally { await stop(webServer); await stop(apiServer); }
  }
  fs.writeFileSync(path.join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`PR screenshot evidence: OK — ${manifest.captures.length} actual browser captures, matching desktop and phone viewports`);
} finally {
  await browser?.close();
  fs.rmSync(scratch, { recursive: true, force: true });
}
