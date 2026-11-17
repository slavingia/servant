// Native FCM v1 and APNs delivery. Credentials never leave this server except
// signed, short-lived authorization tokens sent to their respective provider.
import fs from 'node:fs';
import crypto from 'node:crypto';
import http2 from 'node:http2';
import { sendWebPush } from './web-push.mjs';

const b64 = (x) => Buffer.from(JSON.stringify(x)).toString('base64url');
// Keep this allowlist at the provider boundary as well as in the queue. A new
// application field must never accidentally become a plaintext push preview;
// only the visible title and body (already shaped by notificationPayload) pass.
const clip = (v, max, fallback) => typeof v === 'string' && v.trim() ? (v.length > max ? v.slice(0, max - 1) + '…' : v) : fallback;
function privateNotification(n) {
  const data = {};
  for (const key of ['userId', 'deviceId', 'conversationId', 'chatId', 'caseId', 'codeRequestId', 'threadRoot', 'messageId', 'page']) {
    const value = n.data?.[key];
    if (typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)) data[key] = value;
  }
  return { data, group: data.conversationId || data.chatId || data.caseId || data.codeRequestId || 'messages',
    title: clip(n.title, 80, 'Servant'), body: clip(n.body, 240, 'You have a new message'),
    badge: n.badge === null ? null : Number.isSafeInteger(n.badge) && n.badge > 0 ? Math.min(n.badge, 9999) : 1 };
}
export function fcmMessage(token, notification) {
  const n = privateNotification(notification);
  return { message: {
    token,
    notification: { title: n.title, body: n.body },
    data: { body: JSON.stringify(n.data), channelId: 'messages', threadIdentifier: n.group },
    android: { priority: 'HIGH', ttl: '3600s', notification: { channel_id: 'messages', tag: n.group, sound: 'default', ...(n.badge === null ? {} : { notification_count: n.badge }) } },
  } };
}
// A browser (web-push.mjs). The same title, body and routing ids as a phone gets, and nothing else; the whole
// message is encrypted to the browser, so its push service carries it without reading it.
export function webPushMessage(notification) {
  const n = privateNotification(notification);
  return { title: n.title, body: n.body, tag: n.group, data: n.data };
}
export function apnsPayload(notification) {
  const n = privateNotification(notification);
  // expo-notifications reads a remote push's data ONLY from userInfo.body on
  // iOS (NotificationRecords.serializedNotificationData). Without it a tap has
  // no route and just opens the app. Top-level copies stay for older builds.
  return { aps: { alert: { title: n.title, body: n.body }, sound: 'default', ...(n.badge === null ? {} : { badge: n.badge }), 'thread-id': n.group }, ...n.data, body: n.data };
}
// The APNs topic is the iOS app's bundle id. push.json's apnsTopic wins, then
// SERVANT_BUNDLE_ID, then the open-source placeholder.
export function apnsTopic(c, env = process.env) {
  const id = (typeof c?.apnsTopic === 'string' && c.apnsTopic.trim()) || (env.SERVANT_BUNDLE_ID || '').trim() || 'com.example.servant';
  return id;
}
/**
 * The credentials for the app a device runs. push.json's top-level fields are the server's own app. `"apps"` adds
 * others by bundle id or package: `"apps": { "com.example.other": { "apnsKeyId", "apnsTeamId", "apnsKeyPath" } }`
 * (and/or `fcmKeyPath`, `fcmProjectId`). A device that names an app listed there is sent to with that app's
 * credentials and, on iOS, that app's id as the topic. Returns null for an iPhone app this server has no
 * credentials for: sending with another app's would be refused by Apple and the device's token thrown away.
 */
export function pushCredentials(c, device, env = process.env) {
  const app = typeof device?.app === 'string' ? device.app : '';
  const other = app && c?.apps && typeof c.apps === 'object' && Object.hasOwn(c.apps, app) && c.apps[app] && typeof c.apps[app] === 'object' ? c.apps[app] : null;
  if (other) return { ...other, apnsTopic: (typeof other.apnsTopic === 'string' && other.apnsTopic.trim()) || app };
  if (app && device.platform === 'ios' && app !== apnsTopic(c, env)) return null;
  return c;
}
// `webPush()` gives this server's browser-push signing identity and the contact address that goes with it.
export function createPushTransport(config, fetcher = fetch, webPush = () => null) {
  // One sign-in per key: a server with several apps keeps each app's separately.
  const googles = new Map(), apples = new Map();
  async function googleToken(c) {
    const google = googles.get(c.fcmKeyPath);
    if (google && google.until > Date.now() + 60000) return google.token;
    const key = JSON.parse(fs.readFileSync(c.fcmKeyPath, 'utf8'));
    const iat = Math.floor(Date.now() / 1000);
    const input = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: key.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat, exp: iat + 3600 })}`;
    const assertion = input + '.' + crypto.sign('RSA-SHA256', Buffer.from(input), key.private_key).toString('base64url');
    const r = await fetcher('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }), signal: AbortSignal.timeout(15000) });
    const data = await r.json();
    if (!r.ok || !data.access_token) throw new Error('FCM_AUTH_FAILED');
    googles.set(c.fcmKeyPath, { token: data.access_token, until: Date.now() + (data.expires_in || 3600) * 1000 });
    return data.access_token;
  }
  function appleToken(c) {
    const cached = `${c.apnsTeamId}:${c.apnsKeyId}:${c.apnsKeyPath}`, apple = apples.get(cached);
    if (apple && apple.until > Date.now()) return apple.token;
    const input = `${b64({ alg: 'ES256', kid: c.apnsKeyId })}.${b64({ iss: c.apnsTeamId, iat: Math.floor(Date.now() / 1000) })}`;
    const sig = crypto.sign('sha256', Buffer.from(input), { key: fs.readFileSync(c.apnsKeyPath), dsaEncoding: 'ieee-p1363' }).toString('base64url');
    apples.set(cached, { token: input + '.' + sig, until: Date.now() + 45 * 60000 });
    return input + '.' + sig;
  }
  return async (device, notification) => {
    if (device.platform === 'web') {
      const sender = webPush();
      if (!sender?.identity) throw new Error('WEB_PUSH_NOT_CONFIGURED');
      const message = webPushMessage(notification);
      // A newer alert for the same conversation replaces one the push service is still holding.
      const topic = crypto.createHash('sha256').update(message.tag).digest('base64url').slice(0, 32);
      return sendWebPush(device, message, { identity: sender.identity, subject: sender.subject, topic, fetcher });
    }
    const c = pushCredentials(config(), device);
    // An app this server holds no credentials for: nothing is sent and the registration is kept, so alerts start
    // the moment its credentials are added to push.json.
    if (!c) return { ok: false, invalid: false, retry: false, code: 'APP_NOT_CONFIGURED' };
    if (device.platform === 'android') {
      if (!c?.fcmKeyPath || !c?.fcmProjectId) throw new Error('FCM_NOT_CONFIGURED');
      const r = await fetcher(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(c.fcmProjectId)}/messages:send`, {
        method: 'POST', headers: { Authorization: `Bearer ${await googleToken(c)}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(fcmMessage(device.token, notification)), signal: AbortSignal.timeout(15000),
      });
      const result = await r.json();
      if (r.ok) return { ok: true };
      const code = result.error?.details?.find(d => d['@type']?.endsWith('FcmError'))?.errorCode || result.error?.status || String(r.status);
      if (r.status === 401) googles.delete(c.fcmKeyPath);
      return { ok: false, invalid: code === 'UNREGISTERED', retry: r.status === 429 || r.status >= 500 || r.status === 401, code };
    }
    if (!c?.apnsKeyPath || !c?.apnsKeyId || !c?.apnsTeamId) throw new Error('APNS_NOT_CONFIGURED');
    // Environment comes from the signed app registration, not a caller-supplied URL.
    const host = device.environment === 'development' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com';
    const authorization = appleToken(c);
    return new Promise((resolve, reject) => {
      const client = http2.connect(host);
      let settled = false;
      const finish = (err, result) => {
        if (settled) return;
        settled = true; clearTimeout(timer); client.destroy();
        if (err) reject(err); else resolve(result);
      };
      const timer = setTimeout(() => finish(new Error('APNS_TIMEOUT')), 15000);
      client.on('error', () => finish(new Error('APNS_CONNECTION_FAILED')));
      const req = client.request({ ':method': 'POST', ':path': '/3/device/' + device.token,
        authorization: 'bearer ' + authorization, 'apns-topic': apnsTopic(c), 'apns-push-type': 'alert',
        'apns-priority': '10', 'apns-expiration': String(Math.floor(Date.now() / 1000) + 3600),
        'apns-collapse-id': crypto.createHash('sha256').update(privateNotification(notification).group).digest('hex'),
      });
      let status = 0, body = '';
      req.on('response', h => { status = Number(h[':status']); });
      req.on('data', c => { body += c; });
      req.on('error', () => finish(new Error('APNS_REQUEST_FAILED')));
      req.on('end', () => {
        let reason; try { reason = JSON.parse(body).reason; } catch { /* success has no body */ }
        finish(null, { ok: status === 200, invalid: ['Unregistered', 'BadDeviceToken', 'DeviceTokenNotForTopic'].includes(reason), retry: status === 429 || status >= 500, code: reason || String(status) });
      });
      req.end(JSON.stringify(apnsPayload(notification)));
    });
  };
}
