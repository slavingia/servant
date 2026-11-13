import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { secureInboxPage, secureInboxScript } from './secure-inbox-page.mjs';

const pair = crypto.createECDH('prime256v1'); pair.generateKeys();
const publicKey = pair.getPublicKey('hex', 'compressed');
test('public page escapes server names and serves no third-party code or untrusted markup', () => {
  const html = secureInboxPage({ name: '<script>"&', publicKey });
  assert.ok(html.includes('&lt;script&gt;&quot;&amp;'));
  assert.equal((html.match(/<script/g) || []).length, 1);
  assert.match(html, /src="\/contact\/inbox.js"/);
  assert.match(html, new RegExp(`data-server-key="${publicKey}"`));
  assert.match(html, /Email \(optional\)/);
  assert.match(html, /Anyone with this link can read and reply/);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotThrow(() => new vm.Script(secureInboxScript()));
});

async function rejectedContext({ secure = true, pin = 'different-key' } = {}) {
  const elements = new Map(['error', 'start-button', 'notice'].map(id => [id, { textContent: '', hidden: true, disabled: false }]));
  let replaced = false;
  const stored = new Map([['servant.inbox.key.v1', pin]]);
  await vm.runInNewContext(secureInboxScript(), {
    document: { getElementById: id => elements.get(id), body: { dataset: { serverKey: publicKey } } },
    location: { hash: '#resume=private-test-token', pathname: '/contact', search: '', protocol: secure ? 'https:' : 'http:', hostname: 'example.gov' },
    history: { replaceState: () => { replaced = true; } },
    URLSearchParams, isSecureContext: secure, crypto: crypto.webcrypto,
    localStorage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) },
  });
  await new Promise(resolve => setImmediate(resolve));
  return { elements, stored, replaced };
}
test('a changed pin blocks the conversation without replacing the trusted key', async () => {
  const { elements, stored, replaced } = await rejectedContext();
  assert.match(elements.get('error').textContent, /encryption key has changed/);
  assert.equal(elements.get('start-button').disabled, true);
  assert.equal(stored.get('servant.inbox.key.v1'), 'different-key');
  assert.equal(replaced, true, 'remove recovery token before any network work');
});
test('a remote insecure origin cannot start encrypted messaging', async () => {
  const { elements, stored, replaced } = await rejectedContext({ secure: false, pin: null });
  assert.match(elements.get('error').textContent, /HTTPS connection is required/);
  assert.equal(elements.get('start-button').disabled, true);
  assert.equal(stored.get('servant.inbox.key.v1'), null);
  assert.equal(replaced, true);
});

// The page follows docs/design-system.md like the rest of Servant. It had a green theme of its own, light only.
test('the public page uses the app palette in light and dark, 48-point controls and no colors of its own', async () => {
  const { lightColors, darkColors } = await import('../app/src/lib/theme-colors.ts');
  const html = secureInboxPage({ name: 'Example team', publicKey });
  const css = html.slice(html.indexOf('<style>') + 7, html.indexOf('</style>'));
  const variables = block => Object.fromEntries([...block.matchAll(/--(\w+):(#[0-9A-Fa-f]{6})/g)].map(match => [match[1], match[2]]));
  const light = variables(css.slice(0, css.indexOf('@media (prefers-color-scheme:dark)')));
  const dark = variables(css.slice(css.indexOf('@media (prefers-color-scheme:dark)'), css.indexOf('*{box-sizing')));
  assert.ok(Object.keys(light).length >= 12 && Object.keys(dark).length >= 10);
  for (const [name, value] of Object.entries(light)) assert.equal(value, lightColors[name], `light ${name}`);
  for (const [name, value] of Object.entries(dark)) assert.equal(value, darkColors[name], `dark ${name}`);
  // Every other rule takes its color from those variables.
  const rules = css.slice(css.indexOf('*{box-sizing'));
  assert.deepEqual(rules.match(/#[0-9A-Fa-f]{3,8}\b/g) ?? [], []);
  assert.match(css, /color-scheme:light dark/);
  assert.match(css, /input,textarea\{[^}]*min-height:48px[^}]*border:1px solid var\(--borderStrong\);border-radius:10px/);
  assert.match(css, /button\{[^}]*min-height:48px[^}]*border-radius:6px;background:var\(--primary\);color:var\(--onPrimary\)/);
  assert.match(css, /\.danger\{background:var\(--background\);border-color:var\(--red\);color:var\(--red\)\}/);
  assert.match(html, /<button id="leave" class="danger" type="button">Leave this device<\/button>/, 'leaving is the red outline');
  assert.match(css, /\.download\{[^}]*text-decoration:underline/, 'a download reads as a link');
  assert.doesNotMatch(html, /A direct line to our team/);
});

// A visitor was never told the team had replied: the page said "There are no email notifications".
test('with a mailer the page asks for an address and a code and offers to stop; without one it says there is no email', () => {
  const offered = secureInboxPage({ name: 'Example team', publicKey, notices: true });
  assert.match(offered, /data-notices="1"/);
  assert.match(offered, /Replies appear on this page, and we can email you when one arrives\. You do not need an account\./);
  assert.match(offered, /<p class="hint">To get an email when the team replies\. The reply itself stays on this page\.<\/p>/);
  assert.match(offered, /<label for="alerts-email">Email<\/label><input id="alerts-email" type="email" maxlength="254" autocomplete="email" required>/);
  assert.match(offered, /<label for="alerts-code">6-digit code<\/label><input id="alerts-code" class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required>/);
  for (const label of ['Send code', 'Confirm email', 'Send a new code', 'Use a different email', 'Stop emails']) assert.ok(offered.includes(`>${label}</button>`), label);
  // One main action in each state; the lesser ones are underlined links, still 48 points tall.
  for (const id of ['alerts-resend', 'alerts-change', 'alerts-stop', 'alerts-cancel']) assert.match(offered, new RegExp(`<button id="${id}" class="link" type="button"`), id);
  assert.match(offered, /\.link\{padding:12px 0;background:none;color:var\(--blue\);text-decoration:underline/);
  assert.match(offered, /<div id="alerts" class="notice" hidden>/, 'nothing shows until the server says what state the conversation is in');
  assert.doesNotMatch(offered, /https?:\/\//);

  const plain = secureInboxPage({ name: 'Example team', publicKey });
  assert.match(plain, /data-notices="0"/);
  assert.match(plain, /Replies appear on this page, so come back to it\./);
  assert.match(plain, /Contact information only\. Replies stay in this chat\./);
  assert.match(plain, /There are no email notifications\./);

  const script = secureInboxScript();
  for (const route of ['/v1/inbox/guest/notify', '/v1/inbox/guest/notify/confirm', '/v1/inbox/guest/notify/stop']) assert.ok(script.includes(`'${route}'`), route);
  for (const words of ['Enter the code we emailed you', 'Get an email when the team replies', 'We send a private link back to this conversation. The reply itself stays on this page.', 'Until email is turned on, you will not be told when the team replies.', 'There are no email notifications.', 'To see the reply, come back to this page in this browser, or save your return link below.']) assert.ok(script.includes(words), words);
});
