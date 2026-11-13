// The owner can never be locked out of their own server by session expiry: `servant session-reset`
// on the Mac marks their devices fresh. Real clock; the grace period is zero so a person with no
// email is held at once, which is the worst case for the owner.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { testFetch } from './encrypted-test-client.mjs';
import { REVERIFY_HEADER } from './session-expiry.mjs';

for (const key of Object.keys(process.env)) if (/^(SERVANT_|HERMES_)/.test(key) || key === 'API_SERVER_KEY') delete process.env[key];
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-session-recovery-'));
process.env.SERVANT_DATA_DIR = directory;
process.env.SERVANT_WORKER_MODE = 'external';
process.env.SERVANT_PUSH_CONFIG = path.join(directory, 'push.json');
fs.writeFileSync(process.env.SERVANT_PUSH_CONFIG, '{}');
const HOUR = 3_600_000;
const config = { host: '127.0.0.1', port: 0, name: 'Recovery team', agentName: 'Test agent', agentAccess: 'limited', publicUrl: '', discoveryUrl: '', adminKey: '', upstreams: {},
  emailVerification: { enabled: true, domains: ['example.gov'], mailer: { command: 'true' } }, sessionMaxHours: 12, sessionGraceHours: 0 };
// The CLI runs as its own process and reads config.json, so it must see the same policy.
fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify(config));
let server, base, mod;
before(async () => { mod = await import('./server.mjs'); server = await mod.startServer(config); base = `http://127.0.0.1:${server.address().port}`; });
after(async () => { await server?.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); });

async function api(method, route, body, token) {
  const response = await testFetch(directory, base + route, { method, headers: { 'Content-Type': 'application/json', [REVERIFY_HEADER]: '1', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
function person(name, { role, hoursAgo, email }) {
  const token = crypto.randomBytes(32).toString('base64url');
  const createdAt = Date.now() - hoursAgo * HOUR;
  const user = { id: `usr_${crypto.randomBytes(9).toString('base64url')}`, name, role, createdAt, ...(email ? { email, emailVerifiedAt: createdAt } : {}) };
  const deviceId = `dev_${crypto.randomBytes(9).toString('base64url')}`;
  mod.mutateStateForTest(state => {
    state.users[user.id] = user;
    state.devices[crypto.createHash('sha256').update(token).digest('hex')] = { id: deviceId, userId: user.id, label: 'Mac', createdAt, lastSeenAt: createdAt };
  });
  return { token, user, deviceId };
}
async function cli(...args) {
  const child = spawn(process.execPath, [new URL('./server.mjs', import.meta.url).pathname, ...args], { env: { ...process.env, SERVANT_DATA_DIR: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', c => { output += c; });
  child.stderr.on('data', c => { output += c; });
  const [code] = await once(child, 'close');
  return { code, output };
}

test('the owner, signed in before email codes and held after the grace period, gets back in with session-reset on the Mac', async () => {
  const owner = person('Mo Owner', { role: 'owner', hoursAgo: 13 });
  const held = await api('GET', '/v1/me', undefined, owner.token);
  assert.equal(held.status, 401);
  assert.equal(held.body.error.code, 'session_expired');
  assert.equal((await api('POST', '/v1/session/email', {}, owner.token)).body.error?.code, 'email_needed', 'no email: no code to send');

  const wrong = await cli('session-reset', 'Nobody Here');
  assert.equal(wrong.code, 1);
  assert.match(wrong.output, /No one by that name/);
  assert.equal((await api('GET', '/v1/me', undefined, owner.token)).status, 401, 'a wrong name changes nothing');

  const reset = await cli('session-reset', 'Mo Owner');
  assert.equal(reset.code, 0, reset.output);
  assert.match(reset.output, /Mo Owner is back in on their device for the next 12 hours/);
  const back = await api('GET', '/v1/me', undefined, owner.token);
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal(back.body.user.role, 'owner');
  assert.ok(back.body.session.expiresAt > Date.now() + 11 * HOUR, 'fresh for twelve hours from the reset');
  assert.equal(back.body.session.emailNeeded, true, 'and still asked to add an email');

  // By device id, and for a member with an email too (the owner helping someone who missed the window).
  const pat = person('Pat Member', { role: 'member', hoursAgo: 20, email: 'pat@example.gov' });
  assert.equal((await api('GET', '/v1/me', undefined, pat.token)).status, 401);
  const byDevice = await cli('session-reset', pat.deviceId);
  assert.equal(byDevice.code, 0, byDevice.output);
  assert.equal((await api('GET', '/v1/me', undefined, pat.token)).status, 200);
  assert.equal((await cli('session-reset')).code, 2, 'usage without a name');
});
