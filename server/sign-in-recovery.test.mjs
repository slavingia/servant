// Signing in on a new device when you already have an account, with email codes on.
// Reproduces tester Jo's report (#signin): a pre-email account, a team link that
// says "name taken", and a sign-in link that was forced through a work-email step.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { testFetch } from './encrypted-test-client.mjs';
import { TERMS_VERSION, TERMS_ITEMS } from './terms.mjs';
import { DEVICE_LINK_IP_LIMIT } from './device-links.mjs';
const ACCEPT = { version: TERMS_VERSION, items: TERMS_ITEMS };

for (const key of Object.keys(process.env)) if (/^(SERVANT_|HERMES_)/.test(key) || key === 'API_SERVER_KEY') delete process.env[key];
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-signin-'));
process.env.SERVANT_DATA_DIR = directory;
process.env.SERVANT_WORKER_MODE = 'external';
process.env.SERVANT_PUSH_CONFIG = path.join(directory, 'push.json');
fs.writeFileSync(process.env.SERVANT_PUSH_CONFIG, '{}');
// Email codes ON for the whole file, as on a server that requires them.
const config = { host: '127.0.0.1', port: 0, name: 'Email-on team', agentName: 'Test agent', agentAccess: 'limited', publicUrl: '', discoveryUrl: '', adminKey: '', upstreams: {}, emailVerification: { enabled: true, domains: ['example.gov'] } };
const sent = [];
globalThis.__servantEmailSend = async m => { sent.push(m); };
let server, base, mod;
before(async () => { mod = await import('./server.mjs'); server = await mod.startServer(config); base = `http://127.0.0.1:${server.address().port}`; });
after(async () => { delete globalThis.__servantEmailSend; await server?.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); });

async function api(method, route, body, token) {
  const response = await testFetch(directory, base + route, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}
// Someone who joined before email codes existed: a user and a signed-in phone written as
// that older release did, with no email on file.
async function preEmailPerson(name) {
  const token = crypto.randomBytes(32).toString('base64url');
  const user = { id: `usr_${crypto.randomBytes(9).toString('base64url')}`, name, role: 'member', createdAt: Date.now() - 86400000, agentTier: 0 };
  mod.mutateStateForTest(state => {
    state.users[user.id] = user;
    state.devices[crypto.createHash('sha256').update(token).digest('hex')] = { id: `dev_${crypto.randomBytes(9).toString('base64url')}`, userId: user.id, label: 'Android phone', createdAt: user.createdAt, lastSeenAt: user.createdAt };
  });
  const me = await api('GET', '/v1/me', undefined, token);
  assert.equal(me.status, 200, JSON.stringify(me.body));
  assert.equal(me.body.emailRequired, true);
  return { token, user: me.body.user };
}
const lastCode = () => sent.at(-1).code;
async function emailProof(code, email) {
  const start = await api('POST', '/v1/pair/email', { code, email });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  return { emailChallenge: start.body.challenge, emailCode: lastCode() };
}

test("Jo step 3: a sign-in link from the phone signs in a computer with no work-email step, even when the account has no email", async () => {
  const jo = await preEmailPerson('Jo Link');
  const made = await api('POST', '/v1/sign-in-links', {}, jo.token);
  assert.equal(made.status, 200);
  // The browser pastes the link: terms, then pair. Before the fix this answered 400 email_required.
  const redeemed = await api('POST', '/v1/pair', { terms: ACCEPT, code: made.body.code, device: 'Browser' });
  assert.equal(redeemed.status, 201, JSON.stringify(redeemed.body));
  assert.equal(redeemed.body.user.id, jo.user.id);
  // The phone can see the link was used, and by what.
  const status = await api('GET', '/v1/sign-in-links', undefined, jo.token);
  assert.equal(status.status, 200);
  assert.equal(status.body.link.status, 'used');
  assert.equal(status.body.link.device, 'Browser');
});

test("an older app that still sends an email code with a sign-in link keeps working and attaches the email", async () => {
  const kim = await preEmailPerson('Kim Oldapp');
  const made = await api('POST', '/v1/sign-in-links', {}, kim.token);
  const proof = await emailProof(made.body.code, 'kim.oldapp@example.gov');
  const redeemed = await api('POST', '/v1/pair', { terms: ACCEPT, code: made.body.code, device: 'Browser', ...proof });
  assert.equal(redeemed.status, 201, JSON.stringify(redeemed.body));
  assert.equal(redeemed.body.user.id, kim.user.id);
  assert.equal((await api('GET', '/v1/me', undefined, redeemed.body.token)).body.user.emailVerified, true);
});

test("sign-in link problems are told apart: used, replaced, expired, unknown (never a bare 'try again')", async () => {
  const sam = await preEmailPerson('Sam Links');
  const first = (await api('POST', '/v1/sign-in-links', {}, sam.token)).body;
  const second = (await api('POST', '/v1/sign-in-links', {}, sam.token)).body;
  const replaced = await api('POST', '/v1/pair', { terms: ACCEPT, code: first.code, device: 'Browser' });
  assert.equal(replaced.status, 403);
  assert.equal(replaced.body.error.code, 'invite_replaced');
  assert.match(replaced.body.error.message, /newer link/i);
  assert.equal((await api('POST', '/v1/pair', { terms: ACCEPT, code: second.code, device: 'Browser' })).status, 201);
  const used = await api('POST', '/v1/pair', { terms: ACCEPT, code: second.code, device: 'Browser' });
  assert.equal(used.status, 403);
  assert.equal(used.body.error.code, 'invite_used');
  assert.match(used.body.error.message, /already used/i);
  const third = (await api('POST', '/v1/sign-in-links', {}, sam.token)).body;
  const { createStateStore } = await import('./state-store.mjs');
  const store = createStateStore({ directory });
  store.mutate(state => { for (const inv of Object.values(state.invites)) if (inv.kind === 'sign-in-link' && inv.userId === sam.user.id && !inv.usedAt && !inv.revokedAt) inv.expiresAt = Date.now() - 1; });
  store.close();
  const expired = await api('POST', '/v1/pair', { terms: ACCEPT, code: third.code, device: 'Browser' });
  assert.equal(expired.status, 403);
  assert.equal(expired.body.error.code, 'invite_expired');
  assert.match(expired.body.error.message, /expired/i);
  assert.equal((await api('GET', '/v1/sign-in-links', undefined, sam.token)).body.link.status, 'expired');
  const unknown = await api('POST', '/v1/pair', { terms: ACCEPT, code: 'ZZZZZ-ZZZZZ', device: 'Browser' });
  assert.equal(unknown.status, 403);
  assert.equal(unknown.body.error.code, 'invalid_invite');
  // The email step tells the same story for a dead link.
  assert.equal((await api('POST', '/v1/pair/email', { code: second.code, email: 'sam@example.gov' })).body.error.code, 'invite_used');
});

test("Jo step 1: joining by email with the name of an account that has no email says so, and still refuses to hand the account over by name", async () => {
  const jo = await preEmailPerson('Jo Early');
  const team = (await mod.joinLink({ fresh: true })).code;
  const proof = await emailProof(team, 'jo.early@example.gov');
  const taken = await api('POST', '/v1/pair', { terms: ACCEPT, code: team, device: 'Browser', name: 'jo early', ...proof });
  assert.equal(taken.status, 409);
  assert.equal(taken.body.error.code, 'name_taken', 'older apps keep their name screen');
  assert.deepEqual(taken.body.error.existing, { hasEmail: false });
  assert.match(taken.body.error.message, /Link a computer/);
  // No account was created or changed; Jo's account has no email.
  const { createStateStore } = await import('./state-store.mjs');
  const store = createStateStore({ directory });
  const users = Object.values(store.read().users);
  store.close();
  assert.equal(users.filter(u => u.name.toLowerCase() === 'jo early').length, 1);
  assert.equal(users.find(u => u.id === jo.user.id).email, undefined);
  // A different name still joins as a new person with that email.
  const other = await api('POST', '/v1/pair', { terms: ACCEPT, code: team, device: 'Browser', name: 'Jo E', ...proof });
  assert.equal(other.status, 201, JSON.stringify(other.body));
});

test("the name of an account that has a different email is 'taken' with hasEmail true", async () => {
  const team = (await mod.joinLink({ fresh: true })).code;
  const pat = await api('POST', '/v1/pair', { terms: ACCEPT, code: team, device: 'Browser', name: 'Pat Mail', ...(await emailProof(team, 'pat.mail@example.gov')) });
  assert.equal(pat.status, 201);
  const taken = await api('POST', '/v1/pair', { terms: ACCEPT, code: team, device: 'Browser', name: 'Pat Mail', ...(await emailProof(team, 'someone.else@example.gov')) });
  assert.equal(taken.status, 409);
  assert.equal(taken.body.error.code, 'name_taken');
  assert.deepEqual(taken.body.error.existing, { hasEmail: true });
});

test("claim path: the browser asks the phone to approve; only the approving account is signed in, never the named one", async () => {
  const jo = await preEmailPerson('Jo Claim');
  const other = await preEmailPerson('Other Person');
  // The browser (holding a verified example.gov email) creates a device link and shows its code.
  const link = await api('POST', '/v1/device-links', { device: 'Browser' });
  assert.equal(link.status, 201);
  const route = '/v1/device-links/' + link.body.id;
  // Before approval the browser has nothing.
  assert.equal((await api('POST', route + '/poll', { secret: link.body.secret })).body.status, 'pending');
  // Wrong person: Other approves. The browser becomes Other, not Jo.
  assert.equal((await api('POST', route + '/approve', {}, other.token)).status, 200);
  const got = await api('POST', route + '/poll', { secret: link.body.secret });
  assert.equal(got.status, 200);
  assert.equal(got.body.user.id, other.user.id);
  assert.notEqual(got.body.user.id, jo.user.id);
  // Replayed: the same approved link cannot mint a second session.
  assert.equal((await api('POST', route + '/poll', { secret: link.body.secret })).status, 410);
  // Jo's own approval of his own request signs the browser in as Jo.
  const mine = (await api('POST', '/v1/device-links', { device: 'Browser' })).body;
  assert.equal((await api('POST', `/v1/device-links/${mine.id}/approve`, {}, jo.token)).status, 200);
  const me = await api('POST', `/v1/device-links/${mine.id}/poll`, { secret: mine.secret });
  assert.equal(me.body.user.id, jo.user.id);
  assert.equal((await api('GET', '/v1/me', undefined, me.body.token)).body.emailRequired, true, 'still no email: the app nudges for it');
});

test("claim path: expired requests and too many requests from one browser are refused", async () => {
  const jo = await preEmailPerson('Jo Limits');
  const link = (await api('POST', '/v1/device-links', { device: 'Browser' })).body;
  const { createStateStore } = await import('./state-store.mjs');
  const store = createStateStore({ directory });
  store.mutate(state => { state.invites['desktop:' + link.id].expiresAt = Date.now() - 1; });
  store.close();
  const expired = await api('POST', `/v1/device-links/${link.id}/approve`, {}, jo.token);
  assert.equal(expired.status, 410);
  assert.equal(expired.body.error.code, 'expired_device_link');
  assert.equal((await api('POST', `/v1/device-links/${link.id}/poll`, { secret: link.secret })).status, 410);
  let limited = null;
  for (let i = 0; i < DEVICE_LINK_IP_LIMIT + 1 && !limited; i++) {
    const r = await api('POST', '/v1/device-links', { device: 'Browser' });
    if (r.status === 429) limited = r;
  }
  assert.ok(limited, 'the per-IP limit stops a flood of requests');
  assert.equal(limited.body.error.code, 'rate_limited');
});
