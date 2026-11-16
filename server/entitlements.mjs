// Entitlements (docs/entitlements.md): a named piece of access a person can hold, such as "GitHub" or "Tax data
// API". Each one lists the hosts it lets a person's agent reach. A person asks for one and confirms they already
// have that access themselves; their manager grants or declines, and can take it back. A manager can only grant
// what they hold themselves, so every grant traces back to an owner. The agent never gets someone further than
// their own access goes.
//
// Nothing here is deleted. Retiring an entitlement or revoking a grant changes its status, and every request,
// decision and edit is appended to `history`.
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { cleanHost, hostMatches } from "./egress.mjs";

export const MAX_ENTITLEMENTS = 200;
export const MAX_HOSTS = 50;
/** What a person agrees to when they ask, unless the entitlement has its own wording. */
export const DEFAULT_CONFIRMATION = "I already have this access myself, under my own name, and I will only ask the agent to do what I am allowed to do.";

const fault = (status, code, message) => Object.assign(new Error(message), { status, code });
const newId = prefix => `${prefix}_${crypto.randomBytes(9).toString("base64url")}`;
const line = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export function cleanEntitlementName(value) {
  const name = line(value, 60);
  if (!name) throw fault(400, "bad_request", "An entitlement needs a name");
  return name;
}
/** Host names and "*.example.gov" patterns, lowercased and without repeats. */
export function cleanHosts(value) {
  if (!Array.isArray(value)) throw fault(400, "bad_request", "hosts is a list of host names");
  const hosts = [];
  for (const raw of value) {
    const host = cleanHost(raw);
    if (!host) throw fault(400, "bad_request", `${JSON.stringify(String(raw).slice(0, 80))} isn't a host name. Use a name such as api.example.gov or *.example.gov, without https:// or a path`);
    if (!hosts.includes(host)) hosts.push(host);
  }
  if (hosts.length > MAX_HOSTS) throw fault(400, "bad_request", `An entitlement covers up to ${MAX_HOSTS} hosts`);
  return hosts;
}
/**
 * The store. `known(userId)` says whether someone is on the server now, `isOwner(userId)` whether they are an
 * owner, and `manages(by, userId)` whether `by` is that person's manager. Owners make, edit and retire
 * entitlements and can decide for anyone; a manager decides for the people they manage.
 */
export function createEntitlements(file, { clock = Date.now, known = () => true, isOwner = () => false, manages = () => false } = {}) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout=5000");
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS entitlements (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, hosts TEXT NOT NULL,
      confirmation TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, retired_at INTEGER);
    CREATE TABLE IF NOT EXISTS grants (entitlement_id TEXT NOT NULL, user_id TEXT NOT NULL, status TEXT NOT NULL, note TEXT NOT NULL, confirmation TEXT NOT NULL,
      requested_at INTEGER NOT NULL, decided_by TEXT, decided_at INTEGER, reason TEXT, PRIMARY KEY(entitlement_id, user_id));
    CREATE TABLE IF NOT EXISTS history (seq INTEGER PRIMARY KEY, entitlement_id TEXT NOT NULL, user_id TEXT, action TEXT NOT NULL, by TEXT NOT NULL, at INTEGER NOT NULL, detail TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS grants_user ON grants(user_id, status);
    CREATE TRIGGER IF NOT EXISTS history_no_update BEFORE UPDATE ON history BEGIN SELECT RAISE(ABORT, 'entitlement history is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS history_no_delete BEFORE DELETE ON history BEGIN SELECT RAISE(ABORT, 'entitlement history is append-only'); END;`);
  const tx = fn => { db.exec("BEGIN IMMEDIATE"); try { const out = fn(); db.exec("COMMIT"); return out; } catch (error) { db.exec("ROLLBACK"); throw error; } };
  const note = (entitlementId, userId, action, by, detail = {}) =>
    db.prepare("INSERT INTO history(entitlement_id,user_id,action,by,at,detail) VALUES (?,?,?,?,?,?)").run(entitlementId, userId ?? null, action, String(by), clock(), JSON.stringify(detail));
  const shape = r => r && ({ id: r.id, name: r.name, description: r.description, hosts: JSON.parse(r.hosts), confirmation: r.confirmation || DEFAULT_CONFIRMATION,
    createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at, ...(r.retired_at ? { retiredAt: r.retired_at } : {}) });
  const grantShape = r => r && ({ entitlementId: r.entitlement_id, userId: r.user_id, status: r.status, note: r.note, requestedAt: r.requested_at,
    ...(r.decided_by ? { decidedBy: r.decided_by, decidedAt: r.decided_at } : {}), ...(r.reason ? { reason: r.reason } : {}) });
  const row = id => db.prepare("SELECT * FROM entitlements WHERE id=?").get(String(id));
  const live = id => { const r = row(id); if (!r || r.retired_at) throw fault(404, "not_found", "No such entitlement"); return shape(r); };
  const grantRow = (id, userId) => db.prepare("SELECT * FROM grants WHERE entitlement_id=? AND user_id=?").get(String(id), String(userId));
  const all = () => db.prepare("SELECT * FROM entitlements WHERE retired_at IS NULL ORDER BY name COLLATE NOCASE").all().map(shape);
  /** May `by` decide what `userId` holds? Owners for anyone (themselves included); a manager for the people they manage. */
  const decides = (by, userId) => !!by && known(by) && (isOwner(by) || (String(by) !== String(userId) && manages(by, userId)));
  const holds = (id, userId) => grantRow(id, userId)?.status === "granted";

  return {
    list: all,
    get: id => { const r = row(id); return r && !r.retired_at ? shape(r) : null; },
    decides,
    /** Owners only (checked by the caller): a new entitlement. */
    create({ name, description = "", hosts = [], confirmation = "" }, by) {
      const clean = { name: cleanEntitlementName(name), description: line(description, 300), hosts: cleanHosts(hosts), confirmation: line(confirmation, 500) };
      return tx(() => {
        if (all().length >= MAX_ENTITLEMENTS) throw fault(400, "bad_request", `A server has up to ${MAX_ENTITLEMENTS} entitlements`);
        if (all().some(e => e.name.toLowerCase() === clean.name.toLowerCase())) throw fault(409, "name_taken", "An entitlement already has that name. Try another");
        const id = newId("ent"), now = clock();
        db.prepare("INSERT INTO entitlements(id,name,description,hosts,confirmation,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
          .run(id, clean.name, clean.description, JSON.stringify(clean.hosts), clean.confirmation, String(by), now, now);
        note(id, null, "created", by, clean);
        return shape(row(id));
      });
    },
    /** Owners only (checked by the caller): change the name, description, hosts or the wording people confirm. */
    update(id, patch, by) {
      return tx(() => {
        const current = live(id);
        const next = {
          name: "name" in patch ? cleanEntitlementName(patch.name) : current.name,
          description: "description" in patch ? line(patch.description, 300) : current.description,
          hosts: "hosts" in patch ? cleanHosts(patch.hosts) : current.hosts,
          confirmation: "confirmation" in patch ? line(patch.confirmation, 500) : row(id).confirmation,
        };
        if (all().some(e => e.id !== current.id && e.name.toLowerCase() === next.name.toLowerCase())) throw fault(409, "name_taken", "An entitlement already has that name. Try another");
        db.prepare("UPDATE entitlements SET name=?,description=?,hosts=?,confirmation=?,updated_at=? WHERE id=?")
          .run(next.name, next.description, JSON.stringify(next.hosts), next.confirmation, clock(), current.id);
        note(current.id, null, "updated", by, next);
        return shape(row(id));
      });
    },
    /** Owners only (checked by the caller): nobody can ask for it any more and it stops opening anything. Its history stays. */
    retire(id, by) {
      return tx(() => { const current = live(id); db.prepare("UPDATE entitlements SET retired_at=?,updated_at=? WHERE id=?").run(clock(), clock(), current.id); note(current.id, null, "retired", by); return true; });
    },
    /**
     * A person asks for an entitlement. They must confirm they hold this access themselves; the exact words they
     * agreed to are kept with the request. Asking again while waiting changes nothing; after a refusal or a
     * revocation it is a new request. Returns { grant, fresh } where fresh means their manager should be told.
     */
    request(id, userId, { confirmed, note: text = "" } = {}) {
      return tx(() => {
        const entitlement = live(id);
        if (!known(userId)) throw fault(403, "forbidden", "Only people on this server can ask for an entitlement");
        if (confirmed !== true) throw fault(400, "confirmation_required", `To ask for ${entitlement.name}, confirm: ${entitlement.confirmation}`);
        const existing = grantRow(id, userId);
        if (existing?.status === "granted") throw fault(409, "already_granted", `You already have ${entitlement.name}`);
        if (existing?.status === "requested") return { entitlement, grant: grantShape(existing), fresh: false };
        const clean = line(text, 500);
        db.prepare(`INSERT INTO grants(entitlement_id,user_id,status,note,confirmation,requested_at) VALUES (?,?,'requested',?,?,?)
          ON CONFLICT(entitlement_id, user_id) DO UPDATE SET status='requested', note=excluded.note, confirmation=excluded.confirmation,
            requested_at=excluded.requested_at, decided_by=NULL, decided_at=NULL, reason=NULL`).run(entitlement.id, String(userId), clean, entitlement.confirmation, clock());
        note(entitlement.id, userId, "requested", userId, { note: clean, confirmation: entitlement.confirmation });
        return { entitlement, grant: grantShape(grantRow(id, userId)), fresh: true };
      });
    },
    /**
     * The person's manager (or an owner) answers: "grant" or "deny" a waiting request, or "revoke" what someone
     * holds. A manager can only grant what they hold themselves, nobody but an owner decides their own request,
     * and nobody is given an entitlement they did not ask for.
     */
    decide(id, userId, { decision, by, reason = "" }) {
      if (!["grant", "deny", "revoke"].includes(decision)) throw fault(400, "bad_request", "decision is grant, deny or revoke");
      return tx(() => {
        const entitlement = live(id);
        // An owner is where trust on the server starts, so an owner may answer their own request (it is still recorded).
        if (!decides(by, userId)) throw fault(403, "forbidden", String(by) === String(userId) ? "Your manager or an owner has to decide your own request" : "Only that person's manager or an owner can decide this");
        const existing = grantRow(id, userId);
        if (!existing) throw fault(404, "not_found", "That person hasn't asked for this entitlement");
        // Access is handed down, never made up: a manager passes on only what they were granted themselves.
        if (decision === "grant" && !isOwner(by) && !holds(id, by)) throw fault(403, "not_held", `You can only grant what you hold yourself. Ask for ${entitlement.name} first, or leave this one to an owner`);
        if (decision === "revoke" ? existing.status !== "granted" : existing.status !== "requested") {
          throw fault(409, "conflict", decision === "revoke" ? "That person doesn't hold this entitlement" : "That request was already answered");
        }
        const status = decision === "grant" ? "granted" : decision === "deny" ? "denied" : "revoked";
        const clean = line(reason, 300);
        db.prepare("UPDATE grants SET status=?, decided_by=?, decided_at=?, reason=? WHERE entitlement_id=? AND user_id=?").run(status, String(by), clock(), clean || null, entitlement.id, String(userId));
        note(entitlement.id, userId, status, by, clean ? { reason: clean } : {});
        return { entitlement, grant: grantShape(grantRow(id, userId)) };
      });
    },
    /** Someone left the server: everything they held or were waiting on is revoked. */
    forget(userId, by) {
      tx(() => {
        for (const g of db.prepare("SELECT * FROM grants WHERE user_id=? AND status IN ('granted','requested')").all(String(userId))) {
          db.prepare("UPDATE grants SET status='revoked', decided_by=?, decided_at=?, reason='Left the server' WHERE entitlement_id=? AND user_id=?").run(String(by), clock(), g.entitlement_id, g.user_id);
          note(g.entitlement_id, userId, "revoked", by, { reason: "Left the server" });
        }
      });
    },
    /** One person's standing on one entitlement, or null when they never asked. */
    grant: (id, userId) => grantShape(grantRow(id, userId)) || null,
    /** Everyone's standing on one entitlement, people waiting first. */
    grants: id => db.prepare("SELECT * FROM grants WHERE entitlement_id=? ORDER BY CASE status WHEN 'requested' THEN 0 WHEN 'granted' THEN 1 ELSE 2 END, requested_at").all(String(id)).map(grantShape),
    /** What one person holds right now. */
    held: userId => db.prepare("SELECT e.* FROM grants g JOIN entitlements e ON e.id=g.entitlement_id WHERE g.user_id=? AND g.status='granted' AND e.retired_at IS NULL ORDER BY e.name COLLATE NOCASE").all(String(userId)).map(shape),
    /** May this person's agent reach this host? Only through an entitlement they hold. */
    allows(userId, host) {
      if (!known(userId)) return false;
      return db.prepare("SELECT e.hosts FROM grants g JOIN entitlements e ON e.id=g.entitlement_id WHERE g.user_id=? AND g.status='granted' AND e.retired_at IS NULL").all(String(userId))
        .some(r => JSON.parse(r.hosts).some(pattern => hostMatches(pattern, host)));
    },
    /** The entitlements that would open this host, for telling someone what to ask for. */
    covering: host => all().filter(e => e.hosts.some(pattern => hostMatches(pattern, host))),
    /** Requests waiting on this person's decision: their reports', or everyone's for an owner. */
    waitingOn(userId) {
      return db.prepare("SELECT g.* FROM grants g JOIN entitlements e ON e.id=g.entitlement_id WHERE g.status='requested' AND e.retired_at IS NULL ORDER BY g.requested_at").all()
        .filter(g => decides(userId, g.user_id)).map(grantShape);
    },
    history: (id, limit = 200) => db.prepare("SELECT * FROM history WHERE entitlement_id=? ORDER BY seq DESC LIMIT ?").all(String(id), Math.max(1, Math.min(1000, limit)))
      .map(h => ({ action: h.action, ...(h.user_id ? { userId: h.user_id } : {}), by: h.by, at: h.at, detail: JSON.parse(h.detail) })),
    close: () => db.close(),
  };
}
