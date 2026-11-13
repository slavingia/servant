// Self-serve false-alarm reports for the business-information warning (docs/business-info-filter.md, "Learning from
// false alarms"). When the check warns and the sender believes the message is fine, they can send it AND report the
// warning as a false alarm. Reports are a review queue, never training data by themselves:
//   pending  -> the owner reads it (server.mjs business-reports list) and approves or rejects it
//   approved -> exported for the next training run (server.mjs business-reports export); only these are ever trained on
//   rejected -> the text is erased at once; only a hash stays, so the same message is not queued again
// Why a queue and not "every override trains": people press Send anyway for convenience, and a few bad actors could
// teach the check to ignore real secrets. A person with the owner role is the gate.
// This is also a store of message text outside any chat, which is exactly the thing Servant promises not to hold in
// quantity. So it holds as little as it can: only messages the check really flagged, never personal information, a short
// retention for unreviewed items, a per-person daily cap, and a hard cap on the queue. The file is private (0600).
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";

export const MAX_TEXT = 4000;
export const PER_USER_PER_DAY = 20;
export const MAX_PENDING = 2000;
export const PENDING_DAYS = 30;
const DAY = 24 * 60 * 60 * 1000;

const normalize = (t) => String(t).toLowerCase().replace(/\s+/g, " ").trim();
const hashOf = (t) => crypto.createHash("sha256").update(normalize(t)).digest("hex");
const fault = (status, code, message) => Object.assign(new Error(message), { status, code });

/** Called when someone sends past a business warning and ticks "this wasn't sensitive". The server re-checks everything, so a
 * report can only be about a message the check really flagged that holds no personal information. Never throws and
 * never delays or blocks the send. */
export async function reportFalseAlarm({ store, userId, text, verdict, personal }) {
  try {
    const v = await verdict(text);
    if (!v.warned) return { queued: false, reason: "not_flagged" };
    if (await personal(text)) return { queued: false, reason: "personal_information" };
    const out = store().submit({ userId, text, score: v.score });
    return { queued: !out.duplicate, duplicate: out.duplicate };
  } catch (e) {
    return { queued: false, reason: e?.code || "error" };
  }
}

export function reportingEnabled(raw) {
  return !!raw && typeof raw === "object" && raw.enabled === true && raw.businessInfo === true && raw.reportFalseAlarms === true;
}

export function createBusinessReports({ file, now = Date.now, pendingDays = PENDING_DAYS } = {}) {
  const fresh = !fs.existsSync(file);
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000");
  db.exec(`CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, userId TEXT NOT NULL, text TEXT,
    score REAL NOT NULL, status TEXT NOT NULL DEFAULT 'pending', createdAt INTEGER NOT NULL,
    reviewedAt INTEGER, reviewer TEXT, exportedAt INTEGER
  )`);
  db.exec("CREATE INDEX IF NOT EXISTS reports_status ON reports(status, createdAt)");
  if (fresh) try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  const q = (sql) => db.prepare(sql);
  const st = {
    byHash: q("SELECT id, status FROM reports WHERE hash = ?"),
    pending: q("SELECT COUNT(*) AS n FROM reports WHERE status = 'pending'"),
    today: q("SELECT COUNT(*) AS n FROM reports WHERE userId = ? AND createdAt > ?"),
    insert: q("INSERT INTO reports (id, hash, userId, text, score, createdAt) VALUES (?, ?, ?, ?, ?, ?)"),
    get: q("SELECT * FROM reports WHERE id = ?"),
    list: q("SELECT id, userId, text, score, status, createdAt FROM reports WHERE status = ? ORDER BY createdAt LIMIT ?"),
    approve: q("UPDATE reports SET status = 'approved', reviewedAt = ?, reviewer = ? WHERE id = ? AND status = 'pending'"),
    reject: q("UPDATE reports SET status = 'rejected', text = NULL, reviewedAt = ?, reviewer = ? WHERE id = ? AND status = 'pending'"),
    purge: q("DELETE FROM reports WHERE status = 'pending' AND createdAt < ?"),
    approved: q("SELECT id, text, score FROM reports WHERE status = 'approved' ORDER BY createdAt"),
    markExported: q("UPDATE reports SET exportedAt = ? WHERE id = ?"),
    counts: q("SELECT status, COUNT(*) AS n FROM reports GROUP BY status"),
  };
  const sweep = () => { st.purge.run(now() - pendingDays * DAY); };

  return {
    /** One report. The caller has already checked the check really warned and the text has no personal information. */
    submit({ userId, text, score }) {
      sweep();
      const clean = String(text ?? "").trim();
      if (!clean || clean.length > MAX_TEXT) throw fault(400, "bad_report", "That message can't be reported");
      const hash = hashOf(clean);
      const seen = st.byHash.get(hash);
      if (seen) return { id: seen.id, duplicate: true };
      if (st.today.get(userId, now() - DAY).n >= PER_USER_PER_DAY) throw fault(429, "rate_limited", "You've reported a lot today. Try again tomorrow");
      if (st.pending.get().n >= MAX_PENDING) throw fault(503, "queue_full", "The review queue is full right now");
      const id = `rep_${crypto.randomBytes(9).toString("base64url")}`;
      st.insert.run(id, hash, String(userId), clean, Number(score) || 0, now());
      return { id, duplicate: false };
    },
    list(status = "pending", limit = 200) {
      sweep();
      return st.list.all(status, limit).map((r) => ({ id: r.id, userId: r.userId, text: r.text, score: r.score, status: r.status, createdAt: r.createdAt }));
    },
    approve(id, reviewer) { const r = st.approve.run(now(), String(reviewer || "owner"), String(id)); return r.changes === 1; },
    reject(id, reviewer) { const r = st.reject.run(now(), String(reviewer || "owner"), String(id)); return r.changes === 1; },
    /** Approved reports as plain training rows (benign: the check was wrong to warn). */
    exportApproved() {
      const rows = st.approved.all();
      for (const r of rows) st.markExported.run(now(), r.id);
      return rows.map((r) => ({ id: r.id, text: r.text, labels: [], source: "false_alarm_report", score: r.score }));
    },
    counts() { return Object.fromEntries(st.counts.all().map((r) => [r.status, r.n])); },
    close() { db.close(); },
  };
}
