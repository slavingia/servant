// Sessions expire (session-expiry.mjs): with sessionMaxHours set, a device stops working after that
// many hours and re-enters with a code sent to the work email on file. The clock is faked so a
// twelve-hour session ends in a test; the server runs in this process and reads the same clock.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { testFetch } from './encrypted-test-client.mjs';
import { TERMS_VERSION, TERMS_ITEMS } from './terms.mjs';
import { sessionPolicy, maskEmail, staleAllowed, reentryMail, REVERIFY_HEADER, SESSION_FILE } from './session-expiry.mjs';
import { createPushService, defaults } from './push.mjs';
const ACCEPT = { version: TERMS_VERSION, items: TERMS_ITEMS };

for (const key of Object.keys(process.env)) if (/^(SERVANT_|HERMES_)/.test(key) || key === 'API_SERVER_KEY') delete process.env[key];
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-session-'));
process.env.SERVANT_DATA_DIR = directory;
process.env.SERVANT_WORKER_MODE = 'external';
process.env.SERVANT_PUSH_CONFIG = path.join(directory, 'push.json');
fs.writeFileSync(process.env.SERVANT_PUSH_CONFIG, '{}');

// The fake clock: everything in this process (server, encrypted transport, the test) reads it.
const realNow = Date.now;
let offset = 0;
Date.now = () => realNow() + offset;
const HOUR = 3_600_000, MINUTE = 60_000;
const advance = ms => { offset += ms; };

const PUBLIC = 'https://sessions.example';
const config = { host: '127.0.0.1', port: 0, name: 'Expiring team', agentName: 'Test agent', agentAccess: 'limited', publicUrl: PUBLIC, discoveryUrl: '', adminKey: '', upstreams: {}, guestMeetings: true,
  emailVerification: { enabled: true, domains: ['example.gov'], mailer: { command: 'true' } }, sessionMaxHours: 12, sessionGraceHours: 72 };
const sent = [];
globalThis.__servantEmailSend = async m => { sent.push(m); };
let server, base, mod, startedAt;
before(async () => { mod = await import('./server.mjs'); startedAt = Date.now(); server = await mod.startServer(config); base = `http://127.0.0.1:${server.address().port}`; });
after(async () => { delete globalThis.__servantEmailSend; await server?.shutdown(); Date.now = realNow; fs.rmSync(directory, { recursive: true, force: true }); });

// `reverify: false` is an older app build: no re-entry screen, so no header.
async function api(method, route, body, token, { reverify = true, ip } = {}) {
  const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(reverify ? { [REVERIFY_HEADER]: '1' } : {}), ...(ip ? { 'cf-connecting-ip': ip } : {}) };
  const response = await testFetch(directory, base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let json = {}; try { json = JSON.parse(text); } catch { /* a stream or a page */ }
  return { status: response.status, body: json, text };
}
async function plain(method, route, { body, token } = {}) {
  const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let json = {}; try { json = JSON.parse(text); } catch { /* a page */ }
  return { status: response.status, body: json, text };
}
const lastCode = () => sent.at(-1).code;
const wrongCode = () => (lastCode() === '000000' ? '111111' : '000000');
// Join with the team's flow: invite, work email, code. The device counts as verified now.
async function joinWithEmail(name, email, role = 'member', device = 'Test phone') {
  const code = mod.createInvite({ name, role });
  const start = await api('POST', '/v1/pair/email', { code, email });
  assert.equal(start.status, 200, start.text);
  const paired = await api('POST', '/v1/pair', { terms: ACCEPT, code, device, emailChallenge: start.body.challenge, emailCode: lastCode() });
  assert.equal(paired.status, 201, paired.text);
  return { token: paired.body.token, user: paired.body.user };
}
// Someone from before email codes: user and signed-in device written as that older release did.
function preEmailPerson(name, { role = 'member', createdAt = Date.now() - 5 * 24 * HOUR } = {}) {
  const token = crypto.randomBytes(32).toString('base64url');
  const user = { id: `usr_${crypto.randomBytes(9).toString('base64url')}`, name, role, createdAt, agentTier: 0 };
  const deviceId = `dev_${crypto.randomBytes(9).toString('base64url')}`;
  mod.mutateStateForTest(state => {
    state.users[user.id] = user;
    state.devices[crypto.createHash('sha256').update(token).digest('hex')] = { id: deviceId, userId: user.id, label: 'Android phone', createdAt, lastSeenAt: createdAt };
  });
  return { token, user, deviceId };
}
const expiredError = (r, status = 401) => {
  assert.equal(r.status, status, r.text);
  assert.equal(r.body.error?.code, 'session_expired', r.text);
};

test('the policy is strict about its numbers and refuses to run without a way to send codes', () => {
  const mail = { enabled: true, mailer: { command: 'send' } };
  assert.equal(sessionPolicy({}).enabled, false);
  assert.equal(sessionPolicy({}).requested, false);
  for (const bad of [0, -1, '12', NaN, Infinity, null, true, {}, [12]]) {
    const p = sessionPolicy({ sessionMaxHours: bad, emailVerification: mail });
    assert.equal(p.enabled, false, String(bad));
    assert.equal(p.maxHours, 0, String(bad));
  }
  assert.equal(sessionPolicy({ sessionMaxHours: 12, emailVerification: mail }).enabled, true);
  assert.equal(sessionPolicy({ sessionMaxHours: 0.5, emailVerification: mail }).maxMs, 30 * MINUTE);
  assert.equal(sessionPolicy({ sessionMaxHours: 1e9, emailVerification: mail }).maxHours, 24 * 365, 'capped at a year');
  assert.equal(sessionPolicy({ sessionMaxHours: 12, emailVerification: mail }).graceHours, 72, 'default grace');
  assert.equal(sessionPolicy({ sessionMaxHours: 12, sessionGraceHours: 0, emailVerification: mail }).graceHours, 0);
  assert.equal(sessionPolicy({ sessionMaxHours: 12, sessionGraceHours: '48', emailVerification: mail }).graceHours, 72);
  assert.equal(sessionPolicy({ sessionMaxHours: 12, sessionGraceHours: -5, emailVerification: mail }).graceHours, 72);
  const noEmail = sessionPolicy({ sessionMaxHours: 12 });
  assert.deepEqual([noEmail.requested, noEmail.enabled, noEmail.problem], [true, false, 'emailVerification is off']);
  const noMailer = sessionPolicy({ sessionMaxHours: 12, emailVerification: { enabled: true } });
  assert.deepEqual([noMailer.requested, noMailer.enabled, noMailer.problem], [true, false, 'emailVerification.mailer.command is not set']);
  assert.equal(sessionPolicy({ sessionMaxHours: 12, emailVerification: { enabled: true, mailer: { command: '  ' } } }).enabled, false);
  assert.equal(maskEmail('jo.smith@example.gov'), 'j***@example.gov');
  assert.equal(maskEmail('nonsense'), '');
  assert.equal(staleAllowed('/v1/session/email', {}), true);
  assert.equal(staleAllowed('/v1/signout', {}), true);
  assert.equal(staleAllowed('/v1/me', {}), false);
  assert.equal(staleAllowed('/v1/people/me/email', {}), true, 'no email yet: adding one is the way back in');
  assert.equal(staleAllowed('/v1/people/me/email', { emailVerifiedAt: 1 }), false, 'with an email the code is the way back in');
  const mail1 = reentryMail({ name: 'Pat Tester', device: 'iPhone' })('123456', 10);
  assert.match(mail1.text, /Pat Tester/); assert.match(mail1.text, /iPhone/); assert.match(mail1.text, /123456/); assert.match(mail1.text, /ignore this email/i);
  assert.ok(!/https?:\/\//.test(mail1.text), 'no link in the mail');
});

test('someone with no email keeps working through the grace period, then is held until they confirm one, which also lets them back in', async () => {
  const since = JSON.parse(fs.readFileSync(path.join(directory, SESSION_FILE), 'utf8')).since;
  assert.ok(since >= startedAt && since <= startedAt + 5 * MINUTE, 'the grace period counts from when the policy first ran here');
  advance(20 * HOUR);
  const early = preEmailPerson('Early Bird');
  const ip = '203.0.113.20';
  const me = await api('GET', '/v1/me', undefined, early.token, { ip });
  assert.equal(me.status, 200, me.text);
  assert.equal(me.body.emailRequired, true);
  assert.deepEqual(me.body.session, { expiresAt: since + 72 * HOUR, maxHours: 12, emailNeeded: true, email: null });
  assert.equal((await api('GET', '/v1/conversations', undefined, early.token, { ip })).status, 200, 'twenty hours in, five-day-old device: still working');
  // No email means no code to send.
  const noCode = await api('POST', '/v1/session/email', {}, early.token, { ip });
  assert.equal(noCode.status, 409, noCode.text);
  assert.equal(noCode.body.error.code, 'email_needed');
  advance(53 * HOUR);
  expiredError(await api('GET', '/v1/me', undefined, early.token, { ip }));
  expiredError(await api('GET', '/v1/conversations', undefined, early.token, { ip }));
  assert.equal((await api('POST', '/v1/session/email', {}, early.token, { ip })).body.error?.code, 'email_needed');
  // Held, but adding the first work email is still allowed, and confirming it is the re-entry.
  const start = await api('POST', '/v1/people/me/email', { email: 'early.bird@example.gov' }, early.token, { ip });
  assert.equal(start.status, 200, start.text);
  assert.equal(sent.at(-1).to, 'early.bird@example.gov');
  const bad = await api('POST', '/v1/people/me/email/confirm', { challenge: start.body.challenge, code: wrongCode() }, early.token, { ip });
  assert.equal(bad.body.error?.code, 'email_code_wrong');
  expiredError(await api('GET', '/v1/me', undefined, early.token, { ip }));
  const good = await api('POST', '/v1/people/me/email/confirm', { challenge: start.body.challenge, code: lastCode() }, early.token, { ip });
  assert.equal(good.status, 200, good.text);
  const after = await api('GET', '/v1/me', undefined, early.token, { ip });
  assert.equal(after.status, 200, after.text);
  assert.deepEqual([after.body.emailRequired, after.body.user.emailVerified, after.body.session.emailNeeded, after.body.session.email], [false, true, false, 'e***@example.gov']);
  assert.ok(Math.abs(after.body.session.expiresAt - (Date.now() + 12 * HOUR)) < 5000, 'fresh for twelve hours from the confirmation');
  // Now that there is an email, the email-adding door is closed to a held session: the code is the way.
  advance(13 * HOUR);
  expiredError(await api('POST', '/v1/people/me/email', { email: 'another@example.gov' }, early.token, { ip }));
  const code = await api('POST', '/v1/session/email', {}, early.token, { ip });
  assert.equal(code.status, 200, code.text);
  assert.equal(sent.at(-1).to, 'early.bird@example.gov');
});

test('twelve hours after the email step every door closes with session_expired, and old builds get a 403 instead of a sign-out', async () => {
  const pat = await joinWithEmail('Pat Tester', 'pat.tester@example.gov');
  const me = await api('GET', '/v1/me', undefined, pat.token);
  assert.equal(me.status, 200, me.text);
  assert.deepEqual(me.body.session, { expiresAt: me.body.session.expiresAt, maxHours: 12, emailNeeded: false, email: 'p***@example.gov' });
  assert.ok(Math.abs(me.body.session.expiresAt - (Date.now() + 12 * HOUR)) < 5000, 'ends twelve hours after pairing');
  const general = (await api('GET', '/v1/conversations', undefined, pat.token)).body.conversations.find(c => c.name === 'general');
  assert.ok(general, 'in #general while fresh');
  await api('PUT', '/v1/notifications', { platform: 'ios', token: 'a'.repeat(64), environment: 'production' }, pat.token);
  const link = await api('POST', '/v1/device-links', { device: 'Mac' });
  assert.equal(link.status, 201, link.text);

  advance(12 * HOUR - MINUTE);
  assert.equal((await api('GET', '/v1/me', undefined, pat.token)).status, 200, 'a minute before: still in');
  // An open live stream while fresh…
  const streamRes = await testFetch(directory, `${base}/v1/events`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pat.token}`, Accept: 'text/event-stream', [REVERIFY_HEADER]: '1' } });
  assert.equal(streamRes.status, 200);
  const reader = streamRes.body.getReader();
  const first = await reader.read();
  assert.ok(!first.done, 'the stream is open');

  advance(2 * MINUTE);
  // …ends on its own once the session is over.
  const closed = await Promise.race([
    (async () => { for (;;) { const { done } = await reader.read(); if (done) return 'closed'; } })(),
    new Promise(resolve => setTimeout(() => resolve('still open'), 4000)),
  ]);
  assert.equal(closed, 'closed', 'the live stream ends when the session does');

  // Every path that takes a device token, REST and streams alike.
  const paths = [
    ['GET', '/v1/me'], ['GET', '/v1/conversations'], ['GET', `/v1/conversations/${general.id}/messages`], ['POST', `/v1/conversations/${general.id}/messages`, { text: 'hi' }],
    ['POST', '/v1/events', {}], ['GET', '/v1/events'], ['GET', '/v1/attachments/att_nothing'], ['GET', '/v1/people'], ['GET', '/v1/search?q=hi'],
    ['GET', '/v1/notifications'], ['PUT', '/v1/notifications', { platform: 'ios', token: 'a'.repeat(64), environment: 'production' }], ['PUT', '/v1/notifications/voip', { token: 'b'.repeat(64), environment: 'production' }],
    ['GET', '/v1/meetings'], ['POST', '/v1/meetings', { conversationId: general.id }], ['GET', '/v1/recordings'],
    ['GET', '/v1/chats'], ['GET', '/v1/chats/cht_nothing/messages'], ['POST', '/v1/chats', { title: 'x' }], ['GET', '/v1/projects'], ['GET', '/v1/leaderboard'], ['GET', '/v1/feedback'],
    ['POST', '/v1/sign-in-links', {}], ['GET', '/v1/sign-in-links'], ['GET', `/v1/device-links/${link.body.id}`], ['POST', `/v1/device-links/${link.body.id}/approve`, {}],
    ['PATCH', '/v1/people/me', { name: 'Pat T' }], ['POST', '/v1/people/me/email', { email: 'other@example.gov' }], ['POST', '/v1/feedback', { text: 'x', requestId: 'r', context: {} }],
  ];
  for (const [method, route, body] of paths) {
    const r = await api(method, route, body, pat.token);
    expiredError(r);
    assert.equal(r.body.error.message, 'Your session ended. Enter the code we email you to continue.', route);
    assert.equal(r.body.error.maxHours, 12, route);
  }
  // A build without the re-entry screen: never a 401 it would read as "signed out, wipe the account".
  const old = await api('GET', '/v1/conversations', undefined, pat.token, { reverify: false });
  expiredError(old, 403);
  assert.match(old.body.error.message, /Update Servant/);
  // Public doors stay open; signing out always works.
  assert.equal((await plain('GET', '/health')).status, 200);
  assert.equal((await api('GET', '/v1/pair/email')).status, 200);
  assert.equal((await api('GET', '/v1/server')).status, 200);
  const newLink = await api('POST', '/v1/device-links', { device: 'Mac' });
  assert.equal(newLink.status, 201, 'pairing routes need no session');
  assert.equal((await api('POST', `/v1/device-links/${newLink.body.id}/poll`, { secret: newLink.body.secret })).body.status, 'pending');
  const out = await api('POST', '/v1/signout', {}, pat.token);
  assert.equal(out.status, 200, out.text);
  assert.equal((await api('GET', '/v1/me', undefined, pat.token)).body.error?.code, 'unauthorized', 'signed out is signed out, not expired');
});

test('re-entry: the code goes only to the email on file, works once, only for this device and person, and makes the same token fresh again', async () => {
  const pat = await joinWithEmail('Pat Reentry', 'pat.reentry@example.gov');
  const sam = await joinWithEmail('Sam Other', 'sam.other@example.gov');
  advance(12 * HOUR + MINUTE);
  expiredError(await api('GET', '/v1/me', undefined, pat.token));
  expiredError(await api('GET', '/v1/me', undefined, sam.token));

  // Whatever the caller sends, the code goes to the account's address and the response masks it.
  const before = sent.length;
  const start = await api('POST', '/v1/session/email', { email: 'attacker@example.gov' }, pat.token);
  assert.equal(start.status, 200, start.text);
  assert.equal(sent.length, before + 1);
  assert.equal(sent.at(-1).to, 'pat.reentry@example.gov');
  assert.match(sent.at(-1).text, /Pat Reentry/); assert.match(sent.at(-1).text, /Test phone/); assert.match(sent.at(-1).text, /ignore this email/);
  assert.ok(!/https?:\/\//.test(sent.at(-1).text), 'no link');
  assert.deepEqual(Object.keys(start.body).sort(), ['challenge', 'email', 'expiresInSeconds', 'resendAfterSeconds']);
  assert.equal(start.body.email, 'p***@example.gov');
  assert.ok(!start.text.includes(lastCode()), 'the code is never in the response');
  const challenge = start.body.challenge, code = lastCode();

  // Wrong code: still out. Someone else's token with Pat's challenge: no.
  const wrong = await api('POST', '/v1/session/verify', { challenge, code: wrongCode() }, pat.token);
  assert.equal(wrong.body.error?.code, 'email_code_wrong', wrong.text);
  expiredError(await api('GET', '/v1/me', undefined, pat.token));
  const stolen = await api('POST', '/v1/session/verify', { challenge, code }, sam.token);
  assert.equal(stolen.body.error?.code, 'email_code_expired', 'bound to the device and person that asked');
  expiredError(await api('GET', '/v1/me', undefined, sam.token));
  // A missing challenge, a bogus one, and an empty code say the same thing.
  assert.equal((await api('POST', '/v1/session/verify', {}, pat.token)).body.error?.code, 'email_code_expired');
  assert.equal((await api('POST', '/v1/session/verify', { challenge: 'nope', code }, pat.token)).body.error?.code, 'email_code_expired');

  // The right code on the right device: the same token works again, for another twelve hours.
  const ok = await api('POST', '/v1/session/verify', { challenge, code }, pat.token);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(ok.body.ok, true);
  assert.ok(Math.abs(ok.body.session.expiresAt - (Date.now() + 12 * HOUR)) < 5000);
  const me = await api('GET', '/v1/me', undefined, pat.token);
  assert.equal(me.status, 200, me.text);
  assert.equal(me.body.user.id, pat.user.id);
  assert.ok(Math.abs(me.body.session.expiresAt - (Date.now() + 12 * HOUR)) < 5000);
  // Once.
  assert.equal((await api('POST', '/v1/session/verify', { challenge, code }, pat.token)).body.error?.code, 'email_code_expired');
  advance(11 * HOUR);
  assert.equal((await api('GET', '/v1/me', undefined, pat.token)).status, 200, 'still fresh eleven hours after re-entry');
  advance(2 * HOUR);
  expiredError(await api('GET', '/v1/me', undefined, pat.token));

  // Attempt limit: five wrong tries kill the challenge, even for the right code after.
  const again = await api('POST', '/v1/session/email', {}, pat.token);
  assert.equal(again.status, 200, again.text);
  const code2 = lastCode();
  for (let i = 0; i < 5; i++) assert.equal((await api('POST', '/v1/session/verify', { challenge: again.body.challenge, code: wrongCode() }, pat.token)).body.error?.code, 'email_code_wrong');
  assert.equal((await api('POST', '/v1/session/verify', { challenge: again.body.challenge, code: code2 }, pat.token)).body.error?.code, 'email_code_expired');
  // Ten minutes: a code that was never used is dead.
  const late = await api('POST', '/v1/session/email', {}, pat.token);
  const code3 = lastCode();
  advance(11 * MINUTE);
  assert.equal((await api('POST', '/v1/session/verify', { challenge: late.body.challenge, code: code3 }, pat.token)).body.error?.code, 'email_code_expired');
  // Per-address throttle: five codes per ten minutes, the sixth waits.
  for (let i = 0; i < 5; i++) assert.equal((await api('POST', '/v1/session/email', {}, pat.token)).status, 200);
  const sixth = await api('POST', '/v1/session/email', {}, pat.token);
  assert.equal(sixth.status, 429, sixth.text);
  assert.equal(sixth.body.error.code, 'rate_limited');
  advance(11 * MINUTE);
  const fresh = await api('POST', '/v1/session/email', {}, pat.token);
  assert.equal(fresh.status, 200, fresh.text);
  const done = await api('POST', '/v1/session/verify', { challenge: fresh.body.challenge, code: lastCode() }, pat.token);
  assert.equal(done.status, 200, done.text);
  // Sam, still out, cannot ride on it.
  expiredError(await api('GET', '/v1/me', undefined, sam.token));
  // Per-visitor failure throttle: too many wrong codes from one address and that address waits, like pairing.
  const probe = await api('POST', '/v1/session/email', {}, sam.token, { ip: '203.0.113.9' });
  assert.equal(probe.status, 200, probe.text);
  let limited = null;
  for (let i = 0; i < 12 && !limited; i++) {
    const r = await api('POST', '/v1/session/verify', { challenge: 'x', code: '000000' }, sam.token, { ip: '203.0.113.9' });
    if (r.status === 429) limited = r;
  }
  assert.ok(limited, 'the address is throttled after ten failures');
  assert.equal((await api('POST', '/v1/session/email', {}, sam.token, { ip: '203.0.113.9' })).status, 429, 'sending is throttled for that address too');
});

test('guests are untouched: a guest token keeps working on its meeting while the host is held', async () => {
  advance(11 * MINUTE); // the failure throttle from the test above has passed
  const host = await joinWithEmail('Host Person', 'host.person@example.gov', 'owner', 'Mac');
  const general = (await api('GET', '/v1/conversations', undefined, host.token)).body.conversations.find(c => c.name === 'general');
  const meeting = (await api('POST', '/v1/meetings', { conversationId: general.id }, host.token)).body.meeting;
  assert.ok(meeting?.id, 'the host starts a call while fresh');
  const link = await api('POST', `/v1/meetings/${meeting.id}/guest-link`, { action: 'create' }, host.token);
  assert.equal(link.status, 200, link.text);
  const code = link.body.url.split('/m/')[1];
  const knock = await plain('POST', `/g/${code}/knock`, { body: { name: 'Guest Pat' } });
  assert.equal(knock.status, 200, knock.text);
  const guestToken = knock.body.guestToken;
  assert.equal((await plain('GET', `/g/${code}/state`, { token: guestToken })).status, 200);
  // Age the host's device instead of the clock, so the guest's own six-hour token stays live.
  mod.mutateStateForTest(state => { for (const d of Object.values(state.devices)) if (d.userId === host.user.id) { d.createdAt -= 13 * HOUR; d.sessionVerifiedAt -= 13 * HOUR; } });
  expiredError(await api('GET', `/v1/meetings/${meeting.id}`, undefined, host.token));
  expiredError(await api('POST', `/v1/meetings/${meeting.id}/guests`, { action: 'admit', guestId: 'x' }, host.token));
  const still = await plain('GET', `/g/${code}/state`, { token: guestToken });
  assert.equal(still.status, 200, still.text);
  assert.equal(still.body.state, 'pending');
  assert.equal((await plain('GET', `/m/${code}`)).status, 200, 'the guest page is up');
  // A guest token is no device token, expired or not.
  assert.equal((await api('GET', '/v1/me', undefined, guestToken)).body.error?.code, 'unauthorized');
});

test('push: a device whose session ended gets no call rings and no message text', async () => {
  const file = path.join(directory, 'push-stale.db');
  const dev = { id: 'dev_1', userId: 'usr_1', push: { platform: 'ios', token: 'x'.repeat(64), environment: 'production' }, voip: { token: 'f'.repeat(64), environment: 'production' }, ringsCalls: true };
  const user = { id: 'usr_1', name: 'Pat', notifications: { ...defaults, contentPreviews: true } };
  const state = { devices: { k: dev }, users: { usr_1: user } };
  const delivered = [];
  let stale = false;
  const push = createPushService({ file, autoDrain: false, state: () => state, mutate: fn => fn(state), stale: () => stale,
    resolve: (event) => event.call ? { kind: 'dm', conversationId: 'dm_1', title: 'Sam', body: 'Incoming call', meetingId: 'mtg_1', caller: 'Sam' } : { kind: 'dm', conversationId: 'dm_1', title: 'Sam', body: 'the secret budget numbers' },
    send: async (target, payload) => { delivered.push({ target, payload }); return { ok: true }; } });
  try {
    push.enqueue({ kind: 'message', messageId: 'm1' });
    await push.drain();
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].payload.body, 'the secret budget numbers', 'fresh: the text comes through');
    stale = true;
    push.enqueue({ kind: 'message', messageId: 'm2' });
    push.enqueue({ kind: 'message', messageId: 'm3', call: true });
    await push.drain();
    assert.equal(delivered.length, 2, 'the call never rang');
    assert.equal(delivered[1].payload.title, 'Servant');
    assert.equal(delivered[1].payload.body, "Confirm it's you in Servant to see new messages");
    assert.ok(!JSON.stringify(delivered[1].payload).includes('secret'), 'no message text while held');
    assert.equal(delivered[1].target.platform, 'ios');
    assert.equal(delivered[1].payload.call, undefined);
  } finally { push.close(); }
});
