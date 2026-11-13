#!/usr/bin/env node
// Real Expo web UI -> pinned encrypted API -> temporary server data -> UI.
// Run after npm ci --prefix app and npm ci --prefix desktop, then install a
// Playwright browser: cd desktop && npx playwright install chromium.
//   node scripts/glossary-e2e.mjs
// Optional: SERVANT_E2E_BROWSER=chrome uses installed Chrome; set
// SERVANT_GLOSSARY_WEB_URL to reuse a development server. No live data is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
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
const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'servant-glossary-e2e-'));
const artifacts = path.join(repository, 'desktop/dist/glossary-e2e');
fs.mkdirSync(artifacts, { recursive: true });
const data = path.join(scratch, 'data');
fs.mkdirSync(data, { mode: 0o700 });
const freePort = () => new Promise((resolve, reject) => {
  const listener = net.createServer();
  listener.on('error', reject);
  listener.listen(0, '127.0.0.1', () => { const port = listener.address().port; listener.close(() => resolve(port)); });
});
const waitFor = async (url, child, label) => {
  for (let i = 0; i < 120; i++) {
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
const waitUntil = async (check, label) => {
  for (let i = 0; i < 120; i++) {
    if (await check()) return;
    await delay(250);
  }
  throw new Error(`Timed out: ${label}`);
};
let browser, apiServer, webServer, page;
let serverOutput = '';
let webOutput = '';
const pageErrors = [];
// Only the agent is a fixture: UI messages still cross the real encrypted API.
// Keep the received body so submit assertions verify what reaches the agent.
const sessions = new Map();
const submissions = [];
const upstreamRequests = [];
const hermes = http.createServer(async (req, res) => {
  upstreamRequests.push(`${req.method} ${req.url}`);
  let raw = '';
  for await (const part of req) raw += part;
  const body = raw ? JSON.parse(raw) : {};
  const route = req.url.match(/^\/api\/sessions(?:\/([^/]+))?(\/.*)?$/);
  const id = route?.[1] && decodeURIComponent(route[1]);
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'POST' && req.url === '/api/sessions') {
    sessions.set(body.id, []);
    res.writeHead(201).end(JSON.stringify({ object: 'hermes.session', session: { id: body.id } }));
  } else if (sessions.has(id) && req.method === 'GET' && !route[2]) {
    res.end(JSON.stringify({ object: 'hermes.session', session: { id } }));
  } else if (sessions.has(id) && req.method === 'GET' && route[2] === '/messages') {
    res.end(JSON.stringify({ object: 'list', data: sessions.get(id) }));
  } else if (sessions.has(id) && req.method === 'POST' && route[2] === '/chat/stream') {
    submissions.push({ id, body });
    const messages = sessions.get(id);
    const reply = `Fixture reply ${submissions.length}.`;
    messages.push({ id: messages.length + 1, role: 'user', content: body.message });
    messages.push({ id: messages.length + 1, role: 'assistant', content: reply });
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const event = (name, payload) => res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
    event('run.started', {});
    event('assistant.delta', { delta: reply });
    event('assistant.completed', { content: reply });
    event('run.completed', { usage: { input_tokens: body.message.length, output_tokens: reply.length } });
    event('done', {});
    res.end();
  } else { res.writeHead(404); res.end(JSON.stringify({ error: 'Fixture endpoint not implemented' })); }
});

try {
  await new Promise(resolve => hermes.listen(0, '127.0.0.1', resolve));
  const port = await freePort();
  const apiUrl = `http://127.0.0.1:${port}`;
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({
    name: 'Glossary test server', publicUrl: apiUrl, discovery: 'off', discoveryUrl: '',
    upstreams: { owner: { url: `http://127.0.0.1:${hermes.address().port}`, key: 'fixture-key' } },
  }));
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
  const pair = async (name, role) => {
    const output = await run(process.execPath, [serverEntry, 'invite', '--name', name, '--role', role], { env });
    const code = output.stdout.match(/Invite code:\s*(\S+)/)?.[1];
    assert.ok(code, 'Fixture invite was created');
    const paired = await api('POST', '/v1/pair', { code, device: 'Browser E2E', terms: { version: TERMS_VERSION, items: TERMS_ITEMS } });
    return { ...paired, serverUrl: apiUrl, serverKey: serverIdentity(data).publicKey, serverName: 'Glossary test server' };
  };
  const owner = await pair('Pat Tester', 'owner');
  const reader = await pair('Jo Park', 'member');
  const { project } = await api('POST', '/v1/projects', { name: 'Example app', description: 'Synthetic glossary test', repo: 'example-org/example-app' }, owner.token);
  await api('POST', `/v1/projects/${project.id}/people`, { userId: reader.user.id, level: 'read' }, owner.token);

  const webUrl = process.env.SERVANT_GLOSSARY_WEB_URL || `http://127.0.0.1:${process.env.SERVANT_GLOSSARY_WEB_PORT || await freePort()}`;
  if (!process.env.SERVANT_GLOSSARY_WEB_URL) {
    webServer = spawn(process.execPath, [path.join(repository, 'app/node_modules/expo/bin/cli'), 'start', '--web', '--localhost', '--port', new URL(webUrl).port], {
      cwd: path.join(repository, 'app'), env: { ...env, CI: '1', EXPO_NO_TELEMETRY: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    webServer.stdout.on('data', chunk => { webOutput += chunk; });
    webServer.stderr.on('data', chunk => { webOutput += chunk; });
  }
  await waitFor(webUrl, webServer, 'Expo web');
  browser = await chromium.launch({ ...(process.env.SERVANT_E2E_BROWSER ? { channel: process.env.SERVANT_E2E_BROWSER } : {}) });
  const newPage = async (account, viewport) => {
    const context = await browser.newContext({ viewport });
    const id = accountId(account);
    await context.addInitScript(({ saved, key, indexKey, id }) => {
      localStorage.setItem(key, JSON.stringify(saved));
      localStorage.setItem(indexKey, JSON.stringify({ version: 1, ids: [id], activeId: id }));
    }, { saved: account, key: accountStorageKey(id), indexKey: ACCOUNTS_KEY, id });
    const opened = await context.newPage();
    opened.setDefaultTimeout(30000);
    opened.on('pageerror', error => pageErrors.push(error.message));
    return opened;
  };
  page = await newPage(owner, { width: 1280, height: 1000 });
  const about = `${webUrl}/project?id=${project.id}&tab=about`;
  const glossaryRoute = `/v1/projects/${project.id}/glossary`;
  await page.goto(about);
  await page.getByTestId('glossary-add').click();
  await page.getByRole('textbox', { name: 'Abbreviation', exact: true }).fill('API');
  await page.getByRole('textbox', { name: 'Replacement', exact: true }).fill('Application Programming Interface');
  assert.equal(await page.getByRole('heading', { name: 'Add shortcut', exact: true }).locator('..').getByRole('textbox').count(), 2, 'shortcut forms have only an abbreviation and replacement');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('button', { name: 'Edit API', exact: true }).waitFor();
  for (const [abbreviation, fullName] of [['QA', 'Quality Assurance'], ['QA', 'Queue Administration'], ['SDK', 'Software Development Kit']]) {
    await api('POST', glossaryRoute, { abbreviation, fullName }, owner.token);
  }
  await page.reload();
  await page.getByText('Application Programming Interface', { exact: true }).waitFor();
  await page.getByTestId('project-glossary').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(artifacts, 'glossary-desktop.png'), animations: 'disabled' });
  const readPage = await newPage(reader, { width: 390, height: 844 });
  await readPage.goto(about);
  await readPage.getByText('Application Programming Interface', { exact: true }).waitFor();
  assert.equal(await readPage.getByTestId('glossary-add').count(), 0, 'project readers cannot add shortcuts');
  assert.equal(await readPage.getByRole('button', { name: 'Edit API', exact: true }).count(), 0, 'project readers cannot edit shortcuts');
  await readPage.getByTestId('project-glossary').scrollIntoViewIfNeeded();
  await readPage.screenshot({ path: path.join(artifacts, 'glossary-phone.png'), animations: 'disabled' });
  await readPage.context().close();

  const received = async (before, value, label) => {
    await waitUntil(() => submissions.length > before, `${label}: agent receives message`);
    assert.equal(submissions.length, before + 1, `${label}: sends once`);
    assert.equal(submissions[before].body.message, value, `${label}: the server forwards exact replacement text`);
    await page.getByText(`Fixture reply ${before + 1}.`, { exact: true }).waitFor();
    assert.equal(await page.getByTestId('composer-input').inputValue(), '', `${label}: acceptance clears the draft`);
  };
  for (const [name, viewport] of [['desktop', { width: 1280, height: 1000 }], ['phone', { width: 390, height: 844 }]]) {
    const { chat } = await api('POST', '/v1/chats', { projectId: project.id, title: 'Shortcut example' }, owner.token);
    await page.setViewportSize(viewport);
    await page.goto(`${webUrl}/chat/${chat.id}`);
    const composer = page.getByTestId('composer-input');
    await composer.fill('API');
    await page.getByRole('button', { name: 'Abbreviations, 1', exact: true }).waitFor();
    await composer.press('Space');
    assert.equal(await composer.inputValue(), 'Application Programming Interface ', `${name}: a space replaces a known abbreviation`);
    await composer.fill('API');
    await composer.pressSequentially('.');
    const sentence = 'Application Programming Interface.';
    assert.equal(await composer.inputValue(), sentence, `${name}: a period follows the replacement`);
    assert.deepEqual(await composer.evaluate(node => ({ focused: document.activeElement === node, start: node.selectionStart, end: node.selectionEnd })),
      { focused: true, start: sentence.length, end: sentence.length }, `${name}: the caret stays after the period`);
    await composer.pressSequentially(' Next sentence.');
    assert.equal(await composer.inputValue(), `${sentence} Next sentence.`);
    for (const value of ['https://example.gov/API', '`API']) {
      await composer.fill(value);
      await composer.pressSequentially('.');
      assert.equal(await composer.inputValue(), `${value}.`, `${name}: protected text is unchanged`);
    }
    await composer.fill('API');
    await composer.press('Tab');
    const accepted = 'Application Programming Interface';
    assert.equal(await composer.inputValue(), accepted, `${name}: Tab accepts the replacement`);
    assert.deepEqual(await composer.evaluate(node => ({ focused: document.activeElement === node, start: node.selectionStart, end: node.selectionEnd })),
      { focused: true, start: accepted.length, end: accepted.length }, `${name}: Tab keeps the caret after the replacement`);
    for (const [value, key] of [['API', 'Shift+Tab'], ['UNKNOWN', 'Tab'], ['QA', 'Tab'], ['`API`', 'Tab']]) {
      await composer.fill(value);
      await composer.press(key);
      assert.equal(await composer.inputValue(), value, `${name}: ${key} preserves ${value}`);
      assert.equal(await composer.evaluate(node => document.activeElement === node), false, `${name}: normal focus movement remains available`);
    }
    let before = submissions.length;
    const draft = 'API QA `API` UNKNOWN https://example.gov/API api@example.gov @API /API SDK';
    await composer.fill(draft);
    if (name === 'desktop') await composer.press('Enter');
    else await page.getByTestId('composer-send').click();
    await page.getByRole('heading', { name: 'What is UNKNOWN?', exact: true }).waitFor();
    assert.equal(submissions.length, before, `${name}: the prompt waits before sending`);
    await page.getByRole('button', { name: 'Send as written', exact: true }).click();
    await received(before, 'Application Programming Interface QA `API` UNKNOWN https://example.gov/API api@example.gov @API /API Software Development Kit', name);

    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${name}: no horizontal overflow`);
  }

  const { project: otherProject } = await api('POST', '/v1/projects', { name: 'Another example' }, owner.token);
  for (const [name, viewport, abbreviation, replacement, canceled] of [
    ['desktop', { width: 1280, height: 1000 }, 'AAA', 'Automated Action Archive', 'ZZX'],
    ['phone', { width: 390, height: 844 }, 'BBB', 'Batch Build Board', 'ZZY'],
  ]) {
    const { chat } = await api('POST', '/v1/chats', { title: 'Shared shortcut example' }, owner.token);
    await page.setViewportSize(viewport);
    await page.goto(`${webUrl}/chat/${chat.id}`);
    const composer = page.getByTestId('composer-input');
    const getShortcut = async () => (await api('GET', '/v1/lexicon', undefined, owner.token)).entries.find(entry => entry.abbreviation === abbreviation);
    let before = submissions.length;
    await composer.fill(`${abbreviation} ${abbreviation}`);
    await page.getByTestId('composer-send').click();
    await page.getByRole('heading', { name: `What is ${abbreviation}?`, exact: true }).waitFor();
    assert.equal(submissions.length, before, `${name}: the unknown shortcut has not sent`);
    assert.equal(await getShortcut(), undefined, `${name}: opening the prompt creates nothing`);
    await page.getByRole('textbox', { name: `Replacement for ${abbreviation}`, exact: true }).fill(replacement);
    assert.equal(await page.getByTestId('learn-abbreviation').getByRole('textbox').count(), 1, `${name}: learning asks only for replacement text`);
    await page.screenshot({ path: path.join(artifacts, `learn-${name}.png`), animations: 'disabled' });
    await page.getByRole('button', { name: 'Save and send', exact: true }).click();
    await received(before, `${replacement} ${replacement}`, name);
    const shortcut = await getShortcut();
    assert.equal(shortcut.fullName, replacement);

    before = submissions.length;
    await composer.fill(canceled);
    await page.getByTestId('composer-send').click();
    await page.getByRole('heading', { name: `What is ${canceled}?`, exact: true }).waitFor();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByTestId('learn-abbreviation').waitFor({ state: 'detached' });
    assert.equal(await composer.inputValue(), canceled, `${name}: cancel keeps the draft`);
    assert.equal(await composer.isEditable(), true);
    assert.equal(submissions.length, before, `${name}: cancel sends nothing`);
    await page.getByTestId('composer-send').click();
    await page.getByRole('heading', { name: `What is ${canceled}?`, exact: true }).waitFor();
    await page.getByRole('button', { name: 'Send as written', exact: true }).click();
    await received(before, canceled, name);
    assert.equal((await api('GET', '/v1/lexicon', undefined, owner.token)).entries.some(entry => entry.abbreviation === canceled), false, `${name}: skip creates no shortcut`);

    const { chat: projectChat } = await api('POST', '/v1/chats', { projectId: otherProject.id, title: 'Shared shortcut in a project' }, owner.token);
    await page.goto(`${webUrl}/chat/${projectChat.id}`);
    await composer.fill(abbreviation);
    await page.getByRole('button', { name: 'Abbreviations, 1', exact: true }).waitFor();
    await composer.press('Space');
    assert.equal(await composer.inputValue(), `${replacement} `, `${name}: shared replacement works in another project`);
    await composer.pressSequentially(abbreviation);
    await composer.press('Tab');
    assert.equal(await composer.inputValue(), `${replacement} ${replacement}`, `${name}: Tab accepts the shared replacement`);
    before = submissions.length;
    await page.getByTestId('composer-send').click();
    await received(before, `${replacement} ${replacement}`, name);
    await page.goto(`${webUrl}/chat/${chat.id}`);
    await page.reload();
    await composer.fill(abbreviation);
    before = submissions.length;
    await page.getByTestId('composer-send').click();
    await received(before, replacement, name);
    assert.equal(await page.getByTestId('learn-abbreviation').count(), 0, `${name}: saved shortcuts need no prompt after reload`);

    await page.goto(`${webUrl}/lexicon`);
    await page.getByTestId('lexicon-search').fill(abbreviation);
    await page.getByTestId(`lexicon-entry-${shortcut.id}`).getByText(replacement, { exact: true }).waitFor();
    await page.getByRole('button', { name: `Edit ${abbreviation}`, exact: true }).click();
    const updated = `${replacement} Updated`;
    await page.getByRole('textbox', { name: 'Replacement', exact: true }).fill(updated);
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText(updated, { exact: true }).waitFor();
    assert.equal((await getShortcut()).fullName, updated, `${name}: replacement edits persist`);
    await page.reload();
    await page.getByTestId('lexicon-search').fill(abbreviation);
    await page.getByText(updated, { exact: true }).waitFor();
    await page.screenshot({ path: path.join(artifacts, `shortcuts-${name}.png`), animations: 'disabled' });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${name}: shortcut list fits the viewport`);
  }

  // A replacement that is a local command must be reviewed before it executes.
  await api('POST', '/v1/lexicon', { abbreviation: 'DOHELP', fullName: '/help' }, owner.token);
  const { chat: commandChat } = await api('POST', '/v1/chats', { title: 'Shortcut command review' }, owner.token);
  await page.goto(`${webUrl}/chat/${commandChat.id}`);
  const commandInput = page.getByTestId('composer-input');
  const commandBefore = submissions.length;
  await commandInput.fill('DOHELP');
  await page.getByTestId('composer-send').click();
  await waitUntil(async () => await commandInput.inputValue() === '/help', 'command replacement stays in the draft');
  assert.equal(submissions.length, commandBefore, 'a replacement cannot silently execute or send a command');
  assert.equal(await page.getByText('/help — Show what these commands do', { exact: false }).count(), 0, 'help has not executed');
  await page.getByTestId('composer-send').click();
  await page.getByText('/help — Show what these commands do', { exact: false }).waitFor();
  assert.equal(await commandInput.inputValue(), '', 'a second send executes the reviewed command');
  assert.equal(submissions.length, commandBefore, 'local help does not reach the agent');

  const memberPage = await newPage(reader, { width: 390, height: 844 });
  await memberPage.goto(`${webUrl}/lexicon`);
  await memberPage.getByTestId('lexicon-search').fill('AAA');
  await memberPage.getByText('Automated Action Archive Updated', { exact: true }).waitFor();
  assert.equal(await memberPage.getByRole('button', { name: 'Edit AAA', exact: true }).count(), 0, 'members cannot edit another author shortcut');
  assert.equal(await memberPage.getByRole('button', { name: 'Delete AAA', exact: true }).count(), 0, 'members cannot delete another author shortcut');
  const memberTerm = 'MEMLEX';
  await memberPage.getByRole('button', { name: 'Add shortcut', exact: true }).click();
  await memberPage.getByRole('textbox', { name: 'Abbreviation', exact: true }).fill(memberTerm);
  await memberPage.getByRole('textbox', { name: 'Replacement', exact: true }).fill('Member Example Shortcut');
  await memberPage.getByRole('button', { name: 'Save', exact: true }).click();
  await memberPage.getByRole('button', { name: `Edit ${memberTerm}`, exact: true }).waitFor();
  let memberEntries = (await api('GET', '/v1/lexicon', undefined, reader.token)).entries;
  assert.equal(memberEntries.find(entry => entry.abbreviation === 'AAA').canEdit, false);
  assert.equal(memberEntries.find(entry => entry.abbreviation === memberTerm).canEdit, true, 'members can create and edit their own shortcuts');
  await memberPage.getByRole('button', { name: `Delete ${memberTerm}`, exact: true }).click();
  await memberPage.getByRole('button', { name: 'Delete shortcut', exact: true }).click();
  await memberPage.getByText('Member Example Shortcut', { exact: true }).waitFor({ state: 'detached' });
  memberEntries = (await api('GET', '/v1/lexicon', undefined, reader.token)).entries;
  assert.equal(memberEntries.some(entry => entry.abbreviation === memberTerm), false, 'deletion persists');
  await memberPage.context().close();
  assert.deepEqual(pageErrors, [], 'no uncaught browser errors');
  console.log('shortcut e2e: OK — project access, desktop and phone typing/period/Tab/submit, pending lookup, timeout/retry, learn/cancel/skip, cross-chat reuse, pair CRUD and permissions');
  console.log(`Screenshots: ${artifacts}`);
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => {});
    console.error('Page:', (await page.locator('body').innerText().catch(() => '')).slice(-5000));
    console.error('Composer:', JSON.stringify(await page.getByTestId('composer-input').inputValue().catch(() => 'unavailable')));
  }
  console.error(error);
  console.error('Fixture upstream requests:', upstreamRequests);
  if (pageErrors.length) console.error('Browser errors:', pageErrors);
  console.error('Server output:', serverOutput.slice(-3000));
  if (webOutput) console.error('Expo output:', webOutput.slice(-3000));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await stop(webServer);
  await stop(apiServer);
  hermes.closeAllConnections();
  await new Promise(resolve => hermes.close(resolve));
  fs.rmSync(scratch, { recursive: true, force: true });
}
