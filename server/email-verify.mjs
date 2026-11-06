// Email code verification for sign-in: prove you can read mail at an allowed
// (default irs.gov) address before the invite works. Off unless the owner turns
// it on in config.json: emailVerification: { enabled, domains, mailer }.
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const TTL_MS = 10 * 60 * 1000;
const MAX_TRIES = 5;
const MAX_SENDS_PER_EMAIL = 5; // per 10 minutes

export function emailSettings(cfg = {}) {
  const v = cfg.emailVerification || {};
  const domains = (Array.isArray(v.domains) && v.domains.length ? v.domains : ["irs.gov"]).map((d) => String(d).toLowerCase().replace(/^@/, ""));
  return { enabled: v.enabled === true, domains, mailer: v.mailer || null };
}

export function normalizeEmail(raw) {
  const e = String(raw || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254 ? e : "";
}

// Exact domain or a real subdomain (mail.irs.gov), never a look-alike (irs.gov.evil.com).
export function emailAllowed(email, domains) {
  const host = email.split("@")[1] || "";
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

const hash = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

export function createEmailVerifier({ now = Date.now, send } = {}) {
  const challenges = new Map(); // id -> {email, inviteKey, codeHash, expiresAt, tries, verified}
  const sends = new Map(); // email -> [timestamps]
  const sweep = () => { for (const [k, c] of challenges) if (c.expiresAt < now()) challenges.delete(k); };

  return {
    // Returns { id, email } after the code is emailed.
    async start({ email, inviteKey }, settings) {
      sweep();
      const clean = normalizeEmail(email);
      if (!clean) throw Object.assign(new Error("Enter your work email"), { status: 400, code: "email_invalid" });
      if (!emailAllowed(clean, settings.domains)) {
        throw Object.assign(new Error(`Use your ${settings.domains.map((d) => "@" + d).join(" or ")} email`), { status: 403, code: "email_not_allowed" });
      }
      const recent = (sends.get(clean) || []).filter((t) => now() - t < TTL_MS);
      if (recent.length >= MAX_SENDS_PER_EMAIL) throw Object.assign(new Error("Too many codes sent. Wait ten minutes"), { status: 429, code: "rate_limited" });
      sends.set(clean, [...recent, now()]);
      const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
      const id = crypto.randomBytes(16).toString("base64url");
      challenges.set(id, { email: clean, inviteKey, codeHash: hash(`${id}:${code}`), expiresAt: now() + TTL_MS, tries: 0 });
      try {
        await send({ to: clean, code, minutes: TTL_MS / 60000 }, settings);
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
      if (++c.tries > MAX_TRIES) { challenges.delete(id); throw bad("Too many wrong codes. Ask for a new one", "email_code_expired"); }
      const given = hash(`${id}:${String(code || "").replace(/\s/g, "")}`);
      if (!crypto.timingSafeEqual(Buffer.from(given), Buffer.from(c.codeHash))) throw bad("That code isn't right. Check it and try again", "email_code_wrong");
      if (!keep) challenges.delete(id);
      return c.email;
    },
    consume(id) { challenges.delete(String(id || "")); },
  };
}

// Default sender: runs the owner's mailer command, JSON on stdin
// ({to, subject, text, code}). Nothing is sent if no mailer is configured.
export function commandSender({ to, code, minutes }, settings) {
  const cmd = settings.mailer?.command;
  if (!cmd) return Promise.reject(new Error("no mailer configured"));
  const payload = { to, code, subject: `Your Servant code is ${code}`, text: `Your Servant sign-in code is ${code}. It works for ${minutes} minutes. If you didn't ask for it, ignore this email.` };
  return new Promise((resolve, reject) => {
    const p = spawn("/bin/sh", ["-c", cmd], { stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => { err += d; });
    p.on("error", reject);
    p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`mailer exited ${c}: ${err.slice(0, 200)}`))));
    p.stdin.end(JSON.stringify(payload));
  });
}
