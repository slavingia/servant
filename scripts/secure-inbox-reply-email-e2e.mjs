#!/usr/bin/env node
// The visitor's side of a conversation, start to finish, in real browsers: they write in, confirm their address
// with a code, close the page, are emailed when the team replies, come back through the link on another device,
// answer, and stop the emails. Mail goes to a file through the same mailer command an owner configures; no email
// service takes part. Each step is also saved as a screenshot.
//
// npm ci --prefix app && npm ci --prefix desktop
// cd desktop && npx playwright install chromium
// node scripts/secure-inbox-reply-email-e2e.mjs
// SERVANT_E2E_BROWSER=chrome uses installed Chrome. SERVANT_INBOX_WEB_URL reuses an Expo server from this checkout.
// SERVANT_INBOX_CAPTURE_SCALE=2 saves the screenshots at twice the size; SERVANT_INBOX_CAPTURE_SCHEME=dark runs in dark appearance.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
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
const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'servant-reply-email-e2e-'));
fs.chmodSync(scratch, 0o700);
const artifacts = path.join(repository, 'desktop/dist/secure-inbox-reply-email-e2e');
fs.rmSync(artifacts, { recursive: true, force: true });
fs.mkdirSync(artifacts, { recursive: true });
const data = path.join(scratch, 'data');
const runtime = path.join(scratch, 'runtime');
for (const directory of [data, runtime]) fs.mkdirSync(directory, { mode: 0o700 });
const outboxFile = path.join(scratch, 'outbox.jsonl');
const scale = Number(process.env.SERVANT_INBOX_CAPTURE_SCALE) === 2 ? 2 : 1;
const scheme = process.env.SERVANT_INBOX_CAPTURE_SCHEME === 'dark' ? 'dark' : 'light';
const freePort = () => new Promise((resolve, reject) => {
  const listener = net.createServer();
  listener.on('error', reject);
  listener.listen(0, '127.0.0.1', () => { const port = listener.address().port; listener.close(() => resolve(port)); });
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
// Everything the server handed to the mailer so far, oldest first.
const outbox = () => fs.existsSync(outboxFile) ? fs.readFileSync(outboxFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
const mail = async count => {
  for (let attempt = 0; attempt < 80 && outbox().length < count; attempt++) await delay(250);
  assert.equal(outbox().length, count, `expected ${count} emails so far`);
  return outbox()[count - 1];
};
const visitorText = 'I need help updating the example account.';
const teamReply = 'We received your request. Please send the example form when you can.';
const visitorReply = 'Here is the example form.';
const teamSecond = 'Thank you. The example account is updated.';
const teamAfterStop = 'One more note for the example account.';
const formFile = { name: 'example-form.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic visitor attachment: example form.\n') };
const PHONE = { width: 390, height: 844 }, DESKTOP = { width: 1280, height: 900 };
let browser, apiServer, webServer, page;
let serverOutput = '', webOutput = '';
const pageErrors = [], externalRequests = [], steps = [];

try {
  const port = await freePort();
  const apiUrl = `http://127.0.0.1:${port}`;
  const configPath = path.join(data, 'config.json');
  // The delay before a reply is emailed is a minute by default; one second here keeps the run short.
  const cfg = { host: '127.0.0.1', port, name: 'Example team', publicUrl: apiUrl, discovery: 'off', discoveryUrl: '', upstreams: {}, features: { secureInbox: true } };
  const configure = mailer => {
    fs.writeFileSync(configPath, JSON.stringify({ ...cfg, secureInbox: { noticeDelaySeconds: 1, ...(mailer ? { mailer: { command: `cat >> "${outboxFile}"; echo >> "${outboxFile}"` } } : {}) } }), { mode: 0o600 });
  };
  configure(true);
  const pushConfig = path.join(scratch, 'push-disabled.json');
  fs.writeFileSync(pushConfig, '{}\n', { mode: 0o600 });
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SERVANT_|HERMES_|API_SERVER_KEY$)/.test(key))),
    SERVANT_DATA_DIR: data, SERVANT_RUNTIME_DIR: runtime, SERVANT_HOST: '127.0.0.1', SERVANT_PORT: String(port), SERVANT_PUBLIC_URL: apiUrl,
    SERVANT_DISCOVERY_URL: '', SERVANT_PUSH_CONFIG: pushConfig, SERVANT_WORKER_MODE: 'external', SERVANT_SHUTDOWN_TIMEOUT_MS: '1000',
  };
  const serverEntry = path.join(repository, 'server/server.mjs');
  apiServer = spawn(process.execPath, [serverEntry], { cwd: repository, env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [apiServer.stdout, apiServer.stderr]) stream.on('data', chunk => { serverOutput = (serverOutput + chunk).slice(-6000); });
  await waitFor(`${apiUrl}/health`, apiServer, 'API server');
  const api = async (method, route, body, token) => {
    const response = await testFetch(data, apiUrl + route, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
    const json = await response.json();
    assert.ok(response.ok, `${method} ${route}: ${response.status} ${JSON.stringify(json)}`);
    return json;
  };
  const invited = await run(process.execPath, [serverEntry, 'invite', '--name', 'Pat Tester', '--role', 'owner'], { env });
  const code = invited.stdout.match(/Invite code:\s*(\S+)/)?.[1];
  assert.ok(code, 'Fixture invite was created');
  const paired = await api('POST', '/v1/pair', { code, device: 'Browser E2E', terms: { version: TERMS_VERSION, items: TERMS_ITEMS } });
  const owner = { ...paired, serverUrl: apiUrl, serverKey: serverIdentity(data).publicKey, serverName: cfg.name };
  const webUrl = process.env.SERVANT_INBOX_WEB_URL || `http://127.0.0.1:${await freePort()}`;
  if (!process.env.SERVANT_INBOX_WEB_URL) {
    webServer = spawn(process.execPath, [path.join(repository, 'app/node_modules/expo/bin/cli'), 'start', '--web', '--localhost', '--port', new URL(webUrl).port], { cwd: path.join(repository, 'app'), env: { ...env, CI: '1', EXPO_NO_TELEMETRY: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const stream of [webServer.stdout, webServer.stderr]) stream.on('data', chunk => { webOutput = (webOutput + chunk).slice(-6000); });
  }
  await waitFor(webUrl, webServer, 'Expo web');
  browser = await chromium.launch({ ...(process.env.SERVANT_E2E_BROWSER ? { channel: process.env.SERVANT_E2E_BROWSER } : {}) });
  const open = async (viewport, account) => {
    const context = await browser.newContext({ viewport, deviceScaleFactor: scale, locale: 'en-US', timezoneId: 'America/New_York', colorScheme: scheme, reducedMotion: 'reduce' });
    await context.route(/^https?:\/\//, route => {
      const origin = new URL(route.request().url()).origin;
      if (origin !== apiUrl && origin !== new URL(webUrl).origin) { externalRequests.push(origin); return route.abort('blockedbyclient'); }
      return route.continue();
    });
    if (account) await context.addInitScript(saved => { if (!localStorage.getItem('servant.accounts')) localStorage.setItem('servant.account', JSON.stringify(saved)); }, account);
    const opened = await context.newPage();
    opened.setDefaultTimeout(30000);
    opened.on('pageerror', error => pageErrors.push(error.message));
    return opened;
  };
  // A numbered screenshot of one step. The visitor's page is saved whole; the team's app as its window shows it.
  const shot = async (target, name, who, caption, whole = true) => {
    assert.ok(await target.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${name}: no sideways overflow`);
    const file = `${String(steps.length + 1).padStart(2, '0')}-${name}.png`;
    await target.screenshot({ path: path.join(artifacts, file), animations: 'disabled', fullPage: whole });
    steps.push({ file, who, caption });
  };
  // An email exactly as the server handed it to the mailer, drawn on a plain page: no mail program is involved.
  const emailShot = async (message, name, caption) => {
    const escape = value => String(value).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
    const sheet = await open({ width: 390, height: 300 });
    await sheet.setContent(`<body style="margin:0;padding:16px;background:#F7F8FA;color:#1D1C1D;font:15px/22px system-ui,sans-serif"><div style="background:#fff;border:1px solid #E6E7EB;border-radius:10px;padding:16px">
<p style="margin:0 0 12px;font-size:13px;line-height:18px;color:#5B616B">Email, as handed to the mailer</p>
<p style="margin:0;font-size:13px;line-height:18px;color:#5B616B">To</p><p style="margin:0 0 8px">${escape(message.to)}</p>
<p style="margin:0;font-size:13px;line-height:18px;color:#5B616B">Subject</p><p style="margin:0 0 12px;font-weight:600">${escape(message.subject)}</p>
<pre style="margin:0;padding-top:12px;border-top:1px solid #E6E7EB;white-space:pre-wrap;overflow-wrap:anywhere;font:inherit">${escape(message.text.replace(/#resume=[A-Za-z0-9_-]+/, '#resume=…'))}</pre>
${message.url ? '<p style="margin:12px 0 0;font-size:13px;line-height:18px;color:#5B616B">The private part of the link is left out of this picture.</p>' : ''}</div></body>`);
    await shot(sheet, name, 'email', caption);
    await sheet.context().close();
  };
  const onPage = (target, text) => target.getByText(text, { exact: true }).first().waitFor();

  // 1. The visitor writes in from a phone and gives an address.
  let visitor = await open(PHONE);
  page = visitor;
  await visitor.goto(`${apiUrl}/contact`);
  await onPage(visitor, 'To get an email when the team replies. The reply itself stays on this page.');
  await visitor.getByLabel('Your name', { exact: true }).fill('Ana Ruiz');
  await visitor.getByLabel('Email (optional)', { exact: true }).fill('ana@example.gov');
  await visitor.getByLabel('Subject', { exact: true }).fill('Example account review');
  await visitor.getByLabel('Message', { exact: true }).fill(visitorText);
  await shot(visitor, 'start', 'visitor', 'The visitor writes to the team and gives an email address.');
  await visitor.getByRole('button', { name: 'Start conversation', exact: true }).click();
  await onPage(visitor, visitorText);
  await onPage(visitor, 'Enter the code we emailed you');
  await onPage(visitor, 'Message sent.');
  await shot(visitor, 'enter-code', 'visitor', 'The message is sent. The page asks for the code it just emailed.');

  // 2. The code email, a wrong code, the right one.
  const codeEmail = await mail(1);
  assert.deepEqual({ to: codeEmail.to, subject: codeEmail.subject }, { to: 'ana@example.gov', subject: `Your code for Example team is ${codeEmail.code}` });
  assert.match(codeEmail.code, /^\d{6}$/);
  await emailShot(codeEmail, 'email-code', 'The first email: a code, to prove the address is theirs.');
  await visitor.getByLabel('6-digit code', { exact: true }).fill(codeEmail.code === '000000' ? '111111' : '000000');
  await visitor.getByRole('button', { name: 'Confirm email', exact: true }).click();
  await visitor.getByRole('alert').filter({ hasText: 'That code is not right. Check the email and try again' }).waitFor();
  await visitor.getByLabel('6-digit code', { exact: true }).fill(codeEmail.code);
  await visitor.getByRole('button', { name: 'Confirm email', exact: true }).click();
  await onPage(visitor, 'We email ana@example.gov when the team replies.');
  await onPage(visitor, 'Email confirmed.');
  assert.equal(await visitor.getByText('Until email is turned on', { exact: false }).count(), 0, 'the return link no longer warns that nothing will tell them');
  await shot(visitor, 'emails-on', 'visitor', 'With the code entered, they are emailed each time the team replies.');
  // The visitor closes the page. Someone still reading along would not be emailed.
  await visitor.context().close();

  // 3. The team sees the visitor will be told, and replies.
  const team = await open(DESKTOP, owner);
  page = team;
  await team.goto(`${webUrl}/inbox`);
  await team.getByRole('button', { name: /^Example account review, Ana Ruiz/ }).click();
  await team.getByText(visitorText, { exact: true }).filter({ visible: true }).waitFor();
  await team.getByText('ana@example.gov · Confirmed', { exact: true }).filter({ visible: true }).waitFor();
  await team.getByText('Emailed at ana@example.gov when the team replies.', { exact: true }).filter({ visible: true }).waitFor();
  const conversationId = new URL(team.url()).pathname.split('/').pop();
  const reply = async text => {
    await team.getByRole('textbox', { name: 'Reply', exact: true }).fill(text);
    await team.getByRole('button', { name: 'Send reply', exact: true }).click();
    await team.getByText(text, { exact: true }).filter({ visible: true }).waitFor();
  };
  await reply(teamReply);
  await shot(team, 'team-replies', 'team', 'The team replies. The case says the visitor is emailed at a confirmed address.', false);

  // 4. The reply email, and back in through its link on a device that has never seen the conversation.
  const notice = await mail(2);
  assert.deepEqual({ to: notice.to, subject: notice.subject }, { to: 'ana@example.gov', subject: 'New reply from Example team' });
  assert.ok(notice.url.startsWith(`${apiUrl}/contact#resume=`) && notice.text.includes(notice.url), 'the email links to the conversation');
  await emailShot(notice, 'email-reply', 'The reply email: a private link, and nothing from the conversation.');
  visitor = await open(PHONE);
  page = visitor;
  await visitor.goto(notice.url);
  await onPage(visitor, teamReply);
  assert.equal(new URL(visitor.url()).hash, '', 'the credential is removed from the address bar');
  await onPage(visitor, 'We email ana@example.gov when the team replies.');
  await shot(visitor, 'back-through-link', 'visitor', 'The link opens the conversation on any device, with the reply.');

  // 5. The visitor answers with a file and leaves again; the team's next reply is emailed too.
  await visitor.locator('#reply-files').setInputFiles(formFile);
  await visitor.getByRole('textbox', { name: 'Reply', exact: true }).fill(visitorReply);
  await visitor.getByRole('button', { name: 'Send reply', exact: true }).click();
  await onPage(visitor, visitorReply);
  await visitor.getByRole('button', { name: `Download ${formFile.name}`, exact: true }).waitFor();
  await shot(visitor, 'visitor-replies', 'visitor', 'The visitor answers and attaches a file.');
  await visitor.context().close();
  await team.getByText(visitorReply, { exact: true }).filter({ visible: true }).waitFor();
  await delay(1500);
  assert.equal(outbox().length, 2, 'the visitor\'s own message sends them nothing');
  await reply(teamSecond);
  await team.getByRole('button', { name: 'Resolve conversation', exact: true }).click();
  await team.getByRole('button', { name: 'Reopen conversation', exact: true }).waitFor();
  const second = await mail(3);
  assert.equal(second.subject, 'New reply from Example team');
  assert.equal(second.url, notice.url, 'the same private link each time');
  await delay(1500);
  assert.equal(outbox().length, 3, 'one email for the reply; resolving the case sends none');

  // 6. The visitor reads it, sees the case is resolved, and stops the emails.
  visitor = await open(PHONE);
  page = visitor;
  await visitor.goto(second.url);
  await onPage(visitor, teamSecond);
  await onPage(visitor, 'Resolved · reply to reopen');
  await shot(visitor, 'resolved', 'visitor', 'The next reply was emailed too. The visitor sees the case is resolved and can still reply.');
  await visitor.getByRole('button', { name: 'Stop emails', exact: true }).click();
  await onPage(visitor, 'Emails stopped.');
  await onPage(visitor, 'Get an email when the team replies');
  assert.equal(await visitor.getByLabel('Email', { exact: true }).inputValue(), 'ana@example.gov', 'the address is kept for turning them on again');
  await shot(visitor, 'emails-stopped', 'visitor', 'Stop emails turns them off. They can be turned on again here.');
  await visitor.context().close();
  await reply(teamAfterStop);
  await team.getByText('No email when the team replies. They see a reply when they come back to the page.', { exact: true }).filter({ visible: true }).waitFor();
  await delay(3000);
  assert.equal(outbox().length, 3, 'nothing is sent after Stop emails');
  const kinds = (await api('GET', `/v1/inbox/${conversationId}/activity`, undefined, owner.token)).activity.map(event => event.kind);
  for (const kind of ['notice.on', 'notice.sent', 'notice.off']) assert.ok(kinds.includes(kind), `the case's activity records ${kind}`);
  assert.equal(kinds.filter(kind => kind === 'notice.sent').length, 2);

  // 7. A server with no mailer says so, and offers only the return link.
  configure(false);
  visitor = await open(PHONE);
  page = visitor;
  await visitor.goto(`${apiUrl}/contact`);
  await onPage(visitor, 'Contact information only. Replies stay in this chat.');
  await visitor.getByLabel('Your name', { exact: true }).fill('Jo Park');
  await visitor.getByLabel('Subject', { exact: true }).fill('Example records request');
  await visitor.getByLabel('Message', { exact: true }).fill('Where can I find the example records?');
  await visitor.getByRole('button', { name: 'Start conversation', exact: true }).click();
  await onPage(visitor, 'Where can I find the example records?');
  await onPage(visitor, 'Message sent. To see the reply, come back to this page in this browser, or save your return link below.');
  await onPage(visitor, 'Anyone with this link can read and reply to this conversation. Save it to return from another device. There are no email notifications.');
  assert.equal(await visitor.getByText('Get an email when the team replies', { exact: true }).isVisible(), false, 'no email is offered');
  await shot(visitor, 'no-mailer', 'visitor', 'On a server that sends no email, the page says so and offers the return link.');
  await visitor.context().close();
  assert.equal(outbox().length, 3);

  // Nothing from the conversation is in any email.
  const everything = fs.readFileSync(outboxFile, 'utf8');
  for (const secret of [visitorText, teamReply, visitorReply, teamSecond, teamAfterStop, formFile.name, 'Example account review', 'Ana Ruiz', 'Pat Tester', 'CASE-', conversationId]) assert.equal(everything.includes(secret), false, `no email contains "${secret}"`);
  assert.deepEqual(externalRequests, [], 'no request leaves this machine');
  assert.deepEqual(pageErrors, [], 'no uncaught browser errors');
  fs.writeFileSync(path.join(artifacts, 'steps.json'), JSON.stringify({ scale, scheme, phone: PHONE, desktop: DESKTOP, steps }, null, 2));
  console.log('secure inbox reply email e2e: OK — address confirmed by code, wrong code refused, reply emailed after the visitor leaves, private link opens the conversation on another device, each later reply emailed, none when the visitor writes or the case is resolved, Stop emails, activity recorded, no mailer path, nothing from the conversation in any email');
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
