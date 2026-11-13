// Project abbreviations are authored reference material, not generated guesses.
// Keep them beside the records archive so an edit/delete and its preserved copy
// share one SQLite transaction. No wiki or repository URLs are fetched here.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureRecordsSchema, preserve } from "./records-preserve.mjs";

export const MAX_GLOSSARY_ENTRIES = 500;
export const GLOSSARY_LIMITS = { abbreviation: 32, fullName: 200, description: 2000, history: 8000, wikiUrl: 1000, repo: 100 };
const fields = Object.keys(GLOSSARY_LIMITS);
const fault = (status, code, message) => Object.assign(new Error(message), { status, code });
const normalized = text => text.replace(/\s+/g, " ").trim().toLowerCase();
// A new project reusing an old slug must not inherit its predecessor's glossary.
const scopeOf = project => JSON.stringify([project.id, project.createdAt ?? null]);

export function cleanGlossaryEntry(body, previous) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw fault(400, "bad_request", "Give the abbreviation and its full name");
  if (Object.keys(body).some(key => !fields.includes(key))) throw fault(400, "bad_request", "That glossary field is not supported");
  if (previous && !Object.keys(body).length) throw fault(400, "bad_request", "Choose a glossary field to change");
  const result = {};
  for (const key of fields) {
    const value = body[key] === undefined ? previous?.[key] ?? "" : body[key];
    if (typeof value !== "string") throw fault(400, "bad_request", `${key} must be text`);
    if (value.length > GLOSSARY_LIMITS[key]) throw fault(413, "limit", `Keep ${key} under ${GLOSSARY_LIMITS[key]} characters`);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw fault(400, "bad_request", "Remove control characters from the glossary entry");
    result[key] = value.trim();
  }
  result.abbreviation = result.abbreviation.toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._+\/-]*$/.test(result.abbreviation)) throw fault(400, "bad_request", "Use letters, numbers, periods, underscores, plus signs, slashes or hyphens for the abbreviation");
  result.fullName = result.fullName.replace(/\s+/g, " ");
  if (!result.fullName) throw fault(400, "bad_request", "Give the abbreviation its full name");
  if (result.wikiUrl) {
    let url;
    try { url = new URL(result.wikiUrl); } catch { /* rejected below */ }
    if (!url || url.protocol !== "https:" || !url.hostname || url.username || url.password || /\s/.test(result.wikiUrl)) {
      throw fault(400, "bad_request", "Use an https:// wiki link without a username or password");
    }
    result.wikiUrl = url.href;
    if (result.wikiUrl.length > GLOSSARY_LIMITS.wikiUrl) throw fault(413, "limit", "Keep the wiki link under 1000 characters");
  }
  result.repo = result.repo.replace(/^https:\/\/github\.com\//i, "").replace(/\.git$/, "");
  if (result.repo && (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(result.repo) || result.repo.includes(".."))) {
    throw fault(400, "bad_request", "A GitHub repository looks like owner/name");
  }
  return result;
}

export function createGlossaryStore({ file, keepRecords = () => false }) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
  db.exec(`CREATE TABLE IF NOT EXISTS project_glossary (
    id TEXT PRIMARY KEY, project_scope TEXT NOT NULL, abbreviation TEXT NOT NULL,
    full_name_key TEXT NOT NULL, body TEXT NOT NULL, author_id TEXT NOT NULL,
    UNIQUE(project_scope, abbreviation, full_name_key)
  ); CREATE INDEX IF NOT EXISTS project_glossary_scope ON project_glossary(project_scope);`);
  const rows = db.prepare("SELECT * FROM project_glossary WHERE project_scope = ? ORDER BY abbreviation, full_name_key, id");
  const row = db.prepare("SELECT * FROM project_glossary WHERE project_scope = ? AND id = ?");
  const count = db.prepare("SELECT COUNT(*) AS n FROM project_glossary WHERE project_scope = ?");
  const duplicate = db.prepare("SELECT id FROM project_glossary WHERE project_scope = ? AND abbreviation = ? AND full_name_key = ? AND id != ?");
  const insert = db.prepare("INSERT INTO project_glossary (id, project_scope, abbreviation, full_name_key, body, author_id) VALUES (?, ?, ?, ?, ?, ?)");
  const update = db.prepare("UPDATE project_glossary SET abbreviation = ?, full_name_key = ?, body = ? WHERE id = ?");
  const remove = db.prepare("DELETE FROM project_glossary WHERE id = ?");
  const transaction = work => {
    db.exec("BEGIN IMMEDIATE");
    try { const result = work(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  const requireRow = (project, id) => {
    const value = row.get(scopeOf(project), id);
    if (!value) throw fault(404, "not_found", "That abbreviation is no longer in this project. Refresh and try again");
    return value;
  };
  const checkDuplicate = (project, entry, id = "") => {
    if (duplicate.get(scopeOf(project), entry.abbreviation, normalized(entry.fullName), id)) throw fault(409, "duplicate", "This abbreviation already has that meaning. Edit the existing entry instead");
  };
  const keep = (project, stored, actorId, event) => {
    if (!keepRecords()) return;
    const entry = JSON.parse(stored.body);
    try {
      ensureRecordsSchema(db);
      preserve(db, { event, conversation_id: project.id, conversation_kind: "project", conversation_name: project.name ?? null,
        author_id: stored.author_id, actor_id: actorId, text: `${entry.abbreviation}: ${entry.fullName}`, created_at: entry.createdAt,
        detail: { projectScope: stored.project_scope, entry } });
    } catch {
      throw fault(503, "records_preservation_failed", "This abbreviation can't be changed because its record could not be saved. Try again, or ask your administrator");
    }
  };
  return {
    list: project => rows.all(scopeOf(project)).map(value => JSON.parse(value.body)),
    create(project, body, actorId, now = Date.now()) {
      const cleaned = cleanGlossaryEntry(body);
      return transaction(() => {
        if (count.get(scopeOf(project)).n >= MAX_GLOSSARY_ENTRIES) throw fault(409, "limit", `A project can hold ${MAX_GLOSSARY_ENTRIES} abbreviations. Remove an unused entry first`);
        checkDuplicate(project, cleaned);
        const entry = { id: `gls_${crypto.randomBytes(12).toString("base64url")}`, ...cleaned, createdAt: now, updatedAt: now };
        insert.run(entry.id, scopeOf(project), entry.abbreviation, normalized(entry.fullName), JSON.stringify(entry), actorId);
        return entry;
      });
    },
    update(project, id, body, actorId, now = Date.now()) {
      return transaction(() => {
        const stored = requireRow(project, id);
        const previous = JSON.parse(stored.body);
        const cleaned = cleanGlossaryEntry(body, previous);
        checkDuplicate(project, cleaned, id);
        const entry = { ...previous, ...cleaned, updatedAt: now };
        keep(project, stored, actorId, "glossary_entry_edited");
        update.run(entry.abbreviation, normalized(entry.fullName), JSON.stringify(entry), id);
        return entry;
      });
    },
    remove(project, id, actorId) {
      return transaction(() => {
        const stored = requireRow(project, id);
        keep(project, stored, actorId, "glossary_entry_deleted");
        remove.run(id);
      });
    },
    close: () => db.close(),
  };
}
