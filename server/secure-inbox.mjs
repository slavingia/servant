import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const INBOX_BODY_LIMIT = 15 * 1024 * 1024;
const MAX_FILE = 5 * 1024 * 1024;
const MAX_FILES = 10 * 1024 * 1024;
const PAGE_SIZE = 100;
const HOUR = 60 * 60 * 1000;
export const NOTICE_CODE_MINUTES = 30;
const NOTICE_CODE_TRIES = 5;
const SYSTEM = { id: 'system', name: 'System' };

// A relay address only carries the encrypted API. Public browser conversations
// need the operator's direct HTTPS origin, never an inferred request Host header.
export function secureInboxPublicUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || !(url.protocol === 'https:' || (url.protocol === 'http:' && local))) return null;
    return `${url.origin}/contact`;
  } catch { return null; }
}

const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const identifier = prefix => `${prefix}_${crypto.randomBytes(18).toString('base64url')}`;
const object = value => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_body', 'Send a JSON object');
  return value;
};
const requestId = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(value)) fail(400, 'request_id', 'Give this message a unique request ID before sending');
  return value;
};
function shortText(value, label, limit, required = false) {
  if (value == null && !required) return '';
  if (typeof value !== 'string' || value.length > limit || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(400, 'invalid_input', `Enter a valid ${label} of up to ${limit} characters`);
  const result = value.trim();
  if (required && !result) fail(400, 'invalid_input', `Enter a ${label}`);
  return result;
}
function attachments(input) {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 4) fail(400, 'attachments', 'Attach up to 4 files');
  let total = 0;
  return input.map(part => {
    object(part);
    const name = shortText(part.name, 'file name', 160, true);
    if (/[/\\\r\n]/.test(name) || name === '.' || name === '..') fail(400, 'attachments', 'Choose a file with a simple name');
    if (typeof part.data !== 'string' || part.data.length > Math.ceil(MAX_FILE / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(part.data)) fail(400, 'attachments', 'Send each file as base64, up to 5 MiB');
    const data = Buffer.from(part.data, 'base64');
    total += data.length;
    if (data.toString('base64') !== part.data || data.length > MAX_FILE || total > MAX_FILES) fail(413, 'attachments', 'Attach up to 10 MiB total, with each file up to 5 MiB');
    return { name, data, size: data.length, mime: 'application/octet-stream' };
  });
}
function messageInput(raw) {
  const input = object(raw);
  const text = shortText(input.text, 'message', 20_000);
  const files = attachments(input.attachments);
  if (!text && !files.length) fail(400, 'empty', 'Type a message or attach a file');
  const id = requestId(input.requestId);
  const fingerprint = hash(JSON.stringify({ text, files: files.map(f => ({ name: f.name, hash: hash(f.data) })) }));
  return { text, files, requestId: id, fingerprint };
}
// An address the server will send to. Stricter than a contact address: no control characters or encoded line
// breaks may reach the mailer.
function mailbox(value) {
  if (typeof value !== 'string' || /[\u0000-\u001F\u007F]|%0[ad]/i.test(value)) fail(400, 'invalid_email', 'Enter one valid email address');
  const email = value.trim().toLowerCase();
  const [local = '', domain = ''] = email.split('@');
  if (!email || email.length > 254 || local.length > 64 || local.startsWith('.') || local.endsWith('.') || local.includes('..')
    || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email)
    || domain.split('.').some(label => label.length > 63)) fail(400, 'invalid_email', 'Enter one valid email address');
  return email;
}
function cursor(value) {
  const n = Number(value ?? 0);
  if (!Number.isSafeInteger(n) || n < 0) fail(400, 'cursor', 'Use a valid message cursor');
  return n;
}

function taskDate(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value < '1900-01-01' || value > '9999-12-31') fail(400, 'due_date', 'Choose a valid due date');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) fail(400, 'due_date', 'Choose a valid due date');
  return value;
}

// Visitor credentials never become device credentials. Authored messages, visitor
// details and files are immutable, even when records preservation is disabled.
export function createSecureInbox({ directory, users = () => ({}), now = Date.now, limits = {} }) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const keyFile = path.join(directory, 'inbox-key');
  let key;
  try { key = fs.readFileSync(keyFile); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    try { fs.writeFileSync(keyFile, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 }); }
    catch (race) { if (race.code !== 'EEXIST') throw race; }
    key = fs.readFileSync(keyFile);
  }
  if (key.length !== 32) throw new Error('Invalid inbox key; restore the original inbox-key file');
  fs.chmodSync(keyFile, 0o600);
  const file = path.join(directory, 'inbox.db');
  const db = new DatabaseSync(file);
  fs.chmodSync(file, 0o600);
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS inbox_conversations (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL, subject TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE, start_id TEXT NOT NULL UNIQUE, start_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')), assignee_id TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS inbox_messages (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      conversation_id TEXT NOT NULL REFERENCES inbox_conversations(id), sender TEXT NOT NULL CHECK(sender IN ('visitor','staff')),
      sender_id TEXT NOT NULL, sender_name TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL,
      request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      UNIQUE(conversation_id,sender_id,request_id)
    );
    CREATE INDEX IF NOT EXISTS inbox_messages_conversation ON inbox_messages(conversation_id,sequence);
    CREATE TABLE IF NOT EXISTS inbox_files (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES inbox_messages(id),
      conversation_id TEXT NOT NULL REFERENCES inbox_conversations(id), name TEXT NOT NULL,
      mime TEXT NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS inbox_files_conversation ON inbox_files(conversation_id);
    CREATE TABLE IF NOT EXISTS inbox_reads (
      conversation_id TEXT NOT NULL REFERENCES inbox_conversations(id), reader TEXT NOT NULL,
      through_sequence INTEGER NOT NULL, PRIMARY KEY(conversation_id,reader)
    );
    CREATE TABLE IF NOT EXISTS inbox_limits (scope TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS inbox_usage (id INTEGER PRIMARY KEY CHECK(id=1), conversations INTEGER NOT NULL, messages INTEGER NOT NULL, bytes INTEGER NOT NULL);
    INSERT OR IGNORE INTO inbox_usage SELECT 1,
      (SELECT count(*) FROM inbox_conversations), (SELECT count(*) FROM inbox_messages),
      (SELECT coalesce(sum(size),0) FROM inbox_files) + (SELECT coalesce(sum(length(CAST(text AS BLOB))),0) FROM inbox_messages) +
      (SELECT coalesce(sum(length(CAST(name || email || subject AS BLOB))),0) FROM inbox_conversations);
    CREATE TRIGGER IF NOT EXISTS inbox_conversation_keep BEFORE DELETE ON inbox_conversations BEGIN SELECT RAISE(ABORT,'Inbox content is permanent'); END;
    CREATE TRIGGER IF NOT EXISTS inbox_conversation_identity BEFORE UPDATE OF name,email,subject,token_hash,start_id,start_fingerprint,created_at ON inbox_conversations BEGIN SELECT RAISE(ABORT,'Inbox content is permanent'); END;
    CREATE TRIGGER IF NOT EXISTS inbox_messages_keep_update BEFORE UPDATE ON inbox_messages BEGIN SELECT RAISE(ABORT,'Inbox content is permanent'); END;
    CREATE TRIGGER IF NOT EXISTS inbox_messages_keep_delete BEFORE DELETE ON inbox_messages BEGIN SELECT RAISE(ABORT,'Inbox content is permanent'); END;
    CREATE TRIGGER IF NOT EXISTS inbox_files_keep_update BEFORE UPDATE ON inbox_files BEGIN SELECT RAISE(ABORT,'Inbox content is permanent'); END;
    CREATE TRIGGER IF NOT EXISTS inbox_files_keep_delete BEFORE DELETE ON inbox_files BEGIN SELECT RAISE(ABORT,'Inbox content is permanent'); END;`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS inbox_cases (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL UNIQUE REFERENCES inbox_conversations(id)
    );
    CREATE TABLE IF NOT EXISTS inbox_notes (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      conversation_id TEXT NOT NULL REFERENCES inbox_conversations(id),
      sender_id TEXT NOT NULL, sender_name TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL,
      request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, UNIQUE(conversation_id,sender_id,request_id)
    );
    CREATE INDEX IF NOT EXISTS inbox_notes_conversation ON inbox_notes(conversation_id,sequence);
    CREATE TABLE IF NOT EXISTS inbox_note_files (
      id TEXT PRIMARY KEY, note_id TEXT NOT NULL REFERENCES inbox_notes(id),
      conversation_id TEXT NOT NULL REFERENCES inbox_conversations(id), name TEXT NOT NULL,
      mime TEXT NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS inbox_note_files_conversation ON inbox_note_files(conversation_id);
    CREATE TABLE IF NOT EXISTS inbox_tasks (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES inbox_conversations(id), text TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('open','done')), assignee_id TEXT, due_date TEXT,
      created_at INTEGER NOT NULL, created_by TEXT NOT NULL, created_by_name TEXT NOT NULL, completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS inbox_tasks_conversation ON inbox_tasks(conversation_id,status,due_date,created_at);
    CREATE TABLE IF NOT EXISTS inbox_case_requests (
      conversation_id TEXT NOT NULL REFERENCES inbox_conversations(id), actor_id TEXT NOT NULL,
      request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL,
      PRIMARY KEY(conversation_id,actor_id,request_id)
    );
    CREATE TABLE IF NOT EXISTS inbox_case_starts (
      actor_id TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      conversation_id TEXT NOT NULL REFERENCES inbox_conversations(id), PRIMARY KEY(actor_id,request_id)
    );
    CREATE TABLE IF NOT EXISTS inbox_guest_links (
      conversation_id TEXT PRIMARY KEY REFERENCES inbox_conversations(id), token_hash TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS inbox_activity (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      conversation_id TEXT NOT NULL REFERENCES inbox_conversations(id), kind TEXT NOT NULL,
      actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, at INTEGER NOT NULL, text TEXT NOT NULL, details TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS inbox_activity_conversation ON inbox_activity(conversation_id,sequence);
    CREATE TABLE IF NOT EXISTS inbox_notify (
      conversation_id TEXT PRIMARY KEY REFERENCES inbox_conversations(id), email TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending','on','off')), code_hash TEXT,
      code_expires_at INTEGER NOT NULL DEFAULT 0, tries INTEGER NOT NULL DEFAULT 0,
      notified_through INTEGER NOT NULL DEFAULT 0, claim_until INTEGER NOT NULL DEFAULT 0,
      failures INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS inbox_case_usage (id INTEGER PRIMARY KEY CHECK(id=1), tasks INTEGER NOT NULL, events INTEGER NOT NULL);
    INSERT OR IGNORE INTO inbox_case_usage SELECT 1,(SELECT count(*) FROM inbox_tasks),(SELECT count(*) FROM inbox_activity);
    CREATE TRIGGER IF NOT EXISTS inbox_cases_keep_update BEFORE UPDATE ON inbox_cases BEGIN SELECT RAISE(ABORT,'Case references are permanent'); END;
    CREATE TRIGGER IF NOT EXISTS inbox_cases_keep_delete BEFORE DELETE ON inbox_cases BEGIN SELECT RAISE(ABORT,'Case references are permanent'); END;
    CREATE TRIGGER IF NOT EXISTS inbox_notes_keep_update BEFORE UPDATE ON inbox_notes BEGIN SELECT RAISE(ABORT,'Inbox content is permanent'); END;
    CREATE TRIGGER IF NOT EXISTS inbox_notes_keep_delete BEFORE DELETE ON inbox_notes BEGIN SELECT RAISE(ABORT,'Inbox content is permanent'); END;
    CREATE TRIGGER IF NOT EXISTS inbox_note_files_keep_update BEFORE UPDATE ON inbox_note_files BEGIN SELECT RAISE(ABORT,'Inbox content is permanent'); END;
    CREATE TRIGGER IF NOT EXISTS inbox_note_files_keep_delete BEFORE DELETE ON inbox_note_files BEGIN SELECT RAISE(ABORT,'Inbox content is permanent'); END;
    CREATE TRIGGER IF NOT EXISTS inbox_task_identity BEFORE UPDATE OF id,conversation_id,text,created_at,created_by,created_by_name ON inbox_tasks BEGIN SELECT RAISE(ABORT,'Task content is permanent'); END;
    CREATE TRIGGER IF NOT EXISTS inbox_task_keep_delete BEFORE DELETE ON inbox_tasks BEGIN SELECT RAISE(ABORT,'Task content is permanent'); END;
    CREATE TRIGGER IF NOT EXISTS inbox_requests_keep_update BEFORE UPDATE ON inbox_case_requests BEGIN SELECT RAISE(ABORT,'Case history is permanent'); END;
    CREATE TRIGGER IF NOT EXISTS inbox_requests_keep_delete BEFORE DELETE ON inbox_case_requests BEGIN SELECT RAISE(ABORT,'Case history is permanent'); END;
    CREATE TRIGGER IF NOT EXISTS inbox_starts_keep_update BEFORE UPDATE ON inbox_case_starts BEGIN SELECT RAISE(ABORT,'Case history is permanent'); END;
    CREATE TRIGGER IF NOT EXISTS inbox_starts_keep_delete BEFORE DELETE ON inbox_case_starts BEGIN SELECT RAISE(ABORT,'Case history is permanent'); END;
    CREATE TRIGGER IF NOT EXISTS inbox_links_keep_update BEFORE UPDATE ON inbox_guest_links BEGIN SELECT RAISE(ABORT,'Case history is permanent'); END;
    CREATE TRIGGER IF NOT EXISTS inbox_links_keep_delete BEFORE DELETE ON inbox_guest_links BEGIN SELECT RAISE(ABORT,'Case history is permanent'); END;
    CREATE TRIGGER IF NOT EXISTS inbox_activity_keep_update BEFORE UPDATE ON inbox_activity BEGIN SELECT RAISE(ABORT,'Case history is permanent'); END;
    CREATE TRIGGER IF NOT EXISTS inbox_activity_keep_delete BEFORE DELETE ON inbox_activity BEGIN SELECT RAISE(ABORT,'Case history is permanent'); END;
  `);
  const transaction = fn => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  function reserve({ conversations = 0, messages = 0, bytes = 0 }) {
    const usage = db.prepare('SELECT conversations,messages,bytes FROM inbox_usage WHERE id=1').get();
    if (usage.conversations + conversations > (limits.totalConversations ?? 10_000) || usage.messages + messages > (limits.totalMessages ?? 100_000) || usage.bytes + bytes > (limits.totalBytes ?? 1024 * 1024 * 1024)) {
      fail(507, 'inbox_full', 'The secure inbox has reached its storage limit. Contact the team through another channel; existing conversations are still available');
    }
    db.prepare('UPDATE inbox_usage SET conversations=conversations+?,messages=messages+?,bytes=bytes+? WHERE id=1').run(conversations, messages, bytes);
  }
  const rate = (scope, maximum, period = HOUR) => {
    const window = Math.floor(now() / period) * period;
    const previous = db.prepare('SELECT * FROM inbox_limits WHERE scope=?').get(scope);
    const count = previous?.window === window ? previous.count : 0;
    if (count >= maximum) fail(429, 'rate_limited', 'Too many requests. Wait a while and try again');
    db.prepare('INSERT INTO inbox_limits VALUES (?,?,?) ON CONFLICT(scope) DO UPDATE SET window=excluded.window,count=excluded.count').run(scope, window, count + 1);
    db.prepare('DELETE FROM inbox_limits WHERE window < ?').run(now() - 2 * HOUR);
  };
  const row = id => db.prepare('SELECT * FROM inbox_conversations WHERE id=?').get(id) || fail(404, 'not_found', 'That conversation is unavailable');
  const guest = token => {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) fail(401, 'inbox_session', 'Open your saved conversation link or start a new conversation');
    const tokenHash = hash(token);
    return db.prepare('SELECT * FROM inbox_conversations WHERE token_hash=?').get(tokenHash)
      || db.prepare('SELECT c.* FROM inbox_conversations c JOIN inbox_guest_links g ON g.conversation_id=c.id WHERE g.token_hash=?').get(tokenHash)
      || fail(401, 'inbox_session', 'Open your saved conversation link or start a new conversation');
  };
  const identity = user => {
    const current = users()[user?.id];
    if (!current || !['owner', 'member'].includes(current.role)) fail(403, 'forbidden', 'Sign in as a team member to open the inbox');
    ensureCases();
    return { id: current.id, name: current.name, reader: `staff:${current.id}`, sender: 'staff' };
  };
  const visitor = conversation => ({ id: `visitor:${conversation.id}`, name: conversation.name, reader: 'visitor', sender: 'visitor' });
  const reference = id => {
    const item = db.prepare('SELECT sequence FROM inbox_cases WHERE conversation_id=?').get(id);
    return item ? `CASE-${String(item.sequence).padStart(6, '0')}` : null;
  };
  function assignable(value) {
    if (value !== null && (typeof value !== 'string' || !users()[value] || !['owner', 'member'].includes(users()[value].role))) fail(400, 'assignee', 'Choose a current team member');
    return value;
  }
  function activity(conversationId, actor, kind, text, details = {}) {
    const total = db.prepare('SELECT events FROM inbox_case_usage WHERE id=1').get().events;
    const count = db.prepare('SELECT count(*) AS n FROM inbox_activity WHERE conversation_id=?').get(conversationId).n;
    if (total >= (limits.totalEvents ?? 200_000) || count >= (limits.eventsPerConversation ?? 2000)) fail(507, 'case_history_full', 'This case has reached its activity limit. Existing content is still available; contact the server owner before continuing');
    db.prepare('INSERT INTO inbox_activity (id,conversation_id,kind,actor_id,actor_name,at,text,details) VALUES (?,?,?,?,?,?,?,?)').run(identifier('ia'), conversationId, kind, actor.id, actor.name, now(), text.slice(0, 512), JSON.stringify(details));
    db.prepare('UPDATE inbox_case_usage SET events=events+1 WHERE id=1').run();
  }
  function createCase(conversation, migrated = false, actor = visitor(conversation)) {
    db.prepare('INSERT INTO inbox_cases (conversation_id) VALUES (?)').run(conversation.id);
    activity(conversation.id, migrated ? { id: 'system', name: 'System' } : actor, migrated ? 'case.migrated' : 'case.created', migrated ? 'Created a case for this existing conversation.' : 'Opened this case.');
  }
  // An upgrade assigns references once in a transaction. It never rewrites a
  // message, a credential, a read cursor, an attachment or its original date.
  function ensureCases() {
    if (!db.prepare('SELECT 1 FROM inbox_conversations c LEFT JOIN inbox_cases k ON k.conversation_id=c.id WHERE k.sequence IS NULL LIMIT 1').get()) return;
    transaction(() => {
      for (const conversation of db.prepare('SELECT c.* FROM inbox_conversations c LEFT JOIN inbox_cases k ON k.conversation_id=c.id WHERE k.sequence IS NULL ORDER BY c.created_at,c.id').all()) createCase(conversation, true);
    });
  }
  ensureCases();
  function taskView(task) {
    return { id: task.id, conversationId: task.conversation_id, text: task.text, status: task.status,
      assigneeId: task.assignee_id, assigneeName: users()[task.assignee_id]?.name || null, dueDate: task.due_date,
      createdAt: task.created_at, createdByName: task.created_by_name, completedAt: task.completed_at };
  }
  function tasksFor(id) {
    return db.prepare("SELECT * FROM inbox_tasks WHERE conversation_id=? ORDER BY status='done',due_date IS NULL,due_date,created_at,id LIMIT 200").all(id).map(taskView);
  }
  function caseSummary(id) {
    const tasks = tasksFor(id);
    return { reference: reference(id), openTaskCount: tasks.filter(task => task.status === 'open').length, nextAction: tasks.find(task => task.status === 'open') || null };
  }
  function view(conversation, actor) {
    const last = db.prepare('SELECT text,created_at,sender FROM inbox_messages WHERE conversation_id=? ORDER BY sequence DESC LIMIT 1').get(conversation.id);
    const read = db.prepare('SELECT through_sequence FROM inbox_reads WHERE conversation_id=? AND reader=?').get(conversation.id, actor.reader)?.through_sequence || 0;
    const unread = db.prepare('SELECT count(*) AS n FROM inbox_messages WHERE conversation_id=? AND sequence>? AND sender!=?').get(conversation.id, read, actor.sender).n;
    return { id: conversation.id, name: conversation.name, email: conversation.email, subject: conversation.subject,
      status: conversation.status, assigneeId: actor.sender === 'staff' ? conversation.assignee_id : null,
      assigneeName: actor.sender === 'staff' ? users()[conversation.assignee_id]?.name || null : null,
      createdAt: conversation.created_at,
      updatedAt: actor.sender === 'staff' ? Math.max(conversation.updated_at, db.prepare('SELECT coalesce(max(at),0) AS at FROM inbox_activity WHERE conversation_id=?').get(conversation.id).at) : conversation.updated_at, unread,
      lastMessage: last ? { text: last.text, at: last.created_at, sender: last.sender } : null,
      ...(actor.sender === 'staff' ? caseSummary(conversation.id) : {}) };
  }
  function messageView(message) {
    return { id: message.id, sequence: message.sequence, conversationId: message.conversation_id,
      sender: message.sender, senderName: message.sender_name, text: message.text, createdAt: message.created_at,
      attachments: db.prepare('SELECT id,name,mime,size FROM inbox_files WHERE message_id=? ORDER BY rowid').all(message.id).map(f => ({ ...f })) };
  }
  function detail(conversation, actor, after = 0) {
    const messages = db.prepare('SELECT * FROM inbox_messages WHERE conversation_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(conversation.id, cursor(after), PAGE_SIZE + 1);
    return { conversation: view(conversation, actor), messages: messages.slice(0, PAGE_SIZE).map(messageView), hasMore: messages.length > PAGE_SIZE };
  }
  function write(conversation, actor, input) {
    const previous = db.prepare('SELECT * FROM inbox_messages WHERE conversation_id=? AND sender_id=? AND request_id=?').get(conversation.id, actor.id, hash(input.requestId));
    if (previous) {
      if (previous.fingerprint !== input.fingerprint) fail(409, 'request_conflict', 'This request ID was used for a different message. Start a new send');
      return { message: messageView(previous), conversation: view(row(conversation.id), actor) };
    }
    const count = db.prepare('SELECT (SELECT count(*) FROM inbox_messages WHERE conversation_id=?) + (SELECT count(*) FROM inbox_notes WHERE conversation_id=?) AS n').get(conversation.id, conversation.id).n;
    if (count >= (limits.messagesPerConversation ?? 1000)) fail(409, 'conversation_full', 'This conversation is full. Start a new conversation to continue');
    const bytes = db.prepare('SELECT (SELECT coalesce(sum(size),0) FROM inbox_files WHERE conversation_id=?) + (SELECT coalesce(sum(size),0) FROM inbox_note_files WHERE conversation_id=?) AS n').get(conversation.id, conversation.id).n;
    if (bytes + input.files.reduce((sum, f) => sum + f.size, 0) > (limits.bytesPerConversation ?? 100 * 1024 * 1024)) fail(413, 'conversation_full', 'This conversation has reached its file limit. Start a new conversation for more files');
    reserve({ messages: 1, bytes: Buffer.byteLength(input.text) + input.files.reduce((sum, f) => sum + f.size, 0) });
    rate(`message:${actor.id}`, limits.messagesPerMinute ?? 30, 60_000);
    if (actor.sender === 'visitor') rate('visitor-messages', limits.visitorMessagesPerHour ?? 2000);
    const id = identifier('im');
    const at = now();
    db.prepare('INSERT INTO inbox_messages (id,conversation_id,sender,sender_id,sender_name,text,created_at,request_id,fingerprint) VALUES (?,?,?,?,?,?,?,?,?)').run(id, conversation.id, actor.sender, actor.id, actor.name, input.text, at, hash(input.requestId), input.fingerprint);
    for (const f of input.files) db.prepare('INSERT INTO inbox_files VALUES (?,?,?,?,?,?,?)').run(identifier('if'), id, conversation.id, f.name, f.mime, f.size, f.data);
    if (actor.sender === 'visitor' && conversation.status === 'resolved') activity(conversation.id, actor, 'case.reopened', 'Reopened the case with a new public message.', { before: { status: 'resolved' }, after: { status: 'open' } });
    db.prepare("UPDATE inbox_conversations SET updated_at=?,status=CASE WHEN ?='visitor' THEN 'open' ELSE status END WHERE id=?").run(at, actor.sender, conversation.id);
    return { message: messageView(db.prepare('SELECT * FROM inbox_messages WHERE id=?').get(id)), conversation: view(row(conversation.id), actor) };
  }
  function read(conversation, actor, through) {
    const last = db.prepare('SELECT coalesce(max(sequence),0) AS n FROM inbox_messages WHERE conversation_id=?').get(conversation.id).n;
    const value = cursor(through);
    if (value > last) fail(400, 'cursor', 'Only mark messages you have received as read');
    db.prepare('INSERT INTO inbox_reads VALUES (?,?,?) ON CONFLICT(conversation_id,reader) DO UPDATE SET through_sequence=max(inbox_reads.through_sequence,excluded.through_sequence)').run(conversation.id, actor.reader, value);
    return { ok: true };
  }
  function getFile(conversation, id) {
    const f = db.prepare('SELECT id,name,mime,size,data FROM inbox_files WHERE conversation_id=? AND id=?').get(conversation.id, id);
    if (!f) fail(404, 'not_found', 'That file is unavailable');
    return { file: { ...f, data: Buffer.from(f.data).toString('base64') } };
  }
  function noteView(note) {
    return { id: note.id, sequence: note.sequence, conversationId: note.conversation_id, senderName: note.sender_name,
      text: note.text, createdAt: note.created_at,
      attachments: db.prepare('SELECT id,name,mime,size FROM inbox_note_files WHERE note_id=? ORDER BY rowid').all(note.id).map(f => ({ ...f })) };
  }
  function writeNote(conversation, actor, input) {
    const previous = db.prepare('SELECT * FROM inbox_notes WHERE conversation_id=? AND sender_id=? AND request_id=?').get(conversation.id, actor.id, hash(input.requestId));
    if (previous) {
      if (previous.fingerprint !== input.fingerprint) fail(409, 'request_conflict', 'This request ID was used for a different note. Start a new send');
      return { note: noteView(previous) };
    }
    const count = db.prepare('SELECT (SELECT count(*) FROM inbox_messages WHERE conversation_id=?) + (SELECT count(*) FROM inbox_notes WHERE conversation_id=?) AS n').get(conversation.id, conversation.id).n;
    if (count >= (limits.messagesPerConversation ?? 1000)) fail(409, 'conversation_full', 'This case has reached its message and note limit. Contact the server owner before continuing');
    const bytes = db.prepare('SELECT (SELECT coalesce(sum(size),0) FROM inbox_files WHERE conversation_id=?) + (SELECT coalesce(sum(size),0) FROM inbox_note_files WHERE conversation_id=?) AS n').get(conversation.id, conversation.id).n;
    if (bytes + input.files.reduce((sum, f) => sum + f.size, 0) > (limits.bytesPerConversation ?? 100 * 1024 * 1024)) fail(413, 'conversation_full', 'This case has reached its file limit. Contact the server owner before continuing');
    reserve({ messages: 1, bytes: Buffer.byteLength(input.text) + input.files.reduce((sum, f) => sum + f.size, 0) });
    rate(`message:${actor.id}`, limits.messagesPerMinute ?? 30, 60_000);
    const id = identifier('in');
    db.prepare('INSERT INTO inbox_notes (id,conversation_id,sender_id,sender_name,text,created_at,request_id,fingerprint) VALUES (?,?,?,?,?,?,?,?)').run(id, conversation.id, actor.id, actor.name, input.text, now(), hash(input.requestId), input.fingerprint);
    for (const f of input.files) db.prepare('INSERT INTO inbox_note_files VALUES (?,?,?,?,?,?,?)').run(identifier('inf'), id, conversation.id, f.name, f.mime, f.size, f.data);
    activity(conversation.id, actor, 'note.added', 'Added an internal note.', { noteId: id });
    return { note: noteView(db.prepare('SELECT * FROM inbox_notes WHERE id=?').get(id)) };
  }
  function taskReceipt(conversationId, actor, rawId, fingerprint, execute) {
    const id = hash(requestId(rawId));
    const prior = db.prepare('SELECT fingerprint,result FROM inbox_case_requests WHERE conversation_id=? AND actor_id=? AND request_id=?').get(conversationId, actor.id, id);
    if (prior) {
      if (prior.fingerprint !== fingerprint) fail(409, 'request_conflict', 'This request ID was used for a different task change. Try again with a new request');
      return JSON.parse(prior.result);
    }
    // Each new task receipt produces an activity, keeping both tables bounded.
    const result = execute();
    db.prepare('INSERT INTO inbox_case_requests VALUES (?,?,?,?,?)').run(conversationId, actor.id, id, fingerprint, JSON.stringify(result));
    return result;
  }
  function createTask(conversation, actor, raw) {
    const input = object(raw);
    if (Object.keys(input).some(k => !['text', 'assigneeId', 'dueDate', 'requestId'].includes(k))) fail(400, 'invalid_task', 'Set the task text, assignee, and due date');
    const text = shortText(input.text, 'task', 2000, true);
    const assigneeId = input.assigneeId ?? null;
    if (assigneeId !== null && typeof assigneeId !== 'string') fail(400, 'assignee', 'Choose a current team member');
    const dueDate = taskDate(input.dueDate ?? null);
    const fingerprint = hash(JSON.stringify({ kind: 'task.create', text, assigneeId, dueDate }));
    return taskReceipt(conversation.id, actor, input.requestId, fingerprint, () => {
      assignable(assigneeId);
      const total = db.prepare('SELECT tasks FROM inbox_case_usage WHERE id=1').get().tasks;
      const count = db.prepare('SELECT count(*) AS n FROM inbox_tasks WHERE conversation_id=?').get(conversation.id).n;
      if (count >= Math.min(200, limits.tasksPerConversation ?? 200) || total >= (limits.totalTasks ?? 20_000)) fail(507, 'tasks_full', 'The task limit has been reached. Existing tasks are still available; contact the server owner before adding more');
      reserve({ bytes: Buffer.byteLength(text) });
      rate(`task:${actor.id}`, limits.taskChangesPerMinute ?? 60, 60_000);
      const id = identifier('it');
      db.prepare("INSERT INTO inbox_tasks VALUES (?,?,?,'open',?,?,?,?,?,NULL)").run(id, conversation.id, text, assigneeId, dueDate, now(), actor.id, actor.name);
      db.prepare('UPDATE inbox_case_usage SET tasks=tasks+1 WHERE id=1').run();
      const task = taskView(db.prepare('SELECT * FROM inbox_tasks WHERE id=?').get(id));
      activity(conversation.id, actor, 'task.created', `Created task: ${text.slice(0, 160)}. Assignee: ${task.assigneeName || 'Unassigned'}. Due: ${task.dueDate || 'No date'}.`, { taskId: id, before: null, after: task });
      return { task };
    });
  }
  function updateTask(conversation, actor, id, raw) {
    const input = object(raw);
    const fields = Object.keys(input).filter(k => k !== 'requestId');
    if (!fields.length || fields.some(k => !['status', 'assigneeId', 'dueDate'].includes(k))) fail(400, 'invalid_task', 'Change the task status, assignee, or due date');
    if ('status' in input && !['open', 'done'].includes(input.status)) fail(400, 'status', 'Choose open or done');
    if ('assigneeId' in input && input.assigneeId !== null && typeof input.assigneeId !== 'string') fail(400, 'assignee', 'Choose a current team member');
    if ('dueDate' in input) taskDate(input.dueDate);
    const changes = Object.fromEntries(fields.sort().map(k => [k, input[k]]));
    const fingerprint = hash(JSON.stringify({ kind: 'task.update', id, changes }));
    return taskReceipt(conversation.id, actor, input.requestId, fingerprint, () => {
      if ('assigneeId' in input) assignable(input.assigneeId);
      const task = db.prepare('SELECT * FROM inbox_tasks WHERE conversation_id=? AND id=?').get(conversation.id, id);
      if (!task) fail(404, 'not_found', 'That task is unavailable');
      rate(`task:${actor.id}`, limits.taskChangesPerMinute ?? 60, 60_000);
      const before = taskView(task);
      const status = input.status ?? task.status;
      const completed = status === 'done' ? task.completed_at ?? now() : null;
      db.prepare('UPDATE inbox_tasks SET status=?,assignee_id=?,due_date=?,completed_at=? WHERE conversation_id=? AND id=?').run(status, 'assigneeId' in input ? input.assigneeId : task.assignee_id, 'dueDate' in input ? input.dueDate : task.due_date, completed, conversation.id, id);
      const after = taskView(db.prepare('SELECT * FROM inbox_tasks WHERE id=?').get(id));
      const changedStatus = status !== task.status;
      const kind = changedStatus ? status === 'done' ? 'task.completed' : 'task.reopened' : 'task.updated';
      const verb = changedStatus ? status === 'done' ? 'Completed' : 'Reopened' : 'Updated';
      const summary = [`${verb} task: ${task.text.slice(0, 160)}.`];
      if (before.assigneeId !== after.assigneeId) summary.push(`Assignee: ${before.assigneeName || 'Unassigned'} → ${after.assigneeName || 'Unassigned'}.`);
      if (before.dueDate !== after.dueDate) summary.push(`Due: ${before.dueDate || 'No date'} → ${after.dueDate || 'No date'}.`);
      activity(conversation.id, actor, kind, summary.join(' '), { taskId: id, before, after });
      return { task: after };
    });
  }
  // Reply emails. A visitor proves they can read mail at an address by typing a code into the page they are
  // writing from. Only then does a team reply send that address a notice with the private return link, so a
  // mistyped address gets one code it cannot use and never a link. The notice carries no message text.
  const notifyRow = id => db.prepare('SELECT * FROM inbox_notify WHERE conversation_id=?').get(id);
  const notifyView = id => { const n = notifyRow(id); return n ? { state: n.state, email: n.email } : { state: 'none', email: null }; };
  const latestStaff = id => db.prepare("SELECT coalesce(max(sequence),0) AS n FROM inbox_messages WHERE conversation_id=? AND sender='staff'").get(id).n;
  function notifyStart(conversation, rawEmail) {
    const email = mailbox(rawEmail);
    return transaction(() => {
      if (notifyRow(conversation.id)?.state === 'on') fail(409, 'notice_on', 'Stop emails first, then add a different address');
      // Hashed, like the start quota, so the limits table does not keep addresses.
      rate(`notice-code:${conversation.id}`, limits.noticeCodesPerHour ?? 5);
      rate(`notice-code:${hash(email)}`, limits.noticeCodesPerMailboxPerHour ?? 5);
      rate('notice-codes', limits.totalNoticeCodesPerHour ?? 200);
      const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
      db.prepare(`INSERT INTO inbox_notify (conversation_id,email,state,code_hash,code_expires_at,tries,updated_at) VALUES (?,?,'pending',?,?,0,?)
        ON CONFLICT(conversation_id) DO UPDATE SET email=excluded.email,state='pending',code_hash=excluded.code_hash,code_expires_at=excluded.code_expires_at,tries=0,updated_at=excluded.updated_at`)
        .run(conversation.id, email, hash(`${conversation.id}:${code}`), now() + NOTICE_CODE_MINUTES * 60_000, now());
      return { notify: notifyView(conversation.id), mail: { to: email, code, minutes: NOTICE_CODE_MINUTES } };
    });
  }
  function notifyConfirm(conversation, rawCode) {
    const code = typeof rawCode === 'string' ? rawCode.replace(/\s/g, '') : '';
    const n = notifyRow(conversation.id);
    if (!n || n.state !== 'pending' || !n.code_hash || n.code_expires_at < now()) fail(403, 'notice_code_expired', 'That code has expired. Send a new code');
    if (n.tries >= NOTICE_CODE_TRIES) fail(403, 'notice_code_expired', 'Too many wrong codes. Send a new code');
    if (!/^\d{6}$/.test(code) || !crypto.timingSafeEqual(Buffer.from(hash(`${conversation.id}:${code}`)), Buffer.from(n.code_hash))) {
      // Counted outside a transaction, so refusing the code does not roll the count back.
      db.prepare('UPDATE inbox_notify SET tries=tries+1 WHERE conversation_id=?').run(conversation.id);
      fail(403, 'notice_code_wrong', 'That code is not right. Check the email and try again');
    }
    return transaction(() => {
      // Caught up as of now: the person confirming is looking at the conversation.
      const done = db.prepare("UPDATE inbox_notify SET state='on',code_hash=NULL,tries=0,failures=0,retry_at=0,claim_until=0,notified_through=?,updated_at=? WHERE conversation_id=? AND state='pending' AND code_hash=?")
        .run(latestStaff(conversation.id), now(), conversation.id, n.code_hash);
      if (done.changes !== 1) fail(403, 'notice_code_expired', 'That code has expired. Send a new code');
      // The address is in the record so the team can later see where emails went.
      activity(conversation.id, visitor(conversation), 'notice.on', `Turned on reply emails to ${n.email}.`);
      return { notify: notifyView(conversation.id) };
    });
  }
  function notifyStop(conversation) {
    return transaction(() => {
      const n = notifyRow(conversation.id);
      if (n && n.state !== 'off') {
        if (n.state === 'on') activity(conversation.id, visitor(conversation), 'notice.off', 'Turned off reply emails.');
        db.prepare("UPDATE inbox_notify SET state='off',code_hash=NULL,updated_at=? WHERE conversation_id=?").run(now(), conversation.id);
      }
      return { notify: notifyView(conversation.id) };
    });
  }
  // The team replies the visitor has neither read nor been told about, once the oldest has waited `delayMs`:
  // someone reading along on the page gets no email, and a burst of replies is one email. Each row is claimed
  // for two minutes so that two server processes do not both send it.
  function claimNotices(publicOrigin, { delayMs = 60_000, limit = 20 } = {}) {
    const publicUrl = secureInboxPublicUrl(publicOrigin);
    if (!publicUrl) return [];
    return transaction(() => {
      const claimed = [];
      const rows = db.prepare(`SELECT n.conversation_id AS id, n.email, n.notified_through AS told,
          (SELECT coalesce(max(m.sequence),0) FROM inbox_messages m WHERE m.conversation_id=n.conversation_id AND m.sender='staff') AS latest,
          coalesce((SELECT r.through_sequence FROM inbox_reads r WHERE r.conversation_id=n.conversation_id AND r.reader='visitor'),0) AS seen
        FROM inbox_notify n WHERE n.state='on' AND n.claim_until<=? AND n.retry_at<=? ORDER BY n.updated_at,n.conversation_id LIMIT 1000`).all(now(), now());
      for (const item of rows) {
        if (claimed.length >= limit) break;
        const floor = Math.max(item.seen, item.told);
        if (item.latest <= floor) continue;
        const first = db.prepare("SELECT min(created_at) AS at FROM inbox_messages WHERE conversation_id=? AND sender='staff' AND sequence>?").get(item.id, floor).at;
        if (first > now() - delayMs) continue;
        try {
          rate('notices', limits.totalNoticesPerHour ?? 500);
          rate(`notice:${item.id}`, limits.noticesPerConversationPerHour ?? 6);
          const token = crypto.createHmac('sha256', key).update(`inbox-case-link:${item.id}`).digest('base64url');
          if (!db.prepare('SELECT 1 FROM inbox_guest_links WHERE conversation_id=?').get(item.id)) {
            activity(item.id, SYSTEM, 'case.link-created', 'Created a private return link for reply emails.');
            db.prepare('INSERT INTO inbox_guest_links VALUES (?,?)').run(item.id, hash(token));
          }
          db.prepare('UPDATE inbox_notify SET claim_until=? WHERE conversation_id=?').run(now() + 120_000, item.id);
          claimed.push({ id: item.id, to: item.email, through: item.latest, url: `${publicUrl}#resume=${token}` });
        } catch {
          // Over a sending limit, or the case's history is full: leave it for a later pass rather than send unrecorded mail.
          db.prepare('UPDATE inbox_notify SET retry_at=? WHERE conversation_id=?').run(now() + 10 * 60_000, item.id);
        }
      }
      return claimed;
    });
  }
  function noticeSent(id, through) {
    return transaction(() => {
      db.prepare('UPDATE inbox_notify SET notified_through=max(notified_through,?),claim_until=0,failures=0,retry_at=0 WHERE conversation_id=?').run(cursor(through), id);
      const to = notifyRow(id)?.email;
      try { activity(id, SYSTEM, 'notice.sent', `Emailed ${to} that a reply is waiting.`); } catch { /* The email is sent; a full history must not send it again. */ }
      return { ok: true };
    });
  }
  function noticeFailed(id) {
    return transaction(() => {
      const n = notifyRow(id);
      if (!n) return { ok: true };
      db.prepare('UPDATE inbox_notify SET failures=failures+1,claim_until=0,retry_at=? WHERE conversation_id=?').run(now() + Math.min(6 * HOUR, 5 * 60_000 * 2 ** n.failures), id);
      if (!n.failures) { try { activity(id, SYSTEM, 'notice.failed', `Could not email ${n.email} about a reply. The server will try again.`); } catch { /* Nothing more to record. */ } }
      return { ok: true };
    });
  }
  return {
    staffStart(user, raw) {
      const actor = identity(user), input = object(raw);
      if (Object.keys(input).some(k => !['name', 'email', 'subject', 'requestId'].includes(k))) fail(400, 'invalid_case', 'Enter the contact name, optional email, and subject');
      const name = shortText(input.name, 'name', 80, true);
      const email = shortText(input.email, 'email address', 254);
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'invalid_email', 'Enter a valid email address or leave it blank');
      const subject = shortText(input.subject, 'subject', 160, true);
      const idempotency = hash(requestId(input.requestId));
      const fingerprint = hash(JSON.stringify({ name, email, subject }));
      return transaction(() => {
        const previous = db.prepare('SELECT * FROM inbox_case_starts WHERE actor_id=? AND request_id=?').get(actor.id, idempotency);
        if (previous) {
          if (previous.fingerprint !== fingerprint) fail(409, 'request_conflict', 'This request ID was used for a different case. Start a new request');
          return { conversation: view(row(previous.conversation_id), actor) };
        }
        reserve({ conversations: 1, bytes: Buffer.byteLength(name + email + subject) });
        rate(`case-start:${actor.id}`, limits.staffStartsPerHour ?? 100);
        const id = identifier('inbox'), at = now();
        // No public token exists until a team member explicitly creates a link.
        db.prepare('INSERT INTO inbox_conversations (id,name,email,subject,token_hash,start_id,start_fingerprint,assignee_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, name, email, subject, hash(crypto.randomBytes(32)), `staff:${hash(actor.id + ':' + idempotency)}`, fingerprint, actor.id, at, at);
        const conversation = row(id);
        createCase(conversation, false, actor);
        db.prepare('INSERT INTO inbox_case_starts VALUES (?,?,?,?)').run(actor.id, idempotency, fingerprint, id);
        return { conversation: view(conversation, actor) };
      });
    },
    visitorLink(user, id, publicOrigin) {
      const actor = identity(user); row(id);
      const publicUrl = secureInboxPublicUrl(publicOrigin);
      if (!publicUrl) return { url: null };
      return transaction(() => {
        const token = crypto.createHmac('sha256', key).update(`inbox-case-link:${id}`).digest('base64url');
        if (!db.prepare('SELECT 1 FROM inbox_guest_links WHERE conversation_id=?').get(id)) {
          db.prepare('INSERT INTO inbox_guest_links VALUES (?,?)').run(id, hash(token));
          activity(id, actor, 'case.link-created', 'Created a private return link for the visitor.');
        }
        return { url: `${publicUrl}#resume=${token}` };
      });
    },
    start(raw, { ip = '' } = {}) {
      const input = messageInput(raw);
      const name = shortText(raw.name, 'name', 80, true);
      const email = shortText(raw.email, 'email address', 254);
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'invalid_email', 'Enter a valid email address or leave it blank');
      const subject = shortText(raw.subject, 'subject', 160, true);
      const startId = hash(input.requestId);
      const token = crypto.createHmac('sha256', key).update(`inbox-start:${input.requestId}`).digest('base64url');
      const fingerprint = hash(JSON.stringify({ name, email, subject, message: input.fingerprint }));
      return transaction(() => {
        let conversation = db.prepare('SELECT * FROM inbox_conversations WHERE start_id=?').get(startId);
        const created = !conversation;
        if (conversation) {
          if (conversation.start_fingerprint !== fingerprint) fail(409, 'request_conflict', 'This request ID was already used. Start a new conversation');
        } else {
          // IP keys are hashed so long-lived rate metadata does not retain addresses.
          rate(`start:${hash(ip)}`, limits.startsPerHour ?? 10);
          rate('starts', limits.totalStartsPerHour ?? 100);
          reserve({ conversations: 1, bytes: Buffer.byteLength(name + email + subject) });
          const id = identifier('inbox');
          const at = now();
          db.prepare('INSERT INTO inbox_conversations (id,name,email,subject,token_hash,start_id,start_fingerprint,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run(id, name, email, subject, hash(token), startId, fingerprint, at, at);
          conversation = row(id);
          createCase(conversation);
          write(conversation, visitor(conversation), input);
          conversation = row(id);
        }
        return { token, created, ...detail(conversation, visitor(conversation)), notify: notifyView(conversation.id) };
      });
    },
    guestDetail(token, after) { const c = guest(token); return { ...detail(c, visitor(c), after), notify: notifyView(c.id) }; },
    guestNotifyStart(token, raw) { return notifyStart(guest(token), object(raw).email); },
    // The code could not be sent: forget it, and keep the address for another try.
    guestNotifyUnsent(token) { const c = guest(token); db.prepare("UPDATE inbox_notify SET state='off',code_hash=NULL,updated_at=? WHERE conversation_id=? AND state='pending'").run(now(), c.id); return { notify: notifyView(c.id) }; },
    guestNotifyConfirm(token, raw) { return notifyConfirm(guest(token), object(raw).code); },
    guestNotifyStop(token) { return notifyStop(guest(token)); },
    claimNotices, noticeSent, noticeFailed,
    guestPost(token, raw) {
      const authenticated = guest(token), input = messageInput(raw);
      return transaction(() => {
        // Another API process may resolve the case between authentication and
        // this write lock. Audit reopening from the current transactional row.
        const conversation = row(authenticated.id);
        return write(conversation, visitor(conversation), input);
      });
    },
    guestRead(token, through) { const c = guest(token); return read(c, visitor(c), through); },
    // What a teammate's phone is told when a visitor writes, like a direct message: the visitor's name, the case
    // reference and the text. Null unless this person should hear about it now: the assignee of an assigned case,
    // every team member of an unassigned one, and nobody who has already read that far.
    notificationFor(user, id, sequence) {
      const staff = person => !!person && ['owner', 'member'].includes(person.role);
      const current = users()[user?.id];
      if (!staff(current) || typeof id !== 'string' || !Number.isSafeInteger(sequence)) return null;
      const conversation = db.prepare('SELECT * FROM inbox_conversations WHERE id=?').get(id);
      const message = conversation && db.prepare("SELECT id,text FROM inbox_messages WHERE conversation_id=? AND sequence=? AND sender='visitor'").get(id, sequence);
      if (!message) return null;
      // An assignee who has since left the team no longer answers for the case, so everyone hears again.
      if (staff(users()[conversation.assignee_id]) && conversation.assignee_id !== current.id) return null;
      const read = db.prepare('SELECT through_sequence FROM inbox_reads WHERE conversation_id=? AND reader=?').get(id, `staff:${current.id}`)?.through_sequence || 0;
      if (read >= sequence) return null;
      const files = db.prepare('SELECT count(*) AS n FROM inbox_files WHERE message_id=?').get(message.id).n;
      return { kind: 'dm', caseId: id, title: [conversation.name, reference(id)].filter(Boolean).join(' · '), body: message.text || (files ? 'Sent an attachment' : '') };
    },
    guestFile(token, id) { return getFile(guest(token), id); },
    list(user, { status = 'open', q = '', before, scope = 'all' } = {}) {
      const actor = identity(user);
      if (!['open', 'resolved', 'all'].includes(status)) fail(400, 'status', 'Choose open, resolved, or all conversations');
      const search = shortText(q, 'search', 160);
      const offset = cursor(before);
      if (!['all', 'mine', 'unassigned', 'due'].includes(scope)) fail(400, 'scope', 'Choose all, mine, unassigned, or due cases');
      const today = new Date(now()).toISOString().slice(0, 10);
      const rows = db.prepare(`SELECT c.* FROM inbox_conversations c JOIN inbox_cases k ON k.conversation_id=c.id
        WHERE (?='all' OR c.status=?) AND (?='' OR instr(lower(c.name || ' ' || c.email || ' ' || c.subject || ' ' || printf('CASE-%06d',k.sequence)),lower(?))>0)
        AND (?='all' OR (?='unassigned' AND c.assignee_id IS NULL)
          OR (?='mine' AND (c.assignee_id=? OR EXISTS(SELECT 1 FROM inbox_tasks t WHERE t.conversation_id=c.id AND t.status='open' AND t.assignee_id=?)))
          OR (?='due' AND EXISTS(SELECT 1 FROM inbox_tasks t WHERE t.conversation_id=c.id AND t.status='open' AND t.due_date<=?)))
        ORDER BY max(c.updated_at,coalesce((SELECT max(a.at) FROM inbox_activity a WHERE a.conversation_id=c.id),0)) DESC,c.id LIMIT ? OFFSET ?`)
        .all(status, status, search, search, scope, scope, scope, actor.id, actor.id, scope, today, PAGE_SIZE + 1, offset);
      return { conversations: rows.slice(0, PAGE_SIZE).map(c => view(c, actor)), hasMore: rows.length > PAGE_SIZE, nextOffset: offset + Math.min(rows.length, PAGE_SIZE) };
    },
    staffDetail(user, id, after) { const actor = identity(user); return detail(row(id), actor, after); },
    staffPost(user, id, raw) { const actor = identity(user); const input = messageInput(raw); return transaction(() => write(row(id), actor, input)); },
    staffRead(user, id, through) { const actor = identity(user); return read(row(id), actor, through); },
    staffFile(user, id, fileId) { identity(user); return getFile(row(id), fileId); },
    caseDetail(user, id) {
      const actor = identity(user), conversation = row(id);
      return { conversation: view(conversation, actor), ...caseSummary(id), tasks: tasksFor(id), notify: notifyView(id) };
    },
    notes(user, id, after) {
      identity(user); row(id);
      const notes = db.prepare('SELECT * FROM inbox_notes WHERE conversation_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(id, cursor(after), PAGE_SIZE + 1);
      return { notes: notes.slice(0, PAGE_SIZE).map(noteView), hasMore: notes.length > PAGE_SIZE };
    },
    addNote(user, id, raw) { const actor = identity(user), input = messageInput(raw); return transaction(() => writeNote(row(id), actor, input)); },
    noteFile(user, id, fileId) {
      identity(user); row(id);
      const f = db.prepare('SELECT id,name,mime,size,data FROM inbox_note_files WHERE conversation_id=? AND id=?').get(id, fileId);
      if (!f) fail(404, 'not_found', 'That internal file is unavailable');
      return { file: { ...f, data: Buffer.from(f.data).toString('base64') } };
    },
    addTask(user, id, raw) { const actor = identity(user); return transaction(() => createTask(row(id), actor, raw)); },
    changeTask(user, id, taskId, raw) { const actor = identity(user); return transaction(() => updateTask(row(id), actor, taskId, raw)); },
    activity(user, id, after) {
      identity(user); row(id);
      const events = db.prepare('SELECT id,sequence,kind,actor_name AS actorName,at,text FROM inbox_activity WHERE conversation_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(id, cursor(after), PAGE_SIZE + 1);
      return { activity: events.slice(0, PAGE_SIZE).map(event => ({ ...event })), hasMore: events.length > PAGE_SIZE };
    },
    update(user, id, raw) {
      const actor = identity(user);
      const input = object(raw);
      if (!Object.keys(input).length || Object.keys(input).some(k => !['status', 'assigneeId'].includes(k))) fail(400, 'invalid_update', 'Change the conversation status or assignee');
      if ('status' in input && !['open', 'resolved'].includes(input.status)) fail(400, 'status', 'Choose open or resolved');
      if ('assigneeId' in input && input.assigneeId !== null && (typeof input.assigneeId !== 'string' || !users()[input.assigneeId] || !['owner', 'member'].includes(users()[input.assigneeId].role))) fail(400, 'assignee', 'Choose a current team member');
      return transaction(() => {
        const c = row(id);
        const after = { status: input.status ?? c.status, assigneeId: 'assigneeId' in input ? input.assigneeId : c.assignee_id };
        if (after.status !== c.status) activity(id, actor, after.status === 'resolved' ? 'case.resolved' : 'case.reopened', after.status === 'resolved' ? 'Resolved the case.' : 'Reopened the case.', { before: { status: c.status }, after: { status: after.status } });
        if (after.assigneeId !== c.assignee_id) activity(id, actor, 'case.assigned', after.assigneeId ? `Assigned the case to ${users()[after.assigneeId].name}.` : 'Removed the case assignment.', { before: { assigneeId: c.assignee_id, assigneeName: users()[c.assignee_id]?.name || null }, after: { assigneeId: after.assigneeId, assigneeName: users()[after.assigneeId]?.name || null } });
        db.prepare('UPDATE inbox_conversations SET status=?,assignee_id=?,updated_at=? WHERE id=?').run(after.status, after.assigneeId, after.status !== c.status ? now() : c.updated_at, id);
        return { conversation: view(row(id), actor) };
      });
    },
    close() { db.close(); key.fill(0); },
  };
}
