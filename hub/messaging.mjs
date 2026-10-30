// Channels, direct messages and threads. People talk to each other here; the
// agent joins in when someone mentions @agent.
//
// Storage is node:sqlite (built into Node, so the hub still has no npm
// dependencies). People (users) live in the hub's state.json; this module only
// stores their ids.

import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isMention } from "./push.mjs";

export const AGENT_ID = "agent";
const MAX_TEXT = 8000;
// Every build's notes go here, one post per build, so testers can see what
// changed and talk about it in that post's thread.
export const RELEASES_CHANNEL = "whats-new";
const PAGE = 50;

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
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
CREATE TABLE IF NOT EXISTS releases (
  build TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_threads (
  key TEXT PRIMARY KEY,
  hermes_session_id TEXT NOT NULL,
  last_seen_seq INTEGER NOT NULL DEFAULT 0
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

export function mentionsAgent(text, agentName = "") {
  const t = String(text);
  if (/(^|[^\w@])@agent\b/i.test(t)) return true;
  const n = agentName.trim().split(/\s+/)[0];
  return !!n && new RegExp(`(^|[^\\w@])@${n.replace(/[^\w]/g, "")}\\b`, "i").test(t);
}

/**
 * @param {object} o
 * @param {string} o.file          sqlite file
 * @param {() => Record<string, {id:string,name:string,role:string}>} o.users  current people
 * @param {() => string} o.agentName
 * @param {(o:{sessionId:string, sessionKey:string, text:string, onDelta:(t:string)=>void, onStatus:(t:string)=>void}) => Promise<string>} o.askAgent
 */
export function createMessaging({ file, users, agentName, askAgent, onMessage = () => {} }) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  if (!db.prepare("PRAGMA table_info(members)").all().some((column) => column.name === "archived_at")) {
    db.exec("ALTER TABLE members ADD COLUMN archived_at INTEGER");
  }

  if (!db.prepare("PRAGMA table_info(messages)").all().some(column => column.name === "activity")) {
    db.exec("ALTER TABLE messages ADD COLUMN activity TEXT");
  }
  const q = (sql) => db.prepare(sql);
  const st = {
    conv: q("SELECT * FROM conversations WHERE id = ?"),
    convByName: q("SELECT * FROM conversations WHERE kind = 'channel' AND name = ?"),
    convByDm: q("SELECT * FROM conversations WHERE dm_key = ?"),
    insertConv: q("INSERT INTO conversations (id, kind, name, topic, private, dm_key, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
    member: q("SELECT * FROM members WHERE conversation_id = ? AND user_id = ?"),
    members: q("SELECT user_id FROM members WHERE conversation_id = ?"),
    addMember: q("INSERT OR IGNORE INTO members (conversation_id, user_id, joined_at, last_read_seq) VALUES (?, ?, ?, ?)"),
    removeMember: q("DELETE FROM members WHERE conversation_id = ? AND user_id = ?"),
    lastSeq: q("SELECT COALESCE(MAX(seq), 0) AS seq FROM messages WHERE conversation_id = ?"),
    insertMsg: q("INSERT INTO messages (conversation_id, user_id, thread_root, text, created_at, pending) VALUES (?, ?, ?, ?, ?, ?)"),
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
    memberCount: q("SELECT COUNT(*) AS n FROM members WHERE conversation_id = ?"),
    updateConv: q("UPDATE conversations SET name = ?, topic = ? WHERE id = ?"),
    archive: q("UPDATE conversations SET archived_at = ? WHERE id = ?"),
    archiveMember: q("UPDATE members SET archived_at = ? WHERE conversation_id = ? AND user_id = ?"),
    deleteConv: q("DELETE FROM conversations WHERE id = ?"),
    deleteAgentThreads: q("DELETE FROM agent_threads WHERE substr(key, 1, length(?) + 1) = ? || ':'"),
    publicChannels: q("SELECT id FROM conversations WHERE kind = 'channel' AND private = 0 AND archived_at IS NULL AND name = 'general'"),
    agentThread: q("SELECT * FROM agent_threads WHERE key = ?"),
    putAgentThread: q("INSERT INTO agent_threads (key, hermes_session_id, last_seen_seq) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET last_seen_seq = excluded.last_seen_seq"),
    release: q("SELECT * FROM releases WHERE build = ?"),
    releaseBySeq: q("SELECT * FROM releases WHERE seq = ?"),
    latestRelease: q("SELECT * FROM releases ORDER BY created_at DESC LIMIT 1"),
    putRelease: q("INSERT INTO releases (build, seq, created_at) VALUES (?, ?, ?)"),
    since: q(`SELECT * FROM messages WHERE conversation_id = ? AND seq > ? AND deleted_at IS NULL AND pending = 0 AND activity IS NULL
              AND ((? IS NULL AND thread_root IS NULL) OR thread_root = ? OR seq = ?) ORDER BY seq DESC LIMIT 20`),
  };

  // ----- live events -----
  /** @type {Map<string, Set<(event:string, data:any)=>void>>} */
  const listeners = new Map();
  function subscribe(userId, fn) {
    if (!listeners.has(userId)) listeners.set(userId, new Set());
    listeners.get(userId).add(fn);
    return () => listeners.get(userId)?.delete(fn);
  }
  function publish(conversationId, event, data, onlyUserIds) {
    const ids = onlyUserIds || st.members.all(conversationId).map((r) => r.user_id);
    for (const uid of ids) for (const fn of listeners.get(uid) || []) fn(event, data);
  }

  // ----- views -----
  const person = (uid) => {
    if (uid === AGENT_ID) return { id: AGENT_ID, name: agentName(), agent: true };
    const u = users()[uid];
    return u ? { id: u.id, name: u.name } : { id: uid, name: "Former member" };
  };
  const msgView = (m) => ({
    id: String(m.seq),
    activity: m.activity || undefined,
    conversationId: m.conversation_id,
    user: person(m.user_id),
    threadRoot: m.thread_root ? String(m.thread_root) : null,
    text: m.deleted_at ? "" : m.text,
    deleted: !!m.deleted_at,
    pending: !!m.pending,
    replyCount: m.reply_count,
    lastReplyAt: m.last_reply_at,
    createdAt: m.created_at,
    editedAt: m.edited_at,
  });
  function convView(c, me) {
    const memberIds = st.members.all(c.id).map((r) => r.user_id);
    let title = c.kind === "channel" ? c.name : null;
    if (c.kind === "dm") {
      const others = memberIds.filter((u) => u !== me);
      title = (others.length ? others : [me]).map((u) => person(u).name).join(", ");
    }
    const last = c.last_seq ? st.msg.get(c.last_seq) : null;
    return {
      id: c.id,
      kind: c.kind,
      name: c.name,
      title,
      topic: c.topic,
      private: !!c.private,
      createdBy: c.created_by,
      archived: !!st.member.get(c.id, me)?.archived_at,
      memberCount: memberIds.length,
      members: c.kind === "dm" || memberIds.length <= 50 ? memberIds.map(person) : undefined,
      unread: c.unread ?? 0,
      lastMessage: last ? msgView(last) : null,
      updatedAt: last ? last.created_at : c.created_at,
    };
  }

  // ----- core operations (also used by tests and the CLI) -----
  function ensureChannel(name, topic, createdBy = "system") {
    let c = st.convByName.get(name);
    if (!c) {
      const id = newId("ch");
      st.insertConv.run(id, "channel", name, topic, 0, null, createdBy, now());
      c = st.conv.get(id);
    }
    return c;
  }
  const ensureGeneral = (createdBy) => ensureChannel("general", "Everyone on this hub", createdBy);
  const ensureReleases = () => ensureChannel(RELEASES_CHANNEL, "What changed in each build and what to test. Reply in the thread");

  function joinDefaults(userId) {
    for (const c of [ensureGeneral(), ensureReleases()]) {
      addChannelMember(c, userId);
      publish(c.id, "conversation.updated", { id: c.id });
    }
  }

  const releaseView = (r) => {
    const m = r && st.msg.get(r.seq);
    if (!m || m.deleted_at) return null;
    return { build: r.build, conversationId: m.conversation_id, messageId: String(m.seq), text: m.text, createdAt: r.created_at };
  };

  // One post per build in #whats-new. Posting the same build again updates
  // that post, so iOS and Android scripts can both call this.
  function postRelease({ build, notes, authorId }) {
    build = String(build || "").trim();
    notes = String(notes || "").trim();
    if (!/^[0-9A-Za-z._-]{1,20}$/.test(build)) throw httpError(400, "bad_build", "Give a build number");
    if (!notes) throw httpError(400, "empty", "Write the notes first");
    const text = `Build ${build} is out\n\n${notes}\n\nReply here with anything you find`.slice(0, MAX_TEXT);
    const conv = ensureReleases();
    for (const uid of Object.keys(users())) addChannelMember(conv, uid);
    const existing = st.release.get(build);
    if (existing && st.msg.get(existing.seq)) {
      st.setText.run(text, now(), existing.seq);
      publish(conv.id, "message.updated", msgView(st.msg.get(existing.seq)));
      publish(conv.id, "conversation.updated", { id: conv.id });
      return { ...releaseView(existing), updated: true };
    }
    db.prepare("DELETE FROM releases WHERE build = ?").run(build);
    const m = post(conv, authorId, text);
    st.putRelease.run(build, m.seq, now());
    publish(conv.id, "conversation.updated", { id: conv.id });
    return { ...releaseView(st.release.get(build)), updated: false };
  }
  const latestRelease = () => releaseView(st.latestRelease.get());

  function channelActivity(conv, userId, action) {
    const text = `${person(userId).name} ${action === "joined" ? "joined" : "left"} the channel`;
    const result = st.insertActivity.run(conv.id, userId, text, now(), action);
    publish(conv.id, "message.created", msgView(st.msg.get(Number(result.lastInsertRowid))));
  }
  function addChannelMember(conv, userId, lastReadSeq = st.lastSeq.get(conv.id).seq) {
    const result = st.addMember.run(conv.id, userId, now(), lastReadSeq);
    if (result.changes) channelActivity(conv, userId, "joined");
    return Number(result.changes);
  }

  function post(conv, userId, text, threadRoot = null, { pending = false } = {}) {
    const r = st.insertMsg.run(conv.id, userId, threadRoot, text, now(), pending ? 1 : 0);
    const seq = Number(r.lastInsertRowid);
    if (threadRoot) st.bumpThread.run(now(), threadRoot);
    if (userId !== AGENT_ID) st.markRead.run(seq, conv.id, userId);
    const m = st.msg.get(seq);
    publish(conv.id, "message.created", msgView(m));
    if (threadRoot) publish(conv.id, "message.updated", msgView(st.msg.get(threadRoot)));
    if (!pending) onMessage({ kind: "message", messageId: String(m.seq) });
    return m;
  }

  // The agent answers in a thread under the message that mentioned it, and
  // sees the recent messages it missed in that thread (or channel) as context.
  async function agentReply(conv, trigger) {
    const root = trigger.thread_root || trigger.seq;
    const key = `${conv.id}:${root}`;
    let thread = st.agentThread.get(key);
    const sessionId = thread ? thread.hermes_session_id : `servant_${conv.id}_${root}`;
    const seen = thread ? thread.last_seen_seq : 0;
    const recent = st.since
      .all(conv.id, seen, trigger.thread_root ? root : null, root, root)
      .reverse()
      .filter((m) => m.user_id !== AGENT_ID);
    const where = conv.kind === "channel" ? `#${conv.name}` : "a direct message";
    const transcript = recent.map((m) => `${person(m.user_id).name}: ${m.text}`).join("\n");
    const prompt =
      `[Servant ${where}. Several people can read your reply. Answer the latest message that mentions you, ` +
      `briefly, in plain text.]\n\n${transcript}`;

    const reply = post(conv, AGENT_ID, "", root, { pending: true });
    let text = "";
    let lastPush = 0;
    const push = (force) => {
      if (!force && now() - lastPush < 250) return;
      lastPush = now();
      if (!st.conv.get(conv.id)) return;
      st.setAgentText.run(text, force ? 0 : 1, reply.seq);
      publish(conv.id, "message.updated", msgView(st.msg.get(reply.seq)));
    };
    try {
      const final = await askAgent({
        sessionId,
        sessionKey: `servant:${conv.id}`,
        fresh: !thread,
        text: prompt,
        onDelta: (d) => {
          text += d;
          push(false);
        },
        onStatus: () => {},
      });
      text = final || text || "I couldn't come up with an answer";
    } catch {
      text = text || "I hit a problem. Try asking again";
    }
    push(true);
    if (st.conv.get(conv.id)) {
      st.putAgentThread.run(key, sessionId, reply.seq);
      onMessage({ kind: "message", messageId: String(reply.seq) });
    }
    return st.msg.get(reply.seq);
  }

  function canSee(conv, userId) {
    if (!conv || conv.archived_at) return false;
    if (conv.kind === "channel" && !conv.private) return true;
    return !!st.member.get(conv.id, userId);
  }

  function createChannel(user, { name, topic = "", private: priv = false, memberIds = [] }) {
    const n = channelName(name);
    if (!n) throw httpError(400, "bad_name", "Give the channel a name");
    if (st.convByName.get(n)) throw httpError(409, "name_taken", `#${n} already exists`);
    const id = newId("ch");
    st.insertConv.run(id, "channel", n, String(topic).slice(0, 250), priv ? 1 : 0, null, user.id, now());
    const people = users();
    for (const uid of new Set([user.id, ...memberIds])) if (people[uid]) addChannelMember(st.conv.get(id), uid, 0);
    publish(id, "conversation.updated", { id });
    return st.conv.get(id);
  }

  function openDm(user, userIds) {
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
    }
    return c;
  }

  function notificationFor(messageId, user) {
    const m = st.msg.get(Number(messageId));
    if (!m || m.activity || m.pending || m.deleted_at || m.user_id === user.id) return null;
    const c = st.conv.get(m.conversation_id);
    const membership = c && st.member.get(c.id, user.id);
    if (!c || c.archived_at || !membership || membership.archived_at) return null;
    // No delayed push after the recipient has already read the top-level post.
    if (!m.thread_root && membership.last_read_seq >= m.seq) return null;
    const participant = !!m.thread_root && !!db.prepare("SELECT 1 FROM messages WHERE conversation_id = ? AND (seq = ? OR thread_root = ?) AND user_id = ? AND deleted_at IS NULL AND seq < ? LIMIT 1").get(c.id, m.thread_root, m.thread_root, user.id, m.seq);
    const sender = person(m.user_id).name;
    // New build notes reach everyone, like an @here.
    const release = !m.thread_root && st.releaseBySeq.get(m.seq);
    const unread = st.mine.all(user.id, 0).reduce((n, c) => n + c.unread, 0);
    // Tapping a build's notes opens its thread, where testers discuss it.
    return { kind: c.kind, conversationId: c.id, messageId: String(m.seq), threadRoot: release ? m.seq : m.thread_root,
      mentioned: !!release || isMention(m.text, user), participant, badge: Math.max(1, unread),
      title: release ? `Build ${release.build} is out` : c.kind === "channel" ? `${sender} in #${c.name}` : sender,
      body: m.text, };
  }

  // ----- HTTP -----
  async function handle(req, res, { user, method, parts, url, send, fail, readBody, cors }) {
    const r = parts[1];
    if (!["people", "conversations", "channels", "messages", "events", "releases"].includes(r)) return false;

    if (method === "GET" && r === "releases" && parts[2] === "latest" && parts.length === 3) {
      send(res, 200, { release: latestRelease() });
      return true;
    }

    if (method === "GET" && r === "people" && parts.length === 2) {
      const list = Object.values(users())
        .map((u) => ({ id: u.id, name: u.name, owner: u.role === "owner" }))
        .sort((a, b) => a.name.localeCompare(b.name));
      send(res, 200, { people: list, agent: person(AGENT_ID), me: user.id });
      return true;
    }

    // POST as well as GET: Cloudflare's quick tunnel buffers streamed GET responses
    // until they end, but passes POST streams straight through. The app uses POST.
    if ((method === "GET" || method === "POST") && r === "events") {
      res.writeHead(200, {
        ...cors,
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        Connection: "keep-alive",
      });
      res.write(`event: ready\ndata: {}\n\n`);
      const off = subscribe(user.id, (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      const keepalive = setInterval(() => res.write(": keepalive\n\n"), 15000);
      res.on("close", () => {
        off();
        clearInterval(keepalive);
      });
      return true;
    }

    if (r === "channels" && parts[2] === "browse" && method === "GET") {
      send(res, 200, {
        channels: st.browse.all(user.id).map((c) => ({ id: c.id, name: c.name, topic: c.topic, memberCount: c.member_count })),
      });
      return true;
    }

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

    if (r === "conversations" && parts[2]) {
      const conv = st.conv.get(parts[2]);
      if (!canSee(conv, user.id)) {
        fail(res, 404, "not_found", "That conversation doesn't exist or you can't see it");
        return true;
      }
      const isMember = !!st.member.get(conv.id, user.id);
      const sub = parts[3];

      if ((sub === "archive" || sub === "restore") && method === "POST") {
        if (conv.kind !== "channel" || !isMember)
          return fail(res, 403, "forbidden", "Join the channel first"), true;
        st.archiveMember.run(sub === "archive" ? now() : null, conv.id, user.id);
        publish(conv.id, "conversation.updated", { id: conv.id }, [user.id]);
        send(res, 200, { ok: true });
        return true;
      }
      if (!sub && method === "DELETE") {
        if (conv.kind !== "channel" || (conv.created_by !== user.id && user.role !== "owner"))
          return fail(res, 403, "forbidden", "Only the channel creator or hub owner can delete it"), true;
        if (conv.name === "general") return fail(res, 400, "protected_channel", "#general stays open for everyone"), true;
        const memberIds = st.members.all(conv.id).map((m) => m.user_id);
        db.exec("BEGIN");
        try {
          st.deleteConv.run(conv.id);
          st.deleteAgentThreads.run(conv.id, conv.id);
          db.exec("COMMIT");
        } catch (e) { db.exec("ROLLBACK"); throw e; }
        publish(conv.id, "conversation.updated", { id: conv.id }, memberIds);
        send(res, 200, { ok: true });
        return true;
      }

      if (!sub && method === "GET") {
        send(res, 200, { conversation: convView({ ...conv, last_seq: st.lastSeq.get(conv.id).seq }, user.id), joined: isMember });
        return true;
      }
      if (!sub && method === "PATCH") {
        if (conv.kind !== "channel" || !isMember) return fail(res, 403, "forbidden", "Only channel members can change it"), true;
        const body = await readBody(req);
        const name = body.name !== undefined ? channelName(body.name) : conv.name;
        if (!name) return fail(res, 400, "bad_name", "Give the channel a name"), true;
        if (conv.name === "general" && name !== conv.name) return fail(res, 400, "protected_channel", "#general cannot be renamed"), true;
        const clash = st.convByName.get(name);
        if (clash && clash.id !== conv.id) return fail(res, 409, "name_taken", `#${name} already exists`), true;
        st.updateConv.run(name, body.topic !== undefined ? String(body.topic).slice(0, 250) : conv.topic, conv.id);
        publish(conv.id, "conversation.updated", { id: conv.id });
        send(res, 200, { conversation: convView(st.conv.get(conv.id), user.id) });
        return true;
      }
      if (sub === "join" && method === "POST") {
        if (conv.kind !== "channel") return fail(res, 400, "bad_request", "You can only join channels"), true;
        addChannelMember(conv, user.id);
        publish(conv.id, "conversation.updated", { id: conv.id });
        send(res, 200, { ok: true });
        return true;
      }
      if (sub === "leave" && method === "POST") {
        if (conv.kind !== "channel") return fail(res, 400, "bad_request", "You can only leave channels"), true;
        if (conv.name === "general") return fail(res, 400, "bad_request", "Everyone stays in #general"), true;
        if (st.removeMember.run(conv.id, user.id).changes) channelActivity(conv, user.id, "left");
        publish(conv.id, "conversation.updated", { id: conv.id });
        publish(conv.id, "conversation.updated", { id: conv.id }, [user.id]);
        send(res, 200, { ok: true });
        return true;
      }
      if (sub === "members" && method === "POST") {
        if (!isMember || conv.kind !== "channel") return fail(res, 403, "forbidden", "Join the channel first"), true;
        const body = await readBody(req);
        const people = users();
        const ids = (Array.isArray(body.userIds) ? body.userIds : []).map(String).filter((u) => people[u]);
        let added = 0;
        for (const uid of new Set(ids)) added += addChannelMember(conv, uid, 0);
        publish(conv.id, "conversation.updated", { id: conv.id });
        send(res, 200, { ok: true, added });
        return true;
      }
      if (sub === "read" && method === "POST") {
        const body = await readBody(req);
        st.markRead.run(Number(body.seq) || st.lastSeq.get(conv.id).seq, conv.id, user.id);
        publish(conv.id, "conversation.read", { id: conv.id }, [user.id]);
        send(res, 200, { ok: true });
        return true;
      }
      if (sub === "messages" && method === "GET") {
        const before = Number(url.searchParams.get("before")) || Number.MAX_SAFE_INTEGER;
        const rows = st.page.all(conv.id, before, PAGE);
        send(res, 200, { messages: rows.reverse().map(msgView), more: rows.length === PAGE });
        return true;
      }
      if (sub === "messages" && method === "POST") {
        if (!isMember) return fail(res, 403, "not_member", "Join the channel to post"), true;
        const body = await readBody(req);
        const text = String(body.text || "").trim();
        if (!text) return fail(res, 400, "empty", "Type a message first"), true;
        if (text.length > MAX_TEXT) return fail(res, 413, "too_long", "That message is too long"), true;
        let root = null;
        if (body.threadRoot) {
          const parent = st.msg.get(Number(body.threadRoot));
          if (!parent || parent.conversation_id !== conv.id) return fail(res, 404, "not_found", "That thread is gone"), true;
          if (parent.activity) return fail(res, 400, "channel_activity", "Channel activity cannot have replies"), true;
          root = parent.thread_root || parent.seq;
        }
        const m = post(conv, user.id, text, root);
        send(res, 201, { message: msgView(m) });
        if (mentionsAgent(text, agentName())) agentReply(conv, m).catch((e) => console.error("[servant] agent reply", e));
        return true;
      }
      if (sub === "threads" && parts[4] && method === "GET") {
        const root = st.msg.get(Number(parts[4]));
        if (!root || root.conversation_id !== conv.id || root.thread_root) return fail(res, 404, "not_found", "That thread is gone"), true;
        send(res, 200, { root: msgView(root), replies: st.replies.all(root.seq).map(msgView) });
        return true;
      }
    }

    if (r === "messages" && parts[2]) {
      const m = st.msg.get(Number(parts[2]));
      const conv = m && st.conv.get(m.conversation_id);
      if (!m || !canSee(conv, user.id)) return fail(res, 404, "not_found", "That message is gone"), true;
      if (m.activity) return fail(res, 403, "channel_activity", "Channel activity cannot be changed"), true;
      if (m.deleted_at) return fail(res, 404, "not_found", "That message is gone"), true;
      if (method === "PATCH") {
        if (m.user_id !== user.id) return fail(res, 403, "forbidden", "You can only edit your own messages"), true;
        const body = await readBody(req);
        const text = String(body.text || "").trim();
        if (!text) return fail(res, 400, "empty", "Type a message first"), true;
        st.setText.run(text.slice(0, MAX_TEXT), now(), m.seq);
        const v = msgView(st.msg.get(m.seq));
        publish(conv.id, "message.updated", v);
        send(res, 200, { message: v });
        return true;
      }
      if (method === "DELETE") {
        if (m.user_id !== user.id && user.role !== "owner") return fail(res, 403, "forbidden", "You can only delete your own messages"), true;
        st.softDelete.run(now(), m.seq);
        const v = msgView(st.msg.get(m.seq));
        publish(conv.id, "message.updated", v);
        send(res, 200, { ok: true });
        return true;
      }
    }

    fail(res, 404, "not_found", "Not found");
    return true;
  }

  return { handle, notificationFor, joinDefaults, ensureGeneral, postRelease, latestRelease, createChannel, openDm, post, agentReply, subscribe, close: () => db.close(), db };
}

function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}
