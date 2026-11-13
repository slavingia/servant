// The real server, two doors: a guest token is useless on /v1 (plain or encrypted), a device token is useless on
// /g/, the guest page comes with its headers and nothing from elsewhere, and robots are kept out.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { testFetch } from './encrypted-test-client.mjs';
import { TERMS_VERSION, TERMS_ITEMS } from './terms.mjs';
const ACCEPT = { version: TERMS_VERSION, items: TERMS_ITEMS };

for (const key of Object.keys(process.env)) if (/^(SERVANT_|HERMES_)/.test(key) || key === 'API_SERVER_KEY') delete process.env[key];
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-guest-api-'));
process.env.SERVANT_DATA_DIR = directory;
process.env.SERVANT_WORKER_MODE = 'external';
process.env.SERVANT_PUSH_CONFIG = path.join(directory, 'push.json');
fs.writeFileSync(process.env.SERVANT_PUSH_CONFIG, '{}');
const PUBLIC = 'https://guests.example';
const config = { host: '127.0.0.1', port: 0, name: 'Guest test', agentName: 'Test agent', agentAccess: 'limited', publicUrl: PUBLIC, discoveryUrl: '', adminKey: '', upstreams: {}, guestMeetings: true };
let server, base, mod;
before(async () => { mod = await import('./server.mjs'); server = await mod.startServer(config); base = `http://127.0.0.1:${server.address().port}`; });
after(async () => { await server?.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); });

// Signed in, through the encrypted transport (what the app does).
async function api(method, route, body, token) {
  const response = await testFetch(directory, base + route, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
// Plain HTTPS (what the guest page does).
async function plain(method, route, { body, token } = {}) {
  const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let json = null; try { json = JSON.parse(text); } catch { /* a page */ }
  return { status: response.status, headers: Object.fromEntries(response.headers), text, body: json || {} };
}

test('a guest token opens only the guest door of its own meeting; a device token opens none of it', async () => {
  const owner = (await api('POST', '/v1/pair', { terms: ACCEPT, code: mod.createInvite({ name: 'Ana Ruiz', role: 'owner' }), device: 'Mac' })).body;
  const general = (await api('GET', '/v1/conversations', undefined, owner.token)).body.conversations.find(c => c.name === 'general');
  const meeting = (await api('POST', '/v1/meetings', { conversationId: general.id }, owner.token)).body.meeting;
  assert.equal(meeting.guestsEnabled, true);
  const link = await api('POST', `/v1/meetings/${meeting.id}/guest-link`, { action: 'create' }, owner.token);
  assert.equal(link.status, 200, JSON.stringify(link.body));
  assert.match(link.body.url, new RegExp(`^${PUBLIC}/m/[A-Za-z0-9_-]{20}$`));
  const code = link.body.url.split('/m/')[1];

  // The page, plainly reachable, with its headers.
  const page = await plain('GET', `/m/${code}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Ana Ruiz is hosting/);
  assert.ok(!page.text.includes('general'));
  assert.ok(!/https?:\/\//.test(page.text), 'nothing from elsewhere');
  assert.match(page.headers['content-security-policy'], /^default-src 'none'; script-src 'nonce-[^']+'; style-src 'nonce-[^']+'; connect-src 'self'; media-src blob: mediastream:; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'$/);
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  assert.equal(page.headers['cache-control'], 'no-store');
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.equal(page.headers['x-robots-tag'], 'noindex, nofollow');
  assert.match(page.headers['permissions-policy'], /camera=\(self\), microphone=\(self\), display-capture=\(\)/);
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.equal((await plain('GET', '/m/AAAAAAAAAAAAAAAAAAAA')).status, 404);
  assert.match((await plain('GET', '/robots.txt')).text, /Disallow: \/m\/\nDisallow: \/g\//);

  // Knock, plainly.
  const knock = await plain('POST', `/g/${code}/knock`, { body: { name: 'Pat' } });
  assert.equal(knock.status, 200, knock.text);
  const guestToken = knock.body.guestToken;
  assert.equal(knock.headers['x-robots-tag'], 'noindex, nofollow');
  assert.equal(knock.headers['access-control-allow-origin'], undefined, 'no cross-origin use of the guest API');
  assert.deepEqual((await plain('GET', `/g/${code}/state`, { token: guestToken })).body, { state: 'pending', hostPresent: false });

  // The guest token on /v1: refused plainly (encryption required) and refused through the encrypted transport (not a device).
  for (const route of [`/v1/meetings/${meeting.id}`, '/v1/meetings', '/v1/me', '/v1/conversations', `/v1/conversations/${general.id}/messages`, `/v1/meetings/${meeting.id}/guests`]) {
    assert.equal((await plain('GET', route, { token: guestToken })).status, 426, `${route} plain`);
    assert.equal((await api('GET', route, undefined, guestToken)).status, 401, `${route} encrypted`);
  }
  for (const [route, body] of [[`/v1/meetings/${meeting.id}/join`, { sdp: 'v=0' }], [`/v1/meetings/${meeting.id}/end`, {}], [`/v1/meetings/${meeting.id}/guest-link`, { action: 'create' }], ['/v1/meetings', { conversationId: general.id }]]) {
    assert.equal((await plain('POST', route, { token: guestToken, body })).status, 426, `${route} plain`);
    assert.equal((await api('POST', route, body, guestToken)).status, 401, `${route} encrypted`);
  }
  // The device token on /g/: not a guest.
  for (const sub of ['state', 'join', 'watch', 'state-report', 'leave']) {
    const r = await plain(sub === 'state' ? 'GET' : 'POST', `/g/${code}/${sub}`, { token: owner.token, body: { sdp: 'v=0' } });
    assert.equal(r.status, 401, `${sub} with a device token: ${r.status}`);
  }
  assert.equal((await plain('GET', `/g/${code}/state`)).status, 401, 'no token');
  // The owner still sees the knock; the guest never sees the room.
  const view = (await api('GET', `/v1/meetings/${meeting.id}`, undefined, owner.token)).body.meeting;
  assert.deepEqual(view.guests.pending.map(p => p.name), ['Pat']);
  assert.equal(view.conversationId, general.id);
  const ended = await api('POST', `/v1/meetings/${meeting.id}/end`, {}, owner.token);
  assert.equal(ended.status, 200);
  assert.deepEqual((await plain('GET', `/g/${code}/state`, { token: guestToken })).body, { state: 'ended' });
  assert.equal((await plain('GET', `/m/${code}`)).status, 404);
});
