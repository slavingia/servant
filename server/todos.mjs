// To-dos: the next steps that come out of a recorded meeting (or are typed in), kept as items the team
// can edit, reorder, tag with a project and a release, hand to the agent with one tap, and watch get
// finished. They are shared by default: a to-do tagged with a project is a team item that everyone in
// that project sees; until it is tagged only the person who made it (and whoever it is for) sees it.
// When a to-do is linked to a channel, new, edited and completed to-dos are posted there as quiet
// activity lines.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { jiraCsv, JIRA_DATE_FORMAT } from "./jira-export.mjs";
import { ensureRecordsSchema, preserve } from "./records-preserve.mjs";

export const STATUSES = ["open", "done"];
// The columns of the board. To do and in progress are both open; "doing" is an open to-do that has been started.
export const STAGES = ["todo", "doing", "done"];
// What a tracker needs beyond the words: a kind of work, how much it matters, and a longer write-up.
// An epic is a to-do that other to-dos belong to.
export const TYPES = ["task", "bug", "story", "epic"];
export const PRIORITIES = ["high", "medium", "low"];
export const MAX_DESCRIPTION = 5000;
export const MAX_COMMENT = 2000;
/** The letters before a to-do's number: the project's initials ("Example app" is EA), or TODO without a project. */
export function keyPrefix(projectName) {
  const words = String(projectName || "").toUpperCase().match(/[A-Z0-9]+/g) || [];
  if (!words.length) return "TODO";
  return (words.length === 1 ? words[0].slice(0, 4) : words.map(word => word[0]).join("").slice(0, 5));
}
export const MAX_TEXT = 300;
export const MAX_LIST = 500;
/** An edit posts to the channel at most this often per to-do, so fixing a typo twice isn't two lines. */
export const EDIT_POST_GAP_MS = 60_000;
const STARTING = "starting";
export const DONE_TAG = /^ {0,3}<servant-todo-done[ \t]*\/>[ \t]*$/i;

const fault = (status, code, message) => Object.assign(new Error(message), { status, code });
const plain = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const newId = () => `todo_${crypto.randomBytes(9).toString("base64url")}`;
const fold = s => String(s ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();

/** Does this reply say the work is finished? Returns the reply without the tag, and whether it was there. */
export function readDoneTag(text) {
  const value = String(text ?? "");
  const lines = value.trimEnd().split(/\r?\n/);
  if (!DONE_TAG.test(lines.at(-1) || "")) return { done: false, text: value };
  let fence = null;
  for (const line of lines.slice(0, -1)) {
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) continue;
    if (!fence) fence = match[1];
    else if (match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim()) fence = null;
  }
  return fence ? { done: false, text: value } : { done: true, text: lines.slice(0, -1).join("\n").trimEnd() };
}

/** The line the agent is given when a to-do is handed over. */
export function agentBrief({ todo, projectName, releaseName, source }) {
  const where = [projectName && `the ${projectName} project`, releaseName && `the ${releaseName} release`].filter(Boolean).join(", ");
  return [
    `${todo.text}${todo.assigneeName ? ` (for ${todo.assigneeName})` : ""}`,
    "",
    `This is a to-do${where ? ` in ${where}` : ""}${source ? `, from ${source}` : ""}. Start on it, or tell me what you need.`,
    "",
    "When the work is fully finished, end your final message with <servant-todo-done/> on its own line. " +
      "If it isn't finished, or you need something from the person, leave that out.",
  ].join("\n");
}

/**
 * @param {object} o
 * @param {string} o.file                          sqlite file
 * @param {() => Record<string,{id:string,name:string,role?:string}>} o.users
 * @param {(user:any, projectId:string, releaseId?:string|null) => {projectName:string, releaseName:string, canWrite:boolean}|null} o.project
 *        what this person may do in that project and the names of it and the release; null when they can't see it,
 *        or the release isn't in the project
 * @param {(userId:string, channelId:string) => {name:string}|null} o.channel        null unless they are in that channel
 * @param {(channelId:string, userId:string, text:string) => void} o.announce       post a quiet activity line there
 * @param {(user:any, chatId:string) => boolean} o.canReadChat
 * @param {(o:{userId:string, deviceId?:string, title:string, where:string, transcript:string, projectId?:string, beforeEnqueue:(chat:{id:string}) => void}) => Promise<{id:string}>} o.startWork
 */
export function createTodos({ file, db: suppliedDb, legacyFile, users, project, channel, announce, startWork, canReadChat = () => false, recordsPreservation = () => false, features = () => ({}), now = Date.now, log = console }) {
  if (!suppliedDb) fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = suppliedDb || new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout=5000");
  if (!suppliedDb) db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
    CREATE TABLE IF NOT EXISTS todos (
      id TEXT PRIMARY KEY, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', position REAL NOT NULL,
      created_by TEXT NOT NULL, assignee_id TEXT, assignee_name TEXT,
      project_id TEXT, release_id TEXT, channel_id TEXT,
      source_kind TEXT, source_id TEXT, source_title TEXT, chat_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, done_at INTEGER, done_by TEXT, last_posted_at INTEGER,
      completion_id TEXT
    );
    CREATE INDEX IF NOT EXISTS todos_project ON todos(project_id, release_id);
    CREATE INDEX IF NOT EXISTS todos_source ON todos(source_kind, source_id);
    CREATE INDEX IF NOT EXISTS todos_chat ON todos(chat_id);
    CREATE TABLE IF NOT EXISTS todo_migrations (name TEXT PRIMARY KEY, completed_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS todo_recording_imports (recording_id TEXT PRIMARY KEY, imported_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS todo_completions (
      id TEXT PRIMARY KEY, todo_id TEXT NOT NULL, created_at INTEGER NOT NULL, completed_at INTEGER NOT NULL,
      created_by TEXT NOT NULL, assignee_id TEXT, actor_kind TEXT NOT NULL, actor_id TEXT, reopened_at INTEGER,
      origin_kind TEXT
    );
    CREATE INDEX IF NOT EXISTS todo_completions_task ON todo_completions(todo_id);
    CREATE INDEX IF NOT EXISTS todo_completions_creator ON todo_completions(created_by, completed_at);
    CREATE INDEX IF NOT EXISTS todo_completions_assignee ON todo_completions(assignee_id, completed_at);
    CREATE INDEX IF NOT EXISTS todo_completions_actor ON todo_completions(actor_id, completed_at);
    CREATE TRIGGER IF NOT EXISTS todo_completions_no_delete BEFORE DELETE ON todo_completions
      BEGIN SELECT RAISE(ABORT, 'To-do completion history cannot be deleted'); END;
    CREATE TRIGGER IF NOT EXISTS todo_completions_no_rewrite
      BEFORE UPDATE OF id, todo_id, created_at, completed_at, created_by, assignee_id, actor_kind, actor_id, origin_kind ON todo_completions
      BEGIN SELECT RAISE(ABORT, 'To-do completion history cannot be rewritten'); END;
    CREATE TRIGGER IF NOT EXISTS todo_completions_reopen_once BEFORE UPDATE OF reopened_at ON todo_completions
      WHEN OLD.reopened_at IS NOT NULL OR NEW.reopened_at IS NULL
      BEGIN SELECT RAISE(ABORT, 'A to-do reopening cannot be rewritten'); END;
    CREATE TABLE IF NOT EXISTS todo_agent_completions (
      chat_id TEXT NOT NULL, completion_key TEXT NOT NULL, completed_at INTEGER NOT NULL,
      PRIMARY KEY(chat_id, completion_key)
    );`);
    if (!db.prepare("PRAGMA table_info(todos)").all().some(c => c.name === "completion_id")) db.exec("ALTER TABLE todos ADD COLUMN completion_id TEXT");
    // The board: when a to-do is due (its own date; without one, its release's), and when work on it began.
    // An open to-do that has been started is "in progress"; nothing else about a to-do's status changes.
    if (!db.prepare("PRAGMA table_info(todos)").all().some(c => c.name === "due_date")) db.exec("ALTER TABLE todos ADD COLUMN due_date TEXT");
    if (!db.prepare("PRAGMA table_info(todos)").all().some(c => c.name === "started_at")) db.exec("ALTER TABLE todos ADD COLUMN started_at INTEGER");
    // The tracker: a number that never changes (shown with the project's initials, "EA-42"), a kind, a priority, an
    // estimate, a longer description, the epic it belongs to, and the key of its issue in Jira once it has one.
    const columns = () => db.prepare("PRAGMA table_info(todos)").all().map(c => c.name);
    for (const [name, kind] of [["number", "INTEGER"], ["type", "TEXT"], ["priority", "TEXT"], ["estimate", "REAL"], ["description", "TEXT"], ["parent_id", "TEXT"], ["jira_key", "TEXT"]]) {
      if (!columns().includes(name)) db.exec(`ALTER TABLE todos ADD COLUMN ${name} ${kind}`);
    }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS todos_number ON todos(number);
      CREATE INDEX IF NOT EXISTS todos_parent ON todos(parent_id);
      CREATE TABLE IF NOT EXISTS todo_comments (id TEXT PRIMARY KEY, todo_id TEXT NOT NULL, author_id TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS todo_comments_todo ON todo_comments(todo_id, created_at);`);
    // The work log keeps what the board knew when a to-do was finished: when work on it began and when it was due.
    // Like the rest of a completion, neither can be rewritten afterwards.
    if (!db.prepare("PRAGMA table_info(todo_completions)").all().some(c => c.name === "started_at")) db.exec("ALTER TABLE todo_completions ADD COLUMN started_at INTEGER");
    if (!db.prepare("PRAGMA table_info(todo_completions)").all().some(c => c.name === "due_date")) db.exec("ALTER TABLE todo_completions ADD COLUMN due_date TEXT");
    db.exec(`CREATE TRIGGER IF NOT EXISTS todo_completions_no_rewrite_board BEFORE UPDATE OF started_at, due_date ON todo_completions
      BEGIN SELECT RAISE(ABORT, 'To-do completion history cannot be rewritten'); END;`);
    // Adopt the earlier standalone store once, without changing or deleting it.
    // The receipt lives in the same transaction as the copy, so a retry cannot
    // resurrect a task somebody deleted after the successful migration.
    if (legacyFile && !db.prepare("SELECT 1 FROM todo_migrations WHERE name = 'standalone_v1'").get()) {
      if (fs.existsSync(legacyFile)) {
        const legacy = new DatabaseSync(legacyFile, { readOnly: true });
        try {
          if (legacy.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'todos'").get()) {
            const columns = ["id", "text", "status", "position", "created_by", "assignee_id", "assignee_name", "project_id", "release_id", "channel_id", "source_kind", "source_id", "source_title", "chat_id", "created_at", "updated_at", "done_at", "done_by", "last_posted_at"];
            const insert = db.prepare(`INSERT OR IGNORE INTO todos (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
            for (const todo of legacy.prepare(`SELECT ${columns.join(",")} FROM todos`).all()) insert.run(...columns.map(column => todo[column]));
          }
        } finally { legacy.close(); }
      }
      db.prepare("INSERT INTO todo_migrations VALUES ('standalone_v1', ?)").run(now());
    }
    // Remember prior imports independently of their current tasks. Otherwise
    // reopening a recording after deleting its last task would recreate it.
    db.prepare(`INSERT OR IGNORE INTO todo_recording_imports (recording_id, imported_at)
      SELECT source_id, ? FROM todos WHERE source_kind = 'recording' AND source_id IS NOT NULL GROUP BY source_id`).run(now());
    // Legacy done_at is the actual known completion time. Never substitute an
    // edit time or migration time when an older completed task has no evidence.
    for (const todo of db.prepare("SELECT * FROM todos WHERE status = 'done' AND done_at IS NOT NULL AND completion_id IS NULL").all()) {
      const id = `done_${crypto.randomBytes(9).toString("base64url")}`;
      const kind = todo.done_by === "agent" ? "agent" : todo.done_by ? "person" : "unknown";
      db.prepare("INSERT INTO todo_completions (id,todo_id,created_at,completed_at,created_by,assignee_id,actor_kind,actor_id,origin_kind) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(id, todo.id, todo.created_at, todo.done_at, todo.created_by, todo.assignee_id, kind, kind === "person" ? todo.done_by : null,
          ["recording", "call"].includes(todo.source_kind) ? todo.source_kind : null);
      db.prepare("UPDATE todos SET completion_id = ? WHERE id = ?").run(id, todo.id);
    }
    // Every to-do has a number, in the order they were written: those from before the tracker and any just imported.
    {
      let next = db.prepare("SELECT COALESCE(MAX(number), 0) AS n FROM todos").get().n;
      for (const row of db.prepare("SELECT id FROM todos WHERE number IS NULL ORDER BY created_at, rowid").all()) db.prepare("UPDATE todos SET number = ? WHERE id = ?").run(++next, row.id);
    }
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); if (!suppliedDb) db.close(); throw e; }

  let inTransaction = false;
  let afterCommit = [];
  function transaction(work) {
    if (inTransaction) return work();
    db.exec("BEGIN IMMEDIATE");
    inTransaction = true;
    let result, callbacks;
    try { result = work(); db.exec("COMMIT"); callbacks = afterCommit; }
    catch (e) { db.exec("ROLLBACK"); throw e; }
    finally { inTransaction = false; afterCommit = []; }
    for (const callback of callbacks) { try { callback(); } catch (e) { log.error("[servant] to-do update not posted:", e.message); } }
    return result;
  }

  function keep(todo, event, actorId) {
    if (!recordsPreservation()) return;
    try {
      ensureRecordsSchema(db);
      preserve(db, { event, conversation_id: todo.id, conversation_kind: "todo", author_id: todo.created_by,
        actor_id: actorId || null, text: todo.text, created_at: todo.created_at, detail: { ...todo, ...(event === "todo_changed" || event === "todo_completed" ? {} : { comments: db.prepare("SELECT * FROM todo_comments WHERE todo_id = ? ORDER BY created_at, rowid").all(todo.id) }) } }, [], now());
    } catch { throw fault(503, "records_preservation_failed", "This to-do could not be changed because its record could not be saved. Try again."); }
  }
  const q = s => db.prepare(s);
  const st = {
    get: q("SELECT * FROM todos WHERE id = ?"),
    all: q("SELECT * FROM todos ORDER BY position, created_at, id LIMIT ?"),
    bySource: q("SELECT * FROM todos WHERE source_kind = ? AND source_id = ? ORDER BY position, id"),
    byChat: q("SELECT * FROM todos WHERE chat_id = ?"),
    commentCount: q("SELECT COUNT(*) AS n FROM todo_comments WHERE todo_id = ?"),
    comments: q("SELECT * FROM todo_comments WHERE todo_id = ? ORDER BY created_at, rowid"),
    addComment: q("INSERT INTO todo_comments (id, todo_id, author_id, text, created_at) VALUES (?,?,?,?,?)"),
    delComments: q("DELETE FROM todo_comments WHERE todo_id = ?"),
    children: q("SELECT COUNT(*) AS n FROM todos WHERE parent_id = ?"),
    childRows: q("SELECT * FROM todos WHERE parent_id = ?"),
    maxPos: q("SELECT COALESCE(MAX(position), 0) AS p FROM todos"),
    insert: q(`INSERT INTO todos (id, text, position, created_by, assignee_id, assignee_name, project_id, release_id, channel_id,
      source_kind, source_id, source_title, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`),
    del: q("DELETE FROM todos WHERE id = ?"),
    setPos: q("UPDATE todos SET position = ? WHERE id = ?"),
    claimChat: q("UPDATE todos SET chat_id = ?, updated_at = ? WHERE id = ? AND chat_id IS NULL AND status = 'open'"),
    freeChat: q("UPDATE todos SET chat_id = NULL WHERE id = ? AND chat_id = ?"),
    posted: q("UPDATE todos SET last_posted_at = ? WHERE id = ?"),
    completion: q("INSERT INTO todo_completions (id,todo_id,created_at,completed_at,created_by,assignee_id,actor_kind,actor_id,origin_kind,started_at,due_date) VALUES (?,?,?,?,?,?,?,?,?,?,?)"),
    reopened: q("UPDATE todo_completions SET reopened_at = ? WHERE id = ? AND reopened_at IS NULL"),
    workLog: q("SELECT * FROM todo_completions WHERE created_by = ? OR assignee_id = ? OR (actor_kind = 'person' AND actor_id = ?) ORDER BY completed_at DESC, rowid DESC"),
    agentCompletion: q("SELECT 1 FROM todo_agent_completions WHERE chat_id = ? AND completion_key = ?"),
    recordAgentCompletion: q("INSERT INTO todo_agent_completions VALUES (?, ?, ?)"),
    recordingImported: q("SELECT 1 FROM todo_recording_imports WHERE recording_id = ?"),
    importRecording: q("INSERT INTO todo_recording_imports VALUES (?, ?)"),
  };
  const person = id => users()[id] || null;
  // Hand-offs in flight, by to-do id: a second tap while the first is still starting the chat waits for it and gets the same chat.
  const starting = new Map();
  const hidden = todo => ["recording", "call"].includes(todo?.source_kind) && features().meetings === false;

  /** Can this person see this to-do? */
  function canSee(todo, user) {
    if (!user || hidden(todo)) return false;
    if (user.role === "owner" || todo.created_by === user.id || todo.assignee_id === user.id) return true;
    return !!todo.project_id && !!project(user, todo.project_id);
  }
  /** The board's column for a to-do: done, in progress (open and begun), or to do. */
  const stageOf = todo => todo.status === "done" ? "done" : todo.started_at ? "doing" : "todo";
  /** A due date as YYYY-MM-DD for a real day, or none. */
  function cleanDue(value) {
    if (value === undefined || value === null || value === "") return null;
    const match = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim()) : null;
    const day = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
    if (!day || day.getUTCFullYear() !== Number(match[1]) || day.getUTCMonth() !== Number(match[2]) - 1 || day.getUTCDate() !== Number(match[3]) || Number(match[1]) < 2000 || Number(match[1]) > 2100) {
      throw fault(400, "bad_request", "Give the due date as a day, like 2026-11-20");
    }
    return value.trim();
  }

  /** Can they change it? The author, whoever it's for, a project writer, and the owner. */
  function canEdit(todo, user) {
    if (!user) return false;
    if (user.role === "owner" || todo.created_by === user.id || todo.assignee_id === user.id) return true;
    return !!todo.project_id && !!project(user, todo.project_id)?.canWrite;
  }

  function completed(todo, actorId, at) {
    const id = `done_${crypto.randomBytes(9).toString("base64url")}`;
    const kind = actorId === "agent" ? "agent" : actorId ? "person" : "unknown";
    st.completion.run(id, todo.id, todo.created_at, at, todo.created_by, todo.assignee_id, kind, kind === "person" ? actorId : null,
      ["recording", "call"].includes(todo.source_kind) ? todo.source_kind : null, todo.started_at ?? null, dueAtCompletion(todo));
    return id;
  }
  /** The day a to-do was due when it was finished: its own, or its release's as its author sees the release. */
  function dueAtCompletion(todo) {
    if (todo.due_date) return todo.due_date;
    const author = person(todo.created_by);
    if (!author || !todo.project_id || !todo.release_id) return null;
    try { return project({ id: todo.created_by, ...author }, todo.project_id, todo.release_id)?.releaseDate || null; } catch { return null; }
  }

  function workLog(user) {
    if (!user?.id || !person(user.id)) return [];
    return st.workLog.all(user.id, user.id, user.id).map(entry => {
      const todo = st.get.get(entry.todo_id);
      const originKind = entry.origin_kind;
      const flags = features();
      const allowed = todo && canSee(todo, user) && !(originKind && flags.meetings === false);
      const p = allowed && todo.project_id ? project(user, todo.project_id, todo.release_id) : null;
      const c = allowed && flags.channels !== false && todo.channel_id ? channel(user.id, todo.channel_id) : null;
      return {
        kind: "todo", id: `todo:${entry.id}`, at: entry.completed_at, todoId: entry.todo_id, createdAt: entry.created_at,
        reopenedAt: entry.reopened_at, originKind,
        // What the board knew at that moment: when work began (if it was ever moved to In progress) and the day it was due.
        startedAt: entry.started_at ?? null, due: entry.due_date || null,
        completedBy: entry.actor_kind === "person" ? { kind: "person", id: entry.actor_id, ...(person(entry.actor_id)?.name ? { name: person(entry.actor_id).name } : {}) }
          : { kind: entry.actor_kind === "agent" ? "agent" : "unknown" },
        source: allowed ? { text: todo.text, projectId: p ? todo.project_id : null, projectName: p?.projectName || null,
          releaseId: p ? todo.release_id || null : null, releaseName: p?.releaseName || null,
          channelId: c ? todo.channel_id : null, channelName: c?.name || null } : null,
      };
    });
  }

  function view(todo, user) {
    const p = todo.project_id ? project(user, todo.project_id, todo.release_id) : null;
    const c = features().channels !== false && todo.channel_id ? channel(user.id, todo.channel_id) : null;
    return {
      id: todo.id, text: todo.text, status: todo.status, position: todo.position,
      assignee: todo.assignee_name || todo.assignee_id ? { id: todo.assignee_id || undefined, name: todo.assignee_name || person(todo.assignee_id)?.name || "Someone" } : null,
      projectId: p ? todo.project_id : null, projectName: p?.projectName || null,
      releaseId: p ? todo.release_id || null : null, releaseName: p?.releaseName || null,
      channelId: c ? todo.channel_id : null, channelName: c?.name || null,
      source: todo.source_kind && todo.created_by === user.id ? { kind: todo.source_kind, id: todo.source_id, title: todo.source_title || "" } : null,
      chatId: todo.chat_id && todo.chat_id !== STARTING && canReadChat(user, todo.chat_id) ? todo.chat_id : null, withAgent: !!todo.chat_id && todo.status !== "done",
      createdBy: todo.created_by, createdByName: person(todo.created_by)?.name || "Someone",
      createdAt: todo.created_at, updatedAt: todo.updated_at, doneAt: todo.done_at || null,
      doneBy: todo.done_by === "agent" ? "agent" : todo.done_by ? person(todo.done_by)?.name || "Someone" : null,
      canEdit: canEdit(todo, user),
      // The board's column, and when it is due: its own date, or its release's when it has none of its own.
      stage: stageOf(todo),
      dueDate: todo.due_date || null,
      due: todo.due_date || (p?.releaseDate || null),
      dueFrom: todo.due_date ? "own" : p?.releaseDate ? "release" : null,
      // The tracker's fields.
      number: todo.number, key: `${keyPrefix(p?.projectName)}-${todo.number}`,
      type: TYPES.includes(todo.type) ? todo.type : "task", priority: todo.priority || null, estimate: todo.estimate ?? null,
      description: todo.description || "", jiraKey: todo.jira_key || null,
      ...epicOf(todo, user),
      commentCount: st.commentCount.get(todo.id).n,
    };
  }
  /** The epic a to-do belongs to, named only for someone who can see that epic. */
  function epicOf(todo, user) {
    const parent = todo.parent_id ? st.get.get(todo.parent_id) : null;
    return parent && canSee(parent, user) ? { parentId: parent.id, parentText: parent.text } : { parentId: null, parentText: null };
  }
  function cleanType(value) {
    if (value === undefined || value === null || value === "") return "task";
    if (!TYPES.includes(value)) throw fault(400, "bad_request", "A to-do is a task, a bug, a story or an epic");
    return value;
  }
  function cleanPriority(value) {
    if (value === undefined || value === null || value === "") return null;
    if (!PRIORITIES.includes(value)) throw fault(400, "bad_request", "Priority is high, medium or low");
    return value;
  }
  function cleanEstimate(value) {
    if (value === undefined || value === null || value === "") return null;
    const points = typeof value === "number" ? value : Number(String(value).trim());
    if (!Number.isFinite(points) || points < 0 || points > 1000) throw fault(400, "bad_request", "Give the estimate as a number of points, like 3");
    return Math.round(points * 100) / 100;
  }
  const cleanDescription = value => String(value ?? "").replace(/\r\n?/g, "\n").trim().slice(0, MAX_DESCRIPTION) || null;
  /** A Jira issue key as Jira writes it: PROJ-123. */
  function cleanJiraKey(value) {
    if (value === undefined || value === null || value === "") return null;
    const key = String(value).trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9_]{1,19}-[1-9][0-9]{0,8}$/.test(key)) throw fault(400, "bad_request", "A Jira key looks like APP-42");
    return key;
  }
  /** The epic a to-do is put under: an epic this person can see, and never the to-do itself or another epic's child. */
  function cleanParent(user, value, self, type) {
    if (!value) return null;
    if (type === "epic") throw fault(400, "bad_request", "An epic cannot belong to another epic");
    const parent = st.get.get(String(value));
    if (!parent || parent.id === self || !canSee(parent, user)) throw fault(404, "not_found", "No such epic");
    if (parent.type !== "epic") throw fault(400, "bad_request", "Choose an epic");
    return parent.id;
  }

  const mine = (id, user, needEdit = false) => {
    const todo = typeof id === "string" && st.get.get(id);
    if (!todo || !canSee(todo, user)) throw fault(404, "not_found", "That to-do is gone");
    if (needEdit && !canEdit(todo, user)) throw fault(403, "forbidden", "You can't change this to-do");
    return todo;
  };

  /** Checks a project and a release tag before it is stored. Returns the cleaned pair. */
  function cleanTags(user, projectId, releaseId) {
    const pid = projectId ? String(projectId) : null;
    const rid = releaseId ? String(releaseId) : null;
    if (rid && !pid) throw fault(400, "bad_request", "Choose a project before a release");
    if (pid && !project(user, pid, rid)) throw fault(404, "not_found", rid ? "That release isn't in this project" : "No such project");
    return { pid, rid };
  }
  function cleanChannel(user, channelId) {
    if (!channelId) return null;
    if (features().channels === false || !channel(user.id, String(channelId))) throw fault(403, "forbidden", "Join that channel to post updates there");
    return String(channelId);
  }
  /** Names a person gave for who it's for ("Bo") match a Servant user by full name or a unique first name. */
  function matchPerson(name) {
    const key = fold(name);
    if (!key) return null;
    const all = Object.values(users());
    const exact = all.filter(u => fold(u.name) === key);
    if (exact.length === 1) return exact[0];
    const first = all.filter(u => fold(u.name).split(/\s+/)[0] === key);
    return first.length === 1 ? first[0] : null;
  }
  function cleanAssignee(body) {
    if (body.assigneeId) {
      const u = person(String(body.assigneeId));
      if (!u) throw fault(400, "bad_request", "No such person");
      return { id: u.id, name: u.name };
    }
    const name = plain(body.assigneeName, 60);
    if (!name) return { id: null, name: null };
    const hit = matchPerson(name);
    return hit ? { id: hit.id, name: hit.name } : { id: null, name };
  }

  // ----- channel updates: new, edited, completed (and reopened) -----
  function line(verb, todo, actor) {
    const p = todo.project_id ? project(actor, todo.project_id, todo.release_id) : null;
    const tags = [p?.projectName, p?.releaseName].filter(Boolean).join(" · ");
    const forWho = todo.assignee_name ? ` for ${todo.assignee_name}` : "";
    return `${verb}: ${todo.text}${tags ? ` · ${tags}` : ""}${forWho}`;
  }
  function tell(todo, actorId, verb, { debounce = false } = {}) {
    if (inTransaction) { afterCommit.push(() => tell(todo, actorId, verb, { debounce })); return; }
    if (!todo.channel_id || features().channels === false || hidden(todo)) return;
    const t = now();
    if (debounce && todo.last_posted_at && t - todo.last_posted_at < EDIT_POST_GAP_MS) return;
    const actor = actorId === "agent" ? person(todo.created_by) : person(actorId);
    if (!actor) return;
    const by = actorId === "agent" ? "The agent" : actor.name;
    const sentence = verb === "completed" && actorId === "agent" ? `The agent completed a to-do for ${actor.name}` : `${by} ${verb} a to-do`;
    try {
      announce(todo.channel_id, actorId === "agent" ? todo.created_by : actorId, line(sentence, todo, actor));
      st.posted.run(t, todo.id);
    } catch (e) { log.error("[servant] to-do update not posted:", e.message); }
  }

  // ----- create / list / change -----
  function create(...args) { return transaction(() => createInTransaction(...args)); }
  function createInTransaction(user, body = {}, { source } = {}) {
    const text = plain(body.text, MAX_TEXT);
    if (!text) throw fault(400, "bad_request", "Write what needs doing");
    const { pid, rid } = cleanTags(user, body.projectId, body.releaseId);
    const channelId = cleanChannel(user, body.channelId);
    const who = cleanAssignee(body);
    const dueDate = cleanDue(body.dueDate);
    const type = cleanType(body.type), priority = cleanPriority(body.priority), estimate = cleanEstimate(body.estimate);
    const description = cleanDescription(body.description), parentId = cleanParent(user, body.parentId, null, type);
    const t = now();
    const id = newId();
    st.insert.run(id, text, st.maxPos.get().p + 1, user.id, who.id, who.name, pid, rid, channelId,
      source?.kind || null, source?.id || null, source?.title || null, t, t);
    if (dueDate) db.prepare("UPDATE todos SET due_date = ? WHERE id = ?").run(dueDate, id);
    db.prepare("UPDATE todos SET number = (SELECT COALESCE(MAX(number), 0) + 1 FROM todos), type = ?, priority = ?, estimate = ?, description = ?, parent_id = ? WHERE id = ?")
      .run(type, priority, estimate, description, parentId, id);
    const todo = st.get.get(id);
    tell(todo, user.id, "added");
    return view(st.get.get(id), user);
  }

  function list(user, { project: pid, release: rid, source, status = "open", mine: onlyMine, epic } = {}) {
    const [kind, sid] = typeof source === "string" ? source.split(":") : [];
    const rows = (kind && sid ? st.bySource.all(kind, sid) : st.all.all(MAX_LIST))
      .filter(t => canSee(t, user)
        && (!pid || t.project_id === pid) && (!rid || t.release_id === rid)
        && (status === "all" || t.status === status) && (!epic || t.parent_id === epic || t.id === epic)
        && (!onlyMine || t.created_by === user.id || t.assignee_id === user.id));
    return rows.map(t => view(t, user));
  }

  function update(...args) { return transaction(() => updateInTransaction(...args)); }
  function updateInTransaction(user, id, body = {}) {
    const todo = mine(id, user, true);
    const next = { ...todo };
    const changed = [];
    if ("text" in body) {
      const text = plain(body.text, MAX_TEXT);
      if (!text) throw fault(400, "bad_request", "A to-do needs some words");
      if (text !== todo.text) { next.text = text; changed.push("text"); }
    }
    if ("assigneeId" in body || "assigneeName" in body) {
      const who = cleanAssignee(body);
      if (who.id !== todo.assignee_id || who.name !== todo.assignee_name) { next.assignee_id = who.id; next.assignee_name = who.name; changed.push("assignee"); }
    }
    if ("projectId" in body || "releaseId" in body) {
      const projectId = "projectId" in body ? body.projectId : todo.project_id;
      // Moving to another project clears the release unless a new one is named.
      const releaseId = "releaseId" in body ? body.releaseId : (projectId === todo.project_id ? todo.release_id : null);
      const { pid, rid } = cleanTags(user, projectId, releaseId);
      if (pid !== todo.project_id || rid !== todo.release_id) { next.project_id = pid; next.release_id = rid; changed.push("tags"); }
    }
    let channelAdded = false;
    if ("channelId" in body) {
      const channelId = cleanChannel(user, body.channelId);
      if (channelId !== todo.channel_id) { next.channel_id = channelId; channelAdded = !!channelId && !todo.channel_id; }
    }
    // The tracker's fields. Each is checked, and counts as an edit only when it really changes.
    const tracked = [
      ["type", "type", () => cleanType(body.type), todo.type || "task"],
      ["priority", "priority", () => cleanPriority(body.priority), todo.priority || null],
      ["estimate", "estimate", () => cleanEstimate(body.estimate), todo.estimate ?? null],
      ["description", "description", () => cleanDescription(body.description), todo.description || null],
      ["jiraKey", "jira_key", () => cleanJiraKey(body.jiraKey), todo.jira_key || null],
    ];
    for (const [field, column, clean, before] of tracked) {
      if (!(field in body)) continue;
      const value = clean();
      if (value !== before) { next[column] = value; changed.push(field); }
    }
    if ((next.type || "task") === "epic" && (todo.type || "task") !== "epic" && !("parentId" in body) && todo.parent_id) { next.parent_id = null; changed.push("parent"); }
    if ((todo.type || "task") === "epic" && (next.type || "task") !== "epic" && st.children.get(todo.id).n) throw fault(409, "todo", "Move its to-dos to another epic first");
    if ("parentId" in body) {
      const parentId = cleanParent(user, body.parentId, todo.id, next.type || "task");
      if (parentId !== (todo.parent_id || null)) { next.parent_id = parentId; changed.push("parent"); }
    }
    if ("dueDate" in body) {
      const dueDate = cleanDue(body.dueDate);
      if (dueDate !== (todo.due_date || null)) { next.due_date = dueDate; changed.push("due"); }
    }
    // Moving a card on the board: to do and in progress are both open; done is done.
    let stageChange = false;
    if ("stage" in body) {
      if (!STAGES.includes(body.stage)) throw fault(400, "bad_request", "A to-do is to do, in progress or done");
      if ("status" in body) throw fault(400, "bad_request", "Change the stage or the status, not both");
      body = { ...body, status: body.stage === "done" ? "done" : "open", stage: body.stage };
      const started = body.stage === "doing" ? todo.started_at || now() : body.stage === "todo" ? null : todo.started_at ?? null;
      if (started !== (todo.started_at ?? null)) { next.started_at = started; stageChange = true; }
    }
    let statusChange = null;
    if ("status" in body) {
      if (!STATUSES.includes(body.status)) throw fault(400, "bad_request", "A to-do is open or done");
      if (body.status !== todo.status) {
        next.status = body.status; statusChange = body.status;
        next.done_at = body.status === "done" ? now() : null;
        next.done_by = body.status === "done" ? user.id : null;
        // Unticking a done to-do puts it back in To do; dragging it to In progress says so with a stage.
        if (body.status === "open" && !("stage" in body) && todo.started_at) next.started_at = null;
      }
    }
    if (!changed.length && !statusChange && !stageChange && !channelAdded && next.channel_id === todo.channel_id) return view(todo, user);
    next.updated_at = now();
    keep(todo, "todo_changed", user.id);
    if (statusChange === "done") next.completion_id = completed(next, user.id, next.done_at);
    else if (statusChange === "open") { if (todo.completion_id) st.reopened.run(next.updated_at, todo.completion_id); next.completion_id = null; }
    db.prepare(`UPDATE todos SET text=?, status=?, assignee_id=?, assignee_name=?, project_id=?, release_id=?, channel_id=?,
      done_at=?, done_by=?, updated_at=?, completion_id=?, due_date=?, started_at=? WHERE id=?`)
      .run(next.text, next.status, next.assignee_id, next.assignee_name, next.project_id, next.release_id, next.channel_id,
        next.done_at ?? null, next.done_by ?? null, next.updated_at, next.completion_id ?? null, next.due_date ?? null, next.started_at ?? null, todo.id);
    db.prepare("UPDATE todos SET type=?, priority=?, estimate=?, description=?, parent_id=?, jira_key=? WHERE id=?")
      .run(next.type || "task", next.priority ?? null, next.estimate ?? null, next.description ?? null, next.parent_id ?? null, next.jira_key ?? null, todo.id);
    const saved = st.get.get(todo.id);
    if (statusChange === "done") tell(saved, user.id, "completed");
    else if (statusChange === "open") tell(saved, user.id, "reopened");
    else if (channelAdded) tell(saved, user.id, "added");
    else if (changed.length) tell(saved, user.id, "edited", { debounce: true });
    return view(st.get.get(todo.id), user);
  }

  /** Change several at once (apply a project, release or channel to a whole meeting's list). One channel line, not many. */
  function bulk(...args) { return transaction(() => bulkInTransaction(...args)); }
  function bulkInTransaction(user, ids, patch = {}) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 100) throw fault(400, "bad_request", "Choose some to-dos");
    const rows = ids.map(id => mine(id, user, true));
    const allowed = ["projectId", "releaseId", "channelId", "assigneeId", "assigneeName", "status"];
    const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
    if (!Object.keys(clean).length) throw fault(400, "bad_request", "Nothing to change");
    const newlyLinked = [];
    const out = [];
    for (const row of rows) {
      const before = st.get.get(row.id);
      // One summary line below replaces the per-item "added" lines.
      const hadChannel = !!before.channel_id;
      const silent = { ...clean }; delete silent.channelId;
      let current = view(before, user);
      if (Object.keys(silent).length) current = update(user, row.id, silent);
      if ("channelId" in clean) {
        const channelId = cleanChannel(user, clean.channelId);
        if (channelId !== before.channel_id) {
          keep(st.get.get(row.id), "todo_changed", user.id);
          db.prepare("UPDATE todos SET channel_id = ?, updated_at = ? WHERE id = ?").run(channelId, now(), row.id);
          if (channelId && !hadChannel) newlyLinked.push(row.id);
        }
        current = view(st.get.get(row.id), user);
      }
      out.push(current);
    }
    if (newlyLinked.length) {
      const first = st.get.get(newlyLinked[0]);
      const items = newlyLinked.map(id => st.get.get(id));
      const title = first.source_title && first.created_by === user.id ? ` from ${first.source_title}` : "";
      const text = items.length === 1
        ? line(`${person(user.id).name} added a to-do`, first, user)
        : `${person(user.id).name} added ${items.length} to-dos${title}: ${items.map(t => t.text).join("; ")}`.slice(0, 480);
      afterCommit.push(() => { announce(first.channel_id, user.id, text); for (const t of items) st.posted.run(now(), t.id); });
    }
    return out.map(t => view(st.get.get(t.id), user));
  }

  /** Put these in this order. Positions are re-dealt among themselves, so other lists keep their place. */
  function reorder(user, ids) {
    if (!Array.isArray(ids) || !ids.length || ids.length > MAX_LIST || new Set(ids).size !== ids.length) throw fault(400, "bad_request", "Send each to-do once");
    const rows = ids.map(id => mine(id, user, true));
    const slots = rows.map(r => r.position).sort((a, b) => a - b);
    transaction(() => { ids.forEach((id, i) => st.setPos.run(slots[i], id)); });
    return ids.map(id => view(st.get.get(id), user));
  }

  function remove(user, id) {
    return transaction(() => {
      const todo = mine(id, user, true);
      // Its copy carries its comments. An epic's to-dos stay; they just no longer belong to it.
      keep(todo, "todo_deleted", user.id);
      for (const child of st.childRows.all(todo.id)) { keep(child, "todo_changed", user.id); db.prepare("UPDATE todos SET parent_id = NULL, updated_at = ? WHERE id = ?").run(now(), child.id); }
      st.delComments.run(todo.id);
      st.del.run(todo.id);
    });
  }

  // ----- comments -----
  const commentView = row => ({ id: row.id, text: row.text, createdAt: row.created_at, author: { id: row.author_id, name: person(row.author_id)?.name || "Someone" } });
  /** What has been said on a to-do, oldest first, for anyone who can see it. */
  function comments(user, id) { return st.comments.all(mine(id, user).id).map(commentView); }
  /** Anyone who can see a to-do can say something on it. A comment is not edited or deleted afterwards. */
  function comment(user, id, body = {}) {
    return transaction(() => {
      const todo = mine(id, user);
      const text = String(body.text ?? "").replace(/\r\n?/g, "\n").trim().slice(0, MAX_COMMENT);
      if (!text) throw fault(400, "bad_request", "Write a comment");
      const row = { id: `tc_${crypto.randomBytes(9).toString("base64url")}`, todo_id: todo.id, author_id: user.id, text, created_at: now() };
      st.addComment.run(row.id, row.todo_id, row.author_id, row.text, row.created_at);
      return commentView(row);
    });
  }

  /** Hand it to the agent: one work chat, started once however many times this is tapped. */
  async function sendToAgent(user, device, id) {
    const todo = mine(id, user, true);
    if (todo.status === "done") throw fault(409, "todo", "That to-do is already done");
    const already = t => { const todo = view(t, user); return { todo, chatId: todo.chatId, started: false }; };
    if (todo.chat_id && todo.chat_id !== STARTING) return already(todo);
    // Claim first, so two taps can't start the same work twice. The loser waits for the winner and returns its chat.
    if (!st.claimChat.run(STARTING, now(), todo.id).changes) {
      const flight = starting.get(todo.id);
      if (flight) await flight.catch(() => {});
      return already(mine(todo.id, user, true));
    }
    let linkedChatId = null;
    const beforeEnqueue = chat => transaction(() => {
      const current = mine(todo.id, user, true);
      if (current.status !== "open" || current.chat_id !== STARTING) throw fault(409, "todo_changed", "This to-do changed before the agent could start. Open it and try again.");
      if (!chat?.id || typeof chat.id !== "string" || chat.id === STARTING) throw new Error("The agent did not identify its work chat");
      // Work handed to the agent has begun: the card moves to In progress.
      db.prepare("UPDATE todos SET chat_id = ?, updated_at = ?, started_at = coalesce(started_at, ?) WHERE id = ?").run(chat.id, now(), now(), todo.id);
      linkedChatId = chat.id;
    });
    const run = (async () => {
      const p = todo.project_id ? project(user, todo.project_id, todo.release_id) : null;
      const brief = agentBrief({ todo: { text: todo.text, assigneeName: todo.assignee_name }, projectName: p?.projectName, releaseName: p?.releaseName,
        source: todo.source_kind === "recording" && todo.created_by === user.id ? `the recorded meeting "${todo.source_title || "Meeting"}"` : "" });
      const chat = await startWork({ userId: user.id, deviceId: device?.id, title: todo.text, where: "a to-do", transcript: brief, projectId: todo.project_id || undefined, beforeEnqueue });
      if (!linkedChatId || chat?.id !== linkedChatId) throw new Error("The agent did not link its work chat before starting");
    })();
    starting.set(todo.id, run);
    try {
      await run;
    } catch (e) {
      st.freeChat.run(todo.id, linkedChatId || STARTING);
      // The work never began, so the card goes back to where it was.
      db.prepare("UPDATE todos SET started_at = ? WHERE id = ? AND chat_id IS NULL").run(todo.started_at ?? null, todo.id);
      throw e;
    }
    finally { starting.delete(todo.id); }
    const saved = mine(todo.id, user);
    const visible = view(saved, user);
    return { todo: visible, chatId: visible.chatId, started: true };
  }

  /** The agent said it finished (its reply ended with the done tag): mark the to-do off, and tell the channel. */
  function agentDone(chatId, completionKey) {
    return transaction(() => {
      if (completionKey && st.agentCompletion.get(String(chatId), String(completionKey))) return 0;
      const todos = st.byChat.all(String(chatId)).filter(t => t.status !== "done");
      for (const todo of todos) {
        const t = now();
        keep(todo, "todo_completed", "agent");
        const id = completed(todo, "agent", t);
        db.prepare("UPDATE todos SET status = 'done', done_at = ?, done_by = 'agent', updated_at = ?, completion_id = ? WHERE id = ?").run(t, t, id, todo.id);
        tell(st.get.get(todo.id), "agent", "completed");
      }
      if (completionKey) st.recordAgentCompletion.run(String(chatId), String(completionKey), now());
      return todos.length;
    });
  }

  /** The next steps from a recorded meeting become to-dos for the person who recorded it. Once only. */
  function fromRecording(user, recordingId, title, steps) {
    return transaction(() => {
      if (st.recordingImported.get(recordingId)) return [];
      st.importRecording.run(recordingId, now());
      if (st.bySource.all("recording", recordingId).length) return [];
      return (steps || []).map(s => create(user, { text: s.text, assigneeName: s.owner || "" }, { source: { kind: "recording", id: recordingId, title: plain(title, 80) } }));
    });
  }
  const forSource = (user, kind, id) => st.bySource.all(kind, id).filter(t => canSee(t, user)).map(t => view(t, user));
  function removeSource(kind, id, actorId = null) {
    return transaction(() => {
      for (const todo of st.bySource.all(kind, id)) {
        keep(todo, "todo_source_deleted", actorId);
        for (const child of st.childRows.all(todo.id)) { keep(child, "todo_changed", actorId); db.prepare("UPDATE todos SET parent_id = NULL WHERE id = ?").run(child.id); }
        st.delComments.run(todo.id);
      }
      db.prepare("DELETE FROM todos WHERE source_kind = ? AND source_id = ?").run(kind, id);
    });
  }

  // ----- export for Jira -----
  /** Every to-do this person can see (optionally one project's), with its epic's number and its comments, as a Jira CSV. */
  function jiraExport(user, { project: pid } = {}) {
    if (pid && !project(user, pid, null)) throw fault(404, "not_found", "No such project");
    const issues = list(user, { project: pid, status: "all" }).map(todo => ({
      ...todo, parentNumber: todo.parentId ? st.get.get(todo.parentId)?.number ?? null : null, comments: st.comments.all(todo.id).map(commentView),
    }));
    return { csv: jiraCsv(issues), count: issues.length, dateFormat: JIRA_DATE_FORMAT,
      issues: issues.map(issue => ({ id: issue.id, number: issue.number, key: issue.key, jiraKey: issue.jiraKey, canEdit: issue.canEdit })) };
  }

  // ----- HTTP -----
  async function handle(req, res, { user, device, method, parts, url, send, fail, readBody }) {
    if (parts[1] !== "todos") return false;
    const [, , id, sub] = parts;
    if (!id) {
      if (method === "GET") {
        const p = url.searchParams;
        return send(res, 200, { todos: list(user, { project: p.get("project") || undefined, release: p.get("release") || undefined, source: p.get("source") || undefined,
          status: ["open", "done", "all"].includes(p.get("status")) ? p.get("status") : "open", mine: p.get("mine") === "1", epic: p.get("epic") || undefined }) }), true;
      }
      if (method === "POST") return send(res, 201, { todo: create(user, (await readBody(req)) || {}) }), true;
      return fail(res, 405, "method_not_allowed", "Not allowed"), true;
    }
    if (id === "export" && method === "GET") { res.setHeader("Cache-Control", "no-store"); return send(res, 200, jiraExport(user, { project: url.searchParams.get("project") || undefined })), true; }
    if (id === "reorder" && method === "POST") return send(res, 200, { todos: reorder(user, ((await readBody(req)) || {}).ids) }), true;
    if (id === "bulk" && method === "POST") { const b = (await readBody(req)) || {}; return send(res, 200, { todos: bulk(user, b.ids, b.patch) }), true; }
    if (!sub) {
      if (method === "PATCH") return send(res, 200, { todo: update(user, id, (await readBody(req)) || {}) }), true;
      if (method === "DELETE") return remove(user, id), send(res, 200, { ok: true }), true;
      if (method === "GET") return send(res, 200, { todo: view(mine(id, user), user) }), true;
    }
    if (sub === "comments" && method === "GET") return send(res, 200, { comments: comments(user, id) }), true;
    if (sub === "comments" && method === "POST") return send(res, 201, { comment: comment(user, id, (await readBody(req)) || {}) }), true;
    if (sub === "agent" && method === "POST") { await readBody(req); return send(res, 200, await sendToAgent(user, device, id)), true; }
    return fail(res, 404, "not_found", "Not found"), true;
  }

  const close = () => { if (!suppliedDb) db.close(); };
  return { handle, create, list, update, bulk, reorder, remove, comments, comment, jiraExport, sendToAgent, agentDone, fromRecording, forSource, removeSource, workLog, close, db };
}
