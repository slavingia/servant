// Sharing a prototype with a business owner (docs/prototype-reviews.md). The person who built a prototype types the
// business owner's work email. They get a link by email; after confirming a code sent to that same address they see
// the prototype and can right-click anywhere on it to leave a comment. Each comment is kept here and becomes a
// to-do for the person who shared it.
//
// The business owner is not a member of the server: the link plus a confirmed code opens that one prototype's
// review page and nothing else. Nothing here is deleted: a share is ended, not removed, and comments stay.
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { emailAllowed, normalizeEmail } from "./email-verify.mjs";

export const MAX_COMMENT = 2000;
export const MAX_SHARES_PER_CHAT = 25;
/** A confirmed code lets the reviewer in for this long before another code is needed. */
export const SESSION_MS = 12 * 60 * 60 * 1000;
/** With no allowed domains set on the server, a review can only be shared to a government or military address. */
export const DEFAULT_REVIEW_DOMAINS = ["gov", "mil"];

const fault = (status, code, message) => Object.assign(new Error(message), { status, code });
const hash = value => crypto.createHash("sha256").update(String(value)).digest("hex");
const newId = prefix => `${prefix}_${crypto.randomBytes(9).toString("base64url")}`;
const line = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** The domains a prototype may be shared to: the server's allowed sign-in domains, else .gov and .mil. */
export const reviewDomains = settings => (settings?.domains?.length ? settings.domains : DEFAULT_REVIEW_DOMAINS);

/** "j***@example.gov": enough for the reviewer to know which inbox to look in, without printing the address on a page anyone with the link can open. */
export function maskEmail(email) {
  const [name, host] = String(email).split("@");
  return host ? `${name.slice(0, 1)}***@${host}` : "";
}

/** A page inside the prototype's folder, as the reviewer's browser reported it: "index.html", "plans/compare.html". */
export function cleanPage(value, folder) {
  let page = String(value ?? "");
  const prefix = `/p/${folder}/`;
  if (page.startsWith(prefix)) page = page.slice(prefix.length);
  page = page.replace(/[?#].*$/, "");
  if (!page || page.endsWith("/")) page += "index.html";
  if (page.length > 200 || !/^[A-Za-z0-9._\-/]+$/.test(page) || page.split("/").some(part => !part || part.startsWith("."))) return "index.html";
  return page;
}
const fraction = value => { const n = Number(value); return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0; };

export function createPrototypeReviews(file, { clock = Date.now } = {}) {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout=5000");
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS shares (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, chat_id TEXT NOT NULL, folder TEXT NOT NULL, title TEXT NOT NULL, email TEXT NOT NULL,
      created_by TEXT NOT NULL, created_at INTEGER NOT NULL, verified_at INTEGER, last_seen_at INTEGER, ended_at INTEGER, ended_by TEXT);
    CREATE INDEX IF NOT EXISTS shares_chat ON shares(chat_id);
    CREATE TABLE IF NOT EXISTS sessions (secret_hash TEXT PRIMARY KEY, share_id TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, share_id TEXT NOT NULL, chat_id TEXT NOT NULL, email TEXT NOT NULL, page TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL,
      anchor TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, todo_id TEXT);
    CREATE INDEX IF NOT EXISTS comments_chat ON comments(chat_id, created_at);
    CREATE TRIGGER IF NOT EXISTS comments_no_delete BEFORE DELETE ON comments BEGIN SELECT RAISE(ABORT, 'review comments are kept'); END;`);
  const shareView = r => r && ({ id: r.id, chatId: r.chat_id, folder: r.folder, title: r.title, email: r.email, createdBy: r.created_by, createdAt: r.created_at,
    ...(r.verified_at ? { verifiedAt: r.verified_at } : {}), ...(r.last_seen_at ? { lastSeenAt: r.last_seen_at } : {}), ...(r.ended_at ? { endedAt: r.ended_at } : {}) });
  const commentView = r => ({ id: r.id, shareId: r.share_id, chatId: r.chat_id, email: r.email, page: r.page, x: r.x, y: r.y, anchor: r.anchor, text: r.text, createdAt: r.created_at, ...(r.todo_id ? { todoId: r.todo_id } : {}) });
  const live = row => (row && !row.ended_at ? row : null);

  return {
    /**
     * Share one chat's prototype with one address. Sharing again to the same address makes a fresh link and ends the
     * old one, so a link that went astray can be replaced. Returns the share and the secret for its link, which is
     * only ever in the email.
     */
    share({ chatId, folder, title, email, by, domains }) {
      const clean = normalizeEmail(email);
      if (!clean) throw fault(400, "email_invalid", "Enter the business owner's work email");
      if (!emailAllowed(clean, domains)) throw fault(403, "email_not_allowed", `Use an email that ends in ${domains.map(d => (d.includes(".") ? "@" + d : "." + d)).join(" or ")}`);
      const now = clock();
      db.exec("BEGIN IMMEDIATE");
      try {
        const open = db.prepare("SELECT * FROM shares WHERE chat_id=? AND ended_at IS NULL").all(String(chatId));
        if (open.filter(s => s.email !== clean).length >= MAX_SHARES_PER_CHAT) throw fault(400, "bad_request", `A prototype can be shared with up to ${MAX_SHARES_PER_CHAT} people. End a share to add another`);
        for (const old of open.filter(s => s.email === clean)) {
          db.prepare("UPDATE shares SET ended_at=?, ended_by=? WHERE id=?").run(now, String(by), old.id);
          db.prepare("DELETE FROM sessions WHERE share_id=?").run(old.id);
        }
        const id = newId("rev"), token = crypto.randomBytes(24).toString("base64url");
        db.prepare("INSERT INTO shares(id,token_hash,chat_id,folder,title,email,created_by,created_at) VALUES (?,?,?,?,?,?,?,?)").run(id, hash(token), String(chatId), String(folder), line(title, 120) || "Prototype", clean, String(by), now);
        db.exec("COMMIT");
        return { share: shareView(db.prepare("SELECT * FROM shares WHERE id=?").get(id)), token };
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    },
    /** The share a link belongs to, or null when the link is unknown or was ended. */
    byToken(token) { return shareView(live(db.prepare("SELECT * FROM shares WHERE token_hash=?").get(hash(token || "")))) || null; },
    get(id) { return shareView(db.prepare("SELECT * FROM shares WHERE id=?").get(String(id))) || null; },
    /** Everyone a chat's prototype was shared with, newest first, ended ones included (they still have comments). */
    forChat(chatId) { return db.prepare("SELECT * FROM shares WHERE chat_id=? ORDER BY created_at DESC, rowid DESC").all(String(chatId)).map(shareView); },
    /** End a share: its link and every session stop working. The comments stay. */
    end(id, chatId, by) {
      const changed = db.prepare("UPDATE shares SET ended_at=?, ended_by=? WHERE id=? AND chat_id=? AND ended_at IS NULL").run(clock(), String(by), String(id), String(chatId)).changes > 0;
      if (changed) db.prepare("DELETE FROM sessions WHERE share_id=?").run(String(id));
      return changed;
    },
    /** The chat was deleted, or its person left: every share of it ends. */
    endChat(chatId, by) {
      for (const s of db.prepare("SELECT id FROM shares WHERE chat_id=? AND ended_at IS NULL").all(String(chatId))) this.end(s.id, chatId, by);
    },
    /** The reviewer confirmed the code: a secret their browser keeps for this visit. Only its hash is stored. */
    startSession(shareId) {
      const now = clock();
      const secret = crypto.randomBytes(24).toString("base64url");
      db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now);
      db.prepare("INSERT INTO sessions(secret_hash,share_id,created_at,expires_at) VALUES (?,?,?,?)").run(hash(secret), String(shareId), now, now + SESSION_MS);
      db.prepare("UPDATE shares SET verified_at=COALESCE(verified_at, ?), last_seen_at=? WHERE id=?").run(now, now, String(shareId));
      return { secret, expiresAt: now + SESSION_MS };
    },
    /** The share this link and session open, or null: wrong link, ended share, or a session that is missing, expired or for another share. */
    session(token, secret) {
      const share = live(db.prepare("SELECT * FROM shares WHERE token_hash=?").get(hash(token || "")));
      if (!share || !secret) return null;
      const row = db.prepare("SELECT * FROM sessions WHERE secret_hash=? AND share_id=? AND expires_at>=?").get(hash(secret), share.id, clock());
      if (!row) return null;
      db.prepare("UPDATE shares SET last_seen_at=? WHERE id=?").run(clock(), share.id);
      return shareView(share);
    },
    /** A comment at a point on a page: where (as a share of the page's width and height), the words under the pointer, and what they wrote. */
    comment(share, { page, x, y, anchor, text }) {
      const words = String(text ?? "").replace(/\r\n?/g, "\n").trim();
      if (!words) throw fault(400, "bad_request", "Write your comment first");
      if (words.length > MAX_COMMENT) throw fault(400, "bad_request", `A comment can be up to ${MAX_COMMENT.toLocaleString("en-US")} characters`);
      const id = newId("cmt");
      db.prepare("INSERT INTO comments(id,share_id,chat_id,email,page,x,y,anchor,text,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(id, share.id, share.chatId, share.email, cleanPage(page, share.folder), fraction(x), fraction(y), line(anchor, 120), words, clock());
      return commentView(db.prepare("SELECT * FROM comments WHERE id=?").get(id));
    },
    /** Remember which to-do a comment became. */
    linkTodo(commentId, todoId) { db.prepare("UPDATE comments SET todo_id=? WHERE id=?").run(String(todoId), String(commentId)); },
    /** Every comment on a chat's prototype, oldest first; or only one share's (what that reviewer sees: their own). */
    comments({ chatId, shareId }) {
      const rows = shareId ? db.prepare("SELECT * FROM comments WHERE share_id=? ORDER BY created_at, rowid").all(String(shareId))
        : db.prepare("SELECT * FROM comments WHERE chat_id=? ORDER BY created_at, rowid").all(String(chatId));
      return rows.map(commentView);
    },
    close: () => db.close(),
  };
}
