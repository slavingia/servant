#!/usr/bin/env node
// Real Expo UI -> pinned encrypted API -> isolated SQLite -> UI.
// npm ci --prefix app && npm ci --prefix desktop
// cd desktop && npx playwright install chromium
// node scripts/saved-messages-e2e.mjs
// Optional: SERVANT_SAVED_WEB_URL reuses a running Expo web development server;
// SERVANT_E2E_BROWSER=chrome uses installed Chrome. All account data is synthetic.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { testFetch } from '../server/encrypted-test-client.mjs';
import { serverIdentity } from '../server/secure-transport.mjs';
import { TERMS_VERSION, TERMS_ITEMS } from '../server/terms.mjs';

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(path.join(repository, 'desktop/package.json'));
const { chromium } = require('playwright');
const run = promisify(execFile);
const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'servant-saved-e2e-'));
fs.chmodSync(scratch, 0o700);
const artifacts = path.join(repository, 'desktop/dist/saved-messages-e2e');
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
  for (let attempt = 0; attempt < 120; attempt++) {
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

let browser, apiServer, webServer, page, hermes;
let serverOutput = '', webOutput = '';
const pageErrors = [];
const externalRequests = [];

try {
  // A local synthetic Agent speaks the same session/SSE protocol as Hermes.
  // It completes only the fixture task; no real model or network service is used.
  const sessions = new Map();
  hermes = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    const json = (status, value) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    if (req.method === 'POST' && req.url === '/api/sessions') {
      sessions.set(body.id, []);
      return json(201, { session: { id: body.id } });
    }
    const match = req.url.match(/^\/api\/sessions\/([^/]+)(\/.*)?$/);
    const id = match && decodeURIComponent(match[1]);
    if (!sessions.has(id)) return json(404, {});
    if (req.method === 'GET') return json(200, match[2] === '/messages' ? { data: sessions.get(id) } : { session: { id } });
    if (req.method !== 'POST' || match[2] !== '/chat/stream') return json(404, {});
    const reply = 'Finished the example follow-up.\n<servant-todo-done/>';
    sessions.get(id).push({ role: 'user', content: body.message }, { role: 'assistant', content: reply });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = (name, value) => res.write(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`);
    emit('run.started', {});
    emit('assistant.completed', { content: reply });
    emit('run.completed', { usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
    emit('done', {}); res.end();
  });
  await new Promise(resolve => hermes.listen(0, '127.0.0.1', resolve));
  const port = await freePort();
  const apiUrl = `http://127.0.0.1:${port}`;
  const pushConfig = path.join(scratch, 'push-disabled.json');
  fs.writeFileSync(pushConfig, '{}\n', { mode: 0o600 });
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({
    host: '127.0.0.1', port, name: 'Saved messages test', publicUrl: apiUrl,
    discovery: 'off', discoveryUrl: '', defaultAgentTier: 3,
    upstreams: { owner: { url: `http://127.0.0.1:${hermes.address().port}`, key: 'synthetic-local-key' } },
  }), { mode: 0o600 });
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SERVANT_|HERMES_|API_SERVER_KEY$)/.test(key))),
    SERVANT_DATA_DIR: data, SERVANT_RUNTIME_DIR: runtime,
    SERVANT_HOST: '127.0.0.1', SERVANT_PORT: String(port), SERVANT_PUBLIC_URL: apiUrl,
    SERVANT_DISCOVERY_URL: '', SERVANT_PUSH_CONFIG: pushConfig,
    SERVANT_WORKER_MODE: 'internal', SERVANT_SHUTDOWN_TIMEOUT_MS: '1000',
  };
  const serverEntry = path.join(repository, 'server/server.mjs');
  const startApi = async () => {
    apiServer = spawn(process.execPath, [serverEntry], { cwd: repository, env, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [apiServer.stdout, apiServer.stderr]) stream.on('data', chunk => { serverOutput = (serverOutput + chunk).slice(-6000); });
    await waitFor(`${apiUrl}/health`, apiServer, 'API server');
  };
  await startApi();
  const api = async (method, route, body, token) => {
    const response = await testFetch(data, apiUrl + route, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000),
    });
    const json = await response.json();
    assert.ok(response.ok, `${method} ${route}: ${response.status} ${JSON.stringify(json)}`);
    return json;
  };
  const pair = async (name, role) => {
    const output = await run(process.execPath, [serverEntry, 'invite', '--name', name, '--role', role], { env });
    const code = output.stdout.match(/Invite code:\s*(\S+)/)?.[1];
    assert.ok(code, 'Fixture invite was created');
    const paired = await api('POST', '/v1/pair', { code, device: 'Browser E2E', terms: { version: TERMS_VERSION, items: TERMS_ITEMS } });
    return { ...paired, serverUrl: apiUrl, serverKey: serverIdentity(data).publicKey, serverName: 'Saved messages test' };
  };
  const owner = await pair('Pat Tester', 'owner');
  const member = await pair('Jo Park', 'member');
  const { conversation: channel } = await api('POST', '/v1/conversations', {
    name: 'saved-demo', topic: 'Synthetic saved message checks', memberIds: [member.user.id],
  }, owner.token);
  const post = async (text, threadRoot, token = owner.token, conversationId = channel.id) =>
    (await api('POST', `/v1/conversations/${conversationId}/messages`, { text, ...(threadRoot ? { threadRoot } : {}) }, token)).message;
  const oldRoot = await post('Prepare the example release checklist');
  const reply = await post('Review the checklist and report any gaps', oldRoot.id, member.token);
  // Prove opening the original does not depend on the most recent 50 messages.
  for (let n = 1; n <= 55; n++) await post(`Example update ${n}: routine progress`);
  const recent = await post('Send the example notes after the review');
  const { conversation: dm } = await api('POST', '/v1/conversations', { kind: 'dm', userIds: [member.user.id] }, owner.token);
  const dmMessage = await post('Follow up with the example team', undefined, member.token, dm.id);
  const webUrl = process.env.SERVANT_SAVED_WEB_URL || `http://127.0.0.1:${await freePort()}`;
  if (!process.env.SERVANT_SAVED_WEB_URL) {
    webServer = spawn(process.execPath, [path.join(repository, 'app/node_modules/expo/bin/cli'), 'start', '--web', '--localhost', '--port', new URL(webUrl).port], {
      cwd: path.join(repository, 'app'), env: { ...env, CI: '1', EXPO_NO_TELEMETRY: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [webServer.stdout, webServer.stderr]) stream.on('data', chunk => { webOutput = (webOutput + chunk).slice(-6000); });
  }
  await waitFor(webUrl, webServer, 'Expo web');
  browser = await chromium.launch({ ...(process.env.SERVANT_E2E_BROWSER ? { channel: process.env.SERVANT_E2E_BROWSER } : {}) });
  const newPage = async (account, viewport) => {
    const context = await browser.newContext({ viewport });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: webUrl });
    await context.route(/^https?:\/\//, route => {
      const origin = new URL(route.request().url()).origin;
      if (origin === apiUrl || origin === new URL(webUrl).origin) return route.continue();
      externalRequests.push(origin);
      return route.abort('blockedbyclient');
    });
    await context.addInitScript(saved => {
      if (!localStorage.getItem('servant.accounts')) localStorage.setItem('servant.account', JSON.stringify(saved));
    }, account);
    const opened = await context.newPage();
    opened.setDefaultTimeout(30000);
    opened.on('pageerror', error => pageErrors.push(error.message));
    return opened;
  };
  // Expo keeps previous stack screens mounted and hidden on web.
  const row = message => page.locator(`[data-testid="saved-message-${message.id}"]:visible`);
  const workRow = completion => page.locator(`[data-testid="saved-completion-${completion.id}"]:visible`);
  const mixedRow = entry => page.locator(`[data-testid="work-log-${entry.id}"]:visible`);
  const workLog = async account => (await api('GET', '/v1/work-log', undefined, account.token)).items;
  const waitForEntry = async predicate => {
    for (let n = 0; n < 200; n++) {
      const entry = (await workLog(owner)).find(predicate);
      if (entry) return entry;
      await delay(50);
    }
    assert.fail('Automatic work-log entry did not arrive');
  };
  const savedState = account => api('GET', '/v1/saved-messages', undefined, account.token);
  const savedItems = async account => (await savedState(account)).items;
  const copyReport = async () => {
    await page.bringToFront();
    await page.evaluate(() => navigator.clipboard.writeText('Saved report clipboard check'));
    await page.getByRole('button', { name: 'Copy to clipboard', exact: true }).click();
    await page.getByText('Report copied', { exact: true }).filter({ visible: true }).waitFor();
    await page.waitForFunction(() => navigator.clipboard.readText().then(text => text.startsWith('# Work log')));
    const text = await page.evaluate(() => navigator.clipboard.readText());
    assert.match(text, /^# Work log/m, 'clipboard contains the actual Markdown report');
    // Markdown quotes safely escape punctuation in user data and timestamps.
    // Compare the readable content after removing those punctuation escapes.
    return text.replace(/\\([^\w\s])/g, '$1');
  };
  const menu = async (message, ellipsis = false) => {
    if (ellipsis) {
      // The latest root is the first row of the inverted conversation list.
      await page.getByRole('button', { name: `Actions for ${message.user.name}'s message`, exact: true }).first().click();
    } else {
      await page.getByText(message.text, { exact: true }).filter({ visible: true }).last().click({ delay: 600 });
    }
    await page.getByRole('button', { name: 'Save for later', exact: true }).waitFor();
  };
  const save = async (message, ellipsis = false) => {
    await menu(message, ellipsis);
    await page.getByRole('button', { name: 'Save for later', exact: true }).click();
    await page.getByText('Saved for later. Only you can see your list.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Remove from saved', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  };

  page = await newPage(owner, { width: 1280, height: 900 });
  await page.goto(`${webUrl}/c/${channel.id}`);
  await save(recent, true);
  await page.getByRole('button', { name: 'Saved', exact: true }).click();
  await row(recent).waitFor();
  assert.deepEqual((await savedItems(owner)).map(item => item.messageId), [recent.id], 'message-menu save persisted through the encrypted API');
  await page.reload();
  await row(recent).waitFor();

  await page.goto(`${webUrl}/thread?${new URLSearchParams({ conv: channel.id, root: oldRoot.id })}`);
  await save(oldRoot);
  await save(reply);
  await page.goto(`${webUrl}/c/${dm.id}`);
  await save(dmMessage);
  await page.getByRole('button', { name: 'Saved', exact: true }).click();
  for (const message of [recent, oldRoot, reply, dmMessage]) await row(message).waitFor();
  assert.equal((await savedItems(owner)).length, 4, 'root, reply and DM all save to one private list');

  // Row operation labels and navigation checks are intentionally exercised
  // through the rendered controls, not direct saved-message API mutations.
  const workNote = 'Reviewed the example notes and sent the final summary';
  await row(recent).getByRole('button', { name: 'Add work note', exact: true }).click();
  await row(recent).getByRole('textbox', { name: 'Work completed', exact: true }).fill(workNote);
  const completedAfter = Date.now();
  await row(recent).getByRole('button', { name: 'Complete task', exact: true }).click();
  await page.getByRole('tab', { name: /Completed/ }).click();
  await row(recent).waitFor();
  await page.screenshot({ path: path.join(artifacts, 'saved-completed-desktop.png'), animations: 'disabled' });
  const firstCompletion = (await savedState(owner)).history.find(item => item.messageId === recent.id);
  assert.ok(firstCompletion, 'completing through the UI records a work-log event');
  assert.equal(firstCompletion.note, workNote);
  assert.ok(firstCompletion.completedAt >= completedAfter && firstCompletion.completedAt <= Date.now(), 'the server records the completion time');
  assert.equal(firstCompletion.reopenedAt, null);
  await page.getByRole('tab', { name: /Work log/ }).click();
  await workRow(firstCompletion).getByText(workNote, { exact: true }).waitFor();
  assert.match(await workRow(firstCompletion).innerText(), /\d{1,2}:\d{2}/, 'work log shows a clock time, not just the date');
  const initialReport = await copyReport();
  assert.ok(initialReport.includes(workNote) && initialReport.includes(recent.text));
  assert.ok(initialReport.includes(new Date(firstCompletion.completedAt).toISOString()), 'copy includes the exact completion timestamp');
  // Exercise a denied clipboard after proving the real platform copy succeeds.
  // Expo also falls back to execCommand, so both platform paths must refuse it.
  await page.evaluate(async () => {
    await navigator.clipboard.writeText('Saved report clipboard failure check');
    const writeText = navigator.clipboard.writeText;
    const execCommand = document.execCommand;
    window.__restoreSavedReportClipboard = () => {
      navigator.clipboard.writeText = writeText;
      document.execCommand = execCommand;
      delete window.__restoreSavedReportClipboard;
    };
    navigator.clipboard.writeText = async () => { throw new DOMException('Synthetic clipboard denial', 'NotAllowedError'); };
    document.execCommand = (command, ...args) => command === 'copy' ? false : execCommand.call(document, command, ...args);
  });
  await page.getByRole('button', { name: 'Copy to clipboard', exact: true }).click();
  await page.getByTestId('saved-report-fallback').filter({ visible: true }).waitFor();
  assert.ok((await page.getByTestId('saved-report-fallback').innerText()).includes(workNote), 'copy failure leaves a selectable report');
  assert.equal(await page.getByText('Report copied', { exact: true }).filter({ visible: true }).count(), 0, 'failed clipboard writes never claim success');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Saved report clipboard failure check');
  await page.evaluate(() => window.__restoreSavedReportClipboard());
  assert.ok((await copyReport()).includes(workNote), 'copy can be retried after platform access returns');

  // The open Work log refreshes automatically as other clients and the Agent
  // finish work; these are real encrypted API writes, not browser state fixtures.
  const manualTodo = (await api('POST', '/v1/todos', { text: 'Review the example release plan' }, owner.token)).todo;
  const taskPage = await newPage(owner, { width: 1280, height: 900 });
  await taskPage.goto(`${webUrl}/todos?${new URLSearchParams({ id: manualTodo.id })}`);
  await taskPage.getByRole('checkbox', { name: `Not done: ${manualTodo.text}. Tap to mark done`, exact: true }).click();
  await taskPage.getByRole('checkbox', { name: `Done: ${manualTodo.text}. Tap to reopen`, exact: true }).waitFor();
  await page.bringToFront();
  const manualEntry = await waitForEntry(entry => entry.todoId === manualTodo.id);
  await mixedRow(manualEntry).getByText(manualTodo.text, { exact: true }).waitFor();
  assert.deepEqual(manualEntry.completedBy, { kind: 'person', id: owner.user.id, name: owner.user.name });

  const agentTodo = (await api('POST', '/v1/todos', { text: 'Prepare the example follow-up' }, owner.token)).todo;
  await taskPage.goto(`${webUrl}/todos?${new URLSearchParams({ id: agentTodo.id })}`);
  await taskPage.getByRole('button', { name: `Send to the agent: ${agentTodo.text}`, exact: true }).click();
  await taskPage.waitForURL(url => url.pathname.startsWith('/chat/'));
  await page.bringToFront();
  const agentEntry = await waitForEntry(entry => entry.todoId === agentTodo.id);
  assert.deepEqual(agentEntry.completedBy, { kind: 'agent' });
  await mixedRow(agentEntry).getByText(/^Completed by Agent ·/).waitFor();
  await taskPage.context().close();

  const recording = await api('POST', '/v1/recordings', { size: 1, durationMs: 60000, ext: 'webm' }, owner.token);
  await api('POST', `/v1/recordings/${recording.id}/chunk`, { offset: 0, data: Buffer.from('x').toString('base64') }, owner.token);
  const recordingTitle = 'Example planning memo';
  const finishedRecording = await api('POST', `/v1/recordings/${recording.id}/finish`, { title: recordingTitle }, owner.token);
  assert.equal(finishedRecording.recording.status, 'failed', 'synthetic short audio exercises a notes failure');
  const recordingEntry = await waitForEntry(entry => entry.recordingId === recording.id);
  assert.deepEqual([recordingEntry.kind, recordingEntry.durationMs], ['recording', 60000]);
  await mixedRow(recordingEntry).getByText(recordingTitle, { exact: true }).waitFor();
  assert.match(await mixedRow(recordingEntry).innerText(), /Added .*Recording: 1 min/);
  await page.getByText('3 completions · 1 voice memo · 1 by Agent', { exact: true }).waitFor();
  const mixedReport = await copyReport();
  for (const text of [recordingTitle, agentTodo.text, manualTodo.text, 'Completed by Agent', '1 voice memo', '1 completion by Agent']) assert.ok(mixedReport.includes(text), `mixed report includes ${text}`);
  assert.match(mixedReport, /3 completion events; 3 distinct tasks; 1 voice memo/);
  await page.screenshot({ path: path.join(artifacts, 'work-log-desktop.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Saved', exact: true }).waitFor({ state: 'hidden' });
  // The responsive navigation remounts this screen when crossing its breakpoint.
  await page.getByRole('tab', { name: /Work log/ }).click();
  await mixedRow(recordingEntry).waitFor();
  await page.screenshot({ path: path.join(artifacts, 'work-log-phone.png'), animations: 'disabled' });
  await mixedRow(agentEntry).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(artifacts, 'work-log-phone-entries.png'), animations: 'disabled' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: 'Saved', exact: true }).waitFor();
  await page.getByRole('tab', { name: /Work log/ }).click();
  await mixedRow(agentEntry).getByRole('button', { name: 'Open to-do', exact: true }).click();
  await page.waitForURL(url => url.pathname === '/todos' && url.searchParams.get('id') === agentTodo.id);
  await page.getByRole('checkbox', { name: `Done: ${agentTodo.text}. Tap to reopen`, exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: `${manualTodo.text}. Edit`, exact: true }).filter({ visible: true }).count(), 0, 'Open to-do selects the exact completed task');
  await page.getByRole('button', { name: 'Saved', exact: true }).click();
  await page.getByRole('tab', { name: /Work log/ }).click();
  await api('PATCH', `/v1/todos/${manualTodo.id}`, { status: 'open' }, owner.token);
  await mixedRow(manualEntry).getByText(/Reopened/).waitFor();
  await api('DELETE', `/v1/todos/${manualTodo.id}`, undefined, owner.token);
  await mixedRow(manualEntry).getByText('This to-do is no longer available.', { exact: true }).waitFor();
  const retainedTodo = (await workLog(owner)).find(entry => entry.id === manualEntry.id);
  assert.ok(retainedTodo.reopenedAt && retainedTodo.at === manualEntry.at && retainedTodo.source === null);
  assert.equal((await copyReport()).includes(manualTodo.text), false, 'deleted to-do source text is omitted from exports');
  await page.reload();
  await page.getByRole('tab', { name: /Completed/ }).click();
  await row(recent).getByRole('checkbox').click();
  await page.getByRole('tab', { name: /In progress/ }).click();
  await row(recent).waitFor();
  assert.equal((await savedItems(owner)).find(item => item.messageId === recent.id).completedAt, null);
  const reopenedCompletion = (await savedState(owner)).history.find(item => item.id === firstCompletion.id);
  assert.equal(reopenedCompletion.note, workNote, 'reopening does not replace the authored work note');
  assert.equal(reopenedCompletion.completedAt, firstCompletion.completedAt, 'reopening preserves the original completion time');
  assert.ok(reopenedCompletion.reopenedAt >= firstCompletion.completedAt);

  // Another signed-in client can finish the same task while this browser is
  // writing a note. The rejected note remains a draft and the refreshed state
  // offers a real way to reopen the task and record that additional work.
  const concurrent = await post('Finish the concurrent example review');
  await api('POST', `/v1/saved-messages/${concurrent.id}`, {}, owner.token);
  await page.reload();
  await row(concurrent).getByRole('button', { name: 'Add work note', exact: true }).click();
  const draftNote = 'Drafted the example review summary';
  const otherNote = 'Completed the example review on another device';
  await row(concurrent).getByRole('textbox', { name: 'Work completed', exact: true }).fill(draftNote);
  await api('PATCH', `/v1/saved-messages/${concurrent.id}`, { completed: true, note: otherNote, requestId: randomUUID() }, owner.token);
  await row(concurrent).getByRole('button', { name: 'Complete task', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'already completed on another device' }).waitFor();
  await page.getByRole('tab', { name: /Completed/ }).click();
  await row(concurrent).getByRole('checkbox').click();
  await page.getByRole('tab', { name: /In progress/ }).click();
  await row(concurrent).getByRole('button', { name: 'Edit work note', exact: true }).click();
  assert.equal(await row(concurrent).getByRole('textbox', { name: 'Work completed', exact: true }).inputValue(), draftNote, 'conflicting completion preserves the unsaved draft through reopen');
  await row(concurrent).getByRole('button', { name: 'Complete task', exact: true }).click();
  await page.getByRole('tab', { name: /Completed/ }).click();
  await row(concurrent).waitFor();
  const concurrentHistory = (await savedState(owner)).history.filter(item => item.messageId === concurrent.id);
  assert.equal(concurrentHistory.length, 2);
  assert.deepEqual(concurrentHistory.map(item => item.note).sort(), [draftNote, otherNote].sort(), 'both clients retain their authored completion notes');
  assert.ok(concurrentHistory.find(item => item.note === otherNote).reopenedAt);
  await row(concurrent).getByRole('button', { name: /^Remove saved message:/ }).click();
  await row(concurrent).waitFor({ state: 'detached' });
  assert.equal((await savedItems(owner)).length, 4);

  // A historical fixture makes range filtering observable without changing the
  // app/server clocks (the encrypted transport deliberately rejects clock skew).
  // Only INSERT is used: authored completion history is append-only.
  const oldCompletion = {
    id: 'completion_old_fixture', note: 'Prepared the earlier example release',
    completedAt: Date.now() - 45 * 24 * 60 * 60 * 1000,
  };
  const fixtureDb = new DatabaseSync(path.join(data, 'messages.db'));
  try {
    fixtureDb.exec('PRAGMA busy_timeout=5000');
    fixtureDb.prepare('INSERT INTO saved_message_completions (id,user_id,message_seq,saved_at,completed_at,note,reopened_at) VALUES (?,?,?,?,?,?,?)')
      .run(oldCompletion.id, owner.user.id, Number(oldRoot.id), oldCompletion.completedAt - 60000, oldCompletion.completedAt, oldCompletion.note, oldCompletion.completedAt + 60000);
  } finally { fixtureDb.close(); }
  await page.reload();
  await page.getByRole('tab', { name: /Work log/ }).click();
  await page.getByRole('radio', { name: 'Today', exact: true }).click();
  await workRow(firstCompletion).waitFor();
  assert.equal(await workRow(oldCompletion).count(), 0, 'Today excludes an older completion');
  await page.getByRole('radio', { name: 'All time', exact: true }).click();
  await workRow(oldCompletion).getByText(oldCompletion.note, { exact: true }).waitFor();
  await page.getByRole('radio', { name: 'Custom', exact: true }).click();
  const oldDate = new Date(oldCompletion.completedAt).toLocaleDateString('en-CA');
  await page.getByRole('textbox', { name: 'From date', exact: true }).fill(oldDate);
  await page.getByRole('textbox', { name: 'To date', exact: true }).fill(oldDate);
  await workRow(oldCompletion).waitFor();
  await workRow(firstCompletion).waitFor({ state: 'detached' });
  assert.equal(await workRow(firstCompletion).count(), 0, 'custom dates include only completions in the selected period');
  const oldReport = await copyReport();
  assert.ok(oldReport.includes(oldCompletion.note));
  assert.equal(oldReport.includes(workNote), false, 'clipboard respects the selected date period');
  assert.equal(oldReport.includes(recordingTitle) || oldReport.includes(agentTodo.text), false, 'period filters apply to automatic entries too');
  await page.getByRole('radio', { name: 'All time', exact: true }).click();
  await workRow(firstCompletion).waitFor();
  assert.match(await workRow(firstCompletion).innerText(), /Reopened/);
  await page.screenshot({ path: path.join(artifacts, 'saved-worklog-desktop.png'), animations: 'disabled' });
  await page.getByRole('tab', { name: /In progress/ }).click();

  for (const message of [oldRoot, reply]) {
    await row(message).getByRole('button', { name: 'Open message', exact: true }).click();
    await page.waitForURL(url => url.pathname === '/thread' && url.searchParams.get('focus') === message.id);
    await page.getByText('Saved message', { exact: true }).waitFor();
    assert.ok(await page.getByText(message.text, { exact: true }).filter({ visible: true }).last().isVisible(), 'saved source is highlighted and visible');
    await page.getByRole('button', { name: 'Saved', exact: true }).click();
    await row(message).waitFor();
  }
  await page.screenshot({ path: path.join(artifacts, 'saved-desktop.png'), animations: 'disabled' });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'desktop has no horizontal overflow');

  // Another person can read the same channel but cannot see its reader's saves.
  const otherPage = await newPage(member, { width: 390, height: 844 });
  await otherPage.goto(`${webUrl}/saved`);
  await otherPage.getByText('Nothing to follow up', { exact: true }).waitFor();
  assert.equal((await savedItems(member)).length, 0, 'saved messages are private to their owner');
  assert.deepEqual((await savedState(member)).history, [], 'work notes and completion history are private to their owner');
  assert.deepEqual(await workLog(member), [], 'automatic recording and to-do events remain private to their owner');
  await otherPage.context().close();

  const edited = 'Send the revised example notes after the review';
  await api('PATCH', `/v1/messages/${recent.id}`, { text: edited }, owner.token);
  await page.reload();
  await row(recent).getByText(edited, { exact: true }).waitFor();
  await api('DELETE', `/v1/messages/${recent.id}`, undefined, owner.token);
  await page.reload();
  await row(recent).getByText('This message is no longer available.', { exact: true }).waitFor();
  assert.equal(await row(recent).getByRole('button', { name: 'Open message', exact: true }).count(), 0, 'deleted text is not retained or linked');
  await row(recent).getByRole('button', { name: /^Remove saved message:/ }).click();
  await row(recent).waitFor({ state: 'detached' });
  assert.equal((await savedItems(owner)).length, 3);
  await page.getByRole('tab', { name: /Work log/ }).click();
  await page.getByRole('radio', { name: 'All time', exact: true }).click();
  await workRow(firstCompletion).getByText(workNote, { exact: true }).waitFor();
  const removedHistory = (await savedState(owner)).history.find(item => item.id === firstCompletion.id);
  assert.equal(removedHistory.note, workNote, 'removing the saved reference keeps the work log');
  assert.equal(removedHistory.completedAt, firstCompletion.completedAt);
  assert.equal(removedHistory.message, null, 'deleted source text is not preserved in private work history');
  assert.equal(removedHistory.conversation, null);
  const redactedReport = await copyReport();
  assert.ok(redactedReport.includes(workNote));
  assert.equal(redactedReport.includes(recent.text), false);
  assert.equal(redactedReport.includes(edited), false, 'copy omits inaccessible or deleted source content');

  // The same private list follows this account on a phone-width browser.
  await page.context().close();
  page = await newPage(owner, { width: 390, height: 844 });
  await page.goto(`${webUrl}/channels`);
  await page.getByRole('tab', { name: 'You', exact: true }).click();
  await page.getByRole('button', { name: 'Saved', exact: true }).click();
  await row(oldRoot).waitFor();
  await row(dmMessage).getByRole('button', { name: 'Open message', exact: true }).click();
  await page.waitForURL(url => url.pathname === '/thread' && url.searchParams.get('focus') === dmMessage.id);
  // Scope the press to the source row; the old checklist remains mounted while
  // the phone stack animation runs and contains an identical preview.
  const phoneSource = page.getByRole('button', { name: `Actions for ${dmMessage.user.name}'s message`, exact: true }).locator('..');
  await phoneSource.getByText(dmMessage.text, { exact: true }).click({ delay: 600 });
  await page.getByRole('button', { name: 'Remove from saved', exact: true }).click();
  await page.getByText('Removed from Saved', { exact: true }).waitFor();
  assert.equal((await savedItems(owner)).some(item => item.messageId === dmMessage.id), false, 'phone menu can remove a saved message');
  await page.getByRole('button', { name: 'Save for later', exact: true }).click();
  await page.getByText('Saved for later. Only you can see your list.', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(artifacts, 'saved-phone-menu.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'View saved messages', exact: true }).click();
  await row(dmMessage).waitFor();
  await page.screenshot({ path: path.join(artifacts, 'saved-phone.png'), animations: 'disabled' });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'phone has no horizontal overflow');
  await row(dmMessage).getByRole('checkbox').click();
  await page.getByRole('tab', { name: /Completed/ }).click();
  await row(dmMessage).waitFor();
  await page.screenshot({ path: path.join(artifacts, 'saved-completed-phone.png'), animations: 'disabled' });
  const phoneCompletion = (await savedState(owner)).history.find(item => item.messageId === dmMessage.id);
  assert.ok(phoneCompletion);
  assert.equal(phoneCompletion.note, '', 'one-tap completion works without a note');
  await row(dmMessage).getByRole('checkbox').click();
  await page.getByRole('tab', { name: /In progress/ }).click();
  await row(dmMessage).waitFor();
  await page.getByRole('tab', { name: /Work log/ }).click();
  await page.getByRole('radio', { name: 'All time', exact: true }).click();
  await workRow(firstCompletion).getByText(workNote, { exact: true }).waitFor();
  await workRow(phoneCompletion).waitFor();
  const phoneReport = await copyReport();
  assert.ok(phoneReport.includes(workNote) && phoneReport.includes(dmMessage.text));
  assert.ok(phoneReport.includes(recordingTitle) && phoneReport.includes('Completed by Agent'), 'phone clipboard includes automatic work with explicit Agent attribution');
  await page.screenshot({ path: path.join(artifacts, 'saved-worklog-phone.png'), animations: 'disabled' });
  await page.getByRole('tab', { name: /In progress/ }).click();

  // Removing a source cannot remove the automatic recording event or expose its
  // former title after a fresh process reads the durable work log.
  await api('DELETE', `/v1/recordings/${recording.id}`, undefined, owner.token);
  assert.deepEqual((await workLog(owner)).find(entry => entry.id === recordingEntry.id), { ...recordingEntry, source: null });

  // A transport outage must expose retry, not pretend an empty list was loaded.
  await page.route(`${apiUrl}/v1/secure`, route => route.abort('connectionrefused'));
  await page.reload();
  await page.getByRole('button', { name: 'Try again', exact: true }).waitFor();
  assert.ok(await page.getByRole('alert').count(), 'outage explains the failed load');
  await page.unroute(`${apiUrl}/v1/secure`);
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await row(oldRoot).waitFor();

  // A fresh API process reads the same saved references from SQLite.
  await stop(apiServer);
  await startApi();
  await page.reload();
  await row(oldRoot).waitFor();
  assert.equal((await savedItems(owner)).length, 3, 'saved list persists across server restart');
  const restartedHistory = (await savedState(owner)).history;
  assert.equal(restartedHistory.length, 5, 'completion history survives reopening, removal and a fresh API process');
  assert.equal(restartedHistory.find(item => item.id === firstCompletion.id).note, workNote);
  assert.equal(restartedHistory.find(item => item.id === firstCompletion.id).completedAt, firstCompletion.completedAt);
  assert.equal(restartedHistory.find(item => item.id === firstCompletion.id).reopenedAt, reopenedCompletion.reopenedAt);
  assert.deepEqual(restartedHistory.filter(item => item.messageId === concurrent.id).map(item => item.note).sort(), [draftNote, otherNote].sort());
  await page.getByRole('tab', { name: /Work log/ }).click();
  await page.getByRole('radio', { name: 'All time', exact: true }).click();
  await workRow(firstCompletion).getByText(workNote, { exact: true }).waitFor();
  const restartedWork = await workLog(owner);
  assert.deepEqual(restartedWork.find(entry => entry.id === recordingEntry.id), { ...recordingEntry, source: null });
  assert.deepEqual(restartedWork.find(entry => entry.id === manualEntry.id), retainedTodo);
  assert.deepEqual(restartedWork.find(entry => entry.id === agentEntry.id), agentEntry);
  const restartedReport = await copyReport();
  assert.ok(restartedReport.includes('Completed by Agent'));
  assert.equal(restartedReport.includes(recordingTitle) || restartedReport.includes(manualTodo.text), false, 'removed source content remains absent after restart');
  assert.deepEqual(externalRequests, [], 'the work log and clipboard export never send content to an external service');
  assert.deepEqual(pageErrors, [], 'no uncaught browser errors');
  console.log('saved messages e2e: OK — roots/replies/DMs, notes and timestamps, automatic to-do/Agent/recording log, live refresh, exact completed task navigation, persistent private history, date filters, real Markdown clipboard, source privacy, complete/reopen/remove, outage retry, desktop and phone');
  console.log(`Screenshots: ${artifacts}`);
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {});
    console.error('Page:', (await page.locator('body').innerText().catch(() => '')).slice(-5000));
  }
  console.error(error);
  if (pageErrors.length) console.error('Browser errors:', pageErrors);
  console.error('Server output:', serverOutput.slice(-3000));
  if (webOutput) console.error('Expo output:', webOutput.slice(-3000));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await stop(webServer);
  await stop(apiServer);
  if (hermes) await new Promise(resolve => hermes.close(resolve));
  fs.rmSync(scratch, { recursive: true, force: true });
}
