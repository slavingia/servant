// One-time codes an automation asks its own person for (docs/code-requests.md). A script signed in as you
// (the MCP client) reaches a "enter the code we texted you" step, asks here, your phone gets a push, you type the
// code in Servant and the script picks it up once. Codes live only in this process's memory: never on disk, never
// in a push, and gone the moment they are picked up, cancelled or expired.
import crypto from 'node:crypto';

export const CODE_REQUEST_TTL_MS = 10 * 60 * 1000;
export const CODE_REQUEST_MAX_TTL_MS = 15 * 60 * 1000;
export const CODE_REQUEST_LIMIT = 5;
const ID = /^code_[A-Za-z0-9_-]{12}$/;
const error = (status, code, message) => Object.assign(new Error(message), { status, code });
const clean = (value, max) => typeof value === 'string' ? value.replace(/[\p{C}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';

// Sign-in codes are digits or short letter-and-digit runs; spaces and dashes people type are dropped.
export function normalizeCode(value) {
  const code = typeof value === 'string' ? value.replace(/[\s-]/g, '') : '';
  if (!/^[A-Za-z0-9]{4,12}$/.test(code)) throw error(400, 'invalid_code', 'Enter the code as shown: 4 to 12 letters or numbers');
  return code;
}

export function createCodeRequests({ clock = Date.now } = {}) {
  const requests = new Map();
  function sweep() {
    const at = clock();
    for (const [id, r] of requests) {
      if (r.expiresAt <= at && r.status !== 'expired') { r.status = 'expired'; r.code = null; }
      // Keep a finished request a little while so its requester and the phone can see how it ended.
      if (r.expiresAt + 60_000 <= at) requests.delete(id);
    }
  }
  const view = r => ({ id: r.id, label: r.label, hint: r.hint || undefined, length: r.length || undefined, device: r.device, status: r.status, createdAt: r.createdAt, expiresAt: r.expiresAt });
  function find(id, user) {
    sweep();
    const r = typeof id === 'string' && ID.test(id) ? requests.get(id) : null;
    if (!r || r.userId !== user.id) throw error(404, 'not_found', 'That code request does not exist. It may have expired');
    return r;
  }
  function open(r, verb) {
    if (r.status === 'pending') return;
    const why = { answered: 'already has a code', claimed: 'was already used', cancelled: 'was cancelled', expired: 'expired' }[r.status];
    throw error(410, `code_request_${r.status}`, `That code request ${why}. ${verb}`);
  }
  return {
    create(user, device, body = {}) {
      sweep();
      const label = clean(body.label, 60);
      if (!label) throw error(400, 'bad_request', 'Say what the code is for, like "Login.gov sign-in"');
      const pending = [...requests.values()].filter(r => r.userId === user.id && r.status === 'pending').length;
      if (pending >= CODE_REQUEST_LIMIT) throw error(429, 'rate_limited', `You already have ${CODE_REQUEST_LIMIT} code requests waiting. Answer or cancel one first`);
      // How many characters the code has, when the automation knows: the phone sends it by itself once that many are in.
      const length = body.length === undefined || body.length === null ? 0 : Number(body.length);
      if (!(length === 0 || (Number.isInteger(length) && length >= 4 && length <= 12))) throw error(400, 'bad_request', 'length is the number of characters in the code, from 4 to 12');
      const seconds = Number(body.ttlSeconds);
      const ttl = Number.isFinite(seconds) && seconds > 0 ? Math.min(CODE_REQUEST_MAX_TTL_MS, Math.max(60_000, seconds * 1000)) : CODE_REQUEST_TTL_MS;
      const at = clock();
      const r = { id: `code_${crypto.randomBytes(9).toString('base64url')}`, userId: user.id, deviceId: device.id, device: clean(device.label, 80) || 'Automation',
        label, hint: clean(body.hint, 120), length, status: 'pending', code: null, createdAt: at, expiresAt: at + ttl };
      requests.set(r.id, r);
      return view(r);
    },
    list(user) { sweep(); return [...requests.values()].filter(r => r.userId === user.id && r.status === 'pending').sort((a, b) => a.createdAt - b.createdAt).map(view); },
    get(id, user) { return view(find(id, user)); },
    pending(id, userId) { sweep(); const r = requests.get(id); return r && r.userId === userId && r.status === 'pending' ? view(r) : null; },
    // Whether this process holds the request at all. The worker that delivers alerts is a separate process and never does.
    known(id) { sweep(); return requests.has(id); },
    // From the person's phone (any of their devices but the one that asked).
    answer(id, user, device, value) {
      const r = find(id, user);
      if (r.deviceId === device.id) throw error(403, 'forbidden', 'Enter the code on your phone, not on the device that asked for it');
      open(r, 'Start the sign-in again to get a new one');
      r.code = normalizeCode(value);
      r.status = 'answered';
      r.answeredAt = clock();
      return view(r);
    },
    // Only the device that asked can pick the code up, and only once.
    claim(id, user, device) {
      const r = find(id, user);
      if (r.deviceId !== device.id) throw error(404, 'not_found', 'That code request does not exist. It may have expired');
      if (r.status === 'pending') return { status: 'pending', expiresAt: r.expiresAt };
      if (r.status !== 'answered') return { status: r.status };
      const code = r.code;
      r.code = null;
      r.status = 'claimed';
      return { status: 'answered', code };
    },
    cancel(id, user) {
      const r = find(id, user);
      if (r.status === 'pending' || r.status === 'answered') { r.status = 'cancelled'; r.code = null; }
      return view(r);
    },
    forget(userId) { for (const [id, r] of requests) if (r.userId === userId) requests.delete(id); },
  };
}
