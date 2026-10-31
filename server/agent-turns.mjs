// Private conversations use the same independent worker as channels. The API
// only commits requests and reads this journal; losing a phone/API connection
// never cancels the worker's upstream connection.
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';

const activeStates = ['queued', 'running', 'waiting_for_approval', 'stopping'];
const active = status => activeStates.includes(status);
const fault = (status, code, message) => Object.assign(new Error(message), { status, code });
export const terminalTurn = turn => !active(turn.status);

export function createAgentTurns({ file, execute, clock = Date.now, concurrency = 4 }) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('Invalid private turn concurrency');
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS private_turns (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      chat_id TEXT NOT NULL, user_id TEXT NOT NULL, role TEXT NOT NULL,
      device_id TEXT NOT NULL, session_id TEXT NOT NULL, text TEXT NOT NULL,
      payload TEXT NOT NULL, status TEXT NOT NULL, accepted INTEGER NOT NULL DEFAULT 0,
      assistant_text TEXT NOT NULL DEFAULT '', run_id TEXT, approval TEXT,
      stop_requested INTEGER NOT NULL DEFAULT 0, approval_choice TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      request_id TEXT, request_hash TEXT, message_id TEXT, UNIQUE(chat_id,request_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS private_turn_active ON private_turns(chat_id)
      WHERE status IN ('queued','running','waiting_for_approval','stopping');
    CREATE TABLE IF NOT EXISTS private_turn_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, turn_id TEXT NOT NULL REFERENCES private_turns(id) ON DELETE CASCADE,
      event TEXT NOT NULL, payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS private_turn_event_cursor ON private_turn_events(turn_id,seq);
    CREATE TABLE IF NOT EXISTS private_turn_outbox (
      turn_id TEXT PRIMARY KEY REFERENCES private_turns(id) ON DELETE CASCADE, payload TEXT NOT NULL
    );`);
  // Compatible with an earlier development build of the journal during a
  // rolling API replacement. Existing rows retain their original delivery IDs.
  const columns = new Set(db.prepare('PRAGMA table_info(private_turns)').all().map(c => c.name));
  for (const column of ['request_id', 'request_hash', 'message_id']) {
    if (!columns.has(column)) db.exec(`ALTER TABLE private_turns ADD COLUMN ${column} TEXT`);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS private_turn_request ON private_turns(chat_id,request_id)');
  const row = id => db.prepare('SELECT * FROM private_turns WHERE id=?').get(id);
  const view = t => t && ({ id: t.id, chatId: t.chat_id, status: t.status,
    accepted: !!t.accepted, text: t.text, assistantText: t.assistant_text, messageId: t.message_id,
    canStop: active(t.status) && (t.status === 'queued' || !!t.run_id),
    approval: t.approval ? JSON.parse(t.approval) : null,
    createdAt: t.created_at, updatedAt: t.updated_at });
  function tx(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); db.exec('COMMIT'); return value; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  function event(id, name, payload) {
    db.prepare('INSERT INTO private_turn_events(turn_id,event,payload) VALUES (?,?,?)').run(id, name, JSON.stringify(payload));
  }
  function emit(id, name, payload) {
    tx(() => {
      const t = row(id);
      if (!t || !active(t.status)) return;
      if (name === 'delta') db.prepare('UPDATE private_turns SET assistant_text=assistant_text||?,updated_at=? WHERE id=?').run(payload.text || '', clock(), id);
      if (name === 'sent') db.prepare('UPDATE private_turns SET accepted=1,updated_at=? WHERE id=?').run(clock(), id);
      if (name === 'message') db.prepare('UPDATE private_turns SET assistant_text=?,message_id=?,updated_at=? WHERE id=?').run(payload.text || '', payload.id, clock(), id);
      if (name === 'approval') db.prepare("UPDATE private_turns SET approval=?,approval_choice=NULL,status='waiting_for_approval',updated_at=? WHERE id=?")
        .run(JSON.stringify(payload.approval), clock(), id);
      if (name === 'approval_resolved') db.prepare("UPDATE private_turns SET approval=NULL,approval_choice=NULL,status='running',updated_at=? WHERE id=?").run(clock(), id);
      event(id, name, payload);
      if (name === 'approval' || name === 'approval_resolved') event(id, 'turn', { turn: view(row(id)) });
    });
  }
  function finish(id, status, message, notification) {
    tx(() => {
      const t = row(id);
      if (!t || !active(t.status)) return;
      db.prepare('UPDATE private_turns SET status=?,payload=\'{}\',approval=NULL,approval_choice=NULL,updated_at=? WHERE id=?').run(status, clock(), id);
      if (message) event(id, 'error', { message });
      event(id, 'turn', { turn: view(row(id)) });
      event(id, 'done', { status });
      if (notification) db.prepare('INSERT OR IGNORE INTO private_turn_outbox VALUES (?,?)').run(id, JSON.stringify(notification));
    });
  }
  function requestFingerprint(text, attachments, requestId) {
    if (requestId !== undefined && (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,100}$/.test(requestId))) {
      throw fault(400, 'invalid_request_id', 'Invalid message request ID');
    }
    const payload = JSON.stringify({ attachments: attachments.map(a => ({ ...a, data: Buffer.from(a.data).toString('base64') })) });
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify([text, payload])).digest('hex');
    return { payload, fingerprint };
  }
  function replay({ chat, text, attachments, requestId }) {
    const { fingerprint } = requestFingerprint(text, attachments, requestId);
    if (!requestId) return null;
    const prior = db.prepare('SELECT * FROM private_turns WHERE chat_id=? AND request_id=?').get(chat.id, requestId);
    if (!prior) return null;
    if (prior.request_hash !== fingerprint) throw fault(409, 'request_conflict', 'This request ID was already used for a different message');
    return view(prior);
  }
  function enqueue({ chat, user, device, text, attachments, requestId }) {
    const { payload, fingerprint } = requestFingerprint(text, attachments, requestId);
    return tx(() => {
      if (requestId) {
        const prior = db.prepare('SELECT * FROM private_turns WHERE chat_id=? AND request_id=?').get(chat.id, requestId);
        if (prior) {
          if (prior.request_hash !== fingerprint) throw fault(409, 'request_conflict', 'This request ID was already used for a different message');
          return view(prior);
        }
      }
      if (db.prepare("SELECT id FROM private_turns WHERE chat_id=? AND status IN ('queued','running','waiting_for_approval','stopping')").get(chat.id)) {
        throw fault(409, 'turn_active', 'The agent is still working in this chat');
      }
      const id = `turn_${crypto.randomBytes(12).toString('base64url')}`;
      db.prepare(`INSERT INTO private_turns(id,chat_id,user_id,role,device_id,session_id,text,payload,status,created_at,updated_at,request_id,request_hash)
        VALUES (?,?,?,?,?,?,?,?,'queued',?,?,?,?)`).run(id, chat.id, user.id, chat.role, device.id, chat.hermesSessionId, text, payload, clock(), clock(), requestId || null, fingerprint);
      const turn = view(row(id));
      event(id, 'turn', { turn });
      return turn;
    });
  }
  function requestStop(id) {
    return tx(() => {
      const t = row(id);
      if (!t) throw fault(404, 'not_found', 'No such turn');
      if (!active(t.status)) return view(t);
      if (t.status === 'queued' && !t.run_id) {
        db.prepare("UPDATE private_turns SET status='cancelled',payload='{}',updated_at=? WHERE id=?").run(clock(), id);
        event(id, 'turn', { turn: view(row(id)) }); event(id, 'done', { status: 'cancelled' });
        return view(row(id));
      }
      if (!t.run_id) throw fault(409, 'stop_unavailable', 'Update the Hermes bridge to stop this turn');
      db.prepare("UPDATE private_turns SET stop_requested=1,status='stopping',updated_at=? WHERE id=?").run(clock(), id);
      event(id, 'turn', { turn: view(row(id)) });
      return view(row(id));
    });
  }
  function requestApproval(id, approvalId, choice) {
    if (!['once', 'deny'].includes(choice)) throw fault(400, 'invalid_choice', 'Choose Allow once or Deny');
    return tx(() => {
      const t = row(id);
      if (!t?.approval || t.status !== 'waiting_for_approval' || t.approval_choice || JSON.parse(t.approval).id !== approvalId) {
        throw fault(409, 'approval_stale', 'That approval is no longer waiting for an answer');
      }
      db.prepare('UPDATE private_turns SET approval_choice=?,updated_at=? WHERE id=?').run(choice, clock(), id);
      return view(row(id));
    });
  }
  const tasks = new Set();
  function processNext() {
    if (tasks.size >= concurrency) return Promise.resolve(false);
    const t = tx(() => {
      const next = db.prepare("SELECT * FROM private_turns WHERE status='queued' ORDER BY seq LIMIT 1").get();
      if (!next) return;
      db.prepare('UPDATE private_turns SET status=?,updated_at=? WHERE id=?').run(next.stop_requested ? 'stopping' : next.approval ? 'waiting_for_approval' : 'running', clock(), next.id);
      event(next.id, 'turn', { turn: view(row(next.id)) });
      return row(next.id);
    });
    if (!t) return Promise.resolve(false);
    const payload = JSON.parse(t.payload);
    const task = Promise.resolve().then(async () => {
      const result = await execute({ ...t, attachments: (payload.attachments || []).map(a => ({ ...a, data: Buffer.from(a.data, 'base64') })) }, {
        emit: (name, payload) => emit(t.id, name, payload),
        checkpoint: runId => tx(() => {
          db.prepare('UPDATE private_turns SET run_id=?,updated_at=? WHERE id=?').run(runId, clock(), t.id);
          event(t.id, 'turn', { turn: view(row(t.id)) });
        }),
        controls: () => { const current = row(t.id); return { stop: !!current.stop_requested, choice: current.approval_choice, approval: current.approval && JSON.parse(current.approval) }; },
        controlError: message => emit(t.id, 'error', { message }),
      });
      finish(t.id, result?.status || 'completed', undefined, result?.notification);
      return true;
    }).catch(error => {
      finish(t.id, error?.code === 'run_lost' ? 'interrupted' : 'failed', error?.code === 'agent_error' ? "The agent didn't answer. Try again" : 'The agent connection ended before the answer finished');
      return false;
    }).finally(() => { tasks.delete(task); });
    tasks.add(task);
    return task;
  }
  function recoverInterrupted() {
    const interrupted = db.prepare("SELECT * FROM private_turns WHERE status IN ('running','waiting_for_approval','stopping')").all();
    for (const t of interrupted) {
      if (t.run_id) db.prepare("UPDATE private_turns SET status='queued',updated_at=? WHERE id=?").run(clock(), t.id);
      else finish(t.id, 'interrupted', 'The worker restarted before this answer finished. Review the partial reply before trying again');
    }
    return interrupted.length;
  }
  function drainOutbox(enqueue) {
    for (const item of db.prepare('SELECT * FROM private_turn_outbox').all()) {
      enqueue(JSON.parse(item.payload));
      db.prepare('DELETE FROM private_turn_outbox WHERE turn_id=?').run(item.turn_id);
    }
  }
  return { enqueue, replay, processNext, recoverInterrupted, requestStop, requestApproval, drainOutbox,
    get: id => view(row(id)),
    owns: (id, chatId, userId) => { const t = row(id); return !!t && t.chat_id === chatId && t.user_id === userId; },
    latest: chatId => db.prepare('SELECT * FROM private_turns WHERE chat_id=? ORDER BY seq DESC LIMIT 20').all(chatId).map(view),
    drafts: chatId => db.prepare("SELECT * FROM private_turns WHERE chat_id=? AND accepted=1 AND assistant_text<>'' AND message_id IS NULL ORDER BY seq").all(chatId).map(view),
    events: (id, after = 0) => db.prepare('SELECT seq,event,payload FROM private_turn_events WHERE turn_id=? AND seq>? ORDER BY seq LIMIT 250').all(id, after).map(e => ({ ...e, payload: JSON.parse(e.payload) })),
    whenIdle: async () => { while (tasks.size) await Promise.allSettled([...tasks]); },
    close: () => db.close(),
  };
}
