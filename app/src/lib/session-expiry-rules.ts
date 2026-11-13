// Rules for sessions that end (server: session-expiry.mjs). Pure, so they can be tested without React.
// With `sessionMaxHours` set on the server, a device gets 401 `session_expired` after that many hours
// and re-enters with a code sent to the work email on file. That is not a sign-out: the account,
// the drafts and everything saved on this device stay.

export const SESSION_EXPIRED = "session_expired";

type ErrorLike = { status?: number; code?: string } | null | undefined;

/** The server ended this device's session: ask the person to confirm it's them, keep everything else. */
export function isSessionExpired(e: unknown): boolean {
  const err = e as ErrorLike;
  return !!err && typeof err === "object" && err.code === SESSION_EXPIRED;
}

/** The device is really out (unpaired, revoked, removed): the only 401 that means sign out. */
export function isSignedOut(e: unknown): boolean {
  const err = e as ErrorLike;
  return !!err && typeof err === "object" && err.status === 401 && err.code !== SESSION_EXPIRED;
}

/** What GET /v1/me says about this device's session, or null when sessions don't expire on that server. */
export type SessionInfo = { expiresAt: number; maxHours: number; emailNeeded: boolean; email: string | null };

export function parseSessionInfo(raw: unknown): SessionInfo | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.expiresAt !== "number" || !Number.isFinite(r.expiresAt)) return null;
  return {
    expiresAt: r.expiresAt,
    maxHours: typeof r.maxHours === "number" && Number.isFinite(r.maxHours) ? r.maxHours : 0,
    emailNeeded: r.emailNeeded === true,
    email: typeof r.email === "string" && r.email ? r.email : null,
  };
}

/** True once the time the server gave us has passed: on resume we go to the confirm screen without waiting for a request to fail. */
export function sessionLapsed(info: SessionInfo | null, now: number): boolean {
  return !!info && now >= info.expiresAt;
}

/** The first line on the confirm screen. Plain, no countdown: say what happened and what comes next. */
export function expiryLead(maxHours: number | null, email: string | null, needsEmail = false): string {
  const every = maxHours && maxHours > 0 ? `every ${formatHours(maxHours)}` : "now and then";
  const start = `For safety, Servant asks you to confirm it's you ${every}.`;
  if (needsEmail) return `${start} Add your work email and we'll send a code there.`;
  return email ? `${start} We'll email a code to ${email}.` : `${start} We'll email a code to the work email on your account.`;
}

export function formatHours(hours: number): string {
  if (hours === 1) return "hour";
  if (Number.isInteger(hours)) return `${hours} hours`;
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} minutes`;
  return `${Math.round(hours * 10) / 10} hours`;
}

/** Resend is quiet for a while after each send; no timer on screen, the button just comes back. */
export function canResend(lastSentAt: number | null, now: number, waitSeconds = 30): boolean {
  return lastSentAt === null || now - lastSentAt >= waitSeconds * 1000;
}

/** Only digits, at most six: what the code field keeps from typing, paste or autofill. */
export function cleanCode(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, 6);
}
