// Shared text shortcuts. An authored key/value pair is archived in the same
// SQLite transaction before it is edited or deleted when preservation is on.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureRecordsSchema, preserve } from "./records-preserve.mjs";

export const MAX_LEXICON_ENTRIES = 2000;
export const LEXICON_LIMITS = { abbreviation: 32, fullName: 200 };
const fault = (status, code, message) => Object.assign(new Error(message), { status, code });
const normalized = text => text.trim().toUpperCase();
// An entry Agent guessed for an abbreviation someone used before anyone had defined it. It is in the list so the
// sender is never stopped to answer a question, but it is nobody's word yet: it does not expand in anyone's
// message until a person keeps or corrects it, and until then anyone may.
const guessed = row => JSON.parse(row.body).guessed === true;
const canEdit = (row, user) => user.role === "owner" || row.author_id === user.id || guessed(row);

export function cleanLexiconEntry(body, previous) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw fault(400, "bad_request", "Give the shortcut and replacement text");
  if (Object.keys(body).some(key => !Object.hasOwn(LEXICON_LIMITS, key))) throw fault(400, "bad_request", "Only a shortcut and replacement text are supported");
  if (previous && !Object.keys(body).length) throw fault(400, "bad_request", "Choose a shortcut field to change");
  const result = {};
  for (const [key, limit] of Object.entries(LEXICON_LIMITS)) {
    const value = body[key] === undefined ? previous?.[key] ?? "" : body[key];
    if (typeof value !== "string") throw fault(400, "bad_request", `${key} must be text`);
    if (value.length > limit) throw fault(413, "limit", `Keep ${key} under ${limit} characters`);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw fault(400, "bad_request", "Remove control characters from the shortcut");
    result[key] = value.trim();
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._+\/-]*$/.test(result.abbreviation)) throw fault(400, "bad_request", "Use letters, numbers, periods, underscores, plus signs, slashes or hyphens for the shortcut");
  if (!result.fullName) throw fault(400, "bad_request", "Give the shortcut replacement text");
  return result;
}

export function createLexiconStore({ file, keepRecords = () => false }) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS text_shortcuts (
      id TEXT PRIMARY KEY, shortcut_key TEXT NOT NULL UNIQUE,
      body TEXT NOT NULL, author_id TEXT NOT NULL
    );`);
  const row = db.prepare("SELECT * FROM text_shortcuts WHERE id=?");
  const duplicate = db.prepare("SELECT * FROM text_shortcuts WHERE shortcut_key=? AND id!=?");
  const view = (stored, user) => ({ ...JSON.parse(stored.body), canEdit: canEdit(stored, user) });
  const transaction = work => {
    db.exec("BEGIN IMMEDIATE");
    try { const result = work(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  const editable = (id, user) => {
    const stored = row.get(id);
    if (!stored) throw fault(404, "not_found", "That shortcut is no longer available. Refresh and try again");
    if (!canEdit(stored, user)) throw fault(403, "forbidden", "Only the author or an owner can change this shortcut");
    return stored;
  };
  const conflict = () => fault(409, "duplicate", "This shortcut already has different replacement text. Edit the existing shortcut instead");
  const keep = (stored, user, event) => {
    if (!keepRecords()) return;
    const entry = JSON.parse(stored.body);
    try {
      ensureRecordsSchema(db);
      preserve(db, { event, conversation_id: "lexicon", conversation_kind: "lexicon", conversation_name: "Text shortcuts",
        author_id: stored.author_id, actor_id: user.id, text: `${entry.abbreviation}: ${entry.fullName}`,
        created_at: entry.createdAt, detail: { entry } });
    } catch {
      throw fault(503, "records_preservation_failed", "This shortcut can't be changed because its record could not be saved. Try again, or ask your administrator");
    }
  };
  return {
    list: user => db.prepare("SELECT * FROM text_shortcuts ORDER BY shortcut_key,id").all().map(stored => view(stored, user)),
    create(body, user, now = Date.now()) {
      const cleaned = cleanLexiconEntry(body);
      return transaction(() => {
        const existing = duplicate.get(normalized(cleaned.abbreviation), "");
        if (existing) {
          const previous = JSON.parse(existing.body);
          // A person's definition takes the place of Agent's guess, and becomes theirs.
          if (previous.guessed) {
            keep(existing, user, "lexicon_entry_edited");
            const { guessed: _guess, ...kept } = previous;
            const entry = { ...kept, ...cleaned, updatedAt: now };
            db.prepare("UPDATE text_shortcuts SET shortcut_key=?,body=?,author_id=? WHERE id=?").run(normalized(entry.abbreviation), JSON.stringify(entry), user.id, existing.id);
            return view(row.get(existing.id), user);
          }
          if (previous.fullName !== cleaned.fullName) throw conflict();
          return view(existing, user);
        }
        if (db.prepare("SELECT COUNT(*) AS n FROM text_shortcuts").get().n >= MAX_LEXICON_ENTRIES) {
          throw fault(409, "limit", `The server can hold ${MAX_LEXICON_ENTRIES} shortcuts. Remove an unused shortcut first`);
        }
        const entry = { id: `lex_${crypto.randomBytes(12).toString("base64url")}`, ...cleaned, createdAt: now, updatedAt: now };
        db.prepare("INSERT INTO text_shortcuts VALUES (?,?,?,?)")
          .run(entry.id, normalized(entry.abbreviation), JSON.stringify(entry), user.id);
        return view(row.get(entry.id), user);
      });
    },
    /**
     * Agent's guess for an abbreviation nobody has defined. Null when someone got there first or the list is full:
     * a guess never replaces or contradicts what a person wrote.
     */
    guess(abbreviation, fullName, user, now = Date.now()) {
      const cleaned = cleanLexiconEntry({ abbreviation, fullName });
      return transaction(() => {
        if (duplicate.get(normalized(cleaned.abbreviation), "")) return null;
        if (db.prepare("SELECT COUNT(*) AS n FROM text_shortcuts").get().n >= MAX_LEXICON_ENTRIES) return null;
        const entry = { id: `lex_${crypto.randomBytes(12).toString("base64url")}`, ...cleaned, createdAt: now, updatedAt: now, guessed: true };
        db.prepare("INSERT INTO text_shortcuts VALUES (?,?,?,?)").run(entry.id, normalized(entry.abbreviation), JSON.stringify(entry), user.id);
        return view(row.get(entry.id), user);
      });
    },
    update(id, body, user, now = Date.now()) {
      return transaction(() => {
        const stored = editable(id, user);
        const { guessed: wasGuess, ...previous } = JSON.parse(stored.body);
        const cleaned = cleanLexiconEntry(body, previous);
        if (duplicate.get(normalized(cleaned.abbreviation), id)) throw conflict();
        keep(stored, user, "lexicon_entry_edited");
        // Saving a guess, changed or not, makes it a person's: it is no longer marked as one, and it is theirs.
        const entry = { ...previous, ...cleaned, updatedAt: now };
        db.prepare("UPDATE text_shortcuts SET shortcut_key=?,body=?,author_id=? WHERE id=?")
          .run(normalized(entry.abbreviation), JSON.stringify(entry), wasGuess ? user.id : stored.author_id, id);
        return view(row.get(id), user);
      });
    },
    remove(id, user) {
      return transaction(() => {
        const stored = editable(id, user);
        keep(stored, user, "lexicon_entry_deleted");
        db.prepare("DELETE FROM text_shortcuts WHERE id=?").run(id);
      });
    },
    close: () => db.close(),
  };
}
