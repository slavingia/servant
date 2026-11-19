#!/usr/bin/env node
// The onboarding tour in the real Expo web UI against a temporary server: someone joins and the tour opens,
// they choose a role, and each page says what is true for them: an owner, a full member, a researcher, a member
// with a 5M limit and someone with no agent. Saves captures to docs/captures/onboarding-tour.
// Run after npm ci --prefix app and npm ci --prefix desktop, then: cd desktop && npx playwright install chromium.
//   node scripts/onboarding-tour-e2e.mjs
// SERVANT_E2E_BROWSER=chrome uses installed Chrome. SERVANT_E2E_MODULES=<a package.json> finds Playwright somewhere
// other than desktop/. SERVANT_TOUR_E2E_APP=<another checkout's app directory> with SERVANT_TOUR_E2E_BEFORE=1
// captures that checkout after joining and its You page, for a "before" picture. Captures go to after/ and before/
// there. SERVANT_E2E_DEBUG=<folder> saves what each page showed if a step fails. No live data is used.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { serverIdentity } from '../server/secure-transport.mjs';
import { testFetch } from '../server/encrypted-test-client.mjs';
import { TERMS_VERSION, TERMS_ITEMS } from '../server/terms.mjs';
import { createUsageStore } from '../server/usage.mjs';
import { ACCOUNTS_KEY, accountId, accountStorageKey } from '../app/src/lib/accounts-store.ts';

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(process.env.SERVANT_E2E_MODULES || path.join(repository, 'desktop/package.json'));
const { chromium } = require('playwright');
const run = promisify(execFile);
const before = process.env.SERVANT_TOUR_E2E_BEFORE === '1';
const appDir = process.env.SERVANT_TOUR_E2E_APP || path.join(repository, 'app');
const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'servant-tour-e2e-'));
const shots = path.join(repository, 'docs/captures/onboarding-tour', before ? 'before' : 'after');
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
let browser, apiServer, webServer, agent;
let serverOutput = '', webOutput = '';
const pageErrors = [];
try {
  const port = await freePort();
  const apiUrl = `http://127.0.0.1:${port}`;
  // A stand-in for the agent, so a new chat can be made. It is never asked anything: the tour only reads, and a
  // first ask waits in the message box.
  agent = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    const json = (status, value) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
    if (req.url === '/v1/capabilities') return json(200, { features: {} });
    if (req.method === 'POST' && req.url === '/api/sessions') return json(201, { session: { id: 'made' } });
    if (req.method === 'GET' && req.url.endsWith('/messages')) return json(200, { data: [] });
    return json(200, { session: { id: 'known' } });
  });
  await new Promise(done => agent.listen(0, '127.0.0.1', done));
  // New people start as a Software engineer; the agent is priced at $2 in and $10 out a million tokens, which
  // with one token in ten out is $2.80 a million.
  const settings = { name: 'Example team', publicUrl: apiUrl, discovery: 'off', discoveryUrl: '', defaultAgentTier: 3,
    upstreams: { owner: { url: `http://127.0.0.1:${agent.address().port}`, key: 'fixture-key', model: 'example-model', usdPerMillion: { input: 2, output: 10 } } } };
  const configure = (change = {}) => fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ ...settings, ...change }));
  configure();
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
  const serverKey = serverIdentity(data).publicKey;
  // What the app saves after joining (lib/server.ts pair): the answer, where the server is, and whether the tour is due.
  const account = ({ tour, ...paired }) => ({ ...paired, serverUrl: apiUrl, serverKey, serverName: 'Example team', ...(tour?.due ? { tourDue: true } : {}) });
  const invite = async (name, role) => {
    const output = await run(process.execPath, [serverEntry, 'invite', ...(name ? ['--name', name] : []), '--role', role], { env });
    const code = output.stdout.match(/Invite code:\s*(\S+)/)?.[1];
    assert.ok(code, 'Fixture invite was created');
    return code;
  };
  const pair = async (name, role) => account(await api('POST', '/v1/pair', { code: await invite(name, role), device: 'Browser E2E', terms: { version: TERMS_VERSION, items: TERMS_ITEMS } }));
  const ana = await pair('Ana Ruiz', 'owner');
  const pat = await pair('Pat Tester', 'member');
  const jo = await pair('Jo Park', 'member');
  const sam = await pair('Sam Lee', 'member');
  const noa = await pair('Noa Kim', 'member');
  const change = (person, body) => api('PATCH', `/v1/people/${person.user.id}`, body, ana.token);
  await change(jo, { agentTier: 4 });
  await change(sam, { tokenLimit: 5_000_000 });
  await change(noa, { agentTier: 0 });
  // Today's use, as counts only (usage.db holds no text): Pat 300K tokens, Sam 400K, Ana 700K, one in ten of them out.
  const usage = createUsageStore(path.join(data, 'usage.db'));
  for (const [person, input, output] of [[pat, 270_000, 30_000], [sam, 360_000, 40_000], [ana, 630_000, 70_000]]) {
    usage.record({ eventId: `e2e-${person.user.id}`, userId: person.user.id, source: 'chat', usage: { input_tokens: input, output_tokens: output } });
  }
  usage.close();
  const me = person => api('GET', '/v1/me', undefined, person.token);
  const personOnServer = async person => (await api('GET', '/v1/people', undefined, ana.token)).people.find(p => p.id === person.user.id);

  const webUrl = `http://127.0.0.1:${await freePort()}`;
  webServer = spawn(process.execPath, [path.join(appDir, 'node_modules/expo/bin/cli'), 'start', '--web', '--localhost', '--port', new URL(webUrl).port], {
    cwd: appDir, env: { ...env, CI: '1', EXPO_NO_TELEMETRY: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  webServer.stdout.on('data', chunk => { webOutput += chunk; });
  webServer.stderr.on('data', chunk => { webOutput += chunk; });
  await waitFor(webUrl, webServer, 'Expo web');
  browser = await chromium.launch({ ...(process.env.SERVANT_E2E_BROWSER ? { channel: process.env.SERVANT_E2E_BROWSER } : {}) });
  const phone = { width: 390, height: 844 }, desktop = { width: 1280, height: 900 };
  const newPage = async (who, viewport, { scheme = 'light', at = '/' } = {}) => {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce', colorScheme: scheme, hasTouch: viewport.width < 600 });
    if (who) {
      const id = accountId(who);
      // Only when there is nothing saved yet, so a reload keeps what the app itself saved since.
      await context.addInitScript(({ saved, key, indexKey, id }) => {
        if (localStorage.getItem(indexKey)) return;
        localStorage.setItem(key, JSON.stringify(saved));
        localStorage.setItem(indexKey, JSON.stringify({ version: 1, ids: [id], activeId: id }));
      }, { saved: who, key: accountStorageKey(id), indexKey: ACCOUNTS_KEY, id });
    }
    const opened = await context.newPage();
    opened.setDefaultTimeout(Number(process.env.SERVANT_E2E_TIMEOUT) || 90000);
    opened.on('pageerror', error => pageErrors.push(error.message));
    await opened.goto(webUrl + at);
    return opened;
  };
  const shot = async (page, name) => { await delay(250); await page.screenshot({ path: path.join(shots, name), animations: 'disabled' }); };
  const step = page => page.getByTestId('tour-step').innerText();
  const heading = (page, name) => page.getByRole('heading', { name, exact: true }).waitFor();
  const next = page => page.getByTestId('tour-next').click();
  const says = (page, text) => page.getByText(text, { exact: true }).first().waitFor();
  const TITLES = ["What's your role?", 'You stay in charge', 'Your access level', 'Your daily limit', 'Where your data goes', 'Try asking @agent'];
  const PAGES = ['role', 'in-charge', 'access', 'limit', 'data', 'try'];
  /** Walks the six pages from the first, capturing each as `<prefix>-<n>-<page>.png`; `check(page, n)` asserts on a page. */
  const walk = async (page, prefix, { role, check = async () => {} } = {}) => {
    for (let n = 0; n < 6; n++) {
      await heading(page, TITLES[n]);
      assert.equal(await step(page), `Step ${n + 1} of 6`);
      if (n === 0 && role) {
        await page.getByRole('radio', { name: role, exact: true }).click();
        await page.getByRole('radio', { name: role, exact: true, checked: true }).waitFor();
      }
      await check(page, n);
      if (prefix) await shot(page, `${prefix}-${n + 1}-${PAGES[n]}.png`);
      if (n < 5) await next(page);
    }
  };

  if (before) {
    // The base checkout: joining lands on the app with no tour, and You has no way to one.
    for (const scheme of ['light', 'dark']) {
      const joined = await newPage(pat, phone, { scheme });
      await joined.getByRole('tab', { name: /Agent/ }).first().waitFor();
      await delay(1500);
      assert.equal(await joined.getByText("What's your role?").count(), 0);
      await shot(joined, `after-joining-phone-${scheme}.png`);
      await joined.goto(`${webUrl}/you`);
      await says(joined, 'Link a computer');
      assert.equal(await joined.getByText('Take the tour').count(), 0);
      await shot(joined, `you-phone-${scheme}.png`);
    }
    const wide = await newPage(pat, desktop);
    await wide.getByText('Example team').first().waitFor();
    await delay(1500);
    await shot(wide, 'after-joining-desktop.png');
    console.log(`onboarding-tour-e2e: before captures saved in ${path.relative(repository, shots)}`);
  } else {
    // ---- Someone joins through the app's own join screen, and the tour is the first thing they see. ----
    const kaiCode = await invite('', 'member');
    const joining = await newPage(null, phone, { at: `/pair?code=${encodeURIComponent(kaiCode)}&key=${serverKey}&server=${encodeURIComponent(apiUrl)}` });
    await joining.getByRole('button', { name: 'Agree and join', exact: true }).waitFor();
    for (const box of await joining.getByRole('checkbox').all()) await box.click();
    await joining.getByRole('button', { name: 'Agree and join', exact: true }).click();
    await joining.getByLabel('Your name').fill('Kai Moss');
    await joining.getByRole('button', { name: 'Join workspace', exact: true }).click();
    await heading(joining, TITLES[0]);
    assert.equal(new URL(joining.url()).pathname, '/tour', 'joining goes straight to the tour');
    assert.equal(await joining.getByRole('radio').count(), 7);
    assert.equal(await joining.getByRole('radio', { checked: true }).count(), 0, 'no role is chosen for them');
    await says(joining, 'Your role tailors tips. Your owner sets what the agent can do. People on this server see your role beside your name.');
    // Skipping on the first page still saves "seen": the tour does not come back.
    await joining.getByTestId('tour-skip').click();
    await joining.getByRole('tab', { name: /Agent/ }).first().waitFor();
    const kai = (await api('GET', '/v1/people', undefined, ana.token)).people.find(p => p.name === 'Kai Moss');
    assert.ok(kai, 'Kai joined');
    await joining.reload();
    await joining.getByRole('tab', { name: /Agent/ }).first().waitFor();
    await delay(1500);
    assert.notEqual(new URL(joining.url()).pathname, '/tour', 'skipped means seen');
    assert.equal(kai.jobRole, undefined, 'skipping chooses nothing');

    // ---- Pat, a full member (Software engineer, 20M a day), on a phone: the whole tour. ----
    assert.deepEqual((await me(pat)).tour, { due: true });
    const patBefore = await personOnServer(pat);
    const member = await newPage(pat, phone);
    await heading(member, TITLES[0]);
    assert.equal(new URL(member.url()).pathname, '/tour', 'the tour opens by itself for someone who just joined');
    await shot(member, 'pat-phone-light-1-role-empty.png');
    await walk(member, 'pat-phone-light', { role: 'Designer', check: async (page, n) => {
      if (n === 0) {
        assert.equal(await page.getByRole('radio', { name: 'Designer', exact: true }).getAttribute('aria-checked'), 'true');
        assert.equal(await page.getByRole('progressbar').getAttribute('aria-label'), "Step 1 of 6: What's your role?");
      }
      if (n === 1) {
        await says(page, 'Ask for three ways to simplify a sign-up form, then watch the agent work.');
        // This server has no approval step, and the page says so rather than promising one.
        await says(page, 'No approval step on this server');
        assert.equal(await page.getByText('It asks before it touches files or GitHub').count(), 0);
      }
      if (n === 2) {
        assert.equal(await page.getByTestId('tour-level').innerText(), 'Software engineer');
        await says(page, 'You said your role is Designer. Your role tailors tips. Your owner sets what the agent can do.');
      }
      if (n === 3) {
        assert.equal(await page.getByTestId('tour-limit').innerText(), 'About $56 a day at most');
        await says(page, 'Your limit is 20 million tokens a day. It resets at midnight.');
        await says(page, 'Today: about $0.80 of about $56');
      }
      if (n === 4) await says(page, 'Messages and files are kept on Example team, which your owner runs on a computer they control. The owner can read what is on it.');
      if (n === 5) await says(page, 'Give me three ways to simplify a sign-up form, with the trade-offs of each.');
    } });
    // Back works, the arrow keys turn the page, and so does a sideways drag.
    await member.getByTestId('tour-back').click();
    await heading(member, TITLES[4]);
    await member.keyboard.press('ArrowLeft');
    await heading(member, TITLES[3]);
    await member.keyboard.press('ArrowRight');
    await heading(member, TITLES[4]);
    const finger = await member.context().newCDPSession(member);
    const touch = (type, x, y) => finger.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    const swipe = async (from, to) => { await touch('touchStart', from, 420); for (const x of [0.25, 0.5, 0.75, 1].map(part => from + (to - from) * part)) await touch('touchMove', x, 424); await touch('touchEnd'); };
    await swipe(320, 80);
    await heading(member, TITLES[5]);
    await swipe(80, 320);
    await heading(member, TITLES[4]);
    await swipe(320, 80);
    await heading(member, TITLES[5]);
    // A first ask opens a new agent chat with the words in the box, and nothing sent.
    await member.getByTestId('tour-ask-0').click();
    await member.waitForURL(/\/chat\/cht_/);
    const box = member.getByRole('textbox').first();
    await box.waitFor();
    assert.equal(await box.inputValue(), 'Give me three ways to simplify a sign-up form, with the trade-offs of each.');
    await delay(1500);
    assert.equal(await member.getByText('Something went wrong on the server').count(), 0, 'the new chat was made');
    await shot(member, 'pat-phone-light-7-first-ask-in-chat.png');
    // Finished: seen on the server, the role saved, and nothing about Pat's access changed.
    for (let i = 0; i < 40 && (await me(pat)).tour.due; i++) await delay(250);
    assert.deepEqual((await me(pat)).tour, { due: false });
    const patAfter = await personOnServer(pat);
    assert.deepEqual(patAfter.jobRole, { id: 'designer', label: 'Designer' });
    for (const key of ['agentTier', 'tokenLimit', 'unlimitedTokens', 'managerId', 'owner', 'vibeCoder']) assert.deepEqual(patAfter[key], patBefore[key], `${key} is unchanged by choosing a role`);
    assert.equal((await api('GET', '/v1/tour', undefined, pat.token)).limit.tokens, 20_000_000);
    // Opening the app again does not show the tour; You shows the role and the way back in.
    await member.goto(`${webUrl}/you`);
    await says(member, 'Take the tour');
    assert.equal(await member.getByTestId('profile-line').innerText(), 'Example team · Member · Designer');
    await shot(member, 'pat-phone-light-8-you.png');
    await member.getByText('Take the tour', { exact: true }).click();
    await heading(member, TITLES[0]);
    assert.equal(await member.getByRole('radio', { name: 'Designer', exact: true }).getAttribute('aria-checked'), 'true', 'reopened with the role they chose');
    await member.getByTestId('tour-skip').click();
    await says(member, 'Take the tour');
    assert.equal(new URL(member.url()).pathname, '/you', 'Skip goes back to where the tour was opened');

    // ---- Sam, the same level with a 5M limit, in dark. ----
    const limited = await newPage(sam, phone, { scheme: 'dark' });
    await walk(limited, 'sam-phone-dark', { role: 'Engineer', check: async (page, n) => {
      if (n === 3) {
        assert.equal(await page.getByTestId('tour-limit').innerText(), 'About $14 a day at most');
        await says(page, 'Your limit is 5 million tokens a day. It resets at midnight.');
        await says(page, 'Today: about $1.10 of about $14');
      }
      if (n === 5) await says(page, 'Review the function I paste for bugs and missing tests.');
    } });
    await next(limited);
    await limited.getByRole('tab', { name: /Agent/ }).first().waitFor();
    assert.deepEqual((await me(sam)).tour, { due: false }, 'Done saves seen');
    // Calling yourself an engineer is not the Software engineer level's limit.
    assert.equal((await personOnServer(sam)).tokenLimit, 5_000_000);

    // ---- Jo, a researcher: a restricted agent, and nothing to approve. ----
    const researcher = await newPage(jo, phone);
    await walk(researcher, 'jo-phone-light', { role: 'Researcher', check: async (page, n) => {
      if (n === 1) await says(page, 'Nothing to approve');
      if (n === 2) { assert.equal(await page.getByTestId('tour-level').innerText(), 'User researcher'); await says(page, 'Web and skills; no GitHub, files or commands'); }
      if (n === 3) assert.equal(await page.getByTestId('tour-limit').innerText(), 'About $14 a day at most');
    } });

    // ---- Noa has no agent: the tour says so, and how to ask. ----
    const none = await newPage(noa, phone);
    await walk(none, 'noa-phone-light', { check: async (page, n) => {
      if (n === 2) assert.equal(await page.getByTestId('tour-level').innerText(), 'No agent');
      if (n === 3) { assert.equal(await page.getByTestId('tour-limit').innerText(), 'No agent, so nothing to spend'); assert.equal(await page.getByText('$').count(), 0, 'no invented figure'); }
      if (n === 5) { await says(page, "You don't have agent access yet. Once an owner turns it on, these are good first asks."); assert.equal(await page.getByTestId('tour-ask-0').count(), 0, 'asks are to read, not to press'); }
    } });

    // ---- Ana, the owner, on a wide window in both appearances: no limit, and what the team used today. ----
    for (const scheme of ['light', 'dark']) {
      const owner = await newPage(ana, desktop, { scheme });
      await walk(owner, `ana-desktop-${scheme}`, { role: 'Manager', check: async (page, n) => {
        if (n === 1) await says(page, 'Your agent acts without asking');
        if (n === 2) assert.equal(await page.getByTestId('tour-level').innerText(), 'Owner');
        if (n === 3) {
          assert.equal(await page.getByTestId('tour-limit').innerText(), 'No limit; you pay for what the team uses');
          // 1.26M in at $2 and 140K out at $10 a million.
          await says(page, 'Team today: about $3.90');
          await says(page, 'You today: about $2');
        }
      } });
      if (scheme === 'light') {
        // The owner sees the role Pat chose in People.
        await owner.getByTestId('tour-skip').click();
        await owner.getByRole('heading', { name: TITLES[5] }).waitFor({ state: 'detached' });
        for (let i = 0; i < 40 && (await me(ana)).tour.due; i++) await delay(250);
        await owner.goto(`${webUrl}/members`);
        await owner.getByText(/Software engineer · Role: Designer/).first().waitFor();
        await shot(owner, 'ana-desktop-light-7-people.png');
      }
    }

    // ---- The same pages when the owner turns approvals on, and when members are restricted. ----
    configure({ agentCapabilities: { mode: 'ask' } });
    const asked = await newPage(pat, phone, { at: '/tour' });
    await heading(asked, TITLES[0]); await next(asked);
    await says(asked, 'It asks before it touches files or GitHub');
    await says(asked, 'The first time the agent is about to read or change files or GitHub for you, it stops and Ana Ruiz decides: allow once, allow always or decline.');
    await shot(asked, 'pat-phone-light-approvals-on-2-in-charge.png');
    configure({ agentAccess: 'limited' });
    const restricted = await newPage(pat, phone, { at: '/tour' });
    await heading(restricted, TITLES[0]); await next(restricted);
    await says(restricted, 'Nothing to approve');
    await next(restricted);
    await says(restricted, "On this server, members' agents work with text and the images you send. No files, terminal, web or connected services.");
    await shot(restricted, 'pat-phone-light-members-restricted-3-access.png');
    configure();

    assert.deepEqual(pageErrors, [], 'no page errors');
    console.log(`onboarding-tour-e2e: OK, captures saved in ${path.relative(repository, shots)}`);
  }
} catch (error) {
  console.error(error);
  // SERVANT_E2E_DEBUG=<folder> saves what each page showed when it failed.
  if (process.env.SERVANT_E2E_DEBUG) { let n = 0; for (const context of browser?.contexts() ?? []) for (const page of context.pages()) await page.screenshot({ path: path.join(process.env.SERVANT_E2E_DEBUG, `failed-${n++}.png`) }).catch(() => {}); }
  if (serverOutput) console.error('--- server ---\n' + serverOutput.slice(-2000));
  if (webOutput) console.error('--- web ---\n' + webOutput.slice(-1500));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await stop(webServer); await stop(apiServer); agent?.close(); agent?.closeAllConnections?.();
  fs.rmSync(scratch, { recursive: true, force: true });
}
