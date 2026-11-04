// Channels, direct messages and threads. People talk to each other here; the
// agent joins in when someone mentions @s.
//
// Storage is node:sqlite (built into Node, so the server still has no npm
// dependencies). People (users) live in the server's state.db; this module only
// stores their ids.

import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isMention } from "./push.mjs";
import { validateUploads, mediaPage, rasterMime, MAX_UPLOAD_BODY, MAX_UPLOAD_TOTAL } from "./media.mjs";

// The app sends a 512px square JPEG (well under this).
const MAX_PHOTO_BYTES = 1024 * 1024;
const MAX_PHOTO_BODY = Math.ceil(MAX_PHOTO_BYTES / 3) * 4 + 1024;
import { sourceDeviceKind, sourceDeviceFields } from "./source-device.mjs";

export const AGENT_ID = "agent";
// A private one-to-one conversation between a person and the agent. The agent answers
// every message here without being @mentioned, and each person has one.
export const agentDmKey = userId => `agent:${userId}`;
export const cleanSuggestions = list => (Array.isArray(list) ? list : []).map(x => String(x ?? "").replace(/\s+/g, " ").trim().slice(0, 60)).filter(Boolean).slice(0, 4);
const parseSuggestions = text => { try { return cleanSuggestions(JSON.parse(text)); } catch { return []; } };
export const WELCOME_SUGGESTIONS = ["Show me around", "Summarize a document", "Draft a message", "Plan my week"];
const isAgentDm = conv => conv?.kind === "dm" && typeof conv.dm_key === "string" && conv.dm_key.startsWith("agent:");
const MAX_TEXT = 8000;
const CALL_PUSH_MS = 45_000; // matches how long the app rings
// Every build's notes go here, one post per build, so testers can see what
// changed and talk about it in that post's thread.
export const RELEASES_CHANNEL = "whats-new";
const PAGE = 50;
const PRESENCE_LEASE_MS = 60000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('channel', 'dm')),
  name TEXT,
  topic TEXT NOT NULL DEFAULT '',
  private INTEGER NOT NULL DEFAULT 0,
  dm_key TEXT UNIQUE,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS channel_name ON conversations(name) WHERE kind = 'channel';
CREATE TABLE IF NOT EXISTS members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  archived_at INTEGER,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS members_user ON members(user_id);
-- One-time notices already posted (so a restart never repeats them).
CREATE TABLE IF NOT EXISTS messaging_notes (name TEXT PRIMARY KEY);
-- Someone who leaves a public channel stays out: everyone-joins-everything skips them.
CREATE TABLE IF NOT EXISTS channel_leaves (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  left_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  thread_root INTEGER REFERENCES messages(seq),
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted_at INTEGER,
  reply_count INTEGER NOT NULL DEFAULT 0,
  last_reply_at INTEGER,
  pending INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS messages_conv ON messages(conversation_id, thread_root, seq);
CREATE TABLE IF NOT EXISTS message_reads (
  message_seq INTEGER NOT NULL REFERENCES messages(seq) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  read_at INTEGER NOT NULL,
  PRIMARY KEY (message_seq, user_id),
  FOREIGN KEY (conversation_id, user_id) REFERENCES members(conversation_id, user_id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS people_presence (
  user_id TEXT PRIMARY KEY,
  last_seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS profile_photos (
  user_id TEXT PRIMARY KEY,
  mime TEXT NOT NULL,
  data BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS presence_sessions (
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, session_id)
);
CREATE INDEX IF NOT EXISTS presence_expiry ON presence_sessions(expires_at);
CREATE TABLE IF NOT EXISTS reactions (
  message_seq INTEGER NOT NULL REFERENCES messages(seq) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  emoji TEXT NOT NULL,
  PRIMARY KEY (message_seq, user_id, emoji)
);
CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  message_seq INTEGER NOT NULL REFERENCES messages(seq) ON DELETE CASCADE,
  name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS attachments_message ON attachments(message_seq);
CREATE TABLE IF NOT EXISTS releases (
  build TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS live_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL,
  event TEXT NOT NULL,
  payload TEXT NOT NULL,
  recipients TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_threads (
  key TEXT PRIMARY KEY,
  hermes_session_id TEXT NOT NULL,
  last_seen_seq INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS agent_jobs (
  trigger_seq INTEGER PRIMARY KEY REFERENCES messages(seq) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','working','done','interrupted','cancelled')),
  owner TEXT,
  reply_seq INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_jobs_pending ON agent_jobs(status, created_at);
CREATE TABLE IF NOT EXISTS notification_outbox (
  id TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

const now = () => Date.now();
const newId = (p) => `${p}_${crypto.randomBytes(9).toString("base64url")}`;

// Slack-style channel names: lowercase, digits, dashes.
export function channelName(input) {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/^#/, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

// When @s is asked for real work in a channel or DM, the agent opens a shared agent chat for it
// instead of working in the thread. It says so with this hidden line, which Servant replaces
// with a link to the new chat.
export const WORK_CHAT_TAG = /\n?<servant-chat>([\s\S]{1,200}?)<\/servant-chat>\s*$/;
export const WORK_CHAT_INSTRUCTIONS = "If this needs real work (several steps, running tools, changing code or files, or research longer than a quick answer), " +
  "don't do it here. Reply with one short sentence saying you'll take it to a shared agent chat, then end with a line exactly " +
  "<servant-chat>Short title of the work</servant-chat>. Quick questions: just answer, with no tag.";
export function splitWorkChat(text) {
  const m = String(text || "").match(WORK_CHAT_TAG);
  return m ? { text: String(text).slice(0, m.index).trimEnd(), title: m[1].replace(/\s+/g, " ").trim().slice(0, 80) } : { text: String(text || ""), title: null };
}

export function mentionsAgent(text, agentName = "") {
  const t = String(text);
  // @s is how people call the agent; @agent from older messages still works.
  if (/(^|[^\w@])@(s|agent)(?![\p{L}\p{N}_-])/iu.test(t)) return true;
  const n = agentName.trim().split(/\s+/)[0];
  return !!n && new RegExp(`(^|[^\\w@])@${n.replace(/[^\w]/g, "")}\\b`, "i").test(t);
}

// Mentioning the agent once is enough: it keeps listening to the rest of that
// thread. A reply that @mentions only other people is a side conversation and
// doesn't wake it.
/** In channels and group DMs the agent is never a participant: it answers only when @mentioned. */
export function agentShouldReply(text, agentName = "") {
  return mentionsAgent(text, agentName);
}

// The agent sees the mention plus the message just before it. If that isn't enough, it can ask
// for more once with this hidden line, and Servant sends the earlier messages.
export const MORE_CONTEXT_TAG = /^\s*<servant-more-context\s*\/?>\s*$/;
export const MORE_CONTEXT_INSTRUCTIONS = "You only see the message that mentioned you and the one before it. " +
  "If you truly can't answer without more of the conversation, reply with exactly <servant-more-context/> and nothing else; you'll get the earlier messages.";

/**
 * @param {object} o
 * @param {string} o.file          sqlite file
 * @param {() => Record<string, {id:string,name:string,role:string}>} o.users  current people
 * @param {() => string} o.agentName
 * @param {(o:{sessionId:string, sessionKey:string, text:string, attachments:Array, onDelta:(t:string)=>void, onStatus:(t:string)=>void}) => Promise<string|{text:string,attachments:Array}>} o.askAgent
 */
export function createMessaging({ file, users, agentName, askAgent, onMessage = () => {}, externalWorker = false, onUsage = () => {}, messageExtras = () => null, startWorkChat = null }) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON');
  // Serializing schema checks avoids two starting versions racing ALTER TABLE.
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(SCHEMA);
    if (!db.prepare("PRAGMA table_info(members)").all().some(column => column.name === "archived_at")) {
      db.exec("ALTER TABLE members ADD COLUMN archived_at INTEGER");
    }
    if (!db.prepare("PRAGMA table_info(members)").all().some(column => column.name === "position")) {
      db.exec("ALTER TABLE members ADD COLUMN position INTEGER");
    }
    if (!db.prepare("PRAGMA table_info(messages)").all().some(column => column.name === "activity")) {
      db.exec("ALTER TABLE messages ADD COLUMN activity TEXT");
    }
    if (!db.prepare('PRAGMA table_info(messages)').all().some(value => value.name === 'suggestions')) {
      db.exec('ALTER TABLE messages ADD COLUMN suggestions TEXT');
    }
    for (const column of ['source_device_kind', 'source_device_id']) {
      if (!db.prepare('PRAGMA table_info(messages)').all().some(value => value.name === column)) {
        db.exec(`ALTER TABLE messages ADD COLUMN ${column} TEXT`);
      }
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }

  // SQLite's built-in lower() only folds ASCII. Match literal Unicode text
  // consistently for channels, names, and messages; %, _, and quotes stay text.
  const searchText = value => String(value ?? "").normalize("NFKC").toLowerCase();
  db.function("search_contains", { deterministic: true }, (text, query) => searchText(text).includes(query) ? 1 : 0);

  let inTransaction = false;
  let committedCallbacks = [];
  function afterCommit(fn) {
    if (inTransaction) committedCallbacks.push(fn);
    else fn();
  }
  function transaction(fn) {
    if (inTransaction) return fn();
    db.exec('BEGIN IMMEDIATE');
    inTransaction = true;
    committedCallbacks = [];
    let result;
    let callbacks;
    try {
      result = fn();
      db.exec('COMMIT');
      callbacks = committedCallbacks;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    } finally { inTransaction = false; committedCallbacks = []; }
    // A subscriber failure must not make an already committed write look failed.
    for (const callback of callbacks) {
      try { callback(); } catch { console.warn('[servant] live subscriber failed'); }
    }
    return result;
  }
  function notifyMessage(messageId, call = null) {
    const event = { kind: 'message', messageId: String(messageId), ...(call ? { call: { id: String(call.id), by: String(call.by) } } : {}) };
    db.prepare('INSERT OR IGNORE INTO notification_outbox VALUES (?, ?, ?)').run(`message:${messageId}`, JSON.stringify(event), now());
    if (!externalWorker) afterCommit(() => {
      onMessage(event);
      db.prepare('DELETE FROM notification_outbox WHERE id = ?').run(`message:${messageId}`);
    });
  }
  // Enqueue and acknowledge use separate databases. Push enqueue must retain an
  // idempotency receipt after send, so a crash between these steps is harmless.
  function drainOutbox(enqueue, limit = 100) {
    const rows = db.prepare('SELECT * FROM notification_outbox ORDER BY created_at LIMIT ?').all(limit);
    for (const row of rows) {
      enqueue(JSON.parse(row.event));
      db.prepare('DELETE FROM notification_outbox WHERE id = ?').run(row.id);
    }
    return rows.length;
  }
  const q = (sql) => db.prepare(sql);
  const st = {
    reads: q("SELECT user_id AS userId, read_at AS readAt FROM message_reads WHERE message_seq = ? ORDER BY read_at, user_id"),
    addRead: q("INSERT OR IGNORE INTO message_reads (message_seq, conversation_id, user_id, read_at) VALUES (?, ?, ?, ?)"),
    read: q("SELECT read_at FROM message_reads WHERE message_seq = ? AND user_id = ?"),
    lastSeen: q("SELECT last_seen_at FROM people_presence WHERE user_id = ?"),
    photoVersion: q("SELECT updated_at FROM profile_photos WHERE user_id = ?"),
    photo: q("SELECT mime, data, updated_at FROM profile_photos WHERE user_id = ?"),
    setPhoto: q("INSERT INTO profile_photos VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at"),
    removePhoto: q("DELETE FROM profile_photos WHERE user_id = ?"),
    activePresence: q("SELECT 1 FROM presence_sessions WHERE user_id = ? AND expires_at > ? LIMIT 1"),
    touchPresence: q("INSERT INTO people_presence VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET last_seen_at = MAX(last_seen_at, excluded.last_seen_at)"),
    touchSession: q("INSERT INTO presence_sessions VALUES (?, ?, ?) ON CONFLICT(user_id, session_id) DO UPDATE SET expires_at = excluded.expires_at"),
    endSession: q("DELETE FROM presence_sessions WHERE user_id = ? AND session_id = ?"),
    expiredSessions: q("SELECT DISTINCT user_id FROM presence_sessions WHERE expires_at <= ?"),
    expireSessions: q("DELETE FROM presence_sessions WHERE expires_at <= ?"),
    reactions: q("SELECT emoji, user_id FROM reactions WHERE message_seq = ? ORDER BY emoji, user_id"),
    addReaction: q("INSERT OR IGNORE INTO reactions VALUES (?, ?, ?)"),
    removeReaction: q("DELETE FROM reactions WHERE message_seq = ? AND user_id = ? AND emoji = ?"),
    deleteReactions: q("DELETE FROM reactions WHERE message_seq = ?"),
    attachments: q("SELECT id, name, mime, size FROM attachments WHERE message_seq = ?"),
    attachment: q("SELECT * FROM attachments WHERE id = ?"),
    insertAttachment: q("INSERT INTO attachments VALUES (?, ?, ?, ?, ?, ?)"),
    deleteAttachments: q("DELETE FROM attachments WHERE message_seq = ?"),
    conv: q("SELECT * FROM conversations WHERE id = ?"),
    convByName: q("SELECT * FROM conversations WHERE kind = 'channel' AND name = ?"),
    convByDm: q("SELECT * FROM conversations WHERE dm_key = ?"),
    insertConv: q("INSERT INTO conversations (id, kind, name, topic, private, dm_key, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
    member: q("SELECT * FROM members WHERE conversation_id = ? AND user_id = ?"),
    members: q("SELECT user_id FROM members WHERE conversation_id = ?"),
    addMember: q("INSERT OR IGNORE INTO members (conversation_id, user_id, joined_at, last_read_seq) VALUES (?, ?, ?, ?)"),
    removeMember: q("DELETE FROM members WHERE conversation_id = ? AND user_id = ?"),
    lastSeq: q("SELECT COALESCE(MAX(seq), 0) AS seq FROM messages WHERE conversation_id = ?"),
    insertMsg: q("INSERT INTO messages (conversation_id, user_id, thread_root, text, created_at, pending, source_device_kind, source_device_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
    insertActivity: q("INSERT INTO messages (conversation_id, user_id, text, created_at, activity) VALUES (?, ?, ?, ?, ?)"),
    msg: q("SELECT * FROM messages WHERE seq = ?"),
    bumpThread: q("UPDATE messages SET reply_count = reply_count + 1, last_reply_at = ? WHERE seq = ?"),
    page: q(`SELECT * FROM messages WHERE conversation_id = ? AND thread_root IS NULL AND seq < ? ORDER BY seq DESC LIMIT ?`),
    replies: q("SELECT * FROM messages WHERE thread_root = ? ORDER BY seq ASC"),
    setText: q("UPDATE messages SET text = ?, edited_at = ? WHERE seq = ?"),
    setAgentText: q("UPDATE messages SET text = ?, pending = ? WHERE seq = ?"),
    softDelete: q("UPDATE messages SET text = '', deleted_at = ? WHERE seq = ?"),
    markRead: q("UPDATE members SET last_read_seq = MAX(last_read_seq, ?) WHERE conversation_id = ? AND user_id = ?"),
    mine: q(`SELECT c.*, m.last_read_seq,
               (SELECT COUNT(*) FROM messages x WHERE x.conversation_id = c.id AND x.thread_root IS NULL
                  AND x.seq > m.last_read_seq AND x.user_id != m.user_id AND x.deleted_at IS NULL AND x.activity IS NULL) AS unread,
               (SELECT MAX(seq) FROM messages x WHERE x.conversation_id = c.id AND x.thread_root IS NULL) AS last_seq
             FROM conversations c JOIN members m ON m.conversation_id = c.id
             WHERE m.user_id = ? AND c.archived_at IS NULL AND (m.archived_at IS NULL OR ? = 1)`),
    browse: q(`SELECT c.*, (SELECT COUNT(*) FROM members m WHERE m.conversation_id = c.id) AS member_count
               FROM conversations c WHERE c.kind = 'channel' AND c.private = 0 AND c.archived_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM members m WHERE m.conversation_id = c.id AND m.user_id = ?)
               ORDER BY c.name`),
    browsePage: q(`SELECT c.*, (SELECT COUNT(*) FROM members m WHERE m.conversation_id = c.id) AS member_count
               FROM conversations c WHERE c.kind = 'channel' AND c.private = 0 AND c.archived_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM members m WHERE m.conversation_id = c.id AND m.user_id = ?)
               AND (c.name > ? OR (c.name = ? AND c.id > ?))
               ORDER BY c.name, c.id LIMIT ?`),
    searchChannels: q(`SELECT c.*, m.user_id AS joined_user, m.archived_at AS member_archived_at,
               (SELECT COUNT(*) FROM members x WHERE x.conversation_id = c.id) AS member_count
             FROM conversations c LEFT JOIN members m ON m.conversation_id = c.id AND m.user_id = ?
             WHERE c.kind = 'channel' AND c.archived_at IS NULL AND (c.private = 0 OR m.user_id IS NOT NULL)
               AND (search_contains(c.name, ?) OR search_contains(c.topic, ?))
             ORDER BY m.archived_at IS NOT NULL, m.user_id IS NULL, c.name, c.id LIMIT 10`),
    searchMessages: q(`SELECT x.*, c.kind AS conversation_kind, c.name AS conversation_name
             FROM messages x JOIN conversations c ON c.id = x.conversation_id
             JOIN members m ON m.conversation_id = c.id AND m.user_id = ?
             WHERE c.archived_at IS NULL AND x.deleted_at IS NULL AND x.pending = 0 AND x.activity IS NULL
               AND search_contains(x.text, ?)
             ORDER BY x.seq DESC LIMIT 20`),
    memberCount: q("SELECT COUNT(*) AS n FROM members WHERE conversation_id = ?"),
    updateConv: q("UPDATE conversations SET name = ?, topic = ? WHERE id = ?"),
    archive: q("UPDATE conversations SET archived_at = ? WHERE id = ?"),
    archiveMember: q("UPDATE members SET archived_at = ? WHERE conversation_id = ? AND user_id = ?"),
    setPosition: q("UPDATE members SET position = ? WHERE conversation_id = ? AND user_id = ?"),
    deleteConv: q("DELETE FROM conversations WHERE id = ?"),
    deleteAgentThreads: q("DELETE FROM agent_threads WHERE substr(key, 1, length(?) + 1) = ? || ':'"),
    publicChannels: q("SELECT id FROM conversations WHERE kind = 'channel' AND private = 0 AND archived_at IS NULL AND name = 'general'"),
    // Every open public channel this person isn't in and hasn't left.
    channelsToJoin: q(`SELECT * FROM conversations c WHERE c.kind = 'channel' AND c.private = 0 AND c.archived_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM members m WHERE m.conversation_id = c.id AND m.user_id = ?)
      AND NOT EXISTS (SELECT 1 FROM channel_leaves l WHERE l.conversation_id = c.id AND l.user_id = ?)`),
    noteLeave: q("INSERT OR REPLACE INTO channel_leaves VALUES (?, ?, ?)"),
    clearLeave: q("DELETE FROM channel_leaves WHERE conversation_id = ? AND user_id = ?"),
    agentThread: q("SELECT * FROM agent_threads WHERE key = ?"),
    activeAgentThread: q(`SELECT 1 FROM messages m LEFT JOIN agent_jobs j ON j.trigger_seq = m.seq
      WHERE m.conversation_id = ? AND (m.seq = ? OR m.thread_root = ?) AND m.deleted_at IS NULL
        AND (m.user_id = 'agent' OR (j.trigger_seq IS NOT NULL AND j.status != 'cancelled')) LIMIT 1`),
    putAgentThread: q("INSERT INTO agent_threads (key, hermes_session_id, last_seen_seq) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET last_seen_seq = excluded.last_seen_seq"),
    release: q("SELECT * FROM releases WHERE build = ?"),
    releaseBySeq: q("SELECT * FROM releases WHERE seq = ?"),
    latestRelease: q("SELECT * FROM releases ORDER BY created_at DESC, seq DESC LIMIT 1"),
    putRelease: q("INSERT INTO releases (build, seq, created_at) VALUES (?, ?, ?)"),
    since: q(`SELECT * FROM messages WHERE conversation_id = ? AND seq > ? AND seq <= ? AND deleted_at IS NULL AND pending = 0 AND activity IS NULL
              AND ((? IS NULL AND thread_root IS NULL) OR thread_root = ? OR seq = ?) ORDER BY seq DESC LIMIT 20`),
  };

  const eventInsert = q("INSERT INTO live_events (conversation_id, event, payload, recipients, created_at) VALUES (?, ?, ?, ?, ?)");
  const eventPage = q("SELECT * FROM live_events WHERE id > ? AND id <= ? ORDER BY id LIMIT 250");
  const eventHead = () => Number(q("SELECT seq FROM sqlite_sequence WHERE name = 'live_events'").get()?.seq || 0);
  const eventFloor = () => Number(q("SELECT MIN(id) AS id FROM live_events").get().id || eventHead() + 1);
  const EVENT_HISTORY = 10000;
  const MAX_REPLAY = 2000;

  // ----- live events -----
  /** @type {Map<string, Set<(event:string, data:any)=>void>>} */
  const listeners = new Map();
  const eventStreams = new Set();
  let closingEvents = false;
  const agentTasks = new Set();
  const whenIdle = async () => {
    while (agentTasks.size) await Promise.allSettled([...agentTasks]);
  };
  const closeEvents = () => {
    closingEvents = true;
    for (const end of eventStreams) end();
  };
  function subscribe(userId, fn) {
    if (!listeners.has(userId)) listeners.set(userId, new Set());
    listeners.get(userId).add(fn);
    return () => listeners.get(userId)?.delete(fn);
  }
  // Last typing relay per conversation+person, so a chatty phone can't flood the others.
  const TYPING_MIN_GAP_MS = 2000;
  const typingSent = new Map();
  function resolveEvent(row, userId) {
    if (!users()[userId] || !JSON.parse(row.recipients).includes(userId)) return null;
    if (row.event === 'presence.updated') {
      const { userId: subject } = JSON.parse(row.payload);
      return users()[subject] ? presence(subject) : null;
    }
    if (row.event === 'person.updated') {
      const { userId: subject } = JSON.parse(row.payload);
      return users()[subject] ? person(subject) : null;
    }
    // Invalidation contains only an already-known ID and must survive leave/delete.
    if (row.event === 'conversation.updated') return { id: row.conversation_id };
    const conv = st.conv.get(row.conversation_id);
    if (!conv || conv.archived_at || !st.member.get(conv.id, userId)) return null;
    const data = JSON.parse(row.payload);
    if (row.event.startsWith('message.')) {
      const message = st.msg.get(Number(data.messageId));
      return message && message.conversation_id === conv.id ? msgView(message, true, userId) : null;
    }
    if (row.event === 'typing') {
      if (now() - row.created_at > 6000 || !users()[data.userId] || !st.member.get(conv.id, data.userId)) return null;
      return { conversationId: conv.id, threadRoot: data.threadRoot, user: person(data.userId) };
    }
    if (row.event === 'messages.read') {
      if (!users()[data.userId] || !st.member.get(conv.id, data.userId)) return null;
      const messageIds = data.messageIds.filter(id => {
        const m = st.msg.get(Number(id));
        return m && m.conversation_id === conv.id && !m.deleted_at && !m.pending && !m.activity
          && m.user_id !== AGENT_ID && m.user_id !== data.userId
          && st.read.get(m.seq, data.userId)?.read_at === data.readAt;
      });
      return messageIds.length ? { conversationId: conv.id, userId: data.userId, messageIds, readAt: data.readAt } : null;
    }
    if (row.event === 'conversation.read') return { id: conv.id };
    return null;
  }
  function publish(conversationId, event, data, onlyUserIds) {
    return transaction(() => {
      const ids = [...new Set(onlyUserIds || st.members.all(conversationId).map(r => r.user_id))];
      // Store references, never an old copy of text or attachments which may
      // subsequently be edited/deleted or become inaccessible to a recipient.
      const payload = event.startsWith('message.') ? { messageId: data.id }
        : event === 'typing' ? { userId: data.user.id, threadRoot: data.threadRoot }
        : event === 'messages.read' ? { userId: data.userId, messageIds: data.messageIds, readAt: data.readAt }
        : event === 'presence.updated' || event === 'person.updated' ? { userId: data.userId } : {};
      const at = now();
      const id = Number(eventInsert.run(conversationId, event, JSON.stringify(payload), JSON.stringify(ids), at).lastInsertRowid);
      db.prepare('DELETE FROM live_events WHERE id <= ?').run(id - EVENT_HISTORY);
      const row = { id, conversation_id: conversationId, event, payload: JSON.stringify(payload), recipients: JSON.stringify(ids), created_at: at };
      afterCommit(() => {
        for (const uid of ids) {
          const value = resolveEvent(row, uid);
          if (value) for (const fn of listeners.get(uid) || []) fn(event, value);
        }
      });
      return id;
    });
  }

  // ----- views -----
  function presence(userId) {
    return { userId, lastSeenAt: st.lastSeen.get(userId)?.last_seen_at ?? null, online: !!st.activePresence.get(userId, now()) };
  }
  function publishPresence(userId) {
    publish('', 'presence.updated', { userId }, Object.keys(users()));
  }
  // Expiration is serialized in the shared database: two API processes cannot
  // emit duplicate offline transitions, and a crash cannot leave someone online.
  function expirePresence() {
    const at = now();
    if (!st.expiredSessions.all(at).length) return;
    transaction(() => {
      const expired = st.expiredSessions.all(at);
      st.expireSessions.run(at);
      for (const { user_id: id } of expired) if (users()[id] && !st.activePresence.get(id, at)) publishPresence(id);
    });
  }
  const person = (uid) => {
    if (uid === AGENT_ID) return { id: AGENT_ID, name: agentName(), agent: true };
    const u = users()[uid];
    const { lastSeenAt, online } = presence(uid);
    // photo is a version; the app fetches the image once per version.
    const photo = u && st.photoVersion.get(uid)?.updated_at;
    return u ? { id: u.id, name: u.name, lastSeenAt, online, ...(photo ? { photo: String(photo) } : {}) } : { id: uid, name: "Former member" };
  };
  const msgView = (m, includeReads = true, viewerId) => ({
    id: String(m.seq),
    ...(!m.activity && m.user_id !== AGENT_ID ? sourceDeviceFields(m.source_device_kind, users()[viewerId]) : {}),
    readBy: includeReads && !m.deleted_at && !m.pending && !m.activity && m.user_id !== AGENT_ID
      ? st.reads.all(m.seq).filter(r => !!users()[r.userId]) : [],
    activity: m.activity || undefined,
    conversationId: m.conversation_id,
    user: person(m.user_id),
    threadRoot: m.thread_root ? String(m.thread_root) : null,
    // Pending drafts remain durable for recovery, but conversations only expose
    // the working placeholder until the reply finishes.
    text: m.deleted_at || m.pending ? "" : m.text,
    reactions: m.deleted_at ? [] : Object.entries(Object.groupBy(st.reactions.all(m.seq), r => r.emoji)).map(([emoji, rows]) => ({ emoji, userIds: rows.map(r => r.user_id) })),
    attachments: m.deleted_at || m.pending ? [] : st.attachments.all(m.seq),
    deleted: !!m.deleted_at,
    pending: !!m.pending,
    replyCount: m.reply_count,
    lastReplyAt: m.last_reply_at,
    createdAt: m.created_at,
    editedAt: m.edited_at,
    // Meetings attach their live card and one-tap next steps to agent posts.
    ...(m.user_id === AGENT_ID && !m.deleted_at ? safeExtras(m) : {}),
    // One-tap replies the agent offers under its own message.
    ...(m.user_id === AGENT_ID && !m.deleted_at && m.suggestions ? { suggestions: parseSuggestions(m.suggestions) } : {}),
  });
  function safeExtras(m) {
    try { return messageExtras(m) || {}; } catch (e) { console.error("[servant] message extras", e); return {}; }
  }
  function convView(c, me, includeMembers = false) {
    const memberIds = st.members.all(c.id).map((r) => r.user_id);
    let title = c.kind === "channel" ? c.name : null;
    if (c.kind === "dm") {
      const others = memberIds.filter((u) => u !== me);
      title = (others.length ? others : [me]).map((u) => person(u).name).join(", ");
      if (isAgentDm(c)) title = agentName();
    }
    const last = c.last_seq ? st.msg.get(c.last_seq) : null;
    const membership = st.member.get(c.id, me);
    return {
      id: c.id,
      kind: c.kind,
      name: c.name,
      title,
      topic: c.topic,
      private: !!c.private,
      createdBy: c.created_by,
      archived: !!membership?.archived_at,
      // This person's own place for the channel when they sort by hand.
      position: membership?.position ?? null,
      memberCount: memberIds.length,
      members: includeMembers || c.kind === "dm" || memberIds.length <= 50 ? memberIds.map(person) : undefined,
      unread: c.unread ?? 0,
      ...(isAgentDm(c) ? { agentDm: true } : {}),
      lastMessage: last ? msgView(last, !!st.member.get(c.id, me), me) : null,
      updatedAt: last ? last.created_at : c.created_at,
    };
  }

  // ----- core operations (also used by tests and the CLI) -----
  function ensureChannel(...args) { return transaction(() => ensureChannelInTransaction(...args)); }
  function ensureChannelInTransaction(name, topic, createdBy = "system") {
    let c = st.convByName.get(name);
    if (!c) {
      const id = newId("ch");
      st.insertConv.run(id, "channel", name, topic, 0, null, createdBy, now());
      c = st.conv.get(id);
    }
    return c;
  }
  const ensureGeneral = (createdBy) => ensureChannel("general", "Everyone on this server", createdBy);
  const ensureReleases = () => ensureChannel(RELEASES_CHANNEL, "What changed in each build and what to test. Reply in the thread");

  // Every new person starts with one unread message from the agent: a question and a few
  // one-tap answers, in a private conversation of their own. Safe to call again.
  function welcomeFromAgent(...args) { return transaction(() => welcomeFromAgentInTransaction(...args)); }
  function welcomeFromAgentInTransaction(userId, { text, suggestions } = {}) {
    if (!users()[userId]) throw httpError(404, "not_found", "No such person");
    const key = agentDmKey(userId);
    let conv = st.convByDm.get(key);
    if (conv) return conv;
    const id = newId("dm");
    st.insertConv.run(id, "dm", null, "", 1, key, userId, now());
    st.addMember.run(id, userId, now(), 0);
    conv = st.conv.get(id);
    const first = String(users()[userId].name || "").trim().split(/\s+/)[0];
    const hello = text || `${first ? `Hi ${first}, ` : "Hi, "}I'm ${agentName()}, your assistant here. What would you like help with first?`;
    const m = post(conv, AGENT_ID, hello.slice(0, MAX_TEXT));
    const chips = cleanSuggestions(suggestions ?? WELCOME_SUGGESTIONS);
    if (chips.length) {
      db.prepare("UPDATE messages SET suggestions = ? WHERE seq = ?").run(JSON.stringify(chips), m.seq);
      publish(conv.id, "message.updated", msgView(st.msg.get(m.seq)));
    }
    publish(conv.id, "conversation.updated", { id: conv.id });
    return conv;
  }

  function joinDefaults(...args) { return transaction(() => joinDefaultsInTransaction(...args)); }
  /** Startup backfill: everyone into every public channel, then one note in #general. */
  function joinEveryone(userIds) {
    return transaction(() => {
      const added = Object.fromEntries(userIds.map(u => [u, joinDefaultsInTransaction(u)]));
      // The first run after this change: people were already added quietly and never told.
      if (db.prepare("INSERT OR IGNORE INTO messaging_notes VALUES ('channel_invites_v1')").run().changes) {
        const all = db.prepare("SELECT name FROM conversations WHERE kind = 'channel' AND private = 0 AND archived_at IS NULL AND name NOT IN ('general', ?)").all(RELEASES_CHANNEL).map(c => c.name);
        for (const u of userIds) added[u] = [...new Set([...(added[u] || []), ...all])];
      }
      return announceChannelInvites(added);
    });
  }
  function joinDefaultsInTransaction(userId) {
    for (const c of [ensureGeneral(), ensureReleases()]) {
      addChannelMember(c, userId);
      publish(c.id, "conversation.updated", { id: c.id });
    }
    // Like Slack with everyone invited: every open public channel, starting read so nobody gets a
    // wall of old history. The channel shows "<name> joined the channel".
    const added = [];
    for (const c of st.channelsToJoin.all(userId, userId)) {
      if (addChannelMember(c, userId)) { added.push(c.name); publish(c.id, "conversation.updated", { id: c.id }, [userId]); }
    }
    return added;
  }
  // One visible note in #general when people were added to channels they didn't know about.
  function announceChannelInvites(addedByUser) {
    const names = [...new Set(Object.values(addedByUser).flat())].sort();
    if (!names.length) return null;
    const who = Object.keys(addedByUser).filter(u => addedByUser[u].length).map(u => person(u).name);
    const list = names.map(n => `#${n}`).join(", ");
    const text = `${who.length === 1 ? `${who[0]} was` : "Everyone was"} added to ${names.length === 1 ? "a channel" : "every public channel"}: ${list}\n\nLeave any you don't need from the channel's Details`;
    const general = ensureGeneral();
    return post(general, AGENT_ID, text.slice(0, MAX_TEXT), null, { queueAgent: false });
  }

  const releaseView = (r) => {
    const m = r && st.msg.get(r.seq);
    if (!m || m.deleted_at) return null;
    return { build: r.build, conversationId: m.conversation_id, messageId: String(m.seq), text: m.text, createdAt: r.created_at };
  };

  // One post per build in #whats-new. Posting the same build again updates
  // that post, so iOS and Android scripts can both call this.
  function postRelease(...args) { return transaction(() => postReleaseInTransaction(...args)); }
  function postReleaseInTransaction({ build, notes, authorId }) {
    build = String(build || "").trim();
    notes = String(notes || "").trim();
    if (!/^[0-9A-Za-z._-]{1,20}$/.test(build)) throw httpError(400, "bad_build", "Give a build number");
    if (!notes) throw httpError(400, "empty", "Write the notes first");
    const text = `Build ${build} is out\n\n${notes}\n\nReply here with anything you find`.slice(0, MAX_TEXT);
    const conv = ensureReleases();
    for (const uid of Object.keys(users())) addChannelMember(conv, uid);
    const existing = st.release.get(build);
    if (existing && st.msg.get(existing.seq)) {
      st.setAgentText.run(text, 0, existing.seq); // same build, fresher notes: not an "edit"
      publish(conv.id, "message.updated", msgView(st.msg.get(existing.seq)));
      publish(conv.id, "conversation.updated", { id: conv.id });
      return { ...releaseView(existing), updated: true };
    }
    db.prepare("DELETE FROM releases WHERE build = ?").run(build);
    const m = post(conv, authorId, text, null, { queueAgent: false });
    st.putRelease.run(build, m.seq, now());
    publish(conv.id, "conversation.updated", { id: conv.id });
    return { ...releaseView(st.release.get(build)), updated: false };
  }
  const latestRelease = () => releaseView(st.latestRelease.get());

  function channelActivity(...args) { return transaction(() => channelActivityInTransaction(...args)); }
  function channelActivityInTransaction(conv, userId, action) {
    const text = `${person(userId).name} ${action === "joined" ? "joined" : "left"} the channel`;
    const result = st.insertActivity.run(conv.id, userId, text, now(), action);
    publish(conv.id, "message.created", msgView(st.msg.get(Number(result.lastInsertRowid))));
  }
  // Someone's last device signed out or was removed: they've left Servant.
  // Note it in #general so the team sees it (owner, 10/31).
  function noteMemberLeft(userId, name) {
    return transaction(() => {
      const general = ensureGeneral();
      const result = st.insertActivity.run(general.id, userId, `${name || person(userId).name} left Servant`, now(), "left");
      publish(general.id, "message.created", msgView(st.msg.get(Number(result.lastInsertRowid))));
      publish(general.id, "conversation.updated", { id: general.id });
    });
  }
  function addChannelMember(...args) { return transaction(() => addChannelMemberInTransaction(...args)); }
  function addChannelMemberInTransaction(conv, userId, lastReadSeq = st.lastSeq.get(conv.id).seq) {
    const result = st.addMember.run(conv.id, userId, now(), lastReadSeq);
    st.clearLeave.run(conv.id, userId);
    if (result.changes) channelActivity(conv, userId, "joined");
    return Number(result.changes);
  }

  function post(...args) { return transaction(() => postInTransaction(...args)); }
  function postInTransaction(conv, userId, text, threadRoot = null, { pending = false, attachments = [], queueAgent = externalWorker, device, call = null } = {}) {
    conv = userId === AGENT_ID ? st.conv.get(conv.id) : requireConversation(conv.id, userId, true);
    if (!conv || conv.archived_at) throw httpError(404, 'not_found', 'That conversation is gone');
    if (threadRoot) {
      const root = st.msg.get(threadRoot);
      if (!root || root.deleted_at || root.conversation_id !== conv.id) throw httpError(404, 'not_found', 'That thread is gone');
      if (root.activity) throw httpError(400, 'channel_activity', 'Channel activity cannot have replies');
    }
    const humanDevice = userId !== AGENT_ID && device?.userId === userId ? device : null;
    const r = st.insertMsg.run(conv.id, userId, threadRoot, text, now(), pending ? 1 : 0, sourceDeviceKind(humanDevice), humanDevice?.id || null);
    const seq = Number(r.lastInsertRowid);
    if (conv.kind === "dm") unarchiveDm(conv.id);
    for (const a of attachments) st.insertAttachment.run(newId("file"), seq, a.name, a.mime, a.data.length, a.data);
    if (threadRoot) st.bumpThread.run(now(), threadRoot);
    if (userId !== AGENT_ID) st.markRead.run(seq, conv.id, userId);
    const m = st.msg.get(seq);
    publish(conv.id, "message.created", msgView(m));
    if (threadRoot) publish(conv.id, "message.updated", msgView(st.msg.get(threadRoot)));
    if (!pending) notifyMessage(m.seq, call);
    if (queueAgent && externalWorker && userId !== AGENT_ID && wantsAgent(conv, m)) {
      db.prepare('INSERT OR IGNORE INTO agent_jobs (trigger_seq, created_at) VALUES (?, ?)').run(m.seq, now());
    }
    return m;
  }

  function inAgentThread(conv, root) {
    if (!root) return false;
    if (st.agentThread.get(`${conv.id}:${root}`)) return true;
    // A mention can be a reply to a human-started thread. Keep listening while
    // that first request is queued or running, before a session is saved.
    if (st.activeAgentThread.get(conv.id, root, root)) return true;
    const head = st.msg.get(root);
    return !!head && !head.deleted_at && head.user_id !== AGENT_ID && mentionsAgent(head.text, agentName());
  }
  function wantsAgent(conv, m) {
    if (isAgentDm(conv)) return m.user_id !== AGENT_ID;
    return m.user_id !== AGENT_ID && agentShouldReply(m.text, agentName());
  }

  // The agent answers in a thread under the message that mentioned it, and
  // sees the recent messages it missed in that thread (or channel) as context.
  function agentReply(conv, trigger, job) {
    const task = runAgentReply(conv, trigger, job);
    agentTasks.add(task);
    const settled = () => agentTasks.delete(task);
    task.then(settled, settled);
    return task;
  }

  async function runAgentReply(conv, trigger, job) {
    const direct = isAgentDm(conv);
    // In a person's own conversation with the agent there are no threads: one running chat, replies in line.
    const root = direct ? null : trigger.thread_root || trigger.seq;
    const key = `${conv.id}:${direct ? "dm" : root}`;
    let thread = st.agentThread.get(key);
    const sessionId = thread ? thread.hermes_session_id : `servant_${conv.id}_${direct ? "dm" : root}`;
    const seen = thread ? thread.last_seen_seq : 0;
    const unseen = st.since
      .all(conv.id, seen, trigger.seq, trigger.thread_root ? root : null, root, root)
      .reverse()
      // In a private chat with the agent the first turn includes its own opening question, so the
      // answer makes sense. Later turns already have it in the running session.
      .filter((m) => m.user_id !== AGENT_ID || (direct && !thread));
    // In channels and group DMs: only the mention and the message just before it (it can ask for more).
    const recent = direct ? unseen : unseen.slice(-2);
    const where = direct ? `a private chat with ${person(trigger.user_id).name}` : conv.kind === "channel" ? `#${conv.name}` : "a direct message";
    const audience = direct ? "Only this person reads your reply." : "Several people can read your reply.";
    const transcript = recent.map((m) => `${m.user_id === AGENT_ID ? "You" : person(m.user_id).name}: ${m.text}`).join("\n");
    const work = startWorkChat && !direct ? ` ${WORK_CHAT_INSTRUCTIONS}` : "";
    const more = !direct && unseen.length > recent.length ? ` ${MORE_CONTEXT_INSTRUCTIONS}` : "";
    const prompt =
      `[Servant ${where}. ${audience} Answer the latest message in a short reply in this thread, ` +
      `clearly. Include images when useful.${work}${more}]\n\n${transcript}`;
    // If the agent lost this thread's session (for example after switching
    // agents), it starts over with the whole thread instead of failing.
    const fullThread = thread
      ? st.since.all(conv.id, 0, trigger.seq, trigger.thread_root ? root : null, root, root).reverse()
          .map((m) => `${m.user_id === AGENT_ID ? "You" : person(m.user_id).name}: ${m.text}`).join("\n")
      : transcript;
    const restartPrompt =
      `[Servant ${where}. ${audience} Answer the latest message, ` +
      `clearly. Include images when useful.${work} This is the whole thread so far.]\n\n${fullThread}`;
    // Bound recent visual context to the same total upload budget. Prefer the
    // latest images so an old thread cannot crowd out the triggering message.
    const images = [];
    let imageBytes = 0;
    for (const row of recent.slice().reverse()) {
      for (const a of st.attachments.all(row.seq).reverse()) {
        if (!/^(image|video)\//.test(a.mime) || images.length >= 4 || imageBytes + a.size > MAX_UPLOAD_TOTAL) continue;
        images.unshift(st.attachment.get(a.id));
        imageBytes += a.size;
      }
    }

    const reply = transaction(() => {
      const message = post(conv, AGENT_ID, "", root, { pending: true });
      if (job) db.prepare('UPDATE agent_jobs SET reply_seq = ? WHERE trigger_seq = ? AND owner = ? AND status = ?').run(message.seq, job.trigger_seq, job.owner, 'working');
      return message;
    });
    let text = "";
    let attachments = [];
    let lastSave = 0;
    const saveReply = (finished) => {
      if (!finished && now() - lastSave < 250) return;
      lastSave = now();
      transaction(() => {
        const current = st.msg.get(reply.seq);
        if (!st.conv.get(conv.id) || !current || current.deleted_at) return;
        st.setAgentText.run(text, finished ? 0 : 1, reply.seq);
        // Checkpoint partial output without emitting word-by-word updates.
        if (finished) publish(conv.id, "message.updated", msgView(st.msg.get(reply.seq)));
      });
    };
    try {
      const final = await askAgent({
        onUsage: usage => { try { onUsage({ eventId: `channel:${trigger.seq}`, userId: trigger.user_id, source: "channel", text: trigger.text, usage }); } catch { /* never fail a reply over stats */ } },
        sessionId,
        userId: trigger.user_id,
        sessionKey: `servant:${conv.id}`,
        fresh: !thread,
        text: prompt,
        restartText: restartPrompt,
        attachments: images,
        onDelta: (d) => {
          text += d;
          // A request for more context is never shown, even half-streamed.
          if (more && "<servant-more-context/>".startsWith(text.trim().slice(0, 24))) return;
          saveReply(false);
        },
        onStatus: () => {},
      });
      const read = f => f && typeof f === "object" ? { text: f.text || "", attachments: f.attachments || [] } : { text: f || "", attachments: [] };
      let answer = read(final);
      // Asked for more context: send the earlier messages it didn't see, once.
      if (more && MORE_CONTEXT_TAG.test(answer.text)) {
        text = "";
        const earlier = unseen.slice(0, -recent.length).map((m) => `${m.user_id === AGENT_ID ? "You" : person(m.user_id).name}: ${m.text}`).join("\n");
        answer = read(await askAgent({
          onUsage: usage => { try { onUsage({ eventId: `channel:${trigger.seq}:more`, userId: trigger.user_id, source: "channel", text: trigger.text, usage }); } catch { /* stats only */ } },
          sessionId, userId: trigger.user_id, sessionKey: `servant:${conv.id}`, fresh: false,
          text: `[Earlier messages, oldest first. Now answer the message that mentioned you; don't ask again.]\n\n${earlier}`,
          attachments: [], onDelta: (d) => { text += d; saveReply(false); }, onStatus: () => {},
        }));
        if (MORE_CONTEXT_TAG.test(answer.text)) answer.text = "";
      }
      attachments = answer.attachments;
      text = answer.text || (attachments.length ? "" : text || "I couldn't come up with an answer");
      // Real work goes to a shared agent chat; the thread gets a link to it.
      const work = splitWorkChat(text);
      if (work.title && startWorkChat) {
        text = work.text;
        try {
          const chat = await startWorkChat({ userId: trigger.user_id, deviceId: trigger.source_device_id, title: work.title, where, transcript: fullThread });
          text = `${text ? text + "\n\n" : ""}Working on it in [${chat.title}](/chat/${chat.id}). Anyone can follow along there`;
        } catch (e) {
          text = `${text ? text + "\n\n" : ""}I couldn't open a shared chat for this (${e?.message || "error"}). Ask me again, or start an agent chat`;
        }
      } else if (work.title) text = work.text;
    } catch {
      text = text || "I hit a problem. Try asking again";
    }
    transaction(() => {
      const current = st.msg.get(reply.seq);
      if (current && !current.deleted_at && st.conv.get(conv.id)) {
        for (const a of attachments) st.insertAttachment.run(newId("file"), reply.seq, a.name, a.mime, a.data.length, a.data);
      }
      saveReply(true);
      if (st.conv.get(conv.id)) {
        // Only this trigger's context was sent. A later queued follow-up may
        // predate the reply placeholder and must still reach the next turn.
        st.putAgentThread.run(key, sessionId, trigger.seq);
        notifyMessage(reply.seq);
      }
      if (job) db.prepare("UPDATE agent_jobs SET status = 'done' WHERE trigger_seq = ? AND owner = ? AND status = 'working'").run(job.trigger_seq, job.owner);
    });
    return st.msg.get(reply.seq);
  }

  async function processAgentJob(owner) {
    if (typeof owner !== 'string' || !owner) throw new Error('Worker owner is required');
    const job = transaction(() => {
      const row = db.prepare("SELECT * FROM agent_jobs WHERE status = 'queued' ORDER BY created_at, trigger_seq LIMIT 1").get();
      if (!row) return null;
      db.prepare("UPDATE agent_jobs SET status = 'working', owner = ? WHERE trigger_seq = ? AND status = 'queued'").run(owner, row.trigger_seq);
      return { ...row, owner };
    });
    if (!job) return false;
    const trigger = st.msg.get(job.trigger_seq);
    const conv = trigger && st.conv.get(trigger.conversation_id);
    if (!trigger || trigger.deleted_at || !conv || !users()[trigger.user_id] || !st.member.get(conv.id, trigger.user_id)) {
      db.prepare("UPDATE agent_jobs SET status = 'cancelled' WHERE trigger_seq = ? AND owner = ?").run(job.trigger_seq, owner);
      return true;
    }
    try { await agentReply(conv, trigger, job); }
    catch (error) {
      transaction(() => {
        const current = db.prepare("SELECT * FROM agent_jobs WHERE trigger_seq = ? AND owner = ? AND status = 'working'").get(job.trigger_seq, owner);
        const reply = current?.reply_seq && st.msg.get(current.reply_seq);
        if (reply && reply.pending && !reply.deleted_at && st.conv.get(reply.conversation_id)) {
          st.setAgentText.run(`${reply.text ? reply.text + '\n\n' : ''}The worker could not confirm this answer. Ask again if needed.`, 0, reply.seq);
          publish(reply.conversation_id, 'message.updated', msgView(st.msg.get(reply.seq)));
          notifyMessage(reply.seq);
        }
        db.prepare("UPDATE agent_jobs SET status = 'interrupted' WHERE trigger_seq = ? AND owner = ? AND status = 'working'").run(job.trigger_seq, owner);
      });
      throw error;
    }
    return true;
  }

  // Only call after acquiring exclusive worker ownership. A lost stream may
  // still run inside Hermes, so recovery never blindly replays a claimed job.
  function recoverInterruptedJobs() {
    return transaction(() => {
      const rows = db.prepare("SELECT * FROM agent_jobs WHERE status = 'working'").all();
      for (const job of rows) {
        const reply = job.reply_seq && st.msg.get(job.reply_seq);
        if (reply && !reply.deleted_at && st.conv.get(reply.conversation_id)) {
          const text = `${reply.text ? reply.text + '\n\n' : ''}The worker restarted before confirming this answer. Ask again if needed.`;
          st.setAgentText.run(text, 0, reply.seq);
          publish(reply.conversation_id, 'message.updated', msgView(st.msg.get(reply.seq)));
          notifyMessage(reply.seq);
        }
        db.prepare("UPDATE agent_jobs SET status = 'interrupted' WHERE trigger_seq = ?").run(job.trigger_seq);
      }
      return rows.length;
    });
  }

  function canSee(conv, userId) {
    if (!conv || conv.archived_at) return false;
    if (conv.kind === "channel" && !conv.private) return true;
    return !!st.member.get(conv.id, userId);
  }

  // A message someone may forward to their agent chat: only one they can see.
  function forwardSource(messageId, userId) {
    const m = /^\d+$/.test(String(messageId)) ? st.msg.get(Number(messageId)) : null;
    const conv = m && st.conv.get(m.conversation_id);
    if (!m || m.deleted_at || m.pending || m.activity || !canSee(conv, userId)) throw httpError(404, "not_found", "That message is unavailable");
    return {
      author: person(m.user_id).name,
      where: conv.kind === "channel" ? `#${conv.name}` : "a direct message",
      private: conv.kind !== "channel" || !!conv.private,
      at: m.created_at,
      text: m.text,
      files: db.prepare("SELECT name, mime, data FROM attachments WHERE message_seq = ? ORDER BY rowid").all(m.seq),
    };
  }

  // Forward from an agent chat: the server wrote the header, so post it as-is
  // into a channel or DM the person belongs to.
  function forwardInto(conversationId, user, text, attachments = [], device) {
    const conv = requireConversation(String(conversationId || ""), user.id, true);
    const m = post(conv, user.id, String(text).slice(0, MAX_TEXT), null, { attachments, device });
    if (!externalWorker && wantsAgent(conv, m)) agentReply(conv, m).catch((e) => console.error("[servant] agent reply", e));
    return { conversation: convView(st.conv.get(conv.id), user.id), message: msgView(m, true, user.id) };
  }

  function requireConversation(conversationId, userId, membership = false) {
    const current = st.conv.get(conversationId);
    if (!canSee(current, userId)) throw httpError(404, 'not_found', "That conversation doesn't exist or you can't see it");
    if (membership && !st.member.get(conversationId, userId)) throw httpError(403, 'not_member', 'Join the channel first');
    return current;
  }
  function requireMessage(messageId, userId, membership = false) {
    const current = st.msg.get(messageId);
    if (!current || current.deleted_at) throw httpError(404, 'not_found', 'That message is gone');
    requireConversation(current.conversation_id, userId, membership);
    if (current.activity) throw httpError(403, 'channel_activity', 'Channel activity cannot be changed');
    return current;
  }

  function createChannel(...args) { return transaction(() => createChannelInTransaction(...args)); }
  function createChannelInTransaction(user, { name, topic = "", private: priv = false, memberIds = [] }) {
    const n = channelName(name);
    if (!n) throw httpError(400, "bad_name", "Give the channel a name");
    if (st.convByName.get(n)) throw httpError(409, "name_taken", `#${n} already exists`);
    const id = newId("ch");
    st.insertConv.run(id, "channel", n, String(topic).slice(0, 250), priv ? 1 : 0, null, user.id, now());
    const people = users();
    for (const uid of new Set([user.id, ...memberIds])) if (people[uid]) addChannelMember(st.conv.get(id), uid, 0);
    // Public channels include everyone on the server (they can leave).
    if (!priv) for (const uid of Object.keys(people)) st.addMember.run(id, uid, now(), 0);
    publish(id, "conversation.updated", { id });
    return st.conv.get(id);
  }

  // Archiving a direct conversation hides it until someone writes in it again.
  function unarchiveDm(convId, onlyUserId = null) {
    const archived = st.members.all(convId).filter(m => (!onlyUserId || m.user_id === onlyUserId) && st.member.get(convId, m.user_id)?.archived_at);
    for (const m of archived) st.archiveMember.run(null, convId, m.user_id);
    if (archived.length) publish(convId, "conversation.updated", { id: convId }, archived.map(m => m.user_id));
  }

  function openDm(...args) { return transaction(() => openDmInTransaction(...args)); }
  function openDmInTransaction(user, userIds) {
    const people = users();
    const ids = [...new Set([user.id, ...userIds])].filter((u) => people[u]).sort();
    if (ids.length < 2 && !userIds.includes(user.id)) throw httpError(400, "bad_people", "Pick someone to message");
    if (ids.length > 9) throw httpError(400, "too_many", "A group message can have up to nine people");
    const key = ids.join(",");
    let c = st.convByDm.get(key);
    if (!c) {
      const id = newId("dm");
      st.insertConv.run(id, "dm", null, "", 1, key, user.id, now());
      for (const uid of ids) st.addMember.run(id, uid, now(), 0);
      c = st.conv.get(id);
      publish(id, "conversation.updated", { id });
    } else unarchiveDm(c.id, user.id);
    return c;
  }

  function notificationFor(messageId, user, event = null) {
    const m = st.msg.get(Number(messageId));
    if (!m || m.activity || m.pending || m.deleted_at || m.user_id === user.id) return null;
    const call = event?.call;
    // A call alert is only worth sending while it is ringing, and never to the person who started it.
    if (call && (call.by === user.id || now() - m.created_at > CALL_PUSH_MS)) return null;
    const c = st.conv.get(m.conversation_id);
    const membership = c && st.member.get(c.id, user.id);
    if (!c || c.archived_at || !membership || membership.archived_at) return null;
    // No delayed push after the recipient has already read the top-level post.
    if (!call && !m.thread_root && membership.last_read_seq >= m.seq) return null;
    const participant = !!m.thread_root && !!db.prepare("SELECT 1 FROM messages WHERE conversation_id = ? AND (seq = ? OR thread_root = ?) AND user_id = ? AND deleted_at IS NULL AND seq < ? LIMIT 1").get(c.id, m.thread_root, m.thread_root, user.id, m.seq);
    if (call) {
      const caller = person(call.by).name;
      return { kind: c.kind, conversationId: c.id, meetingId: call.id, caller, place: c.kind === "channel" ? `#${c.name}` : "", mentioned: true, participant: false, badge: Math.max(1, st.mine.all(user.id, 0).reduce((n, x) => n + x.unread, 0)),
        title: `${caller} is calling`, body: c.kind === "channel" ? `In #${c.name}. Tap to join` : "Tap to join" };
    }
    const sender = person(m.user_id).name;
    // New build notes reach everyone, like an @here.
    const release = !m.thread_root && st.releaseBySeq.get(m.seq);
    const unread = st.mine.all(user.id, 0).reduce((n, c) => n + c.unread, 0);
    // Tapping a build's notes opens its thread, where testers discuss it.
    return { kind: c.kind, conversationId: c.id, messageId: String(m.seq), threadRoot: release ? m.seq : m.thread_root,
      mentioned: !!release || isMention(m.text, user), participant, badge: Math.max(1, unread),
      title: release ? `Build ${release.build} is out` : c.kind === "channel" ? `${sender} in #${c.name}` : sender,
      body: m.text || (st.attachments.all(m.seq).length ? "Sent an attachment" : ""), };
  }

  // ----- HTTP -----
  async function handle(req, res, { user, device, method, parts, url, send, fail, readBody, cors, isAuthorized = () => true }) {
    const r = parts[1];
    if (!["people", "conversations", "channels", "messages", "events", "releases", "attachments", "presence", "search"].includes(r)) return false;

    if (r === "search" && method === "GET" && parts.length === 2) {
      if (!isAuthorized() || !users()[user.id]) return fail(res, 401, "unauthorized", "This device is no longer paired"), true;
      const input = (url.searchParams.get("q") ?? "").trim();
      if (input.length > 100) return fail(res, 400, "bad_query", "Search with up to 100 characters"), true;
      res.setHeader("Cache-Control", "no-store");
      if (input.length < 2) return send(res, 200, { channels: [], people: [], messages: [] }), true;
      const query = searchText(input);
      const channels = st.searchChannels.all(user.id, query, query).map(c => ({
        id: c.id, name: c.name, topic: c.topic, memberCount: c.member_count,
        archived: !!c.member_archived_at, joined: !!c.joined_user, private: !!c.private,
      }));
      const people = Object.values(users())
        .filter(u => u.id !== user.id && searchText(u.name).includes(query))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, 10)
        .map(u => ({ ...person(u.id), owner: u.role === "owner" }));
      const titles = new Map();
      const messages = st.searchMessages.all(user.id, query).map(m => {
        if (!titles.has(m.conversation_id)) titles.set(m.conversation_id,
          m.conversation_kind === "channel" ? m.conversation_name : convView(st.conv.get(m.conversation_id), user.id).title);
        return {
          id: String(m.seq), conversationId: m.conversation_id,
          conversationTitle: titles.get(m.conversation_id), conversationKind: m.conversation_kind,
          threadRoot: m.thread_root ? String(m.thread_root) : null,
          text: m.text, user: person(m.user_id), createdAt: m.created_at,
          ...(!m.activity && m.user_id !== AGENT_ID ? sourceDeviceFields(m.source_device_kind, users()[user.id]) : {}),
        };
      });
      send(res, 200, { channels, people, messages });
      return true;
    }

    if (r === "presence" && method === "POST" && parts.length === 2) {
      const body = await readBody(req);
      if (typeof body.active !== "boolean" || typeof body.sessionId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(body.sessionId)) {
        return fail(res, 400, "invalid_presence", "Invalid presence session"), true;
      }
      const value = transaction(() => {
        if (!isAuthorized() || !users()[user.id]) throw httpError(401, "unauthorized", "This device is no longer paired");
        expirePresence();
        const at = now();
        if (body.active) {
          st.touchPresence.run(user.id, at);
          st.touchSession.run(user.id, body.sessionId, at + PRESENCE_LEASE_MS);
          publishPresence(user.id);
        } else if (st.endSession.run(user.id, body.sessionId).changes) {
          st.touchPresence.run(user.id, at);
          publishPresence(user.id);
        }
        return presence(user.id);
      });
      send(res, 200, value);
      return true;
    }

    if (r === "attachments" && method === "GET") {
      const a = st.attachment.get(parts[2] || "");
      const m = a && st.msg.get(a.message_seq);
      if (!m || m.deleted_at || m.pending || !canSee(st.conv.get(m.conversation_id), user.id)) {
        return fail(res, 404, "not_found", "That attachment is unavailable"), true;
      }
      res.setHeader("Cache-Control", "no-store");
      send(res, 200, { data: Buffer.from(a.data).toString("base64") });
      return true;
    }

    if (method === "GET" && r === "releases" && parts[2] === "latest" && parts.length === 3) {
      send(res, 200, { release: latestRelease() });
      return true;
    }

    // Profile photos: everyone on the server sees them; only you change yours.
    if (r === "people" && parts[3] === "photo" && parts.length === 4) {
      if (!isAuthorized() || !users()[user.id]) return fail(res, 401, "unauthorized", "This device is no longer paired"), true;
      if (parts[2] === "me" && (method === "PUT" || method === "DELETE")) {
        let version = null;
        if (method === "PUT") {
          const body = await readBody(req, MAX_PHOTO_BODY);
          const data = typeof body.data === "string" && /^[A-Za-z0-9+/]+={0,2}$/.test(body.data) ? Buffer.from(body.data, "base64") : null;
          const mime = data && rasterMime(data);
          if (!data || !["image/jpeg", "image/png", "image/webp"].includes(mime)) return fail(res, 400, "bad_photo", "Choose a JPEG or PNG photo"), true;
          if (data.length > MAX_PHOTO_BYTES) return fail(res, 413, "photo_too_large", "That photo is too large"), true;
          version = Math.max(now(), (st.photoVersion.get(user.id)?.updated_at ?? 0) + 1);
          st.setPhoto.run(user.id, mime, data, version);
        } else st.removePhoto.run(user.id);
        publish('', 'person.updated', { userId: user.id }, Object.keys(users()));
        send(res, 200, { person: person(user.id) });
        return true;
      }
      if (method === "GET") {
        const row = users()[parts[2]] && st.photo.get(parts[2]);
        if (!row) return fail(res, 404, "not_found", "No photo"), true;
        res.setHeader("Cache-Control", "no-store");
        send(res, 200, { mime: row.mime, data: Buffer.from(row.data).toString("base64"), version: String(row.updated_at) });
        return true;
      }
    }

    if (method === "GET" && r === "people" && parts.length === 2) {
      expirePresence();
      const list = Object.values(users())
        .map((u) => ({ ...person(u.id), owner: u.role === "owner", ...(u.vibeCoder ? { vibeCoder: true } : {}) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      send(res, 200, { people: list, agent: person(AGENT_ID), me: user.id });
      return true;
    }

    // POST as well as GET: Cloudflare's quick tunnel buffers streamed GET responses
    // until they end, but passes POST streams straight through. The app uses POST.
    if ((method === "GET" || method === "POST") && r === "events") {
      // A request accepted before drain may only reach this route later (for
      // example, after reading/decrypting its envelope). Never open a new stream.
      if (closingEvents) return fail(res, 503, "draining", "Server restarting. Try again shortly"), true;
      const rawAfter = url.searchParams.get('after');
      if (rawAfter !== null && (!/^(0|[1-9][0-9]*)$/.test(rawAfter) || !Number.isSafeInteger(Number(rawAfter)))) {
        return fail(res, 400, 'invalid_cursor', 'Invalid event cursor'), true;
      }
      if (!isAuthorized()) return fail(res, 401, 'unauthorized', 'This device is no longer paired'), true;
      res.writeHead(200, {
        ...cors,
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        Connection: "keep-alive",
      });
      let cursor = rawAfter === null ? null : Number(rawAfter);
      let ended = false;
      let timer;
      let keepalive;
      const cleanup = () => {
        ended = true;
        eventStreams.delete(end);
        clearInterval(timer);
        clearInterval(keepalive);
      };
      const end = () => { cleanup(); res.end(); };
      const emit = (event, data, id) => {
        if (ended) return false;
        const writable = res.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        // A slow client reconnects with its last received cursor; never buffer
        // an unbounded event history in this API process.
        if (writable === false) end();
        return !ended;
      };
      const poll = (initial = false) => {
        if (ended) return;
        try {
          if (!isAuthorized() || !users()[user.id]) return end();
          expirePresence();
          const head = eventHead();
          const reset = cursor === null || cursor > head || cursor < eventFloor() - 1 || head - cursor > MAX_REPLAY;
          if (reset) {
            cursor = head;
            emit('ready', { cursor: String(cursor), reset: true }, cursor);
            return;
          }
          const before = cursor;
          // Initial catch-up is bounded by MAX_REPLAY. Subsequent polls process
          // one page so a busy conversation cannot monopolize the event loop.
          do {
            const rows = eventPage.all(cursor, head);
            if (!rows.length) { cursor = head; break; }
            for (const row of rows) {
              cursor = row.id;
              const value = resolveEvent(row, user.id);
              if (value && !emit(row.event, value, row.id)) return;
            }
          } while (initial && cursor < head);
          if (initial) emit('ready', { cursor: String(cursor), reset: false }, cursor);
          else if (cursor > before) emit('checkpoint', { cursor: String(cursor) }, cursor);
        } catch { end(); }
      };
      eventStreams.add(end);
      res.on('close', cleanup);
      poll(true);
      if (!ended) {
        timer = setInterval(() => poll(), 250);
        keepalive = setInterval(() => { if (!ended && res.write(': keepalive\n\n') === false) end(); }, 15000);
        timer.unref?.(); keepalive.unref?.();
      }
      return true;
    }

    if (r === "channels" && parts[2] === "browse" && method === "GET") {
      // Old builds receive the full list; new clients opt into cursor pagination.
      const paged = url.searchParams.has("limit");
      const limit = Number(url.searchParams.get("limit") || 20);
      if (paged && (!Number.isInteger(limit) || limit < 1 || limit > 100)) return fail(res, 400, "invalid_limit", "Invalid page size"), true;
      let after = ["", ""];
      if (paged && url.searchParams.has("after")) {
        try {
          after = JSON.parse(Buffer.from(url.searchParams.get("after"), "base64url").toString());
          if (!Array.isArray(after) || after.length !== 2 || after.some(v => typeof v !== "string" || v.length > 200)) throw new Error();
        } catch { return fail(res, 400, "invalid_cursor", "Invalid channel cursor"), true; }
      }
      const rows = paged ? st.browsePage.all(user.id, after[0], after[0], after[1], limit + 1) : st.browse.all(user.id);
      const more = paged && rows.length > limit;
      const page = more ? rows.slice(0, limit) : rows;
      const last = page.at(-1);
      send(res, 200, {
        channels: page.map(c => ({ id: c.id, name: c.name, topic: c.topic, memberCount: c.member_count })),
        nextCursor: more ? Buffer.from(JSON.stringify([last.name, last.id])).toString("base64url") : null,
      });
      return true;
    }

    if (r === "conversations" && method === "GET") expirePresence();

    if (r === "conversations" && parts.length === 2) {
      if (method === "GET") {
        const list = st.mine.all(user.id, url.searchParams.get("includeArchived") === "1" ? 1 : 0).map((c) => convView(c, user.id));
        list.sort((a, b) => b.updatedAt - a.updatedAt);
        send(res, 200, { conversations: list });
        return true;
      }
      if (method === "POST") {
        const body = await readBody(req);
        const c =
          body.kind === "dm"
            ? openDm(user, Array.isArray(body.userIds) ? body.userIds.map(String) : [])
            : createChannel(user, { name: body.name, topic: body.topic, private: !!body.private, memberIds: Array.isArray(body.memberIds) ? body.memberIds.map(String) : [] });
        send(res, 201, { conversation: convView({ ...c, unread: 0 }, user.id) });
        return true;
      }
    }

    // Saves the order someone dragged their channels into. Personal: it never
    // changes anyone else's list. Unknown or left channels are ignored.
    if (r === "conversations" && parts[2] === "order" && parts.length === 3 && method === "POST") {
      const body = await readBody(req);
      if (!Array.isArray(body.ids) || body.ids.length > 2000 || body.ids.some(id => typeof id !== "string"))
        return fail(res, 400, "invalid_order", "Send the channel IDs in order"), true;
      const ids = [...new Set(body.ids)].filter(id => st.member.get(id, user.id));
      transaction(() => {
        ids.forEach((id, index) => st.setPosition.run(index, id, user.id));
        if (ids.length) publish(ids[0], "conversation.updated", { id: ids[0] }, [user.id]);
      });
      send(res, 200, { ok: true, ids });
      return true;
    }

    if (r === "conversations" && parts[2]) {
      const conv = st.conv.get(parts[2]);
      if (!canSee(conv, user.id)) {
        fail(res, 404, "not_found", "That conversation doesn't exist or you can't see it");
        return true;
      }
      const isMember = !!st.member.get(conv.id, user.id);
      const sub = parts[3];

      if (sub === "media" && method === "GET" && parts.length === 4) {
        const items = db.prepare(`SELECT a.id,a.name,a.mime,a.size,m.seq AS messageId,m.user_id,m.created_at AS createdAt,m.text
          FROM attachments a JOIN messages m ON m.seq=a.message_seq
          WHERE m.conversation_id=? AND m.deleted_at IS NULL AND m.pending = 0 ORDER BY m.seq,a.rowid`).all(conv.id)
          .map(({ user_id, messageId, ...item }) => ({ ...item, messageId: String(messageId), sender: person(user_id) }));
        send(res, 200, mediaPage(items, url.searchParams));
        return true;
      }

      if ((sub === "archive" || sub === "restore") && method === "POST") {
        if (!isMember)
          return fail(res, 403, "forbidden", conv.kind === "dm" ? "You're not in this conversation" : "Join the channel first"), true;
        transaction(() => {
          requireConversation(conv.id, user.id, true);
          st.archiveMember.run(sub === "archive" ? now() : null, conv.id, user.id);
          publish(conv.id, "conversation.updated", { id: conv.id }, [user.id]);
        });
        send(res, 200, { ok: true });
        return true;
      }
      if (!sub && method === "DELETE" && conv.kind === "dm") {
        // Anyone in a direct conversation can delete it, for everyone in it.
        if (!isMember) return fail(res, 403, "forbidden", "You're not in this conversation"), true;
        transaction(() => {
          requireConversation(conv.id, user.id, true);
          const memberIds = st.members.all(conv.id).map(m => m.user_id);
          st.deleteConv.run(conv.id);
          st.deleteAgentThreads.run(conv.id, conv.id);
          publish(conv.id, "conversation.updated", { id: conv.id }, memberIds);
        });
        send(res, 200, { ok: true });
        return true;
      }
      if (!sub && method === "DELETE") {
        if (conv.kind !== "channel" || (conv.created_by !== user.id && user.role !== "owner"))
          return fail(res, 403, "forbidden", "Only the channel creator or server owner can delete it"), true;
        if (conv.name === "general") return fail(res, 400, "protected_channel", "#general stays open for everyone"), true;
        transaction(() => {
          const current = requireConversation(conv.id, user.id);
          if (current.created_by !== user.id && users()[user.id]?.role !== 'owner') throw httpError(403, 'forbidden', 'Only the channel creator or server owner can delete it');
          if (current.name === 'general') throw httpError(400, 'protected_channel', '#general stays open for everyone');
          const memberIds = st.members.all(conv.id).map(m => m.user_id);
          st.deleteConv.run(conv.id);
          st.deleteAgentThreads.run(conv.id, conv.id);
          publish(conv.id, "conversation.updated", { id: conv.id }, memberIds);
        });
        send(res, 200, { ok: true });
        return true;
      }

      if (!sub && method === "GET") {
        send(res, 200, { conversation: convView({ ...conv, last_seq: st.lastSeq.get(conv.id).seq }, user.id, true), joined: isMember });
        return true;
      }
      if (!sub && method === "PATCH") {
        if (conv.kind !== "channel" || !isMember) return fail(res, 403, "forbidden", "Only channel members can change it"), true;
        const body = await readBody(req);
        const view = transaction(() => {
          const current = requireConversation(conv.id, user.id, true);
          const name = body.name !== undefined ? channelName(body.name) : current.name;
          if (!name) throw httpError(400, 'bad_name', 'Give the channel a name');
          if (current.name === 'general' && name !== current.name) throw httpError(400, 'protected_channel', '#general cannot be renamed');
          const clash = st.convByName.get(name);
          if (clash && clash.id !== conv.id) throw httpError(409, 'name_taken', `${name} already exists`);
          st.updateConv.run(name, body.topic !== undefined ? String(body.topic).slice(0, 250) : current.topic, conv.id);
          publish(conv.id, 'conversation.updated', { id: conv.id });
          return convView(st.conv.get(conv.id), user.id);
        });
        send(res, 200, { conversation: view });
        return true;
      }
      if (sub === "join" && method === "POST") {
        if (conv.kind !== "channel") return fail(res, 400, "bad_request", "You can only join channels"), true;
        transaction(() => {
          const current = requireConversation(conv.id, user.id);
          addChannelMember(current, user.id);
          publish(conv.id, "conversation.updated", { id: conv.id });
        });
        send(res, 200, { ok: true });
        return true;
      }
      if (sub === "leave" && method === "POST") {
        if (conv.kind !== "channel") return fail(res, 400, "bad_request", "You can only leave channels"), true;
        if (conv.name === "general") return fail(res, 400, "bad_request", "Everyone stays in #general"), true;
        transaction(() => {
          const current = requireConversation(conv.id, user.id);
          if (current.name === 'general') throw httpError(400, 'protected_channel', 'Everyone stays in #general');
          if (st.removeMember.run(conv.id, user.id).changes) channelActivity(current, user.id, "left");
          st.noteLeave.run(conv.id, user.id, now());
          publish(conv.id, "conversation.updated", { id: conv.id });
          publish(conv.id, "conversation.updated", { id: conv.id }, [user.id]);
        });
        send(res, 200, { ok: true });
        return true;
      }
      if (sub === "members" && method === "POST") {
        if (!isMember || conv.kind !== "channel") return fail(res, 403, "forbidden", "Join the channel first"), true;
        const body = await readBody(req);
        const people = users();
        const ids = (Array.isArray(body.userIds) ? body.userIds : []).map(String).filter((u) => people[u]);
        const added = transaction(() => {
          requireConversation(conv.id, user.id, true);
          let count = 0;
          for (const uid of new Set(ids)) count += addChannelMember(conv, uid, 0);
          publish(conv.id, "conversation.updated", { id: conv.id });
          return count;
        });
        send(res, 200, { ok: true, added });
        return true;
      }
      // Typing uses the shared log but expires after six seconds. Reconnects
      // never replay a stale typing indicator.
      if (sub === "typing" && method === "POST") {
        if (!isMember) return fail(res, 403, "not_member", "Join the channel first"), true;
        const body = await readBody(req);
        transaction(() => {
          requireConversation(conv.id, user.id, true);
          const now_ = now();
          const key = `${conv.id}:${user.id}`;
          if (now_ - (typingSent.get(key) || 0) >= TYPING_MIN_GAP_MS) {
            const others = st.members.all(conv.id).map(m => m.user_id).filter(u => u !== user.id);
            publish(conv.id, 'typing', { conversationId: conv.id, threadRoot: body.threadRoot ? String(body.threadRoot) : null, user: person(user.id) }, others);
            afterCommit(() => typingSent.set(key, now_));
          }
        });
        send(res, 200, { ok: true });
        return true;
      }
      if (sub === "read" && method === "POST") {
        const body = await readBody(req);
        transaction(() => {
          if (!isAuthorized()) throw httpError(401, "unauthorized", "This device is no longer paired");
          requireConversation(conv.id, user.id, true);
          const membership = st.member.get(conv.id, user.id);
          let through;
          if (body.messageIds !== undefined) {
            if (!Array.isArray(body.messageIds) || body.messageIds.length > 100 || body.messageIds.some(id => typeof id !== "string" || !/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id)))) {
              throw httpError(400, "invalid_messages", "Choose up to 100 valid message IDs");
            }
            const messages = [...new Set(body.messageIds)].map(id => st.msg.get(Number(id)));
            if (messages.some(m => !m || m.conversation_id !== conv.id)) throw httpError(400, "invalid_messages", "Messages must belong to this conversation");
            const at = now();
            const changed = [];
            through = membership.last_read_seq;
            for (const m of messages) {
              if (m.deleted_at || m.pending || m.activity) continue;
              if (!m.thread_root) through = Math.max(through, m.seq);
              if (m.user_id === user.id || m.user_id === AGENT_ID || user.id === AGENT_ID) continue;
              if (st.addRead.run(m.seq, conv.id, user.id, at).changes) changed.push(String(m.seq));
            }
            if (changed.length) publish(conv.id, "messages.read", { conversationId: conv.id, userId: user.id, messageIds: changed, readAt: at });
          } else {
            // Older clients use this only to clear their unread badge. A cursor,
            // sending a message, or joining a channel never proves a post was seen.
            through = body.seq === undefined ? st.lastSeq.get(conv.id).seq : Number(body.seq);
            if (!Number.isSafeInteger(through) || through < 0) throw httpError(400, "invalid_messages", "Invalid read position");
            through = Math.min(through, st.lastSeq.get(conv.id).seq);
          }
          if (through > membership.last_read_seq) {
            st.markRead.run(through, conv.id, user.id);
            publish(conv.id, "conversation.read", { id: conv.id }, [user.id]);
          }
        });
        send(res, 200, { ok: true });
        return true;
      }
      if (sub === "messages" && method === "GET") {
        const before = Number(url.searchParams.get("before")) || Number.MAX_SAFE_INTEGER;
        const rows = st.page.all(conv.id, before, PAGE);
        send(res, 200, { messages: rows.reverse().map(m => msgView(m, isMember, user.id)), more: rows.length === PAGE });
        return true;
      }
      if (sub === "messages" && method === "POST") {
        if (!isMember) return fail(res, 403, "not_member", "Join the channel to post"), true;
        const body = await readBody(req, MAX_UPLOAD_BODY);
        let text = String(body.text || "").trim();
        // Only the server writes forward headers; typed lookalikes don't render as one.
        if (/^Forwarded message from /.test(text)) text = `\u200B${text}`;
        const attachments = validateUploads(body.attachments);
        if (!text && !attachments.length) return fail(res, 400, "empty", "Type a message first"), true;
        if (text.length > MAX_TEXT) return fail(res, 413, "too_long", "That message is too long"), true;
        let root = null;
        if (body.threadRoot) {
          const parent = st.msg.get(Number(body.threadRoot));
          if (!parent || parent.conversation_id !== conv.id) return fail(res, 404, "not_found", "That thread is gone"), true;
          if (parent.activity) return fail(res, 400, "channel_activity", "Channel activity cannot have replies"), true;
          root = parent.thread_root || parent.seq;
        }
        const m = post(conv, user.id, text, root, { attachments, device });
        send(res, 201, { message: msgView(m, true, user.id) });
        if (!externalWorker && wantsAgent(conv, m)) agentReply(conv, m).catch((e) => console.error("[servant] agent reply", e));
        return true;
      }
      if (sub === "threads" && parts[4] && method === "GET") {
        const root = st.msg.get(Number(parts[4]));
        if (!root || root.conversation_id !== conv.id || root.thread_root) return fail(res, 404, "not_found", "That thread is gone"), true;
        send(res, 200, { root: msgView(root, isMember, user.id), replies: st.replies.all(root.seq).map(m => msgView(m, isMember, user.id)) });
        return true;
      }
    }

    if (r === "messages" && parts[2]) {
      const m = st.msg.get(Number(parts[2]));
      const conv = m && st.conv.get(m.conversation_id);
      if (!m || !canSee(conv, user.id)) return fail(res, 404, "not_found", "That message is gone"), true;
      if (m.activity) return fail(res, 403, "channel_activity", "Channel activity cannot be changed"), true;
      if (m.deleted_at) return fail(res, 404, "not_found", "That message is gone"), true;
      if (parts[3] === "reactions" && parts.length === 4 && method === "POST") {
        if (!st.member.get(conv.id, user.id)) return fail(res, 403, "not_member", "Join the channel to react"), true;
        if (m.pending) return fail(res, 409, "pending", "Wait for the message to finish"), true;
        const { emoji, active } = await readBody(req);
        if (!["👍", "❤️", "😂", "😮", "😢", "🙏", "🎉", "✅", "👀", "🔥", "👏", "💯"].includes(emoji) || typeof active !== "boolean") {
          return fail(res, 400, "invalid_reaction", "Choose a supported reaction"), true;
        }
        const v = transaction(() => {
          const current = requireMessage(m.seq, user.id, true);
          if (current.pending) throw httpError(409, 'pending', 'Wait for the message to finish');
          (active ? st.addReaction : st.removeReaction).run(m.seq, user.id, emoji);
          const value = msgView(st.msg.get(m.seq), true, user.id);
          publish(conv.id, "message.updated", value);
          return value;
        });
        send(res, 200, { message: v });
        return true;
      }
      if (parts.length !== 3) return fail(res, 404, "not_found", "Not found"), true;
      if (method === "PATCH") {
        if (m.user_id !== user.id) return fail(res, 403, "forbidden", "You can only edit your own messages"), true;
        const body = await readBody(req);
        const text = String(body.text || "").trim();
        if (!text) return fail(res, 400, "empty", "Type a message first"), true;
        const v = transaction(() => {
          const current = requireMessage(m.seq, user.id, true);
          if (current.user_id !== user.id) throw httpError(403, 'forbidden', 'You can only edit your own messages');
          st.setText.run(text.slice(0, MAX_TEXT), now(), m.seq);
          const value = msgView(st.msg.get(m.seq), true, user.id);
          publish(conv.id, "message.updated", value);
          return value;
        });
        send(res, 200, { message: v });
        return true;
      }
      if (method === "DELETE") {
        if (m.user_id !== user.id && user.role !== "owner") return fail(res, 403, "forbidden", "You can only delete your own messages"), true;
        transaction(() => {
          const current = requireMessage(m.seq, user.id);
          if (current.user_id !== user.id && users()[user.id]?.role !== 'owner') throw httpError(403, 'forbidden', 'You can only delete your own messages');
          st.softDelete.run(now(), m.seq);
          st.deleteAttachments.run(m.seq);
          st.deleteReactions.run(m.seq);
          publish(conv.id, "message.updated", msgView(st.msg.get(m.seq)));
        });
        send(res, 200, { ok: true });
        return true;
      }
    }

    fail(res, 404, "not_found", "Not found");
    return true;
  }

  // ----- hooks for features that post on the agent's behalf (meetings) -----
  const meetingHooks = {
    isMember: (conversationId, userId) => { const c = st.conv.get(conversationId); return !!c && !c.archived_at && canSee(c, userId) && !!st.member.get(conversationId, userId); },
    conversationInfo: (conversationId) => { const c = st.conv.get(conversationId); return c && { id: c.id, kind: c.kind, name: c.name || "" }; },
    roomsFor: (userId) => db.prepare("SELECT c.id, c.name FROM conversations c JOIN members m ON m.conversation_id = c.id AND m.user_id = ? WHERE c.kind = 'channel' AND c.archived_at IS NULL ORDER BY c.name").all(userId).map(c => ({ id: c.id, name: c.name })),
    agentPost: (conversationId, text, opts = {}) => { const c = st.conv.get(conversationId); if (!c) throw httpError(404, 'not_found', 'That conversation is gone'); return post(c, AGENT_ID, text.slice(0, MAX_TEXT), null, opts.call ? { call: opts.call } : {}); },
    updateAgentMessage: (seq, text) => transaction(() => {
      const m = st.msg.get(seq);
      if (!m || m.deleted_at || m.user_id !== AGENT_ID) return;
      st.setAgentText.run(text.slice(0, MAX_TEXT), 0, seq);
      publish(m.conversation_id, "message.updated", msgView(st.msg.get(seq)));
    }),
    refreshMessage: (seq) => { const m = st.msg.get(seq); if (m && !m.deleted_at) publish(m.conversation_id, "message.updated", msgView(m)); },
    notifyConversation: (conversationId) => { if (st.conv.get(conversationId)) publish(conversationId, "conversation.updated", { id: conversationId }); },
    // A tapped next step is posted as the person, in a thread under the notes,
    // and wakes the agent exactly as if they had typed it.
    postFromUser: (conversationId, user, text, threadRoot) => {
      const c = requireConversation(conversationId, user.id, true);
      const m = post(c, user.id, text.slice(0, MAX_TEXT), threadRoot || null, { queueAgent: true });
      if (!externalWorker && wantsAgent(c, m)) agentReply(c, m).catch((e) => console.error("[servant] agent reply", e));
      return m;
    },
  };

  function personChanged(userId) { publish('', 'person.updated', { userId }, Object.keys(users())); }
  return { ...meetingHooks, personChanged, handle, forwardSource, forwardInto, notificationFor, joinDefaults, joinEveryone, welcomeFromAgent, noteMemberLeft, ensureGeneral, postRelease, latestRelease, createChannel, openDm, post, agentReply, processAgentJob, recoverInterruptedJobs, drainOutbox, subscribe, whenIdle, closeEvents, close: () => { closeEvents(); db.close(); }, db };
}

function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}
