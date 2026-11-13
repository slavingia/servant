#!/usr/bin/env node
// Two staff browsers + a public visitor -> private case workspaces and encrypted API.
// npm ci --prefix app && npm ci --prefix desktop
// cd desktop && npx playwright install chromium
// node scripts/secure-inbox-cases-e2e.mjs
// SERVANT_E2E_BROWSER=chrome uses installed Chrome.
// SERVANT_INBOX_WEB_URL reuses an Expo server from this checkout.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
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
const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'servant-inbox-cases-e2e-'));
fs.chmodSync(scratch, 0o700);
const artifacts = path.join(repository, 'desktop/dist/secure-inbox-cases-e2e');
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
const privateText = 'Team-only example assessment for the private work plan';
const secondNote = 'Second team member reviewed the private example evidence';
const privateBytes = Buffer.from('Only the team can read this synthetic case document.\n');
const privateFile = { name: 'private-example-assessment.txt', mimeType: 'text/plain', buffer: privateBytes };
const publicDraft = 'We are reviewing your example request and will reply here';
const followUpText = 'Check the private example records';
const dueDate = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
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
  const attach = async (target, file, label = 'Attach files') => {
    const input = target.locator('input[type=file]:visible');
    if (await input.count()) { await input.setInputFiles(file); return; }
    const chosen = target.waitForEvent('filechooser');
    await target.getByRole('button', { name: label, exact: true }).click();
    await (await chosen).setFiles(file);
    await target.getByRole('button', { name: `Remove ${label === 'Attach team files' ? 'team ' : ''}${file.name}`, exact: true }).filter({ visible: true }).waitFor();
  };
  const download = async (target, file, bytes, label = `Download ${file}`) => {
    const completed = target.waitForEvent('download');
    await target.getByRole('button', { name: label, exact: true }).filter({ visible: true }).last().click();
    const transfer = await completed;
    assert.equal(transfer.suggestedFilename(), file);
    assert.deepEqual(fs.readFileSync(await transfer.path()), bytes, 'download preserves exact file bytes');
  };

  const startBody = { name: 'Ana Ruiz', email: 'visitor@example.gov', subject: 'Example case review', text: 'Please help with the example request', requestId: randomUUID() };
  const started = await api('POST', '/v1/inbox/guest/start', startBody);
  const separate = await api('POST', '/v1/inbox/guest/start', { name: 'Pat Tester', subject: 'Separate example case', text: 'Another private visitor conversation', requestId: randomUUID() });
  const id = started.conversation.id;
  const casePath = `/v1/inbox/${id}`;
  const caseState = () => api('GET', `${casePath}/case`, undefined, owner.token);
  const notes = () => api('GET', `${casePath}/notes`, undefined, owner.token);
  const guestState = () => api('GET', '/v1/inbox/guest/conversation', undefined, started.token);
  const tab = (target, name) => target.getByRole('tab', { name, exact: true }).click();
  // Which cases the list shows is one choice of four, so those are radios.
  const view = (target, name) => target.getByRole('radio', { name, exact: true }).click();
  const visibleText = (target, text) => target.getByText(text, { exact: true }).filter({ visible: true });

  const visitor = await newPage(undefined, { width: 390, height: 844 });
  await visitor.goto(`${apiUrl}/contact#resume=${encodeURIComponent(started.token)}`);
  await visibleText(visitor, startBody.text).waitFor();
  assert.equal(new URL(visitor.url()).hash, '', 'return capability is removed before normal navigation');
  page = await newPage(owner);
  await page.goto(`${webUrl}/inbox/${id}`);
  await visibleText(page, startBody.text).waitFor();
  const guestBeforeAssignment = await guestState();
  await page.getByRole('button', { name: 'Assign to me', exact: true }).click();
  await page.getByRole('button', { name: 'Unassign', exact: true }).waitFor();
  const initialCase = await caseState();
  const reference = initialCase.reference;
  assert.match(reference, /^CASE-\d{6,}$/);
  await visibleText(page, reference).waitFor();
  const guestBefore = await guestState();
  assert.deepEqual(guestBefore, guestBeforeAssignment, 'private ownership changes do not alter guest metadata');

  // The two composers retain independent text, files and request identities.
  await page.getByRole('textbox', { name: 'Reply', exact: true }).fill(publicDraft);
  await tab(page, 'Team');
  await visibleText(page, 'Private to your team').waitFor();
  const noteField = page.getByRole('textbox', { name: 'Team note', exact: true });
  await noteField.fill(privateText);
  await attach(page, privateFile, 'Attach team files');
  await tab(page, 'Conversation');
  assert.equal(await page.getByRole('textbox', { name: 'Reply', exact: true }).inputValue(), publicDraft, 'visitor reply draft is retained independently');
  assert.equal(await page.getByRole('button', { name: `Remove team ${privateFile.name}`, exact: true }).filter({ visible: true }).count(), 0, 'private attachment never enters the visitor composer');
  await tab(page, 'Team');
  assert.equal(await noteField.inputValue(), privateText, 'switching tabs retains the private note');
  await page.getByRole('button', { name: `Remove team ${privateFile.name}`, exact: true }).filter({ visible: true }).waitFor();

  await page.route(`${apiUrl}/v1/secure`, route => route.abort('connectionrefused'));
  await page.getByRole('button', { name: 'Add team note', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: /draft|try again/i }).waitFor();
  assert.equal(await noteField.inputValue(), privateText, 'failed private send retains its authored text');
  await page.getByRole('button', { name: `Remove team ${privateFile.name}`, exact: true }).filter({ visible: true }).waitFor();
  await page.unroute(`${apiUrl}/v1/secure`);
  await page.getByRole('button', { name: 'Add team note', exact: true }).click();
  await until(async () => await noteField.inputValue() === '', 'successful private send clears only the private draft');
  await visibleText(page, privateText).waitFor();
  const firstNotes = await notes();
  const note = firstNotes.notes.find(item => item.text === privateText);
  assert.ok(note && note.attachments.length === 1);
  const file = note.attachments[0];
  assert.deepEqual(await guestState(), guestBefore, 'private notes and files do not change any guest-visible data or timestamp');

  const teammate = await newPage(member, { width: 1280, height: 900 });
  await teammate.goto(`${webUrl}/inbox/${id}`);
  await tab(teammate, 'Team');
  await visibleText(teammate, privateText).waitFor();
  await download(teammate, privateFile.name, privateBytes, `Download team file ${privateFile.name}`);
  await teammate.getByRole('textbox', { name: 'Team note', exact: true }).fill(secondNote);
  await teammate.getByRole('button', { name: 'Add team note', exact: true }).click();
  await visibleText(page, secondNote).waitFor();
  await page.screenshot({ path: path.join(artifacts, 'team-notes-desktop.png'), animations: 'disabled' });

  await tab(page, 'Follow-ups');
  await page.getByRole('textbox', { name: 'Follow-up', exact: true }).fill(followUpText);
  await page.getByRole('button', { name: 'Owner', exact: true }).click();
  await page.getByRole('radio', { name: 'Jo Park', exact: true }).click();
  await page.getByRole('textbox', { name: 'Due date', exact: true }).fill(dueDate);
  await page.getByRole('button', { name: 'Add follow-up', exact: true }).click();
  await page.getByRole('button', { name: `Complete ${followUpText}`, exact: true }).waitFor();
  const withTask = await caseState();
  const task = withTask.tasks.find(item => item.text === followUpText);
  assert.ok(task);
  assert.equal(task.assigneeId, member.user.id);
  assert.equal(task.dueDate, dueDate);
  assert.equal(withTask.openTaskCount, 1);
  assert.equal(withTask.nextAction.id, task.id);
  await visibleText(page, 'Next action').waitFor();
  await page.screenshot({ path: path.join(artifacts, 'case-tasks-desktop.png'), animations: 'disabled' });
  assert.deepEqual(await guestState(), guestBefore, 'private follow-up metadata leaves all visitor state unchanged');

  // An open task makes the case appear in its owner's work even when someone
  // else owns the conversation; both staff browsers see the same next action.
  await teammate.goto(`${webUrl}/inbox`);
  await view(teammate, 'My cases');
  await teammate.getByRole('button', { name: /^Example case review, Ana Ruiz/ }).waitFor();
  await teammate.getByRole('button', { name: /^Example case review, Ana Ruiz/ }).click();
  await tab(teammate, 'Follow-ups');
  await teammate.getByRole('button', { name: `Complete ${followUpText}`, exact: true }).click();
  await teammate.getByRole('button', { name: `Reopen ${followUpText}`, exact: true }).waitFor();
  await page.getByRole('button', { name: `Reopen ${followUpText}`, exact: true }).waitFor();
  const completed = await caseState();
  assert.equal(completed.openTaskCount, 0);
  assert.equal(completed.nextAction, null);
  assert.ok(completed.tasks.find(item => item.id === task.id).completedAt);
  await teammate.getByRole('button', { name: `Reopen ${followUpText}`, exact: true }).click();
  await page.getByRole('button', { name: `Complete ${followUpText}`, exact: true }).waitFor();
  assert.equal((await caseState()).nextAction.id, task.id);
  await tab(page, 'Activity');
  await visibleText(page, 'Activity').first().waitFor();
  const history = await api('GET', `${casePath}/activity`, undefined, owner.token);
  assert.ok(history.activity.length >= 5, 'case actions append an observable history');
  assert.ok(history.activity.some(item => item.actorName === member.user.name), 'history attributes the second staff member');
  await visibleText(page, history.activity.at(-1).text).waitFor();
  await page.screenshot({ path: path.join(artifacts, 'case-activity-desktop.png'), animations: 'disabled' });
  assert.deepEqual(await guestState(), guestBefore, 'completion, reopening and private activity leave visitor state unchanged');

  const privateValues = [reference, privateText, secondNote, privateFile.name, file.id, note.id, task.id, followUpText, dueDate, privateBytes.toString(), privateBytes.toString('base64')];
  const noPrivate = value => {
    const serialized = JSON.stringify(value);
    for (const secret of privateValues) assert.equal(serialized.includes(secret), false, 'visitor response contains no private case content or identifiers');
    const visit = item => {
      if (!item || typeof item !== 'object') return;
      for (const [key, child] of Object.entries(item)) {
        assert.equal(['reference', 'openTaskCount', 'nextAction', 'tasks', 'notes', 'activity', 'dueDate'].includes(key), false, 'visitor response exposes no private workspace fields');
        visit(child);
      }
    };
    visit(value);
  };
  noPrivate(await guestState());
  const existingVisitorLink = await api('POST', `${casePath}/visitor-link`, {}, owner.token);
  const additionalToken = new URLSearchParams(new URL(existingVisitorLink.url).hash.slice(1)).get('resume');
  assert.ok(additionalToken && additionalToken !== started.token);
  assert.deepEqual(await guestState(), guestBefore, 'creating another scoped return link leaves original visitor state untouched');
  assert.deepEqual(await api('GET', '/v1/inbox/guest/conversation', undefined, additionalToken), guestBefore, 'both visitor capabilities expose the same public-only conversation');
  const replay = await api('POST', '/v1/inbox/guest/start', startBody);
  assert.equal(replay.token, started.token);
  assert.deepEqual(replay.conversation, guestBefore.conversation);
  assert.deepEqual(replay.messages, guestBefore.messages);
  noPrivate(replay);
  noPrivate(await api('POST', '/v1/inbox/guest/read', { through: guestBefore.messages.at(-1).sequence }, started.token));
  for (const route of [`${casePath}/case`, `${casePath}/notes`, `${casePath}/tasks`, `${casePath}/activity`, `${casePath}/notes/files/${file.id}`]) {
    const denied = await request('GET', route, undefined, started.token);
    assert.ok([401, 403, 404].includes(denied.status), `${route} refuses a visitor credential`);
    noPrivate(await denied.json());
  }
  const deniedGuestFile = await request('GET', `/v1/inbox/guest/files/${file.id}`, undefined, started.token);
  assert.equal(deniedGuestFile.status, 404, 'a team file ID never resolves through public attachment routes');
  noPrivate(await deniedGuestFile.json());
  const wrongCaseFile = await request('GET', `/v1/inbox/${separate.conversation.id}/notes/files/${file.id}`, undefined, owner.token);
  assert.equal(wrongCaseFile.status, 404, 'private files are scoped to the case even for staff');
  assert.equal(await visitor.getByText(privateText, { exact: true }).count(), 0);
  assert.equal(await visitor.getByText(reference, { exact: true }).count(), 0);

  await tab(page, 'Conversation');
  assert.equal(await page.getByRole('textbox', { name: 'Reply', exact: true }).inputValue(), publicDraft, 'private case work never overwrites the original visitor reply draft');
  await page.getByRole('button', { name: 'Send reply', exact: true }).click();
  await visibleText(visitor, publicDraft).waitFor();
  noPrivate(await guestState());
  await visitor.getByRole('textbox', { name: 'Reply', exact: true }).fill('Thank you for the example update');
  await visitor.getByRole('button', { name: 'Send reply', exact: true }).click();
  await visibleText(page, 'Thank you for the example update').waitFor();
  noPrivate(await guestState());

  await page.goto(`${webUrl}/inbox`);
  await view(page, 'My cases');
  await page.getByRole('button', { name: /^Example case review, Ana Ruiz/ }).waitFor();
  await view(page, 'Unassigned');
  await page.getByRole('button', { name: /^Separate example case, Pat Tester/ }).waitFor();
  await until(async () => await page.getByRole('button', { name: /^Example case review, Ana Ruiz/ }).count() === 0, 'Unassigned excludes an owned case');
  await view(page, 'Due follow-ups');
  await page.getByRole('button', { name: /^Example case review, Ana Ruiz/ }).waitFor();
  assert.equal(await page.getByRole('button', { name: /^Separate example case, Pat Tester/ }).count(), 0);
  await view(page, 'All cases');
  await page.getByRole('textbox', { name: 'Search cases', exact: true }).fill(reference);
  await page.getByRole('button', { name: /^Example case review, Ana Ruiz/ }).waitFor();
  await until(async () => await page.getByRole('button', { name: /^Separate example case, Pat Tester/ }).count() === 0, 'search finds a stable case reference');
  await page.screenshot({ path: path.join(artifacts, 'case-list-desktop.png'), animations: 'disabled' });

  // A team can start its own case and prepare private work before inviting
  // the visitor. The copied capability opens only that case's public lane.
  await page.goto(`${webUrl}/inbox`);
  await page.getByRole('button', { name: 'New case', exact: true }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Ana Ruiz');
  await page.getByRole('textbox', { name: 'Contact email (optional)', exact: true }).fill('visitor@example.gov');
  await page.getByRole('textbox', { name: 'Subject', exact: true }).fill('Staff-created example case');
  await page.getByRole('button', { name: 'Create case', exact: true }).click();
  await page.waitForURL(url => url.pathname.startsWith('/inbox/') && url.pathname !== `/inbox/${id}`);
  const proactiveId = new URL(page.url()).pathname.split('/').pop();
  assert.ok(proactiveId && proactiveId !== id);
  const proactiveCase = await api('GET', `/v1/inbox/${proactiveId}/case`, undefined, owner.token);
  const proactiveDetail = await api('GET', `/v1/inbox/${proactiveId}`, undefined, owner.token);
  assert.equal(proactiveDetail.conversation.assigneeId, owner.user.id, 'creating staff member initially owns the case');
  assert.deepEqual(proactiveDetail.messages, [], 'staff-created case has no fabricated public message');
  const preparedNote = 'Private preparation before the visitor joins this example case';
  privateValues.push(proactiveCase.reference, preparedNote);
  await tab(page, 'Team');
  await page.getByRole('textbox', { name: 'Team note', exact: true }).fill(preparedNote);
  await page.getByRole('button', { name: 'Add team note', exact: true }).click();
  await until(async () => await page.getByRole('textbox', { name: 'Team note', exact: true }).inputValue() === '', 'private preparation is stored before creating a visitor link');
  await visibleText(page, preparedNote).waitFor();
  await tab(page, 'Conversation');
  await page.getByRole('button', { name: 'Copy visitor link', exact: true }).click();
  await visibleText(page, 'Visitor link copied').waitFor();
  const visitorLink = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(visitorLink.startsWith(`${apiUrl}/contact#resume=`));
  const proactiveToken = new URLSearchParams(new URL(visitorLink).hash.slice(1)).get('resume');
  assert.ok(proactiveToken);
  const repeatedLink = await api('POST', `/v1/inbox/${proactiveId}/visitor-link`, {}, owner.token);
  assert.equal(repeatedLink.url, visitorLink, 'copying the link again retains the same scoped capability');
  const invitedVisitor = await newPage(undefined, { width: 390, height: 844 });
  await invitedVisitor.goto(visitorLink);
  await visibleText(invitedVisitor, 'Staff-created example case').waitFor();
  assert.equal(new URL(invitedVisitor.url()).hash, '');
  const proactiveGuest = await api('GET', '/v1/inbox/guest/conversation', undefined, proactiveToken);
  assert.equal(proactiveGuest.conversation.id, proactiveId);
  assert.deepEqual(proactiveGuest.messages, []);
  noPrivate(proactiveGuest);
  assert.equal(await invitedVisitor.getByText(preparedNote, { exact: true }).count(), 0);
  await page.getByRole('textbox', { name: 'Reply', exact: true }).fill('Welcome to your staff-created example conversation');
  await page.getByRole('button', { name: 'Send reply', exact: true }).click();
  await visibleText(invitedVisitor, 'Welcome to your staff-created example conversation').waitFor();
  await invitedVisitor.getByRole('textbox', { name: 'Reply', exact: true }).fill('I received the example case link');
  await invitedVisitor.getByRole('button', { name: 'Send reply', exact: true }).click();
  await visibleText(page, 'I received the example case link').waitFor();
  noPrivate(await api('GET', '/v1/inbox/guest/conversation', undefined, proactiveToken));
  await invitedVisitor.screenshot({ path: path.join(artifacts, 'staff-created-visitor-phone.png'), animations: 'disabled', fullPage: true });
  await invitedVisitor.context().close();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${webUrl}/inbox/${id}`);
  for (const label of ['Team', 'Follow-ups', 'Activity']) {
    await tab(page, label);
    if (label === 'Team') await visibleText(page, privateText).waitFor();
    if (label === 'Follow-ups') {
      await page.getByRole('button', { name: `Complete ${followUpText}`, exact: true }).waitFor();
      await page.getByRole('button', { name: `Complete ${followUpText}`, exact: true }).scrollIntoViewIfNeeded();
    }
    await page.screenshot({ path: path.join(artifacts, `case-${label.toLowerCase()}-phone.png`), animations: 'disabled' });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${label} fits a phone viewport`);
  }
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto(`${webUrl}/inbox/${id}`);
  const withinViewport = async (locator, label) => {
    await locator.waitFor();
    const bounds = await locator.boundingBox();
    const viewport = page.viewportSize();
    assert.ok(bounds && bounds.width > 0 && bounds.height > 0 && bounds.x >= -1 && bounds.y >= -1 && bounds.x + bounds.width <= viewport.width + 1 && bounds.y + bounds.height <= viewport.height + 1, `${label} remains inside the short phone viewport`);
  };
  const usableHistory = async (testId, label) => {
    const history = page.getByTestId(testId);
    await withinViewport(history, label);
    const height = (await history.boundingBox()).height;
    assert.ok(height >= 70, `${label} retains room to read and scroll messages (got ${height}px)`);
  };
  await page.getByRole('button', { name: 'Case details', exact: true }).click();
  await page.getByRole('button', { name: 'Case owner', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Copy visitor link', exact: true }).click();
  await visibleText(page, 'Visitor link copied').waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), existingVisitorLink.url, 'phone case details copies the same visitor capability');
  await page.screenshot({ path: path.join(artifacts, 'case-details-short.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Close case details', exact: true }).click();
  await usableHistory('public-message-history', 'public history');
  await withinViewport(page.getByRole('textbox', { name: 'Reply', exact: true }), 'public reply field');
  await withinViewport(page.getByRole('button', { name: 'Send reply', exact: true }), 'public send button');
  await page.screenshot({ path: path.join(artifacts, 'case-conversation-short.png'), animations: 'disabled' });
  await tab(page, 'Team');
  await usableHistory('team-message-history', 'private team history');
  const shortDraft = 'A private draft on a short phone screen';
  await page.getByRole('textbox', { name: 'Team note', exact: true }).fill(shortDraft);
  await withinViewport(page.getByRole('textbox', { name: 'Team note', exact: true }), 'private note field while writing');
  await withinViewport(page.getByRole('button', { name: 'Add team note', exact: true }), 'private send button while writing');
  await withinViewport(page.getByRole('button', { name: 'Attach team files', exact: true }), 'private attachment control while writing');
  await visibleText(page, 'Team note · Private to your team').waitFor();
  await page.screenshot({ path: path.join(artifacts, 'case-team-short-writing.png'), animations: 'disabled' });
  const guestBeforeShortSend = await guestState();
  privateValues.push(shortDraft);
  await page.getByRole('button', { name: 'Add team note', exact: true }).click();
  await until(async () => await page.getByRole('textbox', { name: 'Team note', exact: true }).inputValue() === '', 'focused short-screen send reaches the private lane');
  assert.ok((await notes()).notes.some(note => note.text === shortDraft), 'the actual phone send button stores the private note');
  assert.deepEqual(await guestState(), guestBeforeShortSend, 'a note sent while focused on a short phone leaves guest JSON unchanged');
  const keptShortDraft = 'Another private draft kept on this phone';
  await page.getByRole('textbox', { name: 'Team note', exact: true }).fill(keptShortDraft);
  await page.getByRole('button', { name: 'Done writing', exact: true }).click();
  await tab(page, 'Conversation');
  assert.equal(await page.getByRole('textbox', { name: 'Reply', exact: true }).inputValue(), '', 'private short-screen draft stays out of visitor replies');
  await tab(page, 'Team');
  assert.equal(await page.getByRole('textbox', { name: 'Team note', exact: true }).inputValue(), keptShortDraft);
  const savedCase = await caseState();
  const savedNotes = await notes();
  const savedHistory = await api('GET', `${casePath}/activity`, undefined, owner.token);
  await stop(apiServer);
  await startApi();
  assert.deepEqual(await caseState(), savedCase, 'case reference and tasks persist across restart');
  assert.deepEqual(await notes(), savedNotes, 'private notes and file metadata persist across restart');
  assert.deepEqual(await api('GET', `${casePath}/activity`, undefined, owner.token), savedHistory, 'case activity persists across restart');
  await page.reload();
  await tab(page, 'Team');
  await visibleText(page, privateText).waitFor();
  await download(page, privateFile.name, privateBytes, `Download team file ${privateFile.name}`);
  configure(false);
  for (const route of [`${casePath}/case`, `${casePath}/notes`, `${casePath}/activity`, `${casePath}/notes/files/${file.id}`]) {
    const response = await request('GET', route, undefined, owner.token);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, 'feature_off');
  }
  configure(true);
  assert.deepEqual(await caseState(), savedCase, 'disabling the feature never removes case work');
  assert.deepEqual(await notes(), savedNotes);
  noPrivate(await guestState());
  for (const outbound of outerRequests) {
    assert.equal(outbound.headers.authorization, undefined);
    for (const secret of [privateText, secondNote, privateBytes.toString(), privateBytes.toString('base64'), followUpText, owner.token, member.token, started.token]) assert.equal(outbound.body.includes(secret), false, 'private case content and credentials stay inside encrypted envelopes');
  }
  assert.deepEqual(externalRequests, [], 'case work sends no data to external services');
  assert.deepEqual(pageErrors, [], 'case browsers have no uncaught errors');
  console.log('secure inbox cases e2e: OK — two staff collaborators, proactive case and scoped visitor link, private notes/files, separate drafts and retry, assigned dated follow-ups, complete/reopen, next action, activity, scope/reference search, guest metadata isolation and start replay, scoped files, restart, feature flag, encrypted wire, desktop and short-phone writing');
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
