import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decryptPush, encryptPush, pushServiceUrl, sendWebPush, temporaryWebPushIdentity, vapidAuthorization, vapidSubject, webPushIdentity, webSubscription } from './web-push.mjs';

const key = (privateKey) => { const k = crypto.createECDH('prime256v1'); if (privateKey) k.setPrivateKey(Buffer.from(privateKey, 'base64url')); else k.generateKeys(); return k; };
// A browser: the keys it keeps, and the subscription it hands over.
function browser(endpoint = 'https://fcm.googleapis.com/fcm/send/example-subscription') {
  const receiver = key(), auth = crypto.randomBytes(16);
  return { receiver, auth, subscription: { token: endpoint, p256dh: receiver.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
}

test('a message is encrypted exactly as RFC 8291 says, byte for byte', () => {
  // Section 5 and Appendix A of RFC 8291: the keys, the salt and the message it produces.
  const sender = key('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw');
  const receiver = key('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94');
  assert.equal(sender.getPublicKey().toString('base64url'), 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
  assert.equal(receiver.getPublicKey().toString('base64url'), 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4');
  const subscription = { p256dh: receiver.getPublicKey().toString('base64url'), auth: 'BTBZMqHH6r4Tts7J_aSIgg' };
  const body = encryptPush('When I grow up, I want to be a watermelon', subscription, { salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'), sender });
  assert.equal(body.toString('base64url'),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
  assert.equal(decryptPush(body, receiver, Buffer.from('BTBZMqHH6r4Tts7J_aSIgg', 'base64url')).toString(), 'When I grow up, I want to be a watermelon');
});

test('only the browser that subscribed can read a message, and no two messages look alike', () => {
  const { receiver, auth, subscription } = browser();
  const text = JSON.stringify({ title: 'Jo Park', body: 'The intake form went live this morning.' });
  const first = encryptPush(text, subscription), second = encryptPush(text, subscription);
  assert.equal(decryptPush(first, receiver, auth).toString(), text);
  assert.notDeepEqual(first, second, 'a fresh salt and sender key every time');
  assert.equal(first.includes(Buffer.from('Jo Park')), false, 'nothing readable in what the push service carries');
  // Another browser, a wrong secret or a changed byte cannot open it.
  assert.throws(() => decryptPush(first, key(), auth));
  assert.throws(() => decryptPush(first, receiver, crypto.randomBytes(16)));
  const tampered = Buffer.from(first); tampered[tampered.length - 20] ^= 1;
  assert.throws(() => decryptPush(tampered, receiver, auth));
});

test('the sender proves which server it is with a token the push service can check', () => {
  const identity = temporaryWebPushIdentity();
  const now = Date.UTC(2026, 10, 14, 12);
  const header = vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', identity, 'mailto:team@example.gov', now);
  const [, token, publicKey] = header.match(/^vapid t=([A-Za-z0-9_.-]+), k=([A-Za-z0-9_-]+)$/);
  assert.equal(publicKey, identity.publicKey);
  const [head, claims, signature] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(head, 'base64url')), { typ: 'JWT', alg: 'ES256' });
  // The audience is the push service and nothing about the subscription; it expires within a day.
  assert.deepEqual(JSON.parse(Buffer.from(claims, 'base64url')), { aud: 'https://fcm.googleapis.com', exp: now / 1000 + 12 * 3600, sub: 'mailto:team@example.gov' });
  const raw = Buffer.from(publicKey, 'base64url');
  assert.equal(raw.length, 65);
  const verifier = crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') } });
  assert.equal(crypto.verify('sha256', Buffer.from(`${head}.${claims}`), { key: verifier, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url')), true);
  // No contact address configured: the token simply has none.
  assert.equal('sub' in JSON.parse(Buffer.from(vapidAuthorization('https://web.push.apple.com/x', identity, null, now).split('.')[1], 'base64url')), false);
});

test('the contact address comes from the server\'s own settings', () => {
  assert.equal(vapidSubject({ contactEmail: ' team@example.gov ', publicUrl: 'https://servant.example.gov/' }), 'mailto:team@example.gov');
  assert.equal(vapidSubject({ contactEmail: '', publicUrl: 'https://servant.example.gov/path' }), 'https://servant.example.gov');
  for (const settings of [{}, { contactEmail: 'not an address' }, { publicUrl: 'http://servant.example.gov' }, { publicUrl: 'https://localhost' }, { publicUrl: 'nonsense' }, undefined]) assert.equal(vapidSubject(settings), null);
});

test('the signing key is made once, kept private in the data directory, and never replaced', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'servant-web-push-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = webPushIdentity(dir);
  assert.equal(Buffer.from(first.publicKey, 'base64url').length, 65);
  assert.equal(fs.statSync(path.join(dir, 'web-push-key')).mode & 0o777, 0o600);
  assert.equal(webPushIdentity(dir).publicKey, first.publicKey, 'the same key after a restart');
  // A damaged key is an error to fix, not a reason to make a new one that no browser has subscribed to.
  fs.writeFileSync(path.join(dir, 'web-push-key'), Buffer.alloc(40));
  assert.throws(() => webPushIdentity(dir));
});

test('a subscription can only point at a browser\'s push service', () => {
  for (const url of ['https://fcm.googleapis.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/abc', 'https://web.push.apple.com/abc', 'https://wns2-by3p.notify.windows.com/w/?token=abc']) {
    assert.ok(pushServiceUrl(url), url);
  }
  for (const url of ['http://fcm.googleapis.com/fcm/send/abc', 'https://127.0.0.1/hook', 'https://169.254.169.254/latest/meta-data', 'https://localhost/x', 'https://fcm.googleapis.com.example.net/x',
    'https://example.net/fcm.googleapis.com', 'https://user:secret@fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'https://notify.windows.com.example.net/x', 'file:///etc/passwd',
    'https://fcm.googleapis.com/a b', '', null, 42, 'https://fcm.googleapis.com/' + 'a'.repeat(2100)]) {
    assert.equal(pushServiceUrl(url), null, String(url));
  }
  const { subscription } = browser();
  assert.deepEqual(webSubscription({ token: subscription.token, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }), subscription);
  const keys = { p256dh: subscription.p256dh, auth: subscription.auth };
  // A key that is not a point on the curve, the wrong sizes, the wrong alphabet, or no keys at all.
  const offCurve = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url');
  for (const bad of [{ token: 'https://example.net/x', keys }, { token: subscription.token }, { token: subscription.token, keys: { ...keys, p256dh: offCurve } },
    { token: subscription.token, keys: { ...keys, auth: 'short' } }, { token: subscription.token, keys: { ...keys, p256dh: subscription.p256dh + '=' } },
    { token: subscription.token, keys: { ...keys, auth: Buffer.alloc(15).toString('base64url') } }, null, {}]) {
    assert.equal(webSubscription(bad), null);
  }
});

test('sending posts the encrypted message to the push service and reads its answer', async () => {
  const identity = temporaryWebPushIdentity();
  const { receiver, auth, subscription } = browser('https://updates.push.services.mozilla.com/wpush/v2/example');
  const calls = [];
  const answer = status => async (url, options) => { calls.push({ url, options }); return { status }; };
  const payload = { title: 'Jo Park in #general', body: 'Two requests have come in already.', data: { conversationId: 'ch_1' } };
  const options = { identity, subject: 'mailto:team@example.gov', topic: 'abc123' };
  assert.deepEqual(await sendWebPush(subscription, payload, { ...options, fetcher: answer(201) }), { ok: true });
  const { url, options: request } = calls[0];
  assert.equal(url, subscription.token);
  assert.equal(request.method, 'POST');
  assert.equal(request.redirect, 'error', 'a push service that redirects elsewhere is not followed');
  assert.deepEqual({ ...request.headers, Authorization: request.headers.Authorization.replace(/t=[^,]+/, 't=…').replace(/k=.+/, 'k=…') },
    { Authorization: 'vapid t=…, k=…', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '3600', Urgency: 'high', Topic: 'abc123' });
  assert.deepEqual(JSON.parse(decryptPush(request.body, receiver, auth)), payload);
  assert.equal(Buffer.from(request.body).includes(Buffer.from('Jo Park')), false);
  // Gone for good, try again later, or refused.
  assert.deepEqual(await sendWebPush(subscription, payload, { ...options, fetcher: answer(410) }), { ok: false, invalid: true, retry: false, code: '410' });
  assert.deepEqual(await sendWebPush(subscription, payload, { ...options, fetcher: answer(404) }), { ok: false, invalid: true, retry: false, code: '404' });
  assert.deepEqual(await sendWebPush(subscription, payload, { ...options, fetcher: answer(429) }), { ok: false, invalid: false, retry: true, code: '429' });
  assert.deepEqual(await sendWebPush(subscription, payload, { ...options, fetcher: answer(503) }), { ok: false, invalid: false, retry: true, code: '503' });
  assert.deepEqual(await sendWebPush(subscription, payload, { ...options, fetcher: answer(403) }), { ok: false, invalid: false, retry: false, code: '403' });
  // A stored address that is no longer acceptable is never contacted.
  const before = calls.length;
  assert.deepEqual(await sendWebPush({ ...subscription, token: 'https://127.0.0.1/hook' }, payload, { ...options, fetcher: answer(201) }), { ok: false, invalid: true, retry: false, code: 'BAD_ENDPOINT' });
  assert.equal(calls.length, before);
  // More than a push service accepts is not sent.
  assert.deepEqual(await sendWebPush(subscription, { body: 'x'.repeat(5000) }, { ...options, fetcher: answer(201) }), { ok: false, retry: false, code: 'TOO_LARGE' });
});
