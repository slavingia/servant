// Email code verification for sign-in: prove you can read mail at an allowed
// address before the invite works. Off unless the owner turns it on in
// config.json: emailVerification: { enabled, domains, mailer }. There is no
// default domain: with enabled true and domains empty, no address is allowed
// (fail closed) and the server warns at startup.
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const TTL_MS = 10 * 60 * 1000;
const MAX_TRIES = 5;
const MAX_SENDS_PER_EMAIL = 5; // per 10 minutes, for each address and link/session
// Wrong guesses add up across codes (asking for a fresh code used to reset the count): a six-digit code
// allows 8 real guesses per address and link/session per ten minutes, then a pause.
const MAX_WRONG_PER_EMAIL = 8;

export function emailSettings(cfg = {}) {
  const v = cfg.emailVerification || {};
  const domains = (Array.isArray(v.domains) ? v.domains : []).map((d) => String(d).trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
  return { enabled: v.enabled === true, domains, mailer: v.mailer || null };
}

// The startup warning for a config that turns email codes on but allows no domain. Null when fine.
export function emailSetupWarning(cfg = {}) {
  const s = emailSettings(cfg);
  return s.enabled && !s.domains.length
    ? '[servant] emailVerification.enabled is true but emailVerification.domains is empty: no email address is allowed, so email sign-in will refuse everyone. Add your domains, e.g. "domains": ["example.gov"]'
    : null;
}

export function normalizeEmail(raw) {
  const e = String(raw || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254 ? e : "";
}

// Exact domain or a real subdomain (mail.example.gov), never a look-alike (example.gov.evil.com).
export function emailAllowed(email, domains) {
  const host = email.split("@")[1] || "";
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

const hash = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

export function createEmailVerifier({ now = Date.now, send } = {}) {
  const challenges = new Map(); // id -> {email, inviteKey, codeHash, expiresAt, tries, verified}
  const sends = new Map(); // `${inviteKey}|${email}` -> [timestamps]. Per link/session, so one cannot spend another's budget.
  const wrongs = new Map(); // `${inviteKey}|${email}` -> [timestamps of wrong codes]
  const budgetKey = (inviteKey, email) => `${inviteKey}|${email}`;
  const recentOf = (map, key) => (map.get(key) || []).filter((t) => now() - t < TTL_MS);
  const sweep = () => { for (const [k, c] of challenges) if (c.expiresAt < now()) challenges.delete(k); };

  return {
    // Returns { id, email } after the code is emailed.
    // `mail(code, minutes)` may supply the subject and text (re-entry codes say who and why); the default is the sign-in wording.
    async start({ email, inviteKey, mail }, settings) {
      sweep();
      const clean = normalizeEmail(email);
      if (!clean) throw Object.assign(new Error("Enter your work email"), { status: 400, code: "email_invalid" });
      if (!settings.domains.length) {
        throw Object.assign(new Error("Email sign-in isn't set up yet. Ask the owner to add the allowed email domains"), { status: 403, code: "email_not_allowed" });
      }
      if (!emailAllowed(clean, settings.domains)) {
        throw Object.assign(new Error(`Use your ${settings.domains.map((d) => "@" + d).join(" or ")} email`), { status: 403, code: "email_not_allowed" });
      }
      const key = budgetKey(inviteKey, clean);
      const recent = recentOf(sends, key);
      if (recent.length >= MAX_SENDS_PER_EMAIL) throw Object.assign(new Error("Too many codes sent. Wait ten minutes"), { status: 429, code: "rate_limited" });
      if (recentOf(wrongs, key).length >= MAX_WRONG_PER_EMAIL) throw Object.assign(new Error("Too many wrong codes. Wait ten minutes"), { status: 429, code: "rate_limited" });
      sends.set(key, [...recent, now()]);
      if (sends.size > 5000) for (const [k, v] of sends) if (!v.some((t) => now() - t < TTL_MS)) sends.delete(k);
      if (wrongs.size > 5000) for (const [k, v] of wrongs) if (!v.some((t) => now() - t < TTL_MS)) wrongs.delete(k);
      const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
      const id = crypto.randomBytes(16).toString("base64url");
      challenges.set(id, { email: clean, inviteKey, codeHash: hash(`${id}:${code}`), expiresAt: now() + TTL_MS, tries: 0 });
      try {
        await send({ to: clean, code, minutes: TTL_MS / 60000, ...(mail ? mail(code, TTL_MS / 60000) : {}) }, settings);
      } catch (error) {
        challenges.delete(id);
        console.error("[servant] email send failed:", error?.message || error);
        throw Object.assign(new Error("Couldn't send the code. Try again, or ask the owner to check email setup"), { status: 502, code: "email_send_failed" });
      }
      return { id, email: clean };
    },
    // Consumes the challenge on success unless keep (so a later name/terms error doesn't burn the code). Returns the verified email.
    check({ id, code, inviteKey }, { keep = false } = {}) {
      sweep();
      const c = challenges.get(String(id || ""));
      const bad = (message, code2) => Object.assign(new Error(message), { status: 403, code: code2 });
      if (!c || c.inviteKey !== inviteKey) throw bad("That code expired. Ask for a new one", "email_code_expired");
      const key = budgetKey(inviteKey, c.email);
      if (recentOf(wrongs, key).length >= MAX_WRONG_PER_EMAIL) throw Object.assign(new Error("Too many wrong codes. Wait ten minutes"), { status: 429, code: "rate_limited" });
      if (++c.tries > MAX_TRIES) { challenges.delete(id); throw bad("Too many wrong codes. Ask for a new one", "email_code_expired"); }
      const given = hash(`${id}:${String(code || "").replace(/\s/g, "")}`);
      if (!crypto.timingSafeEqual(Buffer.from(given), Buffer.from(c.codeHash))) {
        wrongs.set(key, [...recentOf(wrongs, key), now()]);
        throw bad("That code isn't right. Check it and try again", "email_code_wrong");
      }
      if (!keep) challenges.delete(id);
      return c.email;
    },
    consume(id) { challenges.delete(String(id || "")); },
  };
}

// Default sender: runs the owner's mailer command, JSON on stdin
// ({to, subject, text, code}). Nothing is sent if no mailer is configured.
export function commandSender({ to, code, minutes, subject, text }, settings) {
  const cmd = settings.mailer?.command;
  if (!cmd) return Promise.reject(new Error("no mailer configured"));
  const payload = { to, code, subject: subject || `Your Servant code is ${code}`, text: text || `Your Servant sign-in code is ${code}. It works for ${minutes} minutes. If you didn't ask for it, ignore this email.` };
  return new Promise((resolve, reject) => {
    const p = spawn("/bin/sh", ["-c", cmd], { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    let stdinError;
    // A stuck mailer (SMTP hung, bad credentials) must not hold someone's sign-in request open forever.
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; p.kill("SIGKILL"); reject(new Error("mailer timed out")); }, Number(settings.mailer?.timeoutMs) > 0 ? Number(settings.mailer.timeoutMs) : 30_000);
    // A command may exit before reading its input. Keep its exit status as the
    // primary failure, but never report success if writing the message failed.
    p.stdin.on("error", (e) => { stdinError = e; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
    p.on("close", (c) => {
      clearTimeout(timer);
      if (timedOut) return;
      if (c !== 0) reject(new Error(`mailer exited ${c}: ${err.slice(0, 200)}`));
      else if (stdinError) reject(new Error("mailer input failed", { cause: stdinError }));
      else resolve();
    });
    p.stdin.end(JSON.stringify(payload));
  });
}
