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

/**
 * Built-in entitlements: on every server, asked for by use rather than by hand. The first time someone's agent is
 * about to read or change files, or read or change GitHub, the person's manager is asked and can allow it once or
 * always. Write covers read. The GitHub pair also opens GitHub's hosts through the network gate.
 */
const GITHUB_HOSTS = ["github.com", "*.github.com", "*.githubusercontent.com"];
export const NATIVE = [
  { id: "native-fs-read", capability: "fs-read", name: "Filesystem read", description: "The agent may read files on the server's computer for this person", hosts: [] },
  { id: "native-fs-write", capability: "fs-write", name: "Filesystem write", description: "The agent may create, change and delete files and run commands that could, for this person. Covers reading", hosts: [], covers: "fs-read" },
  { id: "native-github-read", capability: "github-read", name: "GitHub read", description: "The agent may read repositories, issues and pull requests on GitHub for this person", hosts: GITHUB_HOSTS },
  { id: "native-github-write", capability: "github-write", name: "GitHub write", description: "The agent may push, open and merge pull requests, and change issues on GitHub for this person. Covers reading", hosts: GITHUB_HOSTS, covers: "github-read" },
];
/**
 * Social media (docs/social.md): built in like the four above, but asked for by hand like any other, and it opens
 * no hosts. Holding it lets a person approve what the team's account posts; the server posts, never the agent.
 */
export const SOCIAL_ENTITLEMENT = { id: "native-social", capability: "social", name: "Social media", description: "This person may approve replies and posts that go out from the team's social media account", hosts: [] };
const nativeFor = capability => NATIVE.find(n => n.capability === capability) || null;
/** How long the hosts of a built-in entitlement stay open after an "allow once" is used, so the one action can finish. */
export const ONCE_WINDOW_MS = 10 * 60_000;

/** `"agentCapabilities"` in config.json. Off unless mode is exactly "ask". */
export function capabilitySettings(raw) {
  const cfg = raw && typeof raw === "object" ? raw : {};
  const wait = Number(cfg.waitSeconds);
  return { mode: cfg.mode === "ask" ? "ask" : "off",
    // How long the agent waits for the manager's answer before it tells the person it is waiting. 0: don't wait.
    waitSeconds: Number.isFinite(wait) && wait >= 0 ? Math.min(900, Math.floor(wait)) : 120 };
}

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
  // Added with built-in entitlements: which capability an entitlement stands for, how a request was made ("ask" by the
  // person, "use" by their agent), what the agent was about to do, and when an "allow once" was used.
  const columns = table => db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!columns("entitlements").includes("capability")) db.exec("ALTER TABLE entitlements ADD COLUMN capability TEXT");
  for (const [name, type] of [["via", "TEXT"], ["detail", "TEXT"], ["used_at", "INTEGER"]]) if (!columns("grants").includes(name)) db.exec(`ALTER TABLE grants ADD COLUMN ${name} ${type}`);
  for (const n of [...NATIVE, SOCIAL_ENTITLEMENT]) {
    db.prepare("INSERT OR IGNORE INTO entitlements(id,name,description,hosts,confirmation,created_by,created_at,updated_at,capability) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(n.id, n.name, n.description, JSON.stringify(n.hosts), "", "server", clock(), clock(), n.capability);
  }
  // What agents did or were stopped from doing, one line per checked tool call. Never changed or deleted.
  db.exec(`CREATE TABLE IF NOT EXISTS actions (seq INTEGER PRIMARY KEY, user_id TEXT NOT NULL, chat_id TEXT, needs TEXT NOT NULL, verdict TEXT NOT NULL, detail TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS actions_user ON actions(user_id, seq);
    CREATE TRIGGER IF NOT EXISTS actions_no_update BEFORE UPDATE ON actions BEGIN SELECT RAISE(ABORT, 'the agent action log is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS actions_no_delete BEFORE DELETE ON actions BEGIN SELECT RAISE(ABORT, 'the agent action log is append-only'); END;`);
  const tx = fn => { db.exec("BEGIN IMMEDIATE"); try { const out = fn(); db.exec("COMMIT"); return out; } catch (error) { db.exec("ROLLBACK"); throw error; } };
  const note = (entitlementId, userId, action, by, detail = {}) =>
    db.prepare("INSERT INTO history(entitlement_id,user_id,action,by,at,detail) VALUES (?,?,?,?,?,?)").run(entitlementId, userId ?? null, action, String(by), clock(), JSON.stringify(detail));
  const shape = r => r && ({ id: r.id, name: r.name, description: r.description, hosts: JSON.parse(r.hosts), confirmation: r.confirmation || DEFAULT_CONFIRMATION,
    createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at, ...(r.capability ? { native: true, capability: r.capability, ...(r.capability === SOCIAL_ENTITLEMENT.capability ? { byRequest: true } : {}) } : {}), ...(r.retired_at ? { retiredAt: r.retired_at } : {}) });
  const grantShape = r => r && ({ entitlementId: r.entitlement_id, userId: r.user_id, status: r.status, note: r.note, requestedAt: r.requested_at,
    ...(r.via === "use" ? { via: "use", ...(r.detail ? { detail: r.detail } : {}) } : {}),
    ...(r.decided_by ? { decidedBy: r.decided_by, decidedAt: r.decided_at } : {}), ...(r.reason ? { reason: r.reason } : {}) });
  const row = id => db.prepare("SELECT * FROM entitlements WHERE id=?").get(String(id));
  const live = id => { const r = row(id); if (!r || r.retired_at) throw fault(404, "not_found", "No such entitlement"); return shape(r); };
  const grantRow = (id, userId) => db.prepare("SELECT * FROM grants WHERE entitlement_id=? AND user_id=?").get(String(id), String(userId));
  // Built-in ones first, then the server's own, each A to Z.
  const all = () => db.prepare("SELECT * FROM entitlements WHERE retired_at IS NULL ORDER BY capability IS NULL, name COLLATE NOCASE").all().map(shape);
  /** May `by` decide what `userId` holds? Owners for anyone (themselves included); a manager for the people they manage. */
  const decides = (by, userId) => !!by && known(by) && (isOwner(by) || (String(by) !== String(userId) && manages(by, userId)));
  // Holding a built-in "write" also counts as holding its "read".
  const holds = (id, userId) => grantRow(id, userId)?.status === "granted" || NATIVE.some(n => n.covers && nativeFor(n.covers)?.id === id && grantRow(n.id, userId)?.status === "granted");

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
        if (current.native && "name" in patch && cleanEntitlementName(patch.name) !== current.name) throw fault(400, "bad_request", "A built-in entitlement keeps its name");
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
      return tx(() => { const current = live(id); if (current.native) throw fault(400, "bad_request", "A built-in entitlement can't be retired. Turn the check off in config.json instead");
        db.prepare("UPDATE entitlements SET retired_at=?,updated_at=? WHERE id=?").run(clock(), clock(), current.id); note(current.id, null, "retired", by); return true; });
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
        db.prepare(`INSERT INTO grants(entitlement_id,user_id,status,note,confirmation,requested_at,via) VALUES (?,?,'requested',?,?,?,'ask')
          ON CONFLICT(entitlement_id, user_id) DO UPDATE SET status='requested', note=excluded.note, confirmation=excluded.confirmation,
            requested_at=excluded.requested_at, decided_by=NULL, decided_at=NULL, reason=NULL, via='ask', detail=NULL, used_at=NULL`).run(entitlement.id, String(userId), clean, entitlement.confirmation, clock());
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
      if (!["grant", "once", "deny", "revoke"].includes(decision)) throw fault(400, "bad_request", "decision is grant, once, deny or revoke");
      return tx(() => {
        const entitlement = live(id);
        // An owner is where trust on the server starts, so an owner may answer their own request (it is still recorded).
        if (!decides(by, userId)) throw fault(403, "forbidden", String(by) === String(userId) ? "Your manager or an owner has to decide your own request" : "Only that person's manager or an owner can decide this");
        const existing = grantRow(id, userId);
        if (!existing) throw fault(404, "not_found", "That person hasn't asked for this entitlement");
        // Access is handed down, never made up: a manager passes on only what they were granted themselves.
        if ((decision === "grant" || decision === "once") && !isOwner(by) && !holds(id, by)) throw fault(403, "not_held", `You can only grant what you hold yourself. Ask for ${entitlement.name} first, or leave this one to an owner`);
        // "Allow once" is for a built-in entitlement the agent asked for by use: that one action goes ahead, the next asks again.
        if (decision === "once" && (!entitlement.native || entitlement.byRequest)) throw fault(400, "bad_request", "Only a built-in entitlement can be allowed once");
        if (decision === "revoke" ? existing.status !== "granted" : existing.status !== "requested") {
          throw fault(409, "conflict", decision === "revoke" ? "That person doesn't hold this entitlement" : "That request was already answered");
        }
        const status = decision === "grant" ? "granted" : decision === "once" ? "once" : decision === "deny" ? "denied" : "revoked";
        const clean = line(reason, 300);
        db.prepare("UPDATE grants SET status=?, decided_by=?, decided_at=?, reason=? WHERE entitlement_id=? AND user_id=?").run(status, String(by), clock(), clean || null, entitlement.id, String(userId));
        note(entitlement.id, userId, status, by, clean ? { reason: clean } : {});
        return { entitlement, grant: grantShape(grantRow(id, userId)) };
      });
    },
    /**
     * The agent is about to use a built-in entitlement for someone. "allow" when they hold it (or its "write"), or an
     * "allow once" is waiting, which this uses up. "deny" after a refusal, until the person asks again themselves.
     * Otherwise "wait": a request is on file for their manager (`fresh` the first time, which is when to tell them).
     * `detail` is one line about what the agent was about to do, for the manager; it is kept with the request.
     * With `consume: false` an "allow once" is reported but left in place, so an action that needs several
     * entitlements doesn't spend one before it is known the others are allowed too.
     */
    use(userId, capability, detail = "", { consume = true } = {}) {
      const native = nativeFor(capability);
      if (!native) throw fault(400, "bad_request", "No such built-in entitlement");
      return tx(() => {
        const entitlement = live(native.id);
        if (!known(userId)) return { verdict: "deny", entitlement };
        if (holds(native.id, userId)) return { verdict: "allow", entitlement };
        const existing = grantRow(native.id, userId);
        if (existing?.status === "once") {
          if (!consume) return { verdict: "allow", entitlement, once: true };
          db.prepare("UPDATE grants SET status='used', used_at=? WHERE entitlement_id=? AND user_id=?").run(clock(), native.id, String(userId));
          note(native.id, userId, "used", userId, existing.detail ? { detail: existing.detail } : {});
          return { verdict: "allow", entitlement, once: true };
        }
        if (existing?.status === "denied") return { verdict: "deny", entitlement };
        const clean = line(detail, 300);
        if (existing?.status === "requested") {
          // The latest thing the agent tried is what the manager should see.
          if (clean && existing.via === "use" && clean !== existing.detail) db.prepare("UPDATE grants SET detail=? WHERE entitlement_id=? AND user_id=?").run(clean, native.id, String(userId));
          return { verdict: "wait", entitlement, fresh: false };
        }
        db.prepare(`INSERT INTO grants(entitlement_id,user_id,status,note,confirmation,requested_at,via,detail) VALUES (?,?,'requested','','',?,'use',?)
          ON CONFLICT(entitlement_id, user_id) DO UPDATE SET status='requested', note='', confirmation='', requested_at=excluded.requested_at,
            decided_by=NULL, decided_at=NULL, reason=NULL, via='use', detail=excluded.detail, used_at=NULL`).run(native.id, String(userId), clock(), clean);
        note(native.id, userId, "requested", userId, { via: "use", ...(clean ? { detail: clean } : {}) });
        return { verdict: "wait", entitlement, fresh: true };
      });
    },
    /**
     * One line in the agent action log: whose agent, in which chat, what it was about to do, which built-in
     * entitlements that needed, and what happened ("allowed", "allowed-once", "allowed-owner", "denied", "waiting").
     */
    logAction({ userId, chatId, needs = [], verdict, detail = "" }) {
      db.prepare("INSERT INTO actions(user_id,chat_id,needs,verdict,detail,at) VALUES (?,?,?,?,?,?)").run(String(userId), chatId ? String(chatId) : null, JSON.stringify(needs), String(verdict), line(detail, 300), clock());
    },
    /** The log, newest first: everyone's, or one person's; `before` pages back from a line's number. */
    actions({ userId, before, limit = 100 } = {}) {
      const rows = db.prepare(`SELECT * FROM actions WHERE (? IS NULL OR user_id=?) AND (? IS NULL OR seq<?) ORDER BY seq DESC LIMIT ?`)
        .all(userId ?? null, userId ?? null, before ?? null, before ?? null, Math.max(1, Math.min(500, Number(limit) || 100)));
      return rows.map(r => ({ seq: r.seq, userId: r.user_id, ...(r.chat_id ? { chatId: r.chat_id } : {}), needs: JSON.parse(r.needs), verdict: r.verdict, detail: r.detail, at: r.at }));
    },
    /** Someone left the server: everything they held or were waiting on is revoked. */
    forget(userId, by) {
      tx(() => {
        for (const g of db.prepare("SELECT * FROM grants WHERE user_id=? AND status IN ('granted','requested','once')").all(String(userId))) {
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
      // Granted, or an "allow once" that was just used: its hosts stay open long enough for that one action to finish.
      return db.prepare("SELECT e.hosts FROM grants g JOIN entitlements e ON e.id=g.entitlement_id WHERE g.user_id=? AND e.retired_at IS NULL AND (g.status='granted' OR (g.status='used' AND g.used_at>=?))")
        .all(String(userId), clock() - ONCE_WINDOW_MS).some(r => JSON.parse(r.hosts).some(pattern => hostMatches(pattern, host)));
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
    /** Whether this person holds an entitlement right now (a built-in "write" counts as its "read"). */
    holds: (id, userId) => known(userId) && holds(id, userId),
    close: () => db.close(),
  };
}
