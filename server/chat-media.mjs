import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import { normalizeMediaContent, mediaCaption } from "./media.mjs";

const uid = prefix => `${prefix}_${crypto.randomBytes(12).toString("base64url")}`;
const signature = (role, text, attachments) => mediaCaption(text) + (role === "user"
  ? `:${[...new Set(attachments.map(a => crypto.createHash("sha256").update(a.data).digest("hex")))].join(",")}` : "");
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const inputKey = (text, attachments) => `input:${hash(signature("user", text, attachments))}`;
function sourceKey(content, attachments) {
  const serialized = typeof content === "string" ? content : JSON.stringify(content ?? "");
  const paths = serialized.match(/MEDIA:\s*[^\n]+/gi);
  if (paths?.length) return `media:${hash(paths.join("\n"))}`;
  return attachments.length ? `image:${[...new Set(attachments.map(a => hash(a.data)))].join(",")}` : "";
}
const timestamp = value => {
  if (typeof value === "number") return value < 1e12 ? value * 1000 : value;
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
};

// Mirrors only visible user/assistant messages, never tool calls, secrets, or
// reasoning. The upstream remains the conversation source; this keeps delivery
// media which Hermes resolves in its stream but not in its history response.
export function createChatMediaStore(file) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS chat_messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      chat_id TEXT NOT NULL, upstream_id TEXT, role TEXT NOT NULL,
      text TEXT NOT NULL, at INTEGER NOT NULL, signature TEXT NOT NULL, source_key TEXT NOT NULL DEFAULT '',
      UNIQUE(chat_id, upstream_id)
    );
    CREATE INDEX IF NOT EXISTS chat_messages_chat ON chat_messages(chat_id,seq);
    CREATE TABLE IF NOT EXISTS chat_attachments (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
      name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chat_attachments_message ON chat_attachments(message_id);
    CREATE TABLE IF NOT EXISTS chat_history_sync (
      chat_id TEXT PRIMARY KEY, generation INTEGER NOT NULL
    );`);
  if (!db.prepare("PRAGMA table_info(chat_messages)").all().some(c => c.name === "source_key")) {
    db.exec("ALTER TABLE chat_messages ADD COLUMN source_key TEXT NOT NULL DEFAULT ''");
  }
  const files = db.prepare("SELECT id,name,mime,size FROM chat_attachments WHERE message_id=? ORDER BY rowid");
  const view = row => ({ id: row.id, role: row.role, text: row.text, at: row.at, attachments: files.all(row.id) });
  function transaction(fn) {
    db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); db.exec("COMMIT"); return result; }
    catch (e) { db.exec("ROLLBACK"); throw e; }
  }
  function insert(chatId, role, text, attachments, at = Date.now(), upstreamId = null, key = sourceKey(text, attachments), stableId) {
    const id = stableId || uid("msg");
    db.prepare("INSERT INTO chat_messages(id,chat_id,upstream_id,role,text,at,signature,source_key) VALUES (?,?,?,?,?,?,?,?)")
      .run(id, chatId, upstreamId, role, text, at, signature(role, text, attachments), key);
    for (const a of attachments) db.prepare("INSERT INTO chat_attachments VALUES (?,?,?,?,?,?)")
      .run(uid("chatfile"), id, a.name, a.mime, a.data.length, a.data);
    return view(db.prepare("SELECT * FROM chat_messages WHERE id=?").get(id));
  }
  function accept(chatId, role, text, attachments = [], deliveryKey) {
    return transaction(() => {
      const stableId = deliveryKey ? `msg_${hash(`${chatId}:${role}:${deliveryKey}`).slice(0, 32)}` : undefined;
      const existing = stableId && db.prepare("SELECT * FROM chat_messages WHERE id=?").get(stableId);
      return existing ? view(existing) : insert(chatId, role, text, attachments, Date.now(), null, sourceKey(text, attachments), stableId);
    });
  }
  function identify(messageId, content) {
    const normalized = normalizeMediaContent(content);
    db.prepare("UPDATE chat_messages SET source_key=? WHERE id=? AND upstream_id IS NULL")
      .run(sourceKey(content, normalized.attachments), messageId);
  }
  function identifyInput(messageId, content) {
    // Hermes normalizes text-only arrays to a string. Fingerprint normalized
    // content so video notices bind to the original user row and stored bytes.
    const normalized = normalizeMediaContent(content);
    db.prepare("UPDATE chat_messages SET source_key=? WHERE id=? AND role='user' AND upstream_id IS NULL")
      .run(inputKey(normalized.text, normalized.attachments), messageId);
  }
  function beginSync(chatId) {
    return db.prepare(`INSERT INTO chat_history_sync(chat_id,generation) VALUES (?,1)
      ON CONFLICT(chat_id) DO UPDATE SET generation=generation+1 RETURNING generation`).get(chatId).generation;
  }
  function sync(chatId, raw, generation) {
    return transaction(() => {
      // Fetches can finish out of order, including across API processes during
      // deployment. Never let an older snapshot delete or rebind newer media.
      if (generation !== undefined && db.prepare("SELECT generation FROM chat_history_sync WHERE chat_id=?").get(chatId)?.generation !== generation) {
        return db.prepare("SELECT * FROM chat_messages WHERE chat_id=? ORDER BY at,seq").all(chatId).map(view);
      }
      const result = [];
      const found = new Set();
      const occurrences = new Map();
      for (const message of Array.isArray(raw) ? raw : []) {
        if (!message || !["user", "assistant"].includes(message.role)) continue;
        const normalized = normalizeMediaContent(message.content ?? message.text, message.attachments);
        if (!normalized.text && !normalized.attachments.length) continue;
        const identity = hash(JSON.stringify([message.role, message.content ?? message.text, message.attachments]));
        const occurrence = (occurrences.get(identity) || 0) + 1;
        occurrences.set(identity, occurrence);
        const upstreamId = String(message.id ?? `content:${identity}:${occurrence}`);
        found.add(upstreamId);
        const key = sourceKey(message.content ?? message.text, normalized.attachments);
        let row = db.prepare("SELECT * FROM chat_messages WHERE chat_id=? AND upstream_id=?").get(chatId, upstreamId);
        if (!row) {
          if (message.role === "user") row = db.prepare("SELECT * FROM chat_messages WHERE chat_id=? AND upstream_id IS NULL AND role='user' AND source_key=? ORDER BY seq LIMIT 1")
            .get(chatId, inputKey(normalized.text, normalized.attachments));
          const pending = db.prepare("SELECT * FROM chat_messages WHERE chat_id=? AND upstream_id IS NULL AND role=? AND signature=? ORDER BY seq")
            .all(chatId, message.role, signature(message.role, normalized.text, normalized.attachments));
          row ??= pending.find(candidate => candidate.source_key === key);
          // Older compatible servers may omit run.completed. Fall back only
          // when a caption has one possible pending delivery, never guess
          // between different images carrying the same caption.
          if (!row && pending.length === 1 && key.startsWith("media:") && pending[0].source_key.startsWith("image:")) row = pending[0];
          if (row) {
            db.prepare("UPDATE chat_messages SET upstream_id=? WHERE id=?").run(upstreamId, row.id);
          } else if (normalized.text || normalized.attachments.length) {
            const created = insert(chatId, message.role, normalized.text, normalized.attachments, timestamp(message.timestamp ?? message.created_at), upstreamId, key);
            row = db.prepare("SELECT * FROM chat_messages WHERE id=?").get(created.id);
          }
        }
        if (row) result.push(view(row));
      }
      // The endpoint supplies the full resolved history. Previously confirmed
      // rows that disappear must not remain downloadable from a stale gallery.
      for (const row of db.prepare("SELECT id,upstream_id FROM chat_messages WHERE chat_id=? AND upstream_id IS NOT NULL").all(chatId)) {
        if (!found.has(row.upstream_id)) db.prepare("DELETE FROM chat_messages WHERE id=?").run(row.id);
      }
      // An accepted message is still visible if Hermes fails before persisting
      // its history, or if its history endpoint lags behind the stream.
      result.push(...db.prepare("SELECT * FROM chat_messages WHERE chat_id=? AND upstream_id IS NULL ORDER BY seq").all(chatId).map(view));
      return result;
    });
  }
  function media(chatId, sender, agentName = "Agent") {
    return db.prepare(`SELECT a.id,a.name,a.mime,a.size,m.id AS messageId,m.role,m.at AS createdAt,m.text
      FROM chat_attachments a JOIN chat_messages m ON m.id=a.message_id
      WHERE m.chat_id=? ORDER BY m.at,m.seq,a.rowid`).all(chatId).map(({ role, ...item }) => ({ ...item, sender: role === "assistant" ? { id: "agent", name: agentName, agent: true } : sender }));
  }
  return {
    accept, identify, identifyInput, beginSync, sync, media,
    history: chatId => db.prepare("SELECT * FROM chat_messages WHERE chat_id=? ORDER BY at,seq").all(chatId).map(view),
    last: chatId => { const row = db.prepare("SELECT * FROM chat_messages WHERE chat_id=? ORDER BY at DESC,seq DESC LIMIT 1").get(chatId); return row ? view(row) : null; },
    attachment: id => db.prepare("SELECT a.*,m.chat_id FROM chat_attachments a JOIN chat_messages m ON m.id=a.message_id WHERE a.id=?").get(id),
    deleteChat: chatId => db.prepare("DELETE FROM chat_messages WHERE chat_id=?").run(chatId),
    close: () => db.close(),
  };
}
