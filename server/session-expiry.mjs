// Sessions that end. With `sessionMaxHours` in config.json (for example 12) a signed-in
// device stops working that many hours after it last proved who it is, and has to re-enter with a
// six-digit code sent to the work email already on the account. Off by default: every other
// instance keeps its long-lived device tokens.
//
// What "proved who it is" means: the email step at pairing, or a later re-entry code
// (device.sessionVerifiedAt). A device paired without the email step (a sign-in link from a
// device that was already signed in, the owner's first invite) counts from when it was paired.
//
// People with no confirmed email (they joined before email codes) cannot receive a code, so they
// keep working for `sessionGraceHours` (default 72) after the policy starts, long enough to add
// their email from the You tab. After that they are held like everyone else, and the way back in
// is to confirm an email (allowed on a held session when there is no email yet) or the owner
// running `servant session-reset <name>` on the Mac.
//
// Nothing here is enforced unless codes can actually be delivered (emailVerification on with a
// mailer command); otherwise the server says so at startup and leaves sessions alone.
import fs from "node:fs";
import path from "node:path";
import { emailSettings } from "./email-verify.mjs";

export const SESSION_EXPIRED = "session_expired";
export const SESSION_EXPIRED_MESSAGE = "Your session ended. Enter the code we email you to continue.";
// Builds that cannot re-enter (no reverify screen) get a 403 with this, never a 401 they would treat as "signed out".
export const SESSION_EXPIRED_MESSAGE_OLD = "Your session ended. Update Servant, then open it again to continue.";
export const REVERIFY_HEADER = "x-servant-reverify";
export const SESSION_FILE = "session-policy.json";
const HOUR = 3_600_000;
const MAX_HOURS = 24 * 365;
const DEFAULT_GRACE_HOURS = 72;
const POLICY_CACHE_MS = 1000;
export const RESEND_AFTER_SECONDS = 30;

const finiteNumber = v => typeof v === "number" && Number.isFinite(v);

/** The normalised policy for a config object: hours, whether it was asked for, and whether it can run. */
export function sessionPolicy(cfg = {}) {
  const maxHours = finiteNumber(cfg.sessionMaxHours) && cfg.sessionMaxHours > 0 ? Math.min(cfg.sessionMaxHours, MAX_HOURS) : 0;
  const graceHours = finiteNumber(cfg.sessionGraceHours) && cfg.sessionGraceHours >= 0 ? Math.min(cfg.sessionGraceHours, MAX_HOURS) : DEFAULT_GRACE_HOURS;
  const email = emailSettings(cfg);
  const mailer = typeof email.mailer?.command === "string" && email.mailer.command.trim() !== "";
  const problem = !maxHours ? null
    : !email.enabled ? "emailVerification is off"
    : !mailer ? "emailVerification.mailer.command is not set"
    : null;
  return { requested: maxHours > 0, enabled: maxHours > 0 && !problem, problem, maxHours, graceHours, maxMs: maxHours * HOUR, graceMs: graceHours * HOUR };
}

/** j***@example.gov: enough to recognise the mailbox, not enough to learn it. */
export function maskEmail(email) {
  const [local = "", domain = ""] = String(email || "").split("@");
  if (!local || !domain) return "";
  return `${local[0]}***@${domain}`;
}

/** The re-entry email: who, where, the code, and that nothing happens without it. No link. */
export function reentryMail({ name, device }) {
  return (code, minutes) => ({
    subject: `Your Servant code is ${code}`,
    text: `Someone is continuing as ${name} in Servant on "${device}". If that's you, enter this code there: ${code}. ` +
      `It works for ${minutes} minutes. If you didn't try to sign in, ignore this email: nothing happens without the code. ` +
      `Servant never asks for this code by email, phone or chat.`,
  });
}

/** Can this client show the re-entry screen? The app sends the header on every request. */
export const canReverify = req => String(req?.headers?.[REVERIFY_HEADER] || "") === "1";

/** Routes a held session may still reach. Paths only; the handlers do their own checks. */
export function staleAllowed(pathname, user) {
  if (pathname === "/v1/session/email" || pathname === "/v1/session/verify" || pathname === "/v1/signout") return true;
  // Adding the first email is the re-entry for someone who has none; once there is one, the code is the way.
  if (pathname === "/v1/people/me/email" || pathname === "/v1/people/me/email/confirm") return !user?.emailVerifiedAt;
  return false;
}

export function createSessions({ dir, now = Date.now, config = () => ({}), emailVerifier, log = console.warn }) {
  let source = config;
  let cached = null, cachedAt = -Infinity;
  let since = null;
  const warned = new Set();
  const file = path.join(dir, SESSION_FILE);

  const readSince = () => {
    try { const v = JSON.parse(fs.readFileSync(file, "utf8")).since; return Number.isSafeInteger(v) ? v : null; } catch { return null; }
  };
  const policy = () => {
    if (now() - cachedAt < POLICY_CACHE_MS && cached) return cached;
    cached = sessionPolicy(source());
    cachedAt = now();
    if (cached.requested && cached.problem && !warned.has(cached.problem)) {
      warned.add(cached.problem);
      log(`[servant] sessionMaxHours is ${cached.maxHours} but ${cached.problem}: sessions will not expire until codes can be emailed`);
    }
    if (cached.enabled) {
      // The grace period for people without an email runs from the first moment the policy was live here.
      since ??= readSince();
      if (since === null) {
        since = now();
        try { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.writeFileSync(file, JSON.stringify({ since }), { mode: 0o600 }); } catch (error) { log("[servant] session policy file", error?.message || error); }
      }
    } else if (since !== null || fs.existsSync(file)) {
      // Turned off: the next time it's turned on, the grace period starts again.
      since = null;
      try { fs.rmSync(file, { force: true }); } catch {}
    }
    return cached;
  };

  /** Where a device stands: fresh, expired, and when it turns. */
  function status(device, user) {
    const p = policy();
    if (!p.enabled || !device || !user) return { active: false, expired: false, expiresAt: null, maxHours: p.maxHours, emailNeeded: false };
    const anchor = Number(device.sessionVerifiedAt || device.createdAt || 0);
    const expiresAt = anchor + p.maxMs;
    if (user.emailVerifiedAt) return { active: true, expired: now() >= expiresAt, expiresAt, maxHours: p.maxHours, emailNeeded: false };
    // No email on file: never held before the grace period since the policy began has passed.
    const holdAt = Math.max(expiresAt, since + p.graceMs);
    return { active: true, expired: now() >= holdAt, expiresAt: holdAt, maxHours: p.maxHours, emailNeeded: true, graceUntil: holdAt };
  }

  /** True when this request must be refused because the device's session ended. */
  function expired(req, device, user) {
    const s = status(device, user);
    if (!s.expired) return false;
    const pathname = String(req?.url || "").split("?")[0];
    return !staleAllowed(pathname, user);
  }

  function error(req) {
    const old = !canReverify(req);
    return Object.assign(new Error(old ? SESSION_EXPIRED_MESSAGE_OLD : SESSION_EXPIRED_MESSAGE), {
      status: old ? 403 : 401, code: SESSION_EXPIRED, extra: { maxHours: policy().maxHours },
    });
  }

  /** What GET /v1/me tells the app, or null when sessions don't expire here. */
  function view(device, user) {
    const s = status(device, user);
    if (!s.active) return null;
    return { expiresAt: s.expiresAt, maxHours: s.maxHours, emailNeeded: s.emailNeeded, email: user.email ? maskEmail(user.email) : null };
  }

  const verifiedNow = device => { device.sessionVerifiedAt = now(); };
  const scopeFor = (device, user) => `session:${device.id}:${user.id}`;

  /** POST /v1/session/email and /v1/session/verify. Returns true when it answered. */
  async function handle(req, res, { auth, ip, settings, send, fail, readBody, pairAllowed, emailStartAllowed, pairFailed, mutateAuthenticated }) {
    const pathname = String(req.url || "").split("?")[0];
    if (req.method !== "POST" || (pathname !== "/v1/session/email" && pathname !== "/v1/session/verify")) return false;
    if (!policy().enabled) return fail(res, 404, "not_found", "Sessions don't expire on this server"), true;
    if (!pairAllowed(ip)) return fail(res, 429, "rate_limited", "Too many tries. Wait ten minutes"), true;
    const { user, device } = auth;
    const scope = scopeFor(device, user);
    if (pathname === "/v1/session/email") {
      // Sending mails the account's own address; every request counts against the visitor, like pairing.
      if (!emailStartAllowed(ip)) return fail(res, 429, "rate_limited", "Too many codes sent. Wait ten minutes"), true;
      await readBody(req);
      if (!user.emailVerifiedAt || !user.email) return fail(res, 409, "email_needed", "Add your work email to continue"), true;
      try {
        const out = await emailVerifier.start({ email: user.email, inviteKey: scope, mail: reentryMail({ name: user.name, device: device.label || "this device" }) }, settings);
        return send(res, 200, { challenge: out.id, email: maskEmail(out.email), expiresInSeconds: 600, resendAfterSeconds: RESEND_AFTER_SECONDS }), true;
      } catch (error) {
        if (!error.status) throw error;
        return fail(res, error.status, error.code, error.message), true;
      }
    }
    const body = await readBody(req);
    let confirmed;
    try { confirmed = emailVerifier.check({ id: body.challenge, code: body.code, inviteKey: scope }); }
    catch (error) { if (!error.status) throw error; pairFailed(ip); return fail(res, error.status, error.code, error.message), true; }
    // The address changed under the challenge (it shouldn't: codes go to the address on file).
    if (confirmed !== String(user.email || "").toLowerCase()) { pairFailed(ip); return fail(res, 403, "email_code_expired", "That code expired. Ask for a new one"), true; }
    const session = mutateAuthenticated((state, current) => { verifiedNow(current.device); return view(current.device, current.user); });
    return send(res, 200, { ok: true, session }), true;
  }

  /** `servant session-reset <name, user id or device id>`: marks the person's devices fresh. */
  function reset(state, query) {
    const q = String(query || "").trim();
    if (!q) return null;
    const device = Object.values(state.devices).find(d => d.id === q && !d.revokedAt);
    const people = device ? [state.users[device.userId]] : Object.values(state.users).filter(u => !u.removedAt && (u.id === q || String(u.name).toLowerCase() === q.toLowerCase()));
    if (people.length !== 1 || !people[0]) return { count: people.length };
    const devices = device ? [device] : Object.values(state.devices).filter(d => d.userId === people[0].id && !d.revokedAt);
    for (const d of devices) verifiedNow(d);
    return { count: 1, name: people[0].name, devices: devices.length };
  }

  /** Called once the server is up: pin the config source and say so if the policy can't run. */
  function start(configSource) {
    if (configSource) source = configSource;
    cachedAt = -Infinity;
    return policy();
  }

  return { policy, status, expired, error, view, verifiedNow, handle, reset, start, since: () => since };
}
