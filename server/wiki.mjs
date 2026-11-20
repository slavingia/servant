// The team's wiki: a tree of pages, each a title and Markdown text that anyone on the server can read and edit.
// A page's title or text is authored content, so when records preservation is on the previous version is
// archived in the same SQLite transaction before an edit or a delete; if that copy cannot be saved, nothing changes.
//
// Abbreviations (text shortcuts) appear in the app as a page of the wiki, but stay in their own store
// (lexicon.mjs): they are structured pairs that expand as people type, not Markdown.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureRecordsSchema, preserve } from "./records-preserve.mjs";

export const WIKI_LIMITS = { pages: 1000, title: 120, body: 100_000, depth: 6 };
const fault = (status, code, message) => Object.assign(new Error(message), { status, code });
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const ID = /^wiki_[A-Za-z0-9_-]{16}$/;

function text(value, name, limit, { required = false, oneLine = false } = {}) {
  if (typeof value !== "string") throw fault(400, "bad_request", `The page's ${name} must be text`);
  if (CONTROL.test(value) || (oneLine && /[\r\n\t]/.test(value))) throw fault(400, "bad_request", `Remove control characters from the page's ${name}`);
  const cleaned = oneLine ? value.trim() : value.replace(/\r\n?/g, "\n");
  if (cleaned.length > limit) throw fault(413, "limit", `Keep the page's ${name} under ${limit.toLocaleString("en-US")} characters`);
  if (required && !cleaned) throw fault(400, "bad_request", `Give the page a ${name}`);
  return cleaned;
}
function fields(body, allowed) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw fault(400, "bad_request", "Send the page's title, text or parent");
  const unknown = Object.keys(body).find(key => !allowed.includes(key));
  if (unknown) throw fault(400, "bad_request", `A page has no "${unknown.slice(0, 40)}" to set`);
  return body;
}
const parentOf = body => {
  if (body.parentId === undefined || body.parentId === null) return null;
  if (typeof body.parentId !== "string" || !ID.test(body.parentId)) throw fault(400, "bad_request", "Choose a page to put this one under");
  return body.parentId;
};

export function createWikiStore({ file, keepRecords = () => false, names = () => ({}) }) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS wiki_pages (
      id TEXT PRIMARY KEY, parent_id TEXT REFERENCES wiki_pages(id), title TEXT NOT NULL, body TEXT NOT NULL,
      position INTEGER NOT NULL, author_id TEXT NOT NULL, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS wiki_pages_parent ON wiki_pages(parent_id, position);`);
  // A marked page is one a part of Servant reads: the social media guide (social-draft.mjs) is the page Agent
  // writes replies from. It is read and changed like any page; it can't be deleted while it is marked.
  if (!db.prepare("PRAGMA table_info(wiki_pages)").all().some(column => column.name === "kind")) db.exec("ALTER TABLE wiki_pages ADD COLUMN kind TEXT");
  const row = id => typeof id === "string" && ID.test(id) ? db.prepare("SELECT * FROM wiki_pages WHERE id=?").get(id) : undefined;
  const found = id => row(id) || (() => { throw fault(404, "not_found", "That page is no longer in the wiki. Go back to the list of pages"); })();
  const canDelete = (stored, user) => user.role === "owner" || stored.author_id === user.id;
  const summary = (stored, user) => ({ id: stored.id, parentId: stored.parent_id, title: stored.title, position: stored.position,
    createdAt: stored.created_at, updatedAt: stored.updated_at, updatedByName: names()[stored.updated_by] || null, version: stored.version, canDelete: !stored.kind && canDelete(stored, user),
    ...(stored.kind ? { kind: stored.kind } : {}) });
  const full = (stored, user) => ({ ...summary(stored, user), body: stored.body });
  const transaction = work => {
    db.exec("BEGIN IMMEDIATE");
    try { const result = work(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  // How many pages sit above this one, and how many levels hang below it.
  const depthOf = id => { let depth = 0; for (let at = id; at; at = row(at)?.parent_id) depth += 1; return depth; };
  const heightOf = id => 1 + Math.max(0, ...db.prepare("SELECT id FROM wiki_pages WHERE parent_id=?").all(id).map(child => heightOf(child.id)));
  const nextPosition = parentId => db.prepare("SELECT coalesce(max(position),0)+1 AS n FROM wiki_pages WHERE parent_id IS ?").get(parentId).n;
  const keep = (stored, user, event) => {
    if (!keepRecords()) return;
    try {
      ensureRecordsSchema(db);
      preserve(db, { event, conversation_id: "wiki", conversation_kind: "wiki", conversation_name: "Wiki",
        author_id: stored.updated_by, actor_id: user.id, text: `# ${stored.title}\n\n${stored.body}`, created_at: stored.updated_at,
        detail: { page: { id: stored.id, parentId: stored.parent_id, title: stored.title, version: stored.version, authorId: stored.author_id, createdAt: stored.created_at, updatedAt: stored.updated_at } } });
    } catch {
      throw fault(503, "records_preservation_failed", "This page can't be changed because its record could not be saved. Try again, or ask your administrator");
    }
  };
  return {
    /** Every page without its text, for the tree. */
    list: user => db.prepare("SELECT id,parent_id,title,position,author_id,created_at,updated_at,updated_by,version,kind FROM wiki_pages ORDER BY position,created_at,id").all().map(stored => summary(stored, user)),
    get: (id, user) => full(found(id), user),
    create(body, user, now = Date.now()) {
      const input = fields(body, ["title", "body", "parentId"]);
      const title = text(input.title ?? "", "title", WIKI_LIMITS.title, { required: true, oneLine: true });
      const content = text(input.body ?? "", "text", WIKI_LIMITS.body);
      const parentId = parentOf(input);
      return transaction(() => {
        if (parentId && !row(parentId)) throw fault(404, "not_found", "The page this one would sit under is no longer in the wiki. Choose another");
        if (depthOf(parentId) + 1 > WIKI_LIMITS.depth) throw fault(409, "limit", `Pages can nest ${WIKI_LIMITS.depth} levels deep. Add this one higher up`);
        if (db.prepare("SELECT count(*) AS n FROM wiki_pages").get().n >= WIKI_LIMITS.pages) throw fault(409, "limit", `The wiki can hold ${WIKI_LIMITS.pages.toLocaleString("en-US")} pages. Delete one that is no longer needed first`);
        const id = `wiki_${crypto.randomBytes(12).toString("base64url")}`;
        db.prepare("INSERT INTO wiki_pages (id,parent_id,title,body,position,author_id,created_at,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,?)")
          .run(id, parentId, title, content, nextPosition(parentId), user.id, now, now, user.id);
        return full(row(id), user);
      });
    },
    /** Change the title, the text or where the page sits. `version` is the one the person was looking at. */
    update(id, body, user, now = Date.now()) {
      const input = fields(body, ["title", "body", "parentId", "version"]);
      if (!["title", "body", "parentId"].some(key => key in input)) throw fault(400, "bad_request", "Change the page's title, text or parent");
      return transaction(() => {
        const stored = found(id);
        if (input.version !== undefined && input.version !== stored.version) {
          throw Object.assign(fault(409, "stale", `${names()[stored.updated_by] || "Someone"} changed this page while you were editing. Copy your changes, reload the page, then add them again`), { page: full(stored, user) });
        }
        const title = "title" in input ? text(input.title, "title", WIKI_LIMITS.title, { required: true, oneLine: true }) : stored.title;
        const content = "body" in input ? text(input.body, "text", WIKI_LIMITS.body) : stored.body;
        const parentId = "parentId" in input ? parentOf(input) : stored.parent_id;
        const moved = parentId !== stored.parent_id;
        if (moved) {
          if (parentId && !row(parentId)) throw fault(404, "not_found", "The page this one would sit under is no longer in the wiki. Choose another");
          for (let at = parentId; at; at = row(at)?.parent_id) if (at === id) throw fault(409, "cycle", "A page can't sit under itself or one of its own subpages");
          if (depthOf(parentId) + heightOf(id) > WIKI_LIMITS.depth) throw fault(409, "limit", `Pages can nest ${WIKI_LIMITS.depth} levels deep. Move this one higher up`);
        }
        const written = title !== stored.title || content !== stored.body;
        if (!written && !moved) return full(stored, user);
        // Only what someone wrote is a record; moving a page changes neither its title nor its text.
        if (written) keep(stored, user, "wiki_page_edited");
        db.prepare("UPDATE wiki_pages SET title=?,body=?,parent_id=?,position=?,updated_at=?,updated_by=?,version=version+1 WHERE id=?")
          .run(title, content, parentId, moved ? nextPosition(parentId) : stored.position, written ? now : stored.updated_at, written ? user.id : stored.updated_by, id);
        return full(row(id), user);
      });
    },
    remove(id, user) {
      return transaction(() => {
        const stored = found(id);
        if (stored.kind) throw fault(409, "marked", "Servant reads this page, so it can't be deleted. Ask Agent to change what it says instead");
        if (!canDelete(stored, user)) throw fault(403, "forbidden", "Only the person who made this page or an owner can delete it");
        if (db.prepare("SELECT 1 FROM wiki_pages WHERE parent_id=? LIMIT 1").get(id)) throw fault(409, "has_subpages", "This page has subpages. Move or delete them first");
        keep(stored, user, "wiki_page_deleted");
        db.prepare("DELETE FROM wiki_pages WHERE id=?").run(id);
      });
    },
    /** The marked page of a kind, with its text, or null when there is none yet. */
    marked(kind, user = { id: "server", role: "member" }) {
      const stored = db.prepare("SELECT * FROM wiki_pages WHERE kind=? ORDER BY created_at LIMIT 1").get(String(kind));
      return stored ? full(stored, user) : null;
    },
    /** The marked page of a kind, made from `start` the first time it is wanted. It sits at the top and counts toward no limit. */
    ensureMarked(kind, start, now = Date.now()) {
      return transaction(() => {
        const existing = db.prepare("SELECT * FROM wiki_pages WHERE kind=? ORDER BY created_at LIMIT 1").get(String(kind));
        if (existing) return full(existing, { id: "server", role: "member" });
        const id = `wiki_${crypto.randomBytes(12).toString("base64url")}`;
        db.prepare("INSERT INTO wiki_pages (id,parent_id,title,body,position,author_id,created_at,updated_at,updated_by,kind) VALUES (?,?,?,?,?,?,?,?,?,?)")
          .run(id, null, text(start.title, "title", WIKI_LIMITS.title, { required: true, oneLine: true }), text(start.body, "text", WIKI_LIMITS.body), nextPosition(null), "server", now, now, "server", String(kind));
        return full(row(id), { id: "server", role: "member" });
      });
    },
    close: () => db.close(),
  };
}
