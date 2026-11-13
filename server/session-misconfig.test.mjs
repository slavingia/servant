// sessionMaxHours without a way to email codes: the server says so at startup and leaves sessions
// alone, because nobody could ever get back in.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { testFetch } from './encrypted-test-client.mjs';
import { SESSION_FILE } from './session-expiry.mjs';

for (const key of Object.keys(process.env)) if (/^(SERVANT_|HERMES_)/.test(key) || key === 'API_SERVER_KEY') delete process.env[key];
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-session-misconfig-'));
process.env.SERVANT_DATA_DIR = directory;
process.env.SERVANT_WORKER_MODE = 'external';
process.env.SERVANT_PUSH_CONFIG = path.join(directory, 'push.json');
fs.writeFileSync(process.env.SERVANT_PUSH_CONFIG, '{}');
const HOUR = 3_600_000;
// Email codes on, but no mailer command: codes could never be delivered.
const config = { host: '127.0.0.1', port: 0, name: 'Misconfigured team', agentName: 'Test agent', agentAccess: 'limited', publicUrl: '', discoveryUrl: '', adminKey: '', upstreams: {},
  emailVerification: { enabled: true, domains: ['example.gov'] }, sessionMaxHours: 12 };
const warnings = [];
const realWarn = console.warn;
let server, base, mod;
before(async () => {
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  mod = await import('./server.mjs'); server = await mod.startServer(config); base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { console.warn = realWarn; await server?.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); });

test('without a mailer the server warns once at startup and no session expires', async () => {
  assert.equal(warnings.filter(w => /sessionMaxHours is 12 but emailVerification.mailer.command is not set/.test(w)).length, 1, JSON.stringify(warnings));
  assert.equal(fs.existsSync(path.join(directory, SESSION_FILE)), false, 'no grace clock starts for a policy that is not running');
  const token = crypto.randomBytes(32).toString('base64url');
  const createdAt = Date.now() - 400 * 24 * HOUR;
  mod.mutateStateForTest(state => {
    state.users.usr_old = { id: 'usr_old', name: 'Old Timer', role: 'owner', createdAt };
    state.devices[crypto.createHash('sha256').update(token).digest('hex')] = { id: 'dev_old', userId: 'usr_old', label: 'Mac', createdAt, lastSeenAt: createdAt };
  });
  const response = await testFetch(directory, `${base}/v1/me`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(response.status, 200);
  const me = await response.json();
  assert.equal(me.session, null, 'the app is not told sessions expire');
  const reentry = await testFetch(directory, `${base}/v1/session/email`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } });
  assert.equal(reentry.status, 404, 're-entry routes are closed while the policy is not running');
  assert.equal(warnings.filter(w => /sessionMaxHours/.test(w)).length, 1, 'warned once, not per request');
});
