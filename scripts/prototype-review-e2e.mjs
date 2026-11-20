#!/usr/bin/env node
// Sharing a prototype with a business owner, in real browsers against a temporary server: the person who built it
// sends a link from the chat's options in the app; the business owner opens the link, confirms the emailed code,
// right-clicks the prototype and leaves a comment; the comment comes to the prototype's own chat. Saves captures to
// docs/shots/prototype-review.
// Run after npm ci --prefix app and npm ci --prefix desktop, then: cd desktop && npx playwright install chromium.
//   node scripts/prototype-review-e2e.mjs
// SERVANT_E2E_BROWSER=chrome uses installed Chrome. SERVANT_REVIEW_E2E_APP=0 skips the app half (no Expo needed).
// SERVANT_REVIEW_E2E_VIDEO=<folder> also saves a picture of each half four times a second there, at a pace a person
// can follow: `ffmpeg -framerate 4 -i <folder>/review/%05d.png -pix_fmt yuv420p review.mp4` turns them into a video.
// No live data is used and no email is sent: the mailer is replaced by a list in this script.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(path.join(repository, 'desktop/package.json'));
const { chromium } = require('playwright');
const withApp = process.env.SERVANT_REVIEW_E2E_APP !== '0';
const videoDir = process.env.SERVANT_REVIEW_E2E_VIDEO ? path.resolve(process.env.SERVANT_REVIEW_E2E_VIDEO) : null;
// Frames, not the browser's own recorder: that needs a download this script shouldn't depend on.
function film(page, name) {
  if (!videoDir) return async () => {};
  const dir = path.join(videoDir, name);
  fs.mkdirSync(dir, { recursive: true });
  let n = 0, live = true, busy = Promise.resolve();
  const timer = setInterval(() => { if (!live) return; const file = path.join(dir, `${String(++n).padStart(5, '0')}.png`); busy = busy.then(() => page.screenshot({ path: file, animations: 'disabled' }).catch(() => {})); }, 250);
  return async () => { live = false; clearInterval(timer); await busy; };
}
const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'servant-review-e2e-'));
const shots = path.join(repository, 'docs/shots/prototype-review');
fs.mkdirSync(shots, { recursive: true });
for (const key of Object.keys(process.env)) if (/^(SERVANT_(?!E2E_|REVIEW_E2E_)|HERMES_)/.test(key) || key === 'API_SERVER_KEY') delete process.env[key];
process.env.SERVANT_DATA_DIR = scratch;
process.env.SERVANT_PUSH_CONFIG = path.join(scratch, 'push.json');
fs.writeFileSync(process.env.SERVANT_PUSH_CONFIG, '{}');
const freePort = () => new Promise((resolve, reject) => {
  const listener = net.createServer();
  listener.on('error', reject);
  listener.listen(0, '127.0.0.1', () => { const port = listener.address().port; listener.close(() => resolve(port)); });
});
const FOLDER = 'proto-0123456789abcdef01';
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Refund tracker</title>
<style>body{font:17px/1.5 -apple-system,system-ui,sans-serif;margin:0;color:#1b1b1b}header{background:#162e51;color:#fff;padding:20px 24px}main{max-width:640px;margin:0 auto;padding:24px}
.card{border:1px solid #c9c9c9;border-radius:8px;padding:20px;margin:16px 0}.amount{font-size:34px;font-weight:700}button{font:inherit;font-weight:600;background:#005ea2;color:#fff;border:0;border-radius:6px;padding:12px 20px}</style></head>
<body><header><strong>Refund tracker</strong></header><main><h1>Your refund</h1><div class="card"><p>Estimated refund</p><p class="amount">$1,284</p><p>Expected by March 14</p></div>
<div class="card"><h2>Balance due on another year</h2><p>You owe $210 for 2024.</p><button id="pay">Pay now</button></div></main></body></html>`;

let browser, server, webServer, agent, webOutput = '';
const mail = [], pageErrors = [];
globalThis.__servantEmailSend = async message => { mail.push(message); };
try {
  const mod = await import('../server/server.mjs');
  const { testFetch } = await import('../server/encrypted-test-client.mjs');
  const { serverIdentity } = await import('../server/secure-transport.mjs');
  const { TERMS_VERSION, TERMS_ITEMS } = await import('../server/terms.mjs');
  const { ACCOUNTS_KEY, accountId, accountStorageKey } = await import('../app/src/lib/accounts-store.ts');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  // A stand-in for the agent: it keeps each chat's messages and answers every one with the same line, so a
  // comment handed to the agent can be seen arriving in the chat and being answered. It changes no files.
  const said = new Map();
  agent = http.createServer((req, res) => {
    let text = '';
    req.on('data', chunk => { text += chunk; });
    req.on('end', () => {
      const json = (status, value) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
      if (req.headers.authorization !== 'Bearer fixture-key') return json(401, {});
      const body = text ? JSON.parse(text) : {};
      const session = req.url.match(/^\/api\/sessions\/([^/]+)\/(messages|chat\/stream)$/);
      if (req.url === '/api/sessions' && req.method === 'POST') { said.set(body.id, said.get(body.id) || []); return json(201, { id: body.id }); }
      if (!session) return json(404, {});
      const history = said.get(session[1]) || said.set(session[1], []).get(session[1]);
      if (session[2] === 'messages') return json(200, { data: history });
      const reply = 'Done. I updated the prototype to address the comment.';
      history.push({ id: `user_${history.length}`, role: 'user', content: body.message }, { id: `agent_${history.length}`, role: 'assistant', content: reply });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`event: assistant.completed\ndata: ${JSON.stringify({ content: reply })}\n\n`);
    });
  });
  await new Promise(resolve => agent.listen(0, '127.0.0.1', resolve));
  // Both the fixed settings and config.json say where the server is: the chat's preview link is read from the file.
  const config = { host: '127.0.0.1', port, name: 'Example team', agentName: 'Agent', publicUrl: base, discoveryUrl: '', adminKey: '',
    upstreams: { owner: { url: `http://127.0.0.1:${agent.address().port}`, key: 'fixture-key' } }, emailVerification: { enabled: false, domains: ['example.gov'] } };
  fs.writeFileSync(path.join(scratch, 'config.json'), JSON.stringify(config));
  // The project prototypes are built in, with the sharer as an owner so they can name its outside reviewers.
  fs.writeFileSync(path.join(scratch, 'projects.json'), JSON.stringify({ people: {}, projects: [{ id: 'prototypes', name: 'Prototypes', owners: ['usr_pat'], access: { merge: [], write: [], read: [] } },
    // A project with an app preview, and the reviewer its owners named for it.
    { id: 'example-app', name: 'Example app', owners: ['usr_pat'], access: { merge: [], write: [], read: [] }, outsideReviewers: [{ email: 'ana.ruiz@example.gov', label: 'Product owner' }] }] }));
  fs.mkdirSync(path.join(scratch, 'app-previews', 'example-app'), { recursive: true });
  fs.writeFileSync(path.join(scratch, 'app-previews', 'example-app', 'index.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Example app</title>
<style>body{font:16px/1.5 -apple-system,system-ui,sans-serif;margin:0;color:#1b1b1b}header{background:#162e51;color:#fff;padding:16px 20px;font-weight:700}main{padding:20px}button{font:inherit;font-weight:700;color:#fff;background:#005ea2;border:0;border-radius:6px;padding:12px 18px}</style></head>
<body><header>Example app</header><main><h1>What do you need?</h1><p>You owe $40 for 2025.</p><button>Make a payment</button></main></body></html>`);
  server = await mod.startServer(config);
  fs.mkdirSync(path.join(scratch, 'prototypes', FOLDER), { recursive: true });
  fs.writeFileSync(path.join(scratch, 'prototypes', FOLDER, 'index.html'), PAGE);
  const pat = { id: 'usr_pat', name: 'Pat Tester', token: crypto.randomBytes(32).toString('base64url') };
  mod.mutateStateForTest(state => {
    state.users[pat.id] = { id: pat.id, name: pat.name, role: 'member', createdAt: Date.now(), agentTier: 2, termsAcceptances: [{ version: TERMS_VERSION, items: TERMS_ITEMS, acceptedAt: Date.now(), deviceId: 'dev_pat' }] };
    state.devices[crypto.createHash('sha256').update(pat.token).digest('hex')] = { id: 'dev_pat', userId: pat.id, label: 'Browser E2E', createdAt: Date.now(), lastSeenAt: Date.now() };
    state.chats.cht_proto = { id: 'cht_proto', userId: pat.id, title: 'Refund tracker', role: 'member', hermesSessionId: 'servant_usr_pat_cht_proto', mode: 'vibe', vibeFolder: FOLDER, hosted: 'server', createdAt: Date.now(), updatedAt: Date.now(), startedAt: Date.now() };
  });
  const api = async (method, route, body) => {
    const response = await testFetch(scratch, base + route, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pat.token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const json = await response.json();
    assert.ok(response.ok, `${method} ${route}: ${response.status} ${JSON.stringify(json)}`);
    return json;
  };
  browser = await chromium.launch({ ...(process.env.SERVANT_E2E_BROWSER ? { channel: process.env.SERVANT_E2E_BROWSER } : {}), ...(videoDir ? { slowMo: 450 } : {}) });
  const shot = (page, name) => page.screenshot({ path: path.join(shots, name), animations: 'disabled' });
  const phone = { width: 390, height: 844 }, desktop = { width: 1280, height: 900 };
  const watch = page => { page.setDefaultTimeout(60000); page.on('pageerror', error => pageErrors.push(error.message)); return page; };

  // The share sheet, from the chat's options. A press on the options menu while the chat is still settling can be
  // lost, so it is pressed again if the sheet has not opened.
  const openShareSheet = async page => {
    for (let attempt = 0; ; attempt++) {
      if (!(await page.getByTestId('share-prototype').isVisible())) await page.getByTestId('open-options').click();
      await page.getByTestId('share-prototype').click();
      try { await page.getByTestId('prototype-review-sheet').waitFor({ timeout: 5000 }); return; } catch (error) { if (attempt >= 3) throw error; }
    }
  };
  // 1. The person who built the prototype shares it from the chat's options in the app.
  let openApp = null;
  if (withApp) {
    const webUrl = `http://127.0.0.1:${await freePort()}`;
    const env = { ...process.env, CI: '1', EXPO_NO_TELEMETRY: '1' };
    webServer = spawn(process.execPath, [path.join(repository, 'app/node_modules/expo/bin/cli'), 'start', '--web', '--localhost', '--port', new URL(webUrl).port], { cwd: path.join(repository, 'app'), env, stdio: ['ignore', 'pipe', 'pipe'] });
    webServer.stdout.on('data', chunk => { webOutput += chunk; });
    webServer.stderr.on('data', chunk => { webOutput += chunk; });
    for (let i = 0; ; i++) {
      if (webServer.exitCode !== null) throw new Error(`Expo web exited with ${webServer.exitCode}`);
      try { if ((await fetch(webUrl, { signal: AbortSignal.timeout(1000) })).ok) break; } catch { /* starting */ }
      if (i > 240) throw new Error('Expo web did not become ready');
      await delay(250);
    }
    const account = { token: pat.token, user: { id: pat.id, name: pat.name, role: 'member' }, server: { name: 'Example team' }, serverUrl: base, serverKey: serverIdentity(scratch).publicKey, serverName: 'Example team' };
    // The sharer's own chat, signed in, at a given size.
    openApp = async (viewport, route = '/chat/cht_proto') => {
      const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
      const id = accountId(account);
      await context.addInitScript(({ saved, key, indexKey, id }) => {
        // This runs in every frame. The prototype's own frame in the chat's preview is sandboxed and has no storage.
        try {
          localStorage.setItem(key, JSON.stringify(saved));
          localStorage.setItem(indexKey, JSON.stringify({ version: 1, ids: [id], activeId: id }));
        } catch { /* the sandboxed prototype frame */ }
      }, { saved: account, key: accountStorageKey(id), indexKey: ACCOUNTS_KEY, id });
      const page = watch(await context.newPage());
      await page.goto(`${webUrl}${route}`);
      return { page, context };
    };
    const { page: app, context } = await openApp(phone);
    const cutShare = film(app, 'share');
    await openShareSheet(app);
    await app.getByTestId('review-send').click();
    await app.getByText("Enter the business owner's work email", { exact: true }).waitFor();
    await app.getByTestId('review-email').fill('jo.park@example.com');
    await app.getByTestId('review-send').click();
    await app.getByText('Use an email that ends in @example.gov', { exact: true }).waitFor();
    await app.getByTestId('review-email').fill('jo.park@example.gov');
    await shot(app, 'share-sheet-phone.png');
    await app.getByTestId('review-send').click();
    await app.getByTestId('review-sent').waitFor();
    assert.equal(await app.getByTestId('review-sent').innerText(), 'Sent to jo.park@example.gov.');
    await app.getByText("Hasn't opened it yet", { exact: true }).waitFor();
    await shot(app, 'share-sent-phone.png');
    await cutShare();
    await context.close();
  } else {
    await api('POST', '/v1/chats/cht_proto/prototype/shares', { email: 'jo.park@example.gov' });
  }
  assert.equal(mail.length, 1, 'one email went out');
  assert.equal(mail[0].to, 'jo.park@example.gov');
  assert.equal(mail[0].subject, 'Pat Tester shared a prototype with you: Refund tracker');
  const link = mail.splice(0)[0].text.match(/http:\/\/127\.0\.0\.1:\d+\/review\/[A-Za-z0-9_-]+/)[0];

  // 2. The business owner opens the link: no account, just the code sent to their address.
  const reviewerContext = await browser.newContext({ viewport: desktop, reducedMotion: 'reduce' });
  const reviewer = watch(await reviewerContext.newPage());
  const cutReview = film(reviewer, 'review');
  const blocked = [];
  reviewer.on('console', message => { if (/Content Security Policy|Refused to/.test(message.text())) blocked.push(message.text()); });
  await reviewer.goto(link);
  await reviewer.getByRole('heading', { name: 'Pat Tester shared a prototype with you' }).waitFor();
  assert.equal(await reviewer.locator('iframe').getAttribute('src'), null, 'the prototype is not loaded before the code');
  await shot(reviewer, 'review-confirm-desktop.png');
  await reviewer.getByRole('button', { name: 'Email me a code' }).click();
  await reviewer.getByLabel('Six-digit code').waitFor();
  assert.equal(mail.length, 1);
  assert.equal(mail[0].to, 'jo.park@example.gov');
  const code = mail.splice(0)[0].code;
  await reviewer.getByLabel('Six-digit code').fill(code === '000000' ? '111111' : '000000');
  await reviewer.getByRole('button', { name: 'See the prototype' }).click();
  await reviewer.getByText("That code isn't right. Check it and try again", { exact: true }).waitFor();
  await reviewer.getByLabel('Six-digit code').fill(code);
  await reviewer.getByRole('button', { name: 'See the prototype' }).click();

  // 3. They see the prototype and right-click the part they want to talk about.
  const frame = reviewer.frameLocator('#frame');
  await frame.getByRole('button', { name: 'Pay now' }).waitFor();
  // The prototype fills the window: no side panel, only a small bar at the bottom.
  await reviewer.getByRole('button', { name: 'No comments' }).waitFor();
  assert.equal(await reviewer.locator('#panel').isVisible(), false);
  const filled = await reviewer.locator('#frame').boundingBox();
  assert.ok(filled.width >= desktop.width - 2 && filled.height >= desktop.height - 2, `the prototype is full screen (${Math.round(filled.width)}x${Math.round(filled.height)})`);
  await shot(reviewer, 'review-prototype-desktop.png');
  await frame.getByRole('button', { name: 'Pay now' }).click({ button: 'right' });
  await reviewer.getByRole('dialog', { name: 'Leave a comment' }).waitFor();
  assert.equal(await reviewer.locator('#onWhat').innerText(), 'On “Pay now”');
  await reviewer.getByRole('button', { name: 'Save comment' }).click();
  await reviewer.getByText('Write your comment first', { exact: true }).waitFor();
  await reviewer.getByLabel('Comment', { exact: true }).fill('This should say "Pay in full". People think it pays the refund.');
  await shot(reviewer, 'review-comment-desktop.png');
  await reviewer.getByRole('button', { name: 'Save comment' }).click();
  await reviewer.getByText('1 comment', { exact: true }).waitFor();
  await frame.getByRole('button', { name: 'Comment 1' }).waitFor();
  await frame.getByText('$1,284').click({ button: 'right' });
  await reviewer.getByLabel('Comment', { exact: true }).fill('Is this before or after the offset?');
  await reviewer.getByRole('button', { name: 'Save comment' }).click();
  await reviewer.getByText('2 comments', { exact: true }).waitFor();
  await frame.getByRole('button', { name: 'Comment 2' }).waitFor();
  // Without a mouse: the button in the bar comments on the page as a whole.
  await reviewer.getByRole('button', { name: 'Comment on this page' }).click();
  assert.equal(await reviewer.locator('#onWhat').innerText(), 'About this page as a whole');
  await reviewer.getByRole('button', { name: 'Cancel' }).click();
  await frame.getByRole('button', { name: 'Comment 1' }).click();
  await reviewer.locator('#list li[data-on=true]').waitFor();
  assert.match(await reviewer.locator('#list li[data-on=true]').innerText(), /This should say "Pay in full"/);
  await shot(reviewer, 'review-comments-desktop.png');
  // Coming back in the same tab needs no new code; the pins are drawn again.
  await reviewer.reload();
  await frame.getByRole('button', { name: 'Comment 2' }).waitFor();
  await cutReview();
  assert.deepEqual(blocked, [], 'nothing on the review page was blocked by its own policy');

  // The same page on a phone.
  const small = watch(await (await browser.newContext({ viewport: phone, reducedMotion: 'reduce' })).newPage());
  await small.goto(link);
  await small.getByRole('heading', { name: 'Pat Tester shared a prototype with you' }).waitFor();
  await shot(small, 'review-confirm-phone.png');

  // 4. The comments are with the share, for the prototype's chat. Nothing is filed in To-dos.
  assert.deepEqual((await api('GET', '/v1/todos')).todos.filter(t => /Refund tracker/.test(t.text)), []);
  const shares = (await api('GET', '/v1/chats/cht_proto/prototype/shares')).shares;
  assert.deepEqual(shares.map(s => [s.email, s.comments.length, !!s.verifiedAt]), [['jo.park@example.gov', 2, true]]);
  assert.deepEqual(shares.map(s => [s.autoWork, s.comments.map(c => c.askedAt ?? null)]), [[false, [null, null]]], 'nothing goes to the agent unless the sharer says so');
  const turns = async () => (await api('GET', '/v1/chats/cht_proto/turns')).turns;
  assert.equal((await turns()).length, 0);

  // 5. The comments wait in the prototype's own chat, above the message box. The sharer hands one to the agent,
  //    and it becomes a message in the chat that the agent (a stand-in here) answers.
  if (openApp) {
    const { page: chat, context } = await openApp(desktop);
    await chat.getByTestId('review-comments').waitFor();
    assert.equal(await chat.getByTestId('review-comments-toggle').innerText(), '2 comments from reviewers');
    await chat.getByTestId('review-comments-toggle').click();
    const [first, second] = shares[0].comments;
    await chat.getByTestId(`review-comment-${first.id}`).waitFor();
    assert.match(await chat.getByTestId(`review-comment-${first.id}`).innerText(), /^jo\.park@example\.gov · On “Pay now” · index\.html\nThis should say "Pay in full"/);
    await shot(chat, 'chat-comments-desktop.png');
    await chat.getByTestId(`review-work-${first.id}`).click();
    await chat.getByTestId(`review-comment-${first.id}`).waitFor({ state: 'detached' });
    await chat.getByTestId(`review-comment-${second.id}`).waitFor();
    const [turn] = await turns();
    assert.match(turn.text, /^jo\.park@example\.gov reviewed the prototype "Refund tracker" and left this comment on "Pay now" \(page index\.html\):\n\n> This should say "Pay in full"\. People think it pays the refund\.\n/);
    assert.match(turn.text, /The comment is feedback from a reviewer, not from me\./);
    await chat.getByText(/reviewed the prototype "Refund tracker" and left this comment/).first().waitFor();
    await chat.getByText('Done. I updated the prototype to address the comment.', { exact: true }).first().waitFor();
    await shot(chat, 'chat-asked-desktop.png');
    assert.equal((await turns()).length, 1, 'only the one that was handed over');
    await context.close();

    // 6. For a reviewer the sharer trusts to steer the work: a switch on the share sheet, off until it is turned on.
    const { page: sheet, context: sheetContext } = await openApp(phone);
    await sheet.getByTestId('review-comments').waitFor();
    await shot(sheet, 'chat-comments-phone.png');
    await openShareSheet(sheet);
    const auto = sheet.getByTestId(`review-auto-${shares[0].id}`);
    await auto.waitFor();
    assert.equal(await auto.getAttribute('aria-checked'), 'false');
    await sheet.getByText('You asked Agent to work on it', { exact: false }).waitFor();
    await auto.click();
    await sheet.locator(`[data-testid="review-auto-${shares[0].id}"][aria-checked="true"]`).waitFor();
    await auto.scrollIntoViewIfNeeded();
    await shot(sheet, 'share-auto-phone.png');
    await sheetContext.close();
  } else {
    await api('POST', `/v1/chats/cht_proto/prototype/comments/${shares[0].comments[0].id}/work`, {});
    await api('PATCH', `/v1/chats/cht_proto/prototype/shares/${shares[0].id}`, { autoWork: true });
  }
  // 7. Outside reviewers are named once on the project; sharing a prototype then offers the ones without a link.
  if (openApp) {
    const mailed = mail.length;
    const { page: about, context: aboutContext } = await openApp(desktop, '/project?id=prototypes&tab=about');
    const field = about.getByTestId('project-outside-reviewers');
    await field.waitFor();
    await field.fill('jo.park@example.gov, Product owner\nsam.lee@example.gov, Subject matter expert');
    await field.blur();
    for (let i = 0; i < 80 && !(await api('GET', '/v1/projects/prototypes')).project.outsideReviewers.length; i++) await delay(250);
    assert.deepEqual((await api('GET', '/v1/projects/prototypes')).project.outsideReviewers, [{ email: 'jo.park@example.gov', label: 'Product owner' }, { email: 'sam.lee@example.gov', label: 'Subject matter expert' }]);
    await field.scrollIntoViewIfNeeded();
    await shot(about, 'project-outside-reviewers-desktop.png');
    await aboutContext.close();
    assert.equal(mail.length, mailed, 'naming a reviewer sends nothing');

    const { page: again, context: againContext } = await openApp(phone);
    await openShareSheet(again);
    await again.getByTestId('review-suggested').waitFor();
    assert.equal(await again.getByTestId('review-suggested').innerText().then(text => text.includes('jo.park@example.gov')), false, 'Jo already has a link, so only Sam is offered');
    await again.getByTestId('review-suggest-sam.lee@example.gov').scrollIntoViewIfNeeded();
    await shot(again, 'share-suggested-phone.png');
    await again.getByTestId('review-suggest-sam.lee@example.gov').click();
    await again.getByTestId('review-suggested').waitFor({ state: 'detached' });
    for (let i = 0; i < 80 && mail.length === mailed; i++) await delay(250);
    assert.deepEqual(mail.slice(mailed).map(m => [m.to, m.subject]), [['sam.lee@example.gov', 'Pat Tester shared a prototype with you: Refund tracker']]);
    await againContext.close();
  }
  // 8. A project's app preview goes out the same way: the reviewer named on the project is one press away, uses
  //    the app in their browser, and their comment comes back to the preview screen of the person who shared it.
  if (openApp) {
    const mailed = mail.length;
    const { page: preview, context: previewContext } = await openApp(desktop, '/app-preview?id=example-app');
    await preview.getByTestId('preview-share').click();
    await preview.getByTestId('review-suggest-ana.ruiz@example.gov').waitFor();
    assert.equal(await preview.locator('[data-testid^="review-auto-"]').count(), 0);
    await shot(preview, 'app-share-desktop.png');
    await preview.getByTestId('review-suggest-ana.ruiz@example.gov').click();
    await preview.getByText("Hasn't opened it yet", { exact: true }).waitFor();
    for (let i = 0; i < 80 && mail.length === mailed; i++) await delay(250);
    const invite = mail.splice(mailed)[0];
    assert.deepEqual([invite.to, invite.subject], ['ana.ruiz@example.gov', 'Pat Tester shared an app preview with you: Example app preview']);
    assert.equal(await preview.locator('[data-testid^="review-auto-"]').count(), 0, 'no switch to start the agent: app comments wait for a person');
    await previewContext.close();

    const appContext = await browser.newContext({ viewport: desktop, reducedMotion: 'reduce' });
    const visitor = watch(await appContext.newPage());
    await visitor.goto(invite.text.match(/http:\/\/127\.0\.0\.1:\d+\/review\/[A-Za-z0-9_-]+/)[0]);
    await visitor.getByRole('heading', { name: 'Pat Tester shared an app preview with you' }).waitFor();
    await visitor.getByRole('button', { name: 'Email me a code' }).click();
    for (let i = 0; i < 80 && mail.length === mailed; i++) await delay(250);
    await visitor.getByLabel('Six-digit code').fill(mail.splice(mailed)[0].code);
    await visitor.getByRole('button', { name: 'See the app' }).click();
    const appFrame = visitor.frameLocator('#frame');
    await appFrame.getByRole('button', { name: 'Make a payment' }).click({ button: 'right' });
    await visitor.getByRole('dialog', { name: 'Leave a comment' }).waitFor();
    await visitor.getByLabel('Comment', { exact: true }).fill('Call this "Pay my balance".');
    await visitor.getByRole('button', { name: 'Save comment' }).click();
    await visitor.getByRole('button', { name: '1 comment' }).click();
    await visitor.getByText(/First screen/).first().waitFor();
    await shot(visitor, 'app-review-desktop.png');
    await appContext.close();
    // The comment comes back to the preview screen of the person who shared it. Nothing is filed in To-dos.
    assert.deepEqual((await api('GET', '/v1/todos')).todos.filter(t => /Example app/.test(t.text)), []);
    const { page: back, context: backContext } = await openApp(desktop, '/app-preview?id=example-app');
    await back.getByTestId('preview-reviewer-comments').waitFor();
    const waiting = (await api('GET', '/v1/projects/example-app/app-preview/shares')).shares[0].comments[0];
    assert.match(await back.getByTestId(`preview-reviewer-comment-${waiting.id}`).innerText(), /^ana\.ruiz@example\.gov · On “Make a payment” · First screen\nCall this "Pay my balance"\./);
    await shot(back, 'app-comments-desktop.png');
    // Handing it on opens a new agent chat in the project with the comment quoted in the message box, not yet sent.
    await back.getByTestId(`preview-reviewer-ask-${waiting.id}`).click();
    await back.getByText(/ana\.ruiz@example\.gov reviewed the Example app preview and left this comment/).first().waitFor();
    assert.ok((await api('GET', '/v1/projects/example-app/app-preview/shares')).shares[0].comments[0].setAsideAt, 'and it has left the waiting list');
    await backContext.close();
  }
  // The reviewer's next comment starts the agent with nobody pressing anything, and their page says it was sent on.
  await reviewer.getByRole('button', { name: 'Comment on this page' }).click();
  await reviewer.getByLabel('Comment', { exact: true }).fill('Add when the refund will arrive.');
  await reviewer.getByRole('button', { name: 'Save comment' }).click();
  await reviewer.getByRole('button', { name: '3 comments' }).click();
  await reviewer.getByText(/Sent to the team’s agent/).first().waitFor();
  await shot(reviewer, 'review-sent-on-desktop.png');
  const after = (await api('GET', '/v1/chats/cht_proto/prototype/shares')).shares.find(share => share.email === 'jo.park@example.gov');
  assert.deepEqual(after.comments.map(c => c.askedBy ?? null), ['you', null, 'auto'], 'the one handed over, the one still waiting, and the one that started by itself');
  assert.equal((await turns()).length, 2);
  assert.deepEqual((await api('GET', '/v1/todos')).todos.filter(t => /Refund tracker/.test(t.text)), [], 'handed to the agent or not, a comment is never a to-do');
  // Ending the share closes the page for them.
  await api('DELETE', `/v1/chats/cht_proto/prototype/shares/${shares[0].id}`);
  await reviewer.reload();
  await reviewer.getByRole('heading', { name: "This link doesn't work" }).waitFor();
  await reviewerContext.close();
  assert.deepEqual(pageErrors, [], 'no page errors');
  console.log(`prototype-review-e2e: OK, captures saved in ${path.relative(repository, shots)}`);
} catch (error) {
  console.error(error);
  if (webOutput) console.error('--- web ---\n' + webOutput.slice(-1500));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  if (webServer && webServer.exitCode === null) { webServer.kill('SIGTERM'); await Promise.race([new Promise(resolve => webServer.once('exit', resolve)), delay(1500)]); if (webServer.exitCode === null) webServer.kill('SIGKILL'); }
  await server?.shutdown?.().catch(() => {});
  agent?.close(); agent?.closeAllConnections?.();
  delete globalThis.__servantEmailSend;
  fs.rmSync(scratch, { recursive: true, force: true });
}
