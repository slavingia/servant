// Social media (docs/social.md): the posts on X that mention the team's account or match its searches, the replies
// drafted to them, and when each approved reply goes out. Almost everything here is a reply to someone else's
// post; a post of the team's own is the same thing with nothing to answer.
//
// A reply is a draft until someone who holds the Social media entitlement approves it. Approval gives it a time:
// the next opening, so a run of approvals goes out spaced apart rather than all at once, or a time the approver
// chose. Changing an approved reply's words takes the approval away.
//
// Nothing is deleted. Every wording a reply has had is kept in `social_versions`; skipping a post and discarding a
// reply change a status. So there is no authored content here for records preservation to copy first.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { xKeys, xLength, X_API, X_POST_LIMIT } from "./x-client.mjs";

export const SOCIAL_LIMITS = { image: 5 * 1024 * 1024, post: X_POST_LIMIT, searches: 10, search: 400, page: 50, scheduleAheadMs: 366 * 86_400_000, instruction: 500 };
const fault = (status, code, message) => Object.assign(new Error(message), { status, code });
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** `"social"` in config.json. On only when the X account's four values are all there. */
export function socialSettings(raw, env = process.env) {
  const cfg = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const x = cfg.x && typeof cfg.x === "object" ? cfg.x : {};
  const keys = xKeys(x, env);
  const minutes = (value, fallback, min, max) => { const n = Number(value); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback; };
  const searches = [];
  for (const entry of Array.isArray(cfg.searches) ? cfg.searches : []) {
    const query = typeof entry === "string" ? entry.replace(CONTROL, "").replace(/\s+/g, " ").trim().slice(0, SOCIAL_LIMITS.search) : "";
    if (query && !searches.includes(query) && searches.length < SOCIAL_LIMITS.searches) searches.push(query);
  }
  return {
    configured: !!keys, keys,
    // Where X is. Only a test or a stand-in changes it.
    api: typeof x.api === "string" && /^https?:\/\//.test(x.api) ? x.api : X_API,
    searches,
    // How often X is asked for new posts, and how far apart approved replies go out.
    pollMs: minutes(cfg.pollMinutes, 5, 1, 24 * 60) * 60_000,
    spacingMs: minutes(cfg.spacingMinutes, 2, 0, 24 * 60) * 60_000,
  };
}

/** A reply's words, checked: text, not empty, within what X allows. */
export function cleanPostText(value) {
  if (typeof value !== "string") throw fault(400, "bad_request", "A reply needs its words as text");
  const text = value.replace(/\r\n?/g, "\n").replace(CONTROL, "").trim();
  if (!text) throw fault(400, "bad_request", "Write the reply before saving it");
  if (xLength(text) > SOCIAL_LIMITS.post) throw fault(413, "limit", `X allows ${SOCIAL_LIMITS.post} characters and this is ${xLength(text)}. Shorten it`);
  return text;
}

/**
 * The first moment at or after `now` that is at least `gap` away from every time in `taken` (what is already
 * waiting to go out, and when the last one went). With no gap, now.
 */
export function nextOpening(taken, now, gap) {
  let at = now;
  if (gap <= 0) return at;
  for (const time of [...taken].sort((a, b) => a - b)) {
    if (time <= at - gap) continue;
    if (time >= at + gap) break;
    at = time + gap;
  }
  return at;
}

const laterId = (a, b) => { try { return BigInt(a) > BigInt(b || "0"); } catch { return false; } };
const same = (a, b) => String(a ?? "").replace(/\s+/g, " ").trim() === String(b ?? "").replace(/\s+/g, " ").trim();
/** How long a reply may sit as "being posted" before it is taken to have been cut off. */
export const POSTING_STALE_MS = 2 * 60_000;

/**
 * The store. `names()` maps a person's id to their name, and `mayApprove(userId)` says whether that person holds
 * the Social media entitlement right now (asked again when a reply is due, so an approval does not outlive it).
 */
export function createSocial({ file, clock = Date.now, names = () => ({}), mayApprove = () => false }) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS social_posts (
      id TEXT PRIMARY KEY, network TEXT NOT NULL, remote_id TEXT NOT NULL, kind TEXT NOT NULL, search TEXT,
      author_id TEXT NOT NULL, author_handle TEXT NOT NULL, author_name TEXT NOT NULL, author_avatar TEXT NOT NULL,
      text TEXT NOT NULL, url TEXT NOT NULL, posted_at INTEGER NOT NULL, fetched_at INTEGER NOT NULL,
      likes INTEGER NOT NULL DEFAULT 0, reposts INTEGER NOT NULL DEFAULT 0, replies INTEGER NOT NULL DEFAULT 0,
      skipped_at INTEGER, skipped_by TEXT, suggestion TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS social_posts_remote ON social_posts(network, remote_id);
    CREATE INDEX IF NOT EXISTS social_posts_time ON social_posts(posted_at DESC, id);
    CREATE TABLE IF NOT EXISTS social_replies (
      id TEXT PRIMARY KEY, post_id TEXT REFERENCES social_posts(id), text TEXT NOT NULL, agent_text TEXT, status TEXT NOT NULL,
      created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_by TEXT NOT NULL, updated_at INTEGER NOT NULL,
      approved_by TEXT, approved_at INTEGER, scheduled_for INTEGER, claimed_at INTEGER, posted_at INTEGER,
      remote_id TEXT, error TEXT, lesson TEXT
    );
    CREATE INDEX IF NOT EXISTS social_replies_post ON social_replies(post_id, status);
    CREATE INDEX IF NOT EXISTS social_replies_due ON social_replies(status, scheduled_for);
    CREATE TABLE IF NOT EXISTS social_versions (reply_id TEXT NOT NULL, seq INTEGER NOT NULL, text TEXT NOT NULL, source TEXT NOT NULL, by TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(reply_id, seq));
    CREATE TRIGGER IF NOT EXISTS social_versions_no_update BEFORE UPDATE ON social_versions BEGIN SELECT RAISE(ABORT, 'reply wordings are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS social_versions_no_delete BEFORE DELETE ON social_versions BEGIN SELECT RAISE(ABORT, 'reply wordings are append-only'); END;
    CREATE TABLE IF NOT EXISTS social_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS social_images (
      id TEXT PRIMARY KEY, reply_id TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL,
      source TEXT NOT NULL, prompt TEXT, by TEXT NOT NULL, at INTEGER NOT NULL
    );
    CREATE TRIGGER IF NOT EXISTS social_images_no_update BEFORE UPDATE ON social_images BEGIN SELECT RAISE(ABORT, 'post images are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS social_images_no_delete BEFORE DELETE ON social_images BEGIN SELECT RAISE(ABORT, 'post images are append-only'); END;`);
  // The picture a post carries, if any: the id of a row in social_images. Taking a picture off clears this; the row stays.
  if (!db.prepare("PRAGMA table_info(social_replies)").all().some(c => c.name === "image_id")) db.exec("ALTER TABLE social_replies ADD COLUMN image_id TEXT");
  const imageMeta = id => id ? db.prepare("SELECT id,name,mime,size,source,prompt FROM social_images WHERE id=?").get(id) : undefined;
  const tx = work => { db.exec("BEGIN IMMEDIATE"); try { const out = work(); db.exec("COMMIT"); return out; } catch (error) { db.exec("ROLLBACK"); throw error; } };
  const kv = {
    get: key => db.prepare("SELECT value FROM social_kv WHERE key=?").get(key)?.value ?? null,
    set: (key, value) => db.prepare("INSERT INTO social_kv(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, String(value)),
  };
  const name = id => id ? names()[id] || "Former member" : null;
  // A reply that is still in play for its post: anything but a discarded one.
  const ACTIVE = "status<>'discarded'";
  const postRow = id => typeof id === "string" ? db.prepare("SELECT * FROM social_posts WHERE id=?").get(id) : undefined;
  const replyRow = id => typeof id === "string" ? db.prepare("SELECT * FROM social_replies WHERE id=?").get(id) : undefined;
  const activeFor = postId => db.prepare(`SELECT * FROM social_replies WHERE post_id=? AND ${ACTIVE} ORDER BY created_at DESC LIMIT 1`).get(postId);
  const foundPost = id => postRow(id) || (() => { throw fault(404, "not_found", "That post is no longer in Social. Go back to the list"); })();
  const foundReply = id => replyRow(id) || (() => { throw fault(404, "not_found", "That reply is no longer in Social. Go back to the list"); })();

  const replyView = (r, withPost = false) => r && ({
    id: r.id, postId: r.post_id, text: r.text, status: r.status,
    // Whether the agent wrote the first wording, and whether a person has changed it since.
    byAgent: r.agent_text !== null, edited: r.agent_text !== null && !same(r.agent_text, r.text),
    createdByName: name(r.created_by), updatedAt: r.updated_at,
    ...(r.approved_by ? { approvedByName: name(r.approved_by), approvedAt: r.approved_at } : {}),
    ...(r.scheduled_for ? { scheduledFor: r.scheduled_for } : {}),
    ...(r.posted_at ? { postedAt: r.posted_at, url: `https://x.com/i/status/${r.remote_id}` } : {}),
    ...(r.error ? { error: r.error } : {}), ...(r.lesson ? { lesson: r.lesson } : {}),
    ...(r.image_id ? (m => m ? { image: { id: m.id, name: m.name, mime: m.mime, size: m.size, byAgent: m.source === "agent", ...(m.prompt ? { prompt: m.prompt } : {}) } } : {})(imageMeta(r.image_id)) : {}),
    ...(withPost && r.post_id ? { post: postView(postRow(r.post_id), false) } : {}),
  });
  const postView = (p, withReply = true) => p && ({
    id: p.id, kind: p.kind, ...(p.search ? { search: p.search } : {}),
    author: { name: p.author_name, handle: p.author_handle, ...(p.author_avatar ? { avatar: p.author_avatar } : {}) },
    text: p.text, url: p.url, postedAt: p.posted_at, likes: p.likes, reposts: p.reposts, replies: p.replies,
    ...(p.skipped_at ? { skipped: { at: p.skipped_at, byName: name(p.skipped_by) } } : {}),
    ...(p.suggestion ? { suggestion: p.suggestion } : {}),
    ...(withReply ? { reply: replyView(activeFor(p.id)) || null } : {}),
  });
  const version = (replyId, text, source, by) => db.prepare("INSERT INTO social_versions(reply_id,seq,text,source,by,at) VALUES (?,(SELECT coalesce(max(seq),0)+1 FROM social_versions WHERE reply_id=?),?,?,?,?)")
    .run(replyId, replyId, text, source, by, clock());
  const newReply = (postId, text, source, by) => {
    const id = `sr_${crypto.randomBytes(12).toString("base64url")}`, now = clock();
    db.prepare("INSERT INTO social_replies(id,post_id,text,agent_text,status,created_by,created_at,updated_by,updated_at) VALUES (?,?,?,?,'draft',?,?,?,?)")
      .run(id, postId, text, source === "agent" ? text : null, by, now, by, now);
    version(id, text, source, by);
    return id;
  };
  // Times no other reply should go out near: what is waiting, and what went out recently.
  const taken = (now, gap, except) => db.prepare("SELECT coalesce(posted_at, scheduled_for) AS at FROM social_replies WHERE id<>? AND (status IN ('scheduled','posting') OR (status='posted' AND posted_at>=?))")
    .all(except, now - gap).map(row => row.at);

  return {
    kv,
    /**
     * Posts X sent back, kept once each. `kind` is "mention" or "search" (with the search that found it). A post
     * already here as a search match becomes a mention when it turns up as one. Returns how many were new.
     */
    keep(kind, search, posts, { ownId = "" } = {}) {
      return tx(() => {
        let added = 0;
        for (const post of posts) {
          // The account's own posts are not something to reply to.
          if (ownId && post.authorId === ownId) continue;
          const id = `x_${post.remoteId}`;
          const existing = postRow(id);
          if (existing) {
            db.prepare("UPDATE social_posts SET likes=?,reposts=?,replies=?,kind=CASE WHEN ?='mention' THEN 'mention' ELSE kind END WHERE id=?").run(post.likes, post.reposts, post.replies, kind, id);
            continue;
          }
          db.prepare(`INSERT INTO social_posts(id,network,remote_id,kind,search,author_id,author_handle,author_name,author_avatar,text,url,posted_at,fetched_at,likes,reposts,replies)
            VALUES (?,'x',?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, post.remoteId, kind, kind === "search" ? search : null, post.authorId, post.authorHandle, post.authorName, post.authorAvatar, post.text, post.url, post.postedAt, clock(), post.likes, post.reposts, post.replies);
          added += 1;
        }
        return added;
      });
    },
    /** The newest post id seen for a source, so the next request asks only for what came after. */
    cursor: source => kv.get(`since:${source}`),
    advance(source, posts) { for (const post of posts) if (laterId(post.remoteId, kv.get(`since:${source}`))) kv.set(`since:${source}`, post.remoteId); },

    /**
     * Posts, newest first. `filter`: "open" (nothing approved yet and not skipped), "drafted" (a draft is waiting for
     * approval) or "skipped". `source`: "all", "mentions" or "search". `before` pages back from a post.
     */
    posts({ filter = "open", source = "all", before = null, limit = SOCIAL_LIMITS.page } = {}) {
      const where = [], args = [];
      const reply = states => `EXISTS (SELECT 1 FROM social_replies r WHERE r.post_id=p.id AND r.status IN (${states}))`;
      if (filter === "skipped") where.push("p.skipped_at IS NOT NULL");
      else {
        where.push("p.skipped_at IS NULL", `NOT ${reply("'scheduled','posting','posted'")}`);
        if (filter === "drafted") where.push(reply("'draft','failed'"));
      }
      if (source === "mentions") where.push("p.kind='mention'");
      if (source === "search") where.push("p.kind='search'");
      const edge = before ? postRow(before) : null;
      if (edge) { where.push("(p.posted_at<? OR (p.posted_at=? AND p.id<?))"); args.push(edge.posted_at, edge.posted_at, edge.id); }
      const size = Math.max(1, Math.min(SOCIAL_LIMITS.page, Number(limit) || SOCIAL_LIMITS.page));
      const rows = db.prepare(`SELECT p.* FROM social_posts p WHERE ${where.join(" AND ")} ORDER BY p.posted_at DESC, p.id DESC LIMIT ?`).all(...args, size + 1);
      return { posts: rows.slice(0, size).map(p => postView(p)), hasMore: rows.length > size };
    },
    post: id => postView(foundPost(id)),
    reply: id => replyView(foundReply(id), true),
    /** The post and its reply as stored, for drafting. */
    raw(postId) { const post = foundPost(postId); return { post, reply: activeFor(post.id) || null }; },

    /** The agent's wording for a post: a new draft, or a new wording of the draft that is there. */
    draftByAgent(postId, text, by) {
      const clean = cleanPostText(text);
      return tx(() => {
        const post = foundPost(postId), existing = activeFor(post.id);
        if (existing && !["draft", "failed"].includes(existing.status)) throw fault(409, "conflict", "This reply was already approved. Cancel it before asking for another draft");
        if (existing) {
          db.prepare("UPDATE social_replies SET text=?,agent_text=?,status='draft',error=NULL,updated_by=?,updated_at=? WHERE id=?").run(clean, clean, by, clock(), existing.id);
          version(existing.id, clean, "agent", by);
        } else newReply(post.id, clean, "agent", by);
        db.prepare("UPDATE social_posts SET suggestion=NULL WHERE id=?").run(post.id);
        return postView(postRow(post.id));
      });
    },
    /** The agent read the post and the guide and thinks no reply is called for. Kept as a note on the post. */
    suggestSkip(postId, reason) {
      const post = foundPost(postId);
      db.prepare("UPDATE social_posts SET suggestion=? WHERE id=?").run(String(reason || "No reply needed").replace(CONTROL, "").replace(/\s+/g, " ").trim().slice(0, 200) || "No reply needed", post.id);
      return postView(postRow(post.id));
    },
    /**
     * A person writes or changes a reply. Changing one that was approved takes the approval away. With no post it is
     * a post of the team's own, and `source` is "agent" when the agent wrote it from that person's note.
     */
    write(postId, text, by, source = "person") {
      const clean = cleanPostText(text);
      return tx(() => {
        const post = postId === null ? null : foundPost(postId);
        const existing = post ? activeFor(post.id) : null;
        if (!existing) return replyView(replyRow(newReply(post?.id ?? null, clean, post ? "person" : source, by)), true);
        return replyView(replyRow(edit(existing, clean, by)), true);
      });
    },
    edit(replyId, text, by) {
      const clean = cleanPostText(text);
      return tx(() => replyView(replyRow(edit(foundReply(replyId), clean, by)), true));
    },
    /**
     * Put a picture on a reply or post, in place of any it had. `image` is { name, mime, data }; `source` is "person"
     * for one somebody attached and "agent" for one the agent made from `prompt`. Like new words, a new picture needs
     * a new approval. The picture it replaces stays in social_images.
     */
    setImage(replyId, image, by, { source = "person", prompt = "" } = {}) {
      if (!image || !Buffer.isBuffer(image.data) || !image.data.length || !/^image\/(png|jpeg|gif|webp)$/.test(image.mime || "")) throw fault(400, "attachments", "Attach a PNG, JPEG, GIF or WebP image");
      if (image.data.length > SOCIAL_LIMITS.image) throw fault(413, "too_large", `That image is larger than ${SOCIAL_LIMITS.image / 1048576} MB. Use a smaller one`);
      return tx(() => {
        const r = foundReply(replyId);
        changeable(r, "picture");
        const id = `simg_${crypto.randomBytes(12).toString("base64url")}`;
        db.prepare("INSERT INTO social_images(id,reply_id,name,mime,size,data,source,prompt,by,at) VALUES (?,?,?,?,?,?,?,?,?,?)")
          .run(id, r.id, String(image.name || "image").slice(0, 180), image.mime, image.data.length, image.data, source === "agent" ? "agent" : "person", prompt ? String(prompt).slice(0, SOCIAL_LIMITS.instruction) : null, by, clock());
        db.prepare("UPDATE social_replies SET image_id=?,status='draft',approved_by=NULL,approved_at=NULL,scheduled_for=NULL,error=NULL,updated_by=?,updated_at=? WHERE id=?").run(id, by, clock(), r.id);
        return replyView(replyRow(r.id), true);
      });
    },
    /** Take the picture off. The reply goes back to a draft; the picture's row is kept. */
    clearImage(replyId, by) {
      return tx(() => {
        const r = foundReply(replyId);
        changeable(r, "picture");
        if (r.image_id) db.prepare("UPDATE social_replies SET image_id=NULL,status='draft',approved_by=NULL,approved_at=NULL,scheduled_for=NULL,error=NULL,updated_by=?,updated_at=? WHERE id=?").run(by, clock(), r.id);
        return replyView(replyRow(r.id), true);
      });
    },
    /** The picture's bytes, for showing it: { name, mime, data }, or null when the reply has none. */
    image(replyId) {
      const r = foundReply(replyId);
      const row = r.image_id ? db.prepare("SELECT name,mime,data FROM social_images WHERE id=?").get(r.image_id) : null;
      return row ? { name: row.name, mime: row.mime, data: Buffer.from(row.data) } : null;
    },
    /**
     * Approve a reply: it goes out at `at` when given, else at the next opening `gap` away from the others.
     * The caller has already checked that `by` may approve.
     */
    approve(replyId, by, { at = null, gap = 0 } = {}) {
      return tx(() => {
        const r = foundReply(replyId), now = clock();
        if (!["draft", "failed"].includes(r.status)) throw fault(409, "conflict", r.status === "posted" ? "This reply was already posted" : r.status === "discarded" ? "This reply was discarded" : "This reply was already approved");
        cleanPostText(r.text);
        if (r.post_id && postRow(r.post_id)?.skipped_at) throw fault(409, "conflict", "This post was skipped. Bring it back before approving a reply to it");
        let when;
        if (at === null || at === undefined) when = nextOpening(taken(now, gap, r.id), now, gap);
        else {
          if (!Number.isFinite(at)) throw fault(400, "bad_request", "Choose a date and time to post this");
          if (at < now - 60_000) throw fault(400, "bad_request", "That time has passed. Choose a later one, or post at the next opening");
          if (at > now + SOCIAL_LIMITS.scheduleAheadMs) throw fault(400, "bad_request", "Choose a time within the next year");
          when = Math.max(now, Math.floor(at));
        }
        db.prepare("UPDATE social_replies SET status='scheduled',approved_by=?,approved_at=?,scheduled_for=?,error=NULL,claimed_at=NULL WHERE id=?").run(by, now, when, r.id);
        return replyView(replyRow(r.id), true);
      });
    },
    /** Take an approved reply back to a draft before it goes out. */
    cancel(replyId) {
      return tx(() => {
        const r = foundReply(replyId);
        if (r.status !== "scheduled") throw fault(409, "conflict", r.status === "posted" ? "This reply was already posted" : r.status === "posting" ? "This reply is being posted right now" : "This reply isn't waiting to be posted");
        db.prepare("UPDATE social_replies SET status='draft',approved_by=NULL,approved_at=NULL,scheduled_for=NULL WHERE id=?").run(r.id);
        return replyView(replyRow(r.id), true);
      });
    },
    discard(replyId, by) {
      return tx(() => {
        const r = foundReply(replyId);
        if (!["draft", "failed"].includes(r.status)) throw fault(409, "conflict", r.status === "posted" ? "This reply was already posted, so it can't be discarded here" : "Cancel this reply before discarding it");
        db.prepare("UPDATE social_replies SET status='discarded',updated_by=?,updated_at=? WHERE id=?").run(by, clock(), r.id);
        return { reply: replyView(replyRow(r.id), true), post: r.post_id ? postView(postRow(r.post_id)) : null };
      });
    },
    /** Skip a post: it needs no reply. A draft waiting on it is discarded; an approved reply must be cancelled first. */
    skip(postId, by) {
      return tx(() => {
        const post = foundPost(postId), existing = activeFor(post.id);
        if (existing && ["scheduled", "posting", "posted"].includes(existing.status)) throw fault(409, "conflict", existing.status === "posted" ? "This post was already replied to" : "A reply to this post is approved. Cancel it first");
        if (existing) db.prepare("UPDATE social_replies SET status='discarded',updated_by=?,updated_at=? WHERE id=?").run(by, clock(), existing.id);
        db.prepare("UPDATE social_posts SET skipped_at=?,skipped_by=? WHERE id=?").run(clock(), by, post.id);
        return postView(postRow(post.id));
      });
    },
    restore(postId) {
      const post = foundPost(postId);
      db.prepare("UPDATE social_posts SET skipped_at=NULL,skipped_by=NULL WHERE id=?").run(post.id);
      return postView(postRow(post.id));
    },

    /**
     * The next reply whose time has come, claimed for posting so that no other process posts it too. A reply whose
     * approver no longer holds the entitlement goes back to a draft instead. Null when nothing is due.
     */
    claimDue() {
      return tx(() => {
        const now = clock();
        // Cut off mid-post (a restart): whether X took it is unknown, so it is never sent again without someone looking.
        db.prepare("UPDATE social_replies SET status='failed',error='Servant stopped while this was being posted. Check the account on X before trying again' WHERE status='posting' AND claimed_at<?").run(now - POSTING_STALE_MS);
        for (const r of db.prepare("SELECT * FROM social_replies WHERE status='scheduled' AND scheduled_for<=? ORDER BY scheduled_for, created_at").all(now)) {
          if (!mayApprove(r.approved_by)) {
            db.prepare("UPDATE social_replies SET status='draft',approved_by=NULL,approved_at=NULL,scheduled_for=NULL,error=? WHERE id=?")
              .run(`${name(r.approved_by)} approved this but no longer holds Social media, so it was not posted. It needs approving again`, r.id);
            continue;
          }
          if (db.prepare("UPDATE social_replies SET status='posting',claimed_at=? WHERE id=? AND status='scheduled'").run(now, r.id).changes !== 1) continue;
          return { id: r.id, text: r.text, ...(r.image_id ? { hasImage: true } : {}), replyTo: r.post_id ? postRow(r.post_id)?.remote_id ?? null : null, isReply: !!r.post_id };
        }
        return null;
      });
    },
    posted(replyId, remoteId) { db.prepare("UPDATE social_replies SET status='posted',posted_at=?,remote_id=?,error=NULL WHERE id=? AND status='posting'").run(clock(), String(remoteId), replyId); },
    failed(replyId, message) { db.prepare("UPDATE social_replies SET status='failed',error=? WHERE id=? AND status='posting'").run(String(message).slice(0, 300), replyId); },
    /** X asked for a pause: the claimed reply goes back in line unchanged. */
    release(replyId) { db.prepare("UPDATE social_replies SET status='scheduled',claimed_at=NULL WHERE id=? AND status='posting'").run(replyId); },

    /** What the agent first wrote and what was approved, when a person changed it in between. Null otherwise. */
    correction(replyId) {
      const r = replyRow(replyId);
      return r && r.agent_text !== null && !same(r.agent_text, r.text) && !r.lesson ? { before: r.agent_text, after: r.text } : null;
    },
    learned(replyId, lesson) { db.prepare("UPDATE social_replies SET lesson=? WHERE id=?").run(lesson, replyId); },

    /** Approved replies and what became of them, with a time in [from, to): waiting, posted or failed, oldest first. */
    schedule({ from = 0, to = Number.MAX_SAFE_INTEGER } = {}) {
      return db.prepare(`SELECT * FROM social_replies WHERE status IN ('scheduled','posting','posted','failed') AND coalesce(posted_at, scheduled_for) >= ? AND coalesce(posted_at, scheduled_for) < ?
        ORDER BY coalesce(posted_at, scheduled_for), created_at LIMIT 2000`).all(Number(from) || 0, Number(to) || Number.MAX_SAFE_INTEGER).map(r => replyView(r, true));
    },
    /** Drafts of the team's own posts (not replies), newest first. */
    ownDrafts: () => db.prepare("SELECT * FROM social_replies WHERE post_id IS NULL AND status IN ('draft','failed') ORDER BY updated_at DESC LIMIT 100").all().map(r => replyView(r)),
    counts() {
      const one = sql => db.prepare(sql).get().n;
      const pending = "NOT EXISTS (SELECT 1 FROM social_replies r WHERE r.post_id=p.id AND r.status IN ('scheduled','posting','posted'))";
      return {
        open: one(`SELECT count(*) AS n FROM social_posts p WHERE p.skipped_at IS NULL AND ${pending}`),
        drafted: one(`SELECT count(*) AS n FROM social_posts p WHERE p.skipped_at IS NULL AND ${pending} AND EXISTS (SELECT 1 FROM social_replies r WHERE r.post_id=p.id AND r.status IN ('draft','failed'))`),
        scheduled: one("SELECT count(*) AS n FROM social_replies WHERE status IN ('scheduled','posting')"),
        failed: one("SELECT count(*) AS n FROM social_replies WHERE status='failed'"),
      };
    },
    versions: replyId => db.prepare("SELECT seq,text,source,by,at FROM social_versions WHERE reply_id=? ORDER BY seq").all(replyId).map(v => ({ seq: v.seq, text: v.text, source: v.source, byName: name(v.by), at: v.at })),
    close: () => db.close(),
  };

  // Words and pictures change only until a reply is on its way out.
  function changeable(r, what) {
    if (["posting", "posted", "discarded"].includes(r.status)) throw fault(409, "conflict", r.status === "posted" ? `This reply was already posted, so its ${what} can't change` : r.status === "posting" ? "This reply is being posted right now" : "This reply was discarded");
  }
  function edit(r, clean, by) {
    changeable(r, "words");
    if (clean === r.text) return r.id;
    // New words need a new approval.
    db.prepare("UPDATE social_replies SET text=?,status='draft',approved_by=NULL,approved_at=NULL,scheduled_for=NULL,error=NULL,updated_by=?,updated_at=? WHERE id=?").run(clean, by, clock(), r.id);
    version(r.id, clean, "person", by);
    return r.id;
  }
}
