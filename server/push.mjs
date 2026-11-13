import { DatabaseSync } from 'node:sqlite';

// Owner, 11/2: alerts show who sent the message and what they said, for
// channels, DMs and agent chats. `contentPreviews` (default on) is the switch;
// the legacy `previews` flag was forced false for months, so it is ignored and
// mirrored from contentPreviews for older app builds.
export const defaults = { mode: 'mentions', previews: true, contentPreviews: true, pausedUntil: 0 };
export const preferences = (user) => {
  const p = { ...defaults, ...user?.notifications };
  p.contentPreviews = user?.notifications?.contentPreviews !== false;
  p.previews = p.contentPreviews;
  return p;
};
export const TITLE_MAX = 80, BODY_MAX = 240;
// Plain text for a lock screen: no markdown markers, one line, length-capped.
export function previewText(text, max) {
  const s = String(text || '')
    .replace(/```[a-z]*\n?/gi, '').replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // List items become "a · b · c" instead of one run-on sentence.
    .replace(/\n+\s{0,3}(?:[-*+]|\d+\.)\s+/g, '\u0000LI').replace(/^\s{0,3}(?:[-*+]|\d+\.)\s+/, '')
    .replace(/^\s{0,3}(#{1,6}|>)\s+/gm, '').replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(^|\W)[*_]([^*_\n]+)[*_](?=\W|$)/g, '$1$2')
    .replace(/\u0000LI/g, (_, i, all) => /[:.!?]\s*$/.test(all.slice(0, i)) && !all.slice(0, i).includes('\u0000LI') ? ' ' : ' · ')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s;
}
export function isMention(text, user) {
  const names = [user.id, user.name, user.name?.replace(/\s+/g, '-'), user.name?.split(/\s+/)[0], 'channel', 'here'].filter(Boolean);
  return names.some(name => new RegExp(`(^|[^\\w@])@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^\\w-])`, 'i').test(text));
}
export function wantsNotification(info, settings, now = Date.now()) {
  if (!info || settings.mode === 'none' || settings.pausedUntil > now) return false;
  return !!(settings.mode === 'all' || info.kind === 'dm' || info.kind === 'agent' || info.mentioned || info.participant);
}
// `plain`: the device's session ended (session-expiry.mjs), so the alert carries no message text, whatever the person's preview setting.
export function notificationPayload(info, user, deviceId, { plain = false } = {}) {
  const rich = !plain && preferences(user).contentPreviews;
  const title = rich && previewText(info.title, TITLE_MAX), body = rich && previewText(info.body, BODY_MAX);
  return {
    title: title || 'Servant',
    body: body || (plain ? 'Confirm it\'s you in Servant to see new messages' : 'You have a new message'),
    group: info.conversationId || info.chatId || info.caseId,
    ...(info.meetingId ? { call: { meetingId: info.meetingId, caller: info.caller || '', place: info.place || '' } } : {}),
    badge: info.badge || 1,
    // A case from the secure inbox routes by its own id: it is neither a conversation nor an agent chat.
    data: { userId: user.id, deviceId, ...(info.conversationId ? { conversationId: info.conversationId } : info.caseId ? { caseId: info.caseId } : { chatId: info.chatId }),
      ...(info.meetingId ? { meetingId: info.meetingId } : {}), ...(info.threadRoot ? { threadRoot: String(info.threadRoot) } : {}), ...(info.messageId ? { messageId: String(info.messageId) } : {}) },
  };
}

// The durable queue stores routing references. Eligibility is resolved just
// before delivery, after checking current membership and device status.
// `stale(device, user)`: true while that device's session has ended; it then gets no call rings and no message text.
export function createPushService({ file, state, mutate, resolve, send, clock = Date.now, log = console.warn, autoDrain = true, stale = () => false }) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout=5000');
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, user_id TEXT NOT NULL, event TEXT NOT NULL,
      created_at INTEGER NOT NULL, due_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS jobs_due ON jobs(due_at);
    CREATE TABLE IF NOT EXISTS enqueued_events (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);`);
  const insert = db.prepare('INSERT OR IGNORE INTO jobs VALUES (?, ?, ?, ?, ?, ?, 0)');
  const remove = db.prepare('DELETE FROM jobs WHERE id = ?');
  const due = db.prepare('SELECT * FROM jobs WHERE due_at <= ? ORDER BY due_at LIMIT 50');
  const postpone = db.prepare('UPDATE jobs SET due_at = ? WHERE id = ?');
  const retry = db.prepare('UPDATE jobs SET attempts = attempts + 1, due_at = ? WHERE id = ?');
  let activeDrain = null, shutdownPromise = null, stopping = false, stopped = false;
  function enqueue(event) {
    if (stopped) throw new Error('Push service is closed');
    const s = state(); const now = clock();
    const eventKey = `${event.kind}:${event.messageId || event.eventId}`;
    db.exec('BEGIN IMMEDIATE');
    try {
      // Keep a durable receipt after delivery. If the API/worker crashes between
      // enqueue and acknowledging its outbox, replay cannot re-send that event.
      const added = db.prepare('INSERT OR IGNORE INTO enqueued_events VALUES (?, ?)').run(eventKey, now).changes;
      if (added) for (const d of Object.values(s.devices)) {
        const user = s.users[d.userId];
        if (d.revokedAt || !d.push || !user) continue;
        if (!wantsNotification(resolve(event, user), preferences(user), now)) continue;
        const key = `${d.id}:${eventKey}`;
        insert.run(key, d.id, user.id, JSON.stringify(event), now, now);
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    // Delivery is detached from HTTP message/SSE responses.
    if (autoDrain) backgroundDrain();
  }
  function drain() {
    if (activeDrain) return activeDrain;
    if (stopping || stopped) return Promise.resolve();
    // Assign the promise before delivery begins, including synchronous send hooks.
    activeDrain = Promise.resolve().then(deliver).finally(() => { activeDrain = null; });
    return activeDrain;
  }
  async function deliver() {
    if (stopping || stopped) return;
    for (const job of due.all(clock())) {
      if (stopping || stopped) break;
      const s = state(); const device = Object.values(s.devices).find(d => d.id === job.device_id); const user = s.users[job.user_id];
      const event = JSON.parse(job.event);
      const info = user && resolve(event, user);
      if (!device?.push || device.revokedAt || device.userId !== user?.id || clock() - job.created_at > 3600000 || !wantsNotification(info, preferences(user), clock())) {
        remove.run(job.id); continue;
      }
      // A session that ended neither rings nor reads along: calls are dropped, messages arrive without their text.
      const expired = stale(device, user) === true;
      if (expired && event.call) { remove.run(job.id); continue; }
      // A call only rings once. Someone already looking at the conversation sees the in-app ring.
      if (event.call && device.pushPresence?.until > clock() && device.pushPresence.conversation === info.conversationId) { remove.run(job.id); continue; }
      if (!event.call && device.pushPresence?.until > clock() && device.pushPresence.conversation === (info.conversationId || info.chatId || info.caseId)) {
        // Give a background transition time to clear its presence lease.
        // Ordinary messages are rechecked against read state before delivery.
        if (event.kind === 'agent' && clock() - job.created_at >= 5000) remove.run(job.id);
        else postpone.run(Math.min(device.pushPresence.until, clock() + 5000), job.id);
        continue;
      }
      // iPhones with a VoIP token get a real ringing call (CallKit); everyone else a normal alert or Android call push.
      const voip = !!event.call && device.voip?.token ? device.voip : null;
      // Android builds that can ring say so (device.ringsCalls); older builds keep getting a normal alert.
      const target = voip ? { platform: 'ios-voip', token: voip.token, environment: voip.environment } : { ...device.push, ringing: !!(event.call && device.ringsCalls) };
      const token = target.token;
      try {
        const notification = notificationPayload(info, user, device.id, { plain: expired });
        // Independent servers cannot know the all-server unread total.
        if (device.push.aggregateBadge === true) notification.badge = null;
        const result = await send(target, notification);
        if (stopped) break;
        if (result.invalid) mutate(s => {
          const d = Object.values(s.devices).find(d => d.id === job.device_id);
          if (voip) { if (d?.voip?.token === token) delete d.voip; }
          else if (d?.push?.token === token) delete d.push;
        });
        if (result.ok || result.invalid || !result.retry || job.attempts >= 5) {
          remove.run(job.id);
          if (!result.ok && !result.invalid) log('[push] delivery rejected:', result.code);
        } else retry.run(clock() + Math.min(300000, 5000 * 2 ** job.attempts), job.id);
      } catch {
        if (stopped) break;
        if (job.attempts >= 5) { remove.run(job.id); log('[push] delivery unavailable after retries'); }
        else retry.run(clock() + Math.min(300000, 5000 * 2 ** job.attempts), job.id);
      }
    }
  }
  function backgroundDrain() {
    void drain().catch(() => log('[push] could not drain notification queue'));
  }
  const timer = autoDrain ? setInterval(backgroundDrain, 5000) : null; timer?.unref();
  function close() {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    db.close();
  }
  function shutdown() {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    clearInterval(timer);
    // Finish recording the current delivery, but leave unsent jobs for restart.
    shutdownPromise = (async () => {
      try { await activeDrain; }
      finally { close(); }
    })();
    return shutdownPromise;
  }
  return { enqueue, drain, pending: () => db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n,
    shutdown, close };
}

export function updatePushRegistration(s, device, body) {
  if (body.token === null) { delete device.push; delete device.voip; delete device.ringsCalls; delete device.pushPresence; return; }
  const { platform, token, environment = 'production' } = body;
  if (!['ios', 'android'].includes(platform) || typeof token !== 'string' || token.length < 20 || token.length > 4096 || /\s/.test(token) ||
      (platform === 'ios' && !/^[a-f0-9]{64,200}$/i.test(token)) || !['development', 'production'].includes(environment)) {
    throw Object.assign(new Error('Invalid notification registration'), { status: 400, code: 'bad_push_token' });
  }
  // A physical install belongs to only its latest paired account/device.
  for (const other of Object.values(s.devices)) if (other.id !== device.id && other.push?.token === token) delete other.push;
  device.push = { platform, token, environment, ...(body.aggregateBadge === true ? { aggregateBadge: true } : {}) };
}
// The PushKit token an iPhone gets for incoming calls. It is separate from the alert token.
export function updateVoipRegistration(s, device, body) {
  if (body.android === true) { device.ringsCalls = true; return; }
  if (body.token === null) { delete device.voip; return; }
  const { token, environment = 'production' } = body;
  if (typeof token !== 'string' || !/^[a-f0-9]{64,200}$/i.test(token) || !['development', 'production'].includes(environment)) {
    throw Object.assign(new Error('Invalid call registration'), { status: 400, code: 'bad_push_token' });
  }
  for (const other of Object.values(s.devices)) if (other.id !== device.id && other.voip?.token === token) delete other.voip;
  device.voip = { token, environment };
}
export function updatePreferences(user, body, now = Date.now()) {
  const p = preferences(user);
  if (body.mode !== undefined) {
    if (!['all', 'mentions', 'none'].includes(body.mode)) throw Object.assign(new Error('Choose all, mentions, or none'), { status: 400, code: 'bad_preference' });
    p.mode = body.mode;
  }
  if (body.contentPreviews !== undefined) {
    if (typeof body.contentPreviews !== 'boolean') throw Object.assign(new Error('Invalid preview preference'), { status: 400, code: 'bad_preference' });
    p.contentPreviews = body.contentPreviews;
  }
  // Older builds always send previews:false; only the new switch changes it.
  p.previews = p.contentPreviews;
  if (body.pausedUntil !== undefined) {
    if (!Number.isFinite(body.pausedUntil) || body.pausedUntil < 0 || body.pausedUntil > now + 7 * 86400000) throw Object.assign(new Error('Pause for up to seven days'), { status: 400, code: 'bad_preference' });
    p.pausedUntil = body.pausedUntil;
  }
  user.notifications = p;
}
