// Personal access tokens (docs/access-tokens.md): a person makes one, names it, and uses it from somewhere the app
// can't go, such as a script or a shell on a work computer where nothing can be installed. A token stands for the
// person who made it, but only at /api/v1/, a short list of things written for that use; it is never accepted by
// the app's own API.
//
// The token is shown once, when it is made. Only its hash is kept. It ends on the day chosen, when its person
// revokes it, or when they leave the server. Nothing here is deleted: a revoked token stays on the list as revoked.
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const TOKEN_PREFIX = "svt_";
export const MAX_TOKENS_PER_PERSON = 20;
export const DEFAULT_DAYS = 90;
export const MAX_DAYS = 366;
const DAY = 86_400_000;
const fault = (status, code, message) => Object.assign(new Error(message), { status, code });
const hash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const line = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** `"accessTokens"` in config.json. Off unless enabled is exactly true: the door is not there until an owner opens it. */
export function accessTokenSettings(raw) {
  const cfg = raw && typeof raw === "object" ? raw : {};
  const perMinute = Number(cfg.requestsPerMinute);
  return { enabled: cfg.enabled === true, requestsPerMinute: Number.isFinite(perMinute) && perMinute > 0 ? Math.min(600, Math.floor(perMinute)) : 60 };
}

/** Whether a string has the shape of a token, without saying whether it is a real one. */
export const looksLikeToken = value => typeof value === "string" && /^svt_[A-Za-z0-9_-]{43}$/.test(value);

export function createAccessTokens(file, { clock = Date.now } = {}) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout=5000");
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS tokens (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL, name TEXT NOT NULL, hint TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_used_at INTEGER, revoked_at INTEGER, revoked_by TEXT);
    CREATE INDEX IF NOT EXISTS tokens_user ON tokens(user_id, created_at);
    CREATE TRIGGER IF NOT EXISTS tokens_no_delete BEFORE DELETE ON tokens BEGIN SELECT RAISE(ABORT, 'access tokens are revoked, not deleted'); END;`);
  const view = r => r && ({ id: r.id, name: r.name, hint: r.hint, createdAt: r.created_at, expiresAt: r.expires_at,
    ...(r.last_used_at ? { lastUsedAt: r.last_used_at } : {}), ...(r.revoked_at ? { revokedAt: r.revoked_at } : {}),
    // What it is right now, in one word, so nobody has to compare dates.
    state: r.revoked_at ? "revoked" : r.expires_at <= clock() ? "expired" : "active" });
  const uses = new Map();

  return {
    /** Make a token for a person. Returns its record and the token itself, which is never available again. */
    create(userId, { name, days = DEFAULT_DAYS } = {}) {
      const clean = line(name, 60);
      if (!clean) throw fault(400, "bad_request", "Name the token after where you will use it, for example Work laptop");
      const length = Number(days);
      if (!Number.isInteger(length) || length < 1 || length > MAX_DAYS) throw fault(400, "bad_request", `A token lasts from 1 to ${MAX_DAYS} days`);
      const now = clock();
      const live = db.prepare("SELECT count(*) AS n FROM tokens WHERE user_id=? AND revoked_at IS NULL AND expires_at>?").get(String(userId), now).n;
      if (live >= MAX_TOKENS_PER_PERSON) throw fault(400, "bad_request", `You can have up to ${MAX_TOKENS_PER_PERSON} tokens at once. Revoke one you no longer use`);
      const secret = TOKEN_PREFIX + crypto.randomBytes(32).toString("base64url");
      const id = `tok_${crypto.randomBytes(9).toString("base64url")}`;
      db.prepare("INSERT INTO tokens(id,token_hash,user_id,name,hint,created_at,expires_at) VALUES (?,?,?,?,?,?,?)").run(id, hash(secret), String(userId), clean, `${secret.slice(0, 8)}…${secret.slice(-4)}`, now, now + length * DAY);
      return { token: secret, record: view(db.prepare("SELECT * FROM tokens WHERE id=?").get(id)) };
    },
    /** One person's tokens, newest first, revoked and expired ones included. */
    list: userId => db.prepare("SELECT * FROM tokens WHERE user_id=? ORDER BY created_at DESC, rowid DESC").all(String(userId)).map(view),
    /** Revoke one of a person's own tokens. False when it isn't theirs or was already revoked. */
    revoke(id, userId, by = userId) {
      return db.prepare("UPDATE tokens SET revoked_at=?, revoked_by=? WHERE id=? AND user_id=? AND revoked_at IS NULL").run(clock(), String(by), String(id), String(userId)).changes > 0;
    },
    /** Someone left the server: every token of theirs stops. */
    forget(userId, by) { db.prepare("UPDATE tokens SET revoked_at=?, revoked_by=? WHERE user_id=? AND revoked_at IS NULL").run(clock(), String(by), String(userId)); },
    /**
     * Who a presented token stands for: { userId, id } when it is real, not revoked and not expired; otherwise null.
     * The same answer for every kind of wrong, so a guess learns nothing.
     */
    check(secret) {
      if (!looksLikeToken(secret)) return null;
      const r = db.prepare("SELECT * FROM tokens WHERE token_hash=?").get(hash(secret));
      const now = clock();
      if (!r || r.revoked_at || r.expires_at <= now) return null;
      // Written at most once a minute: "last used" is for the person to see, not a counter.
      if (!r.last_used_at || now - r.last_used_at > 60_000) db.prepare("UPDATE tokens SET last_used_at=? WHERE id=?").run(now, r.id);
      return { userId: r.user_id, id: r.id };
    },
    /** Count one request against a token's minute. False when it has used the minute up. */
    allow(id, perMinute) {
      const now = clock();
      if (uses.size > 5000) for (const [k, v] of uses) if (now - v.start > 60_000) uses.delete(k);
      const u = uses.get(id);
      if (!u || now - u.start > 60_000) { uses.set(id, { start: now, n: 1 }); return true; }
      return ++u.n <= perMinute;
    },
    close: () => db.close(),
  };
}
