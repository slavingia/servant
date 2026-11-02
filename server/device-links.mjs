// Phone-approved device linking. Records live in the existing transactional
// invite map, under a namespace no legacy invite hash can match. This keeps a
// rolling API deployment compatible without adding a separate token database.
import crypto from 'node:crypto';

export const DEVICE_LINK_TTL_MS = 5 * 60 * 1000;
export const DEVICE_LINK_LIMIT = 1000;
export const DEVICE_LINK_IP_LIMIT = 20;
const PREFIX = 'desktop:';
const HANDLE = /^[A-Za-z0-9_-]{43}$/;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const random = () => crypto.randomBytes(32).toString('base64url');
const error = (status, code, message) => Object.assign(new Error(message), { status, code });
const activeUser = user => user && !user.deletedAt && !user.disabledAt && !user.deactivatedAt && !user.retiredAt;

function lookup(state, id, at) {
  const record = typeof id === 'string' && HANDLE.test(id) && state.invites[PREFIX + id];
  if (!record || record.kind !== 'desktop-link') throw error(404, 'invalid_device_link', 'That sign-in request does not exist. Show a new QR code on your Mac');
  if (record.expiresAt <= at) throw error(410, 'expired_device_link', 'That QR code expired. Show a new code on your Mac');
  return record;
}

function available(record) {
  if (record.usedAt) throw error(410, 'used_device_link', 'That QR code has already been used. Show a new code on your Mac');
  if (record.deniedAt) throw error(410, 'denied_device_link', 'Sign-in was declined. Show a new code on your Mac to try again');
}

function checkSecret(record, secret) {
  const digest = typeof secret === 'string' && HANDLE.test(secret) ? hash(secret) : null;
  if (!digest || !crypto.timingSafeEqual(Buffer.from(digest, 'hex'), Buffer.from(record.secretHash, 'hex'))) {
    throw error(404, 'invalid_device_link', 'That sign-in request does not exist');
  }
}

export function createDeviceLink(state, { device, ip }, at = Date.now()) {
  const ipHash = hash(String(ip || 'unknown'));
  let total = 0, fromIp = 0;
  for (const [key, entry] of Object.entries(state.invites)) {
    if (!key.startsWith(PREFIX) || entry.kind !== 'desktop-link') continue;
    if (entry.expiresAt <= at) { delete state.invites[key]; continue; }
    total++;
    if (entry.ipHash === ipHash) fromIp++;
  }
  // Used and denied requests count until their original expiry, so rapidly
  // canceling/redeeming requests cannot evade the five-minute creation limit.
  if (total >= DEVICE_LINK_LIMIT || fromIp >= DEVICE_LINK_IP_LIMIT) {
    throw error(429, 'rate_limited', 'Too many sign-in requests. Wait five minutes and try again');
  }
  const id = random(), secret = random();
  const digits = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  const code = digits.slice(0, 3) + ' ' + digits.slice(3);
  const label = typeof device === 'string' ? device.replace(/[\p{C}]/gu, '').trim().slice(0, 80) : '';
  const record = { kind: 'desktop-link', secretHash: hash(secret), ipHash, device: label || 'Mac', code, createdAt: at, expiresAt: at + DEVICE_LINK_TTL_MS };
  state.invites[PREFIX + id] = record;
  return { id, secret, code, expiresAt: record.expiresAt, intervalMs: 2000 };
}

export function previewDeviceLink(state, id, at = Date.now()) {
  const record = lookup(state, id, at);
  available(record);
  return { id, device: record.device, code: record.code, expiresAt: record.expiresAt, status: record.approvedAt ? 'approved' : 'pending' };
}

export function approveDeviceLink(state, id, auth, at = Date.now()) {
  const record = lookup(state, id, at);
  available(record);
  if (record.approvedAt) throw error(409, 'device_link_approved', 'That sign-in request was already approved');
  if (!activeUser(state.users[auth.user.id]) || auth.device.revokedAt) throw error(401, 'unauthorized', 'This phone is no longer signed in');
  record.approvedAt = at;
  record.userId = auth.user.id;
  record.approverDeviceId = auth.device.id;
  return { ok: true };
}

export function denyDeviceLink(state, id, auth, at = Date.now()) {
  const record = lookup(state, id, at);
  available(record);
  if (record.approvedAt && record.userId !== auth.user.id) throw error(409, 'device_link_approved', 'That sign-in request was already approved');
  record.deniedAt = at;
  return { ok: true };
}

export function pollDeviceLink(state, id, secret, at = Date.now()) {
  const record = lookup(state, id, at);
  checkSecret(record, secret);
  available(record);
  if (!record.approvedAt) return { status: 'pending', expiresAt: record.expiresAt };
  const user = state.users[record.userId];
  const approver = Object.values(state.devices).find(device => device.id === record.approverDeviceId && device.userId === record.userId);
  // Recheck at redemption, after approval: signing out or revoking the phone
  // before the Mac claims this request must prevent creating another session.
  if (!activeUser(user) || !approver || approver.revokedAt) {
    throw error(410, 'denied_device_link', 'The approving phone is no longer signed in. Show a new code on your Mac');
  }
  const token = random();
  state.devices[hash(token)] = {
    id: `dev_${crypto.randomBytes(9).toString('base64url')}`, userId: user.id,
    label: record.device, createdAt: at, lastSeenAt: at,
  };
  record.usedAt = at;
  // The token exists only in this response. It is never stored in the link or
  // disclosed to the approving phone, and a second redemption cannot mint one.
  return { status: 'approved', token, user: { id: user.id, name: user.name, role: user.role } };
}
