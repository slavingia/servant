// Web Push for browsers: what a browser's own push service needs to deliver an alert to a page that is not open.
// Three standards, done with Node's crypto and nothing else:
//   RFC 8030  the HTTP request to the browser's push service;
//   RFC 8292  VAPID: a signed token that says which server is sending;
//   RFC 8291  the message itself, encrypted to keys that never leave the browser (aes128gcm, RFC 8188).
// The push service (Google, Mozilla, Apple, Microsoft) carries the message but cannot read it.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const b64url = value => Buffer.from(value).toString('base64url');
const fromB64url = (value, length) => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.toString('base64url') === value && (!length || bytes.length === length) ? bytes : null;
};

// This server's signing key for browser push. Like the transport key it is made once, kept in the data
// directory and never leaves the machine; browsers get the public half, and a subscription made for one key
// accepts messages signed by no other.
export function webPushIdentity(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'web-push-key');
  const key = crypto.createECDH('prime256v1');
  try { key.setPrivateKey(fs.readFileSync(file)); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error; // Never silently rotate a damaged key: every browser would stop hearing.
    key.generateKeys();
    try { fs.writeFileSync(file, key.getPrivateKey(), { mode: 0o600, flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; key.setPrivateKey(fs.readFileSync(file)); }
  }
  fs.chmodSync(file, 0o600);
  return identityFrom(key);
}
function identityFrom(ecdh) {
  const publicBytes = ecdh.getPublicKey();
  const jwk = { kty: 'EC', crv: 'P-256', d: b64url(ecdh.getPrivateKey()), x: b64url(publicBytes.subarray(1, 33)), y: b64url(publicBytes.subarray(33)) };
  return { publicKey: b64url(publicBytes), signingKey: crypto.createPrivateKey({ key: jwk, format: 'jwk' }) };
}
/** For tests: an identity that is not saved anywhere. */
export function temporaryWebPushIdentity() {
  const key = crypto.createECDH('prime256v1'); key.generateKeys();
  return identityFrom(key);
}

// The browsers' push services. A subscription names the address to send to, and that address comes from a
// signed-in browser: only these hosts are ever contacted, so a subscription cannot point the server at
// something inside its own network.
const PUSH_HOSTS = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com'];
const PUSH_HOST_SUFFIXES = ['.push.services.mozilla.com', '.push.apple.com', '.notify.windows.com'];
export function pushServiceUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /\s/.test(value)) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) return null;
  const host = url.hostname.toLowerCase();
  return PUSH_HOSTS.includes(host) || PUSH_HOST_SUFFIXES.some(suffix => host.endsWith(suffix)) ? url : null;
}

/** A browser's subscription as the app sends it: where to send, and the two keys the message is encrypted to. */
export function webSubscription(body) {
  const url = pushServiceUrl(body?.token);
  const p256dh = fromB64url(body?.keys?.p256dh, 65), auth = fromB64url(body?.keys?.auth, 16);
  if (!url || !p256dh || p256dh[0] !== 4 || !auth) return null;
  // The key must be a point on the curve, or encrypting to it later would throw.
  try { const probe = crypto.createECDH('prime256v1'); probe.generateKeys(); probe.computeSecret(p256dh); } catch { return null; }
  return { token: url.href, p256dh: body.keys.p256dh, auth: body.keys.auth };
}

// Who is sending, for the push service: a token it can check against the key the browser subscribed with.
// `subject` is how the push service's operator could reach whoever runs this server (a mailto: or https: address).
export function vapidAuthorization(endpoint, identity, subject, now = Date.now()) {
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64url(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, ...(subject ? { sub: subject } : {}) }));
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key: identity.signingKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${identity.publicKey}`;
}
export function vapidSubject({ contactEmail, publicUrl } = {}) {
  if (typeof contactEmail === 'string' && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(contactEmail.trim())) return 'mailto:' + contactEmail.trim();
  try { const url = new URL(publicUrl); if (url.protocol === 'https:' && url.hostname.includes('.')) return url.origin; } catch { /* no address to give */ }
  return null;
}

// One message, encrypted so that only the browser holding the subscription's private key can read it.
// `salt` and `sender` are random for every message; tests pass the RFC's own to check the result byte for byte.
const freshKey = () => { const key = crypto.createECDH('prime256v1'); key.generateKeys(); return key; };
export function encryptPush(plaintext, subscription, { salt = crypto.randomBytes(16), sender = freshKey() } = {}) {
  const receiverKey = fromB64url(subscription.p256dh, 65), authSecret = fromB64url(subscription.auth, 16);
  if (!receiverKey || !authSecret) throw new Error('Invalid subscription keys');
  const senderKey = sender.getPublicKey();
  const shared = sender.computeSecret(receiverKey);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), receiverKey, senderKey]), 32));
  const key = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', key, nonce);
  // One record: the text, then 0x02 to say it is the last.
  const sealed = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21); salt.copy(header); header.writeUInt32BE(4096, 16); header[20] = senderKey.length;
  return Buffer.concat([header, senderKey, sealed]);
}
// What a browser does with it. Here for tests, and for anyone checking this server against a push service of
// their own.
export function decryptPush(body, receiver, authSecret) {
  const salt = body.subarray(0, 16), keyLength = body[20];
  const senderKey = body.subarray(21, 21 + keyLength), sealed = body.subarray(21 + keyLength);
  const shared = receiver.computeSecret(senderKey);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, Buffer.concat([Buffer.from('WebPush: info\0'), receiver.getPublicKey(), senderKey]), 32));
  const key = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = crypto.createDecipheriv('aes-128-gcm', key, nonce);
  decipher.setAuthTag(sealed.subarray(-16));
  const padded = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
  const end = padded.lastIndexOf(2);
  if (end < 0) throw new Error('Not a final record');
  return padded.subarray(0, end);
}

// The request to the push service. `urgency: high` so a phone or laptop on battery still shows it now; the
// message waits an hour for a browser that is closed, like the phone alerts; `topic` lets a newer alert for the
// same conversation replace one still waiting.
export async function sendWebPush(subscription, payload, { identity, subject, topic, fetcher = fetch, now = Date.now() }) {
  const url = pushServiceUrl(subscription.token);
  if (!url) return { ok: false, invalid: true, retry: false, code: 'BAD_ENDPOINT' };
  const body = encryptPush(Buffer.from(JSON.stringify(payload)), subscription);
  if (body.length > 4096) return { ok: false, retry: false, code: 'TOO_LARGE' };
  const response = await fetcher(url.href, {
    method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { Authorization: vapidAuthorization(url.href, identity, subject, now), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '3600', Urgency: 'high', ...(topic ? { Topic: topic } : {}) },
  });
  if (response.status >= 200 && response.status < 300) return { ok: true };
  // 404 and 410: the browser unsubscribed or the subscription expired. It will never work again.
  return { ok: false, invalid: response.status === 404 || response.status === 410, retry: response.status === 429 || response.status >= 500, code: String(response.status) };
}
