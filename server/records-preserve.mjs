// Records preservation (docs/records-management.md). When an agency turns on `recordsPreservation`, nothing a person
// authored is destroyed by Servant: before a message is edited or deleted, or a conversation is deleted, the content as it
// stood is copied into an append-only table in the SAME database and the SAME transaction, so the copy and the change
// succeed or fail together. People still see what they expect (the edit shows, the deleted message and conversation
// disappear); the agency keeps the record, and a records officer can export it (`server.mjs records export`).
//
// What this is: a way to stop Servant itself from being the thing that loses a record, with a tamper-evident log.
// What it is not: a records schedule, a legal determination of what is a record, or protection from someone who can
// open the database file (the hash chain makes changes detectable, not impossible). The agency decides all of that.
import crypto from "node:crypto";

export function recordsPreservationEnabled(raw) { return !!raw && typeof raw === "object" && raw.enabled === true; }

const GENESIS = "0".repeat(64);

export function ensureRecordsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS records_archive (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      conversation_kind TEXT,
      conversation_name TEXT,
      message_seq INTEGER,
      thread_root INTEGER,
      author_id TEXT,
      actor_id TEXT,
      text TEXT,
      created_at INTEGER,
      detail TEXT,
      preserved_at INTEGER NOT NULL,
      prev_hash TEXT NOT NULL,
      hash TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS records_archive_conv ON records_archive(conversation_id, id);
    CREATE TABLE IF NOT EXISTS records_archive_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      archive_id INTEGER NOT NULL,
      name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, data BLOB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS records_archive_files_row ON records_archive_files(archive_id);
    CREATE TRIGGER IF NOT EXISTS records_archive_no_update BEFORE UPDATE ON records_archive
      BEGIN SELECT RAISE(ABORT, 'preserved records are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS records_archive_no_delete BEFORE DELETE ON records_archive
      BEGIN SELECT RAISE(ABORT, 'preserved records are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS records_archive_files_no_update BEFORE UPDATE ON records_archive_files
      BEGIN SELECT RAISE(ABORT, 'preserved records are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS records_archive_files_no_delete BEFORE DELETE ON records_archive_files
      BEGIN SELECT RAISE(ABORT, 'preserved records are append-only'); END;
  `);
}

const canonical = (row) => JSON.stringify([row.event, row.conversation_id, row.conversation_kind ?? null, row.conversation_name ?? null, row.message_seq ?? null, row.thread_root ?? null, row.author_id ?? null, row.actor_id ?? null, row.text ?? null, row.created_at ?? null, row.detail ?? null, row.preserved_at]);
const chain = (prev, row) => crypto.createHash("sha256").update(prev).update("\n").update(canonical(row)).digest("hex");

/** Append one preserved entry. Must be called inside the caller's transaction, before the destructive statement. */
export function preserve(db, row, files = [], now = Date.now()) {
  const entry = { detail: null, ...row, preserved_at: now };
  if (entry.detail && typeof entry.detail !== "string") entry.detail = JSON.stringify(entry.detail);
  const prev = db.prepare("SELECT hash FROM records_archive ORDER BY id DESC LIMIT 1").get()?.hash ?? GENESIS;
  const hash = chain(prev, entry);
  const info = db.prepare(`INSERT INTO records_archive (event, conversation_id, conversation_kind, conversation_name, message_seq, thread_root, author_id, actor_id, text, created_at, detail, preserved_at, prev_hash, hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(entry.event, entry.conversation_id, entry.conversation_kind ?? null, entry.conversation_name ?? null, entry.message_seq ?? null, entry.thread_root ?? null,
      entry.author_id ?? null, entry.actor_id ?? null, entry.text ?? null, entry.created_at ?? null, entry.detail, entry.preserved_at, prev, hash);
  const id = Number(info.lastInsertRowid);
  for (const f of files) {
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    db.prepare("INSERT INTO records_archive_files (archive_id, name, mime, size, sha256, data) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, f.name, f.mime, data.length, crypto.createHash("sha256").update(data).digest("hex"), data);
  }
  return id;
}

/** Recompute the chain. { ok, checked, brokenAt }: brokenAt is the first entry that does not match its predecessor. */
export function verifyChain(db) {
  let prev = GENESIS, checked = 0;
  for (const r of db.prepare("SELECT * FROM records_archive ORDER BY id").all()) {
    const ok = r.prev_hash === prev && r.hash === chain(prev, r);
    if (!ok) return { ok: false, checked, brokenAt: r.id };
    prev = r.hash; checked++;
  }
  for (const f of db.prepare("SELECT id, size, sha256, data FROM records_archive_files").all()) {
    const data = Buffer.from(f.data);
    if (data.length !== f.size || crypto.createHash("sha256").update(data).digest("hex") !== f.sha256) return { ok: false, checked, brokenAt: `file ${f.id}` };
  }
  return { ok: true, checked, brokenAt: null };
}

/** Every preserved entry, oldest first, as plain objects (attachments listed, bytes via `files`). */
export function listPreserved(db, { conversationId, since = 0 } = {}) {
  const rows = conversationId
    ? db.prepare("SELECT * FROM records_archive WHERE conversation_id = ? AND id > ? ORDER BY id").all(conversationId, since)
    : db.prepare("SELECT * FROM records_archive WHERE id > ? ORDER BY id").all(since);
  const files = db.prepare("SELECT id, name, mime, size, sha256 FROM records_archive_files WHERE archive_id = ? ORDER BY id");
  return rows.map(r => ({ ...r, detail: r.detail ? JSON.parse(r.detail) : null, files: files.all(r.id) }));
}

export function preservedFile(db, fileId) {
  return db.prepare("SELECT name, mime, data FROM records_archive_files WHERE id = ?").get(fileId);
}
