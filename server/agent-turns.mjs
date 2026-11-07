// Private conversations use the same independent worker as channels. The API
// only commits requests and reads this journal; losing a phone/API connection
// never cancels the worker's upstream connection.
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { sourceDeviceKind } from './source-device.mjs';

export const MAX_QUEUED = 5;
const activeStates = ['queued', 'research_queued', 'running', 'waiting_for_approval', 'stopping'];
const MAX_STEPS = 40;
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
      request_id TEXT, request_hash TEXT, message_id TEXT, research_handoff_id TEXT,
      delivery_started INTEGER NOT NULL DEFAULT 0, UNIQUE(chat_id,request_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS private_turn_running ON private_turns(chat_id)
      WHERE status IN ('running','waiting_for_approval','stopping');
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
  db.exec('BEGIN IMMEDIATE');
  try {
    const columns = new Set(db.prepare('PRAGMA table_info(private_turns)').all().map(c => c.name));
    for (const column of ['request_id', 'request_hash', 'message_id', 'source_device_kind', 'research_handoff_id']) {
      if (!columns.has(column)) db.exec(`ALTER TABLE private_turns ADD COLUMN ${column} TEXT`);
    }
    if (!columns.has('delivery_started')) {
      db.exec('ALTER TABLE private_turns ADD COLUMN delivery_started INTEGER NOT NULL DEFAULT 0');
      db.exec('UPDATE private_turns SET delivery_started=1 WHERE run_id IS NOT NULL OR accepted=1');
    }
    // Steering: a queued message can be folded into the running turn.
    if (!columns.has('steer_requested')) db.exec('ALTER TABLE private_turns ADD COLUMN steer_requested INTEGER NOT NULL DEFAULT 0');
    if (!columns.has('steered_into')) db.exec('ALTER TABLE private_turns ADD COLUMN steered_into TEXT');
    // The agent's latest progress line ("Searching the web"), for viewers that
    // aren't following the live stream.
    if (!columns.has('activity')) db.exec('ALTER TABLE private_turns ADD COLUMN activity TEXT');
    // Every progress step so far ([{ label, detail?, at }]), for the expanded view.
    if (!columns.has('steps')) db.exec("ALTER TABLE private_turns ADD COLUMN steps TEXT NOT NULL DEFAULT '[]'");
    if (!columns.has('started_at')) db.exec('ALTER TABLE private_turns ADD COLUMN started_at INTEGER');
    // Unused since conversations stopped closing themselves; kept so older journals open unchanged.
    for (const column of ['closed_by', 'closed_reason']) if (!columns.has(column)) db.exec(`ALTER TABLE private_turns ADD COLUMN ${column} TEXT`);
    for (const column of ['closed_at', 'closer_checked_at']) if (!columns.has(column)) db.exec(`ALTER TABLE private_turns ADD COLUMN ${column} INTEGER`);
    // Earlier journals allowed one queued-or-running turn per chat. Messages now
    // queue behind a running turn, so only running turns stay unique per chat.
    db.exec('DROP INDEX IF EXISTS private_turn_active');
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS private_turn_request ON private_turns(chat_id,request_id)');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS private_turn_research_handoff ON private_turns(research_handoff_id) WHERE research_handoff_id IS NOT NULL');
  // Unread agent replies, per conversation owner (not per phone). The first run
  // marks every reply that already exists as read so an upgrade doesn't light
  // up old conversations; replies finished after that start unread.
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS private_reply_reads (
      turn_id TEXT PRIMARY KEY REFERENCES private_turns(id) ON DELETE CASCADE,
      read_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS private_turn_migrations (name TEXT PRIMARY KEY);
    CREATE INDEX IF NOT EXISTS private_reply_owner ON private_turns(user_id,chat_id,status);`);
    if (db.prepare("INSERT OR IGNORE INTO private_turn_migrations VALUES ('reply_reads_v1')").run().changes) {
      db.prepare("INSERT OR IGNORE INTO private_reply_reads SELECT id, ? FROM private_turns WHERE status='completed'").run(clock());
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  const unreadWhere = "t.status='completed' AND t.message_id IS NOT NULL AND r.turn_id IS NULL";
  const unreadByChat = userId => Object.fromEntries(db.prepare(`SELECT t.chat_id AS chat, COUNT(*) AS n
    FROM private_turns t LEFT JOIN private_reply_reads r ON r.turn_id=t.id
    WHERE t.user_id=? AND ${unreadWhere} GROUP BY t.chat_id`).all(userId).map(x => [x.chat, x.n]));
  // Opening a conversation reads every finished reply in it.
  const markChatRead = (chatId, userId) => db.prepare(`INSERT OR IGNORE INTO private_reply_reads
    SELECT t.id, ? FROM private_turns t WHERE t.chat_id=? AND t.user_id=? AND t.status='completed'`).run(clock(), chatId, userId).changes;
  const row = id => db.prepare('SELECT * FROM private_turns WHERE id=?').get(id);
  const view = t => t && ({ id: t.id, chatId: t.chat_id, status: t.status === 'research_queued' ? 'queued' : t.status,
    accepted: !!t.accepted, text: t.text, assistantText: t.assistant_text, messageId: t.message_id,
    canStop: active(t.status) && (t.status === 'queued' || !!t.run_id),
    steerRequested: !!t.steer_requested, steeredInto: t.steered_into || null, activity: active(t.status) ? t.activity || null : null,
    steps: active(t.status) ? JSON.parse(t.steps || '[]') : [], startedAt: t.started_at ?? null,
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
      if (name === 'status') db.prepare('UPDATE private_turns SET activity=?,updated_at=? WHERE id=?').run(String(payload.text || '').slice(0, 80), clock(), id);
      if (name === 'step') {
        // A repeat of the last step (same line, no new detail) only refreshes it.
        const steps = JSON.parse(t.steps || '[]'), last = steps.at(-1);
        const step = { label: String(payload.label || '').slice(0, 80), ...(payload.detail ? { detail: String(payload.detail).slice(0, 200) } : {}), at: clock() };
        if (last && last.label === step.label && !step.detail) return;
        steps.push(step);
        db.prepare('UPDATE private_turns SET steps=?,updated_at=? WHERE id=?').run(JSON.stringify(steps.slice(-MAX_STEPS)), clock(), id);
      }
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
  function enqueue({ chat, user, device, text, attachments, requestId, researchHandoffId }) {
    if (researchHandoffId !== undefined && (typeof researchHandoffId !== 'string' || !/^rhh_[A-Za-z0-9_-]{12}$/.test(researchHandoffId))) {
      throw fault(400, 'research_handoff_invalid', 'Invalid research handoff');
    }
    const { payload, fingerprint } = requestFingerprint(text, attachments, requestId);
    return tx(() => {
      if (requestId) {
        const prior = db.prepare('SELECT * FROM private_turns WHERE chat_id=? AND request_id=?').get(chat.id, requestId);
        if (prior) {
          if (prior.request_hash !== fingerprint) throw fault(409, 'request_conflict', 'This request ID was already used for a different message');
          return view(prior);
        }
      }
      if (db.prepare("SELECT COUNT(*) AS n FROM private_turns WHERE chat_id=? AND status IN ('queued','research_queued')").get(chat.id).n >= MAX_QUEUED) {
        throw fault(409, 'queue_full', `Up to ${MAX_QUEUED} messages can wait. Steer or remove one first`);
      }
      const id = `turn_${crypto.randomBytes(12).toString('base64url')}`;
      const status = researchHandoffId ? 'held' : 'queued';
      db.prepare(`INSERT INTO private_turns(id,chat_id,user_id,role,device_id,session_id,text,payload,status,created_at,updated_at,request_id,request_hash,source_device_kind,research_handoff_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, chat.id, user.id, chat.role, device.id, chat.hermesSessionId, text, payload, status, clock(), clock(), requestId || null, fingerprint, sourceDeviceKind(device), researchHandoffId || null);
      const turn = view(row(id));
      if (status === 'queued') event(id, 'turn', { turn });
      return turn;
    });
  }
  function releaseResearchHandoff(id, researchHandoffId) {
    return tx(() => {
      const t = row(id);
      if (!t || t.research_handoff_id !== researchHandoffId) throw fault(409, 'research_handoff_changed', 'Research handoff turn does not match');
      if (t.status === 'held') {
        db.prepare("UPDATE private_turns SET status='research_queued',updated_at=? WHERE id=?").run(clock(), id);
        event(id, 'turn', { turn: view(row(id)) });
      }
      return view(row(id));
    });
  }
  function abandonResearchHandoff(id, researchHandoffId) {
    return tx(() => {
      const t = row(id);
      if (!t || t.research_handoff_id !== researchHandoffId || t.status !== 'held') return false;
      db.prepare('DELETE FROM private_turns WHERE id=?').run(id);
      return true;
    });
  }
  const researchHandoffRetryable = (id, researchHandoffId) => {
    const t = row(id);
    return !!t && t.research_handoff_id === researchHandoffId && !t.accepted && !t.delivery_started && !active(t.status) && t.status !== 'held';
  };
  function rearmResearchHandoff(id, researchHandoffId, { text, attachments, requestId, device }) {
    if (!device?.id) throw fault(400, 'research_handoff_invalid', 'Retry device is invalid');
    const { payload, fingerprint } = requestFingerprint(text, attachments, requestId);
    return tx(() => {
      const t = row(id);
      if (!t || t.research_handoff_id !== researchHandoffId || t.accepted || t.delivery_started || active(t.status) || t.status === 'held') {
        throw fault(409, 'research_handoff_pending', 'Research handoff turn is not safely retryable');
      }
      if (requestId) {
        const other = db.prepare('SELECT id,request_hash FROM private_turns WHERE chat_id=? AND request_id=?').get(t.chat_id, requestId);
        if (other && other.id !== id) throw fault(409, 'request_conflict', 'This request ID was already used for a different message');
      }
      db.prepare('DELETE FROM private_turn_events WHERE turn_id=?').run(id);
      db.prepare('DELETE FROM private_turn_outbox WHERE turn_id=?').run(id);
      db.prepare(`UPDATE private_turns SET device_id=?,source_device_kind=?,text=?,payload=?,status='held',accepted=0,assistant_text='',run_id=NULL,approval=NULL,
        stop_requested=0,approval_choice=NULL,updated_at=?,request_id=?,request_hash=?,message_id=NULL,steer_requested=0,
        steered_into=NULL,activity=NULL,steps='[]',started_at=NULL,delivery_started=0 WHERE id=?`)
        .run(device.id, sourceDeviceKind(device), text, payload, clock(), requestId || null, fingerprint, id);
      return view(row(id));
    });
  }
  function reconcileResearchHandoffs(bindings = []) {
    const expected = new Map(bindings.map(binding => [binding.researchHandoffId, binding]));
    return tx(() => {
      let released = 0, abandoned = 0;
      for (const t of db.prepare("SELECT * FROM private_turns WHERE status='held' AND research_handoff_id IS NOT NULL").all()) {
        const binding = expected.get(t.research_handoff_id);
        if (binding?.turnId === t.id && binding.chatId === t.chat_id) {
          db.prepare("UPDATE private_turns SET status='research_queued',updated_at=? WHERE id=?").run(clock(), t.id);
          event(t.id, 'turn', { turn: view(row(t.id)) });
          released++;
        } else {
          db.prepare('DELETE FROM private_turns WHERE id=?').run(t.id);
          abandoned++;
        }
      }
      return { released, abandoned };
    });
  }
  function requestStop(id) {
    return tx(() => {
      const t = row(id);
      if (!t) throw fault(404, 'not_found', 'No such turn');
      if (!active(t.status)) return view(t);
      if (['queued', 'research_queued'].includes(t.status) && !t.run_id) {
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
  // One tap: fold a waiting message into the reply that's running now. The
  // worker running that reply delivers it; if the reply finishes first, the
  // message simply runs next as its own turn, so nothing is lost.
  function requestSteer(id) {
    return tx(() => {
      const t = row(id);
      if (!t) throw fault(404, 'not_found', 'No such turn');
      if (t.status !== 'queued' || t.run_id) throw fault(409, 'steer_unavailable', 'That message is no longer waiting');
      if ((JSON.parse(t.payload).attachments || []).length || !t.text.trim()) throw fault(409, 'steer_files', 'Messages with files run next, after this reply');
      if (!db.prepare("SELECT id FROM private_turns WHERE chat_id=? AND status IN ('running','waiting_for_approval')").get(t.chat_id)) {
        throw fault(409, 'nothing_to_steer', 'The agent already finished. Your message will run next');
      }
      db.prepare('UPDATE private_turns SET steer_requested=1,updated_at=? WHERE id=?').run(clock(), id);
      event(id, 'turn', { turn: view(row(id)) });
      return view(row(id));
    });
  }
  function pendingSteers(activeId) {
    const a = row(activeId);
    if (!a) return [];
    return db.prepare("SELECT id,text,payload FROM private_turns WHERE chat_id=? AND status='queued' AND steer_requested=1 AND run_id IS NULL ORDER BY seq")
      .all(a.chat_id).map(t => ({ id: t.id, text: t.text, hasAttachments: (JSON.parse(t.payload).attachments || []).length > 0 }));
  }
  function markSteered(id, activeId) {
    return tx(() => {
      const t = row(id);
      if (!t || t.status !== 'queued' || !t.steer_requested) return null;
      db.prepare("UPDATE private_turns SET status='steered',accepted=1,steered_into=?,payload='{}',updated_at=? WHERE id=?").run(activeId, clock(), id);
      event(id, 'turn', { turn: view(row(id)) }); event(id, 'done', { status: 'steered' });
      event(activeId, 'turn', { turn: view(row(activeId)) });
      return view(row(id));
    });
  }
  // The agent finished before reading a steer: run that message next, keeping
  // its place at the front of the queue. Its chat message already exists.
  function requeueSteer(id) {
    return tx(() => {
      const t = row(id);
      if (!t || t.status !== 'steered') return null;
      db.prepare("UPDATE private_turns SET status='queued',steer_requested=0,steered_into=NULL,updated_at=? WHERE id=?").run(clock(), id);
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
      // Oldest waiting message in a chat that isn't already running a turn.
      const next = db.prepare(`SELECT * FROM private_turns q WHERE q.status IN ('queued','research_queued') AND NOT EXISTS (
        SELECT 1 FROM private_turns r WHERE r.chat_id=q.chat_id AND r.status IN ('running','waiting_for_approval','stopping'))
        ORDER BY q.seq LIMIT 1`).get();
      if (!next) return;
      db.prepare('UPDATE private_turns SET status=?,started_at=COALESCE(started_at,?),updated_at=? WHERE id=?').run(next.stop_requested ? 'stopping' : next.approval ? 'waiting_for_approval' : 'running', clock(), clock(), next.id);
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
        controls: () => { const current = row(t.id); return { stop: !!current.stop_requested, choice: current.approval_choice, approval: current.approval && JSON.parse(current.approval), steers: current.stop_requested ? [] : pendingSteers(t.id) }; },
        steered: id => markSteered(id, t.id),
        controlError: message => emit(t.id, 'error', { message }),
        deliveryStarted: () => tx(() => db.prepare('UPDATE private_turns SET delivery_started=1,updated_at=? WHERE id=?').run(clock(), t.id)),
      });
      for (const id of result?.unreadSteers || []) requeueSteer(id);
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
  // The accepted user message ID is already stable in every compatible worker
  // (chat-media.accept uses chatId:user:turnId). Project this API-owned snapshot
  // without requiring the independent worker to rewrite cached messages/events.
  const userMessageId = t => `msg_${crypto.createHash('sha256').update(`${t.chat_id}:user:${t.id}`).digest('hex').slice(0, 32)}`;
  const sourceMap = rows => new Map(rows.map(t => [userMessageId(t), t.source_device_kind]));
return { unreadByChat, markChatRead, enqueue, replay, releaseResearchHandoff, abandonResearchHandoff, researchHandoffRetryable, rearmResearchHandoff, reconcileResearchHandoffs, processNext, recoverInterrupted, requestStop, requestApproval, requestSteer, markSteered, requeueSteer, drainOutbox,
    messageSources: chatId => sourceMap(db.prepare('SELECT id,chat_id,source_device_kind FROM private_turns WHERE chat_id=?').all(chatId)),
    // Who sent each user message; a research plan can have edit collaborators.
    messageAuthors: chatId => new Map(db.prepare('SELECT id,chat_id,user_id FROM private_turns WHERE chat_id=?').all(chatId).map(t => [userMessageId(t), t.user_id])),
    turnMessageSources: id => sourceMap(db.prepare('SELECT id,chat_id,source_device_kind FROM private_turns WHERE id=?').all(id)),
    get: id => view(row(id)),
    owns: (id, chatId, userId) => { const t = row(id); return !!t && t.chat_id === chatId && t.user_id === userId; },
    latest: chatId => db.prepare('SELECT * FROM private_turns WHERE chat_id=? ORDER BY seq DESC LIMIT 20').all(chatId).map(view),
    drafts: chatId => db.prepare("SELECT * FROM private_turns WHERE chat_id=? AND accepted=1 AND assistant_text<>'' AND message_id IS NULL ORDER BY seq").all(chatId).map(view),
    events: (id, after = 0) => db.prepare('SELECT seq,event,payload FROM private_turn_events WHERE turn_id=? AND seq>? ORDER BY seq LIMIT 250').all(id, after).map(e => ({ ...e, payload: JSON.parse(e.payload) })),
    whenIdle: async () => { while (tasks.size) await Promise.allSettled([...tasks]); },
    close: () => db.close(),
  };
}
