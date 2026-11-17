// Private conversations use the same independent worker as channels. The API
// only commits requests and reads this journal; losing a phone/API connection
// never cancels the worker's upstream connection.
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { sourceDeviceKind } from './source-device.mjs';
import { usualWork, LONG_REPLY_MS, SAMPLE } from './turn-estimate.mjs';

export const MAX_QUEUED = 5;
const activeStates = ['queued', 'running', 'waiting_for_approval', 'stopping'];
const MAX_STEPS = 40;
const active = status => activeStates.includes(status);
const steerable = status => status === 'running' || status === 'waiting_for_approval';
// Copy spells out one to nine.
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const fault = (status, code, message) => Object.assign(new Error(message), { status, code });
export const terminalTurn = turn => !active(turn.status);

export function createAgentTurns({ file, execute, clock = Date.now, concurrency = 4, keepRecords = false }) {
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
    for (const column of ['request_id', 'request_hash', 'message_id', 'source_device_kind']) {
      if (!columns.has(column)) db.exec(`ALTER TABLE private_turns ADD COLUMN ${column} TEXT`);
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
    // When the reply ended, so the app can say how long the agent worked.
    if (!columns.has('finished_at')) db.exec('ALTER TABLE private_turns ADD COLUMN finished_at INTEGER');
    // Set by the worker running the reply: its agent can take a message mid-task.
    if (!columns.has('can_steer')) db.exec('ALTER TABLE private_turns ADD COLUMN can_steer INTEGER NOT NULL DEFAULT 0');
    // How long replies like this one usually work, fixed when it starts (turn-estimate.mjs); null when the history can't say.
    if (!columns.has('usual_ms')) db.exec('ALTER TABLE private_turns ADD COLUMN usual_ms INTEGER');
    // Waiting for the person's OK is not work: since when it has been waiting, and how long it has waited in all.
    if (!columns.has('waiting_since')) db.exec('ALTER TABLE private_turns ADD COLUMN waiting_since INTEGER');
    if (!columns.has('waited_ms')) db.exec('ALTER TABLE private_turns ADD COLUMN waited_ms INTEGER NOT NULL DEFAULT 0');
    // Unused since conversations stopped closing themselves; kept so older journals open unchanged.
    for (const column of ['closed_by', 'closed_reason']) if (!columns.has(column)) db.exec(`ALTER TABLE private_turns ADD COLUMN ${column} TEXT`);
    for (const column of ['closed_at', 'closer_checked_at']) if (!columns.has(column)) db.exec(`ALTER TABLE private_turns ADD COLUMN ${column} INTEGER`);
    // Earlier journals allowed one queued-or-running turn per chat. Messages now
    // queue behind a running turn, so only running turns stay unique per chat.
    db.exec('DROP INDEX IF EXISTS private_turn_active');
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS private_turn_request ON private_turns(chat_id,request_id)');
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
  // Replies in other people's conversations (shared ones, or any, for the owner), per reader.
  // Each reader starts from the moment they first ask, so nothing old lights up; after that a
  // finished reply is unread until they open that conversation or mark everything read.
  db.exec(`CREATE TABLE IF NOT EXISTS private_reply_views (
    turn_id TEXT NOT NULL REFERENCES private_turns(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL, read_at INTEGER NOT NULL, PRIMARY KEY (turn_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS private_reader_since (user_id TEXT PRIMARY KEY, since INTEGER NOT NULL);`);
  const readerSince = userId => {
    db.prepare('INSERT OR IGNORE INTO private_reader_since VALUES (?, ?)').run(userId, clock());
    return db.prepare('SELECT since FROM private_reader_since WHERE user_id=?').get(userId).since;
  };
  const unreadOthers = (userId, chatIds) => {
    const since = readerSince(userId), counts = {};
    if (!chatIds.length) return counts;
    const marks = chatIds.map(() => '?').join(',');
    for (const x of db.prepare(`SELECT t.chat_id AS chat, COUNT(*) AS n FROM private_turns t
      LEFT JOIN private_reply_views v ON v.turn_id=t.id AND v.user_id=?
      WHERE t.chat_id IN (${marks}) AND t.user_id!=? AND t.status='completed' AND t.message_id IS NOT NULL
        AND t.updated_at>? AND v.turn_id IS NULL GROUP BY t.chat_id`).all(userId, ...chatIds, userId, since)) counts[x.chat] = x.n;
    return counts;
  };
  // Opening (or marking read) someone else's conversation reads every finished reply in it for you only.
  const markViewed = (userId, chatIds) => {
    readerSince(userId);
    if (!chatIds.length) return 0;
    const marks = chatIds.map(() => '?').join(',');
    return db.prepare(`INSERT OR IGNORE INTO private_reply_views SELECT t.id, ?, ? FROM private_turns t
      WHERE t.chat_id IN (${marks}) AND t.user_id!=? AND t.status='completed'`).run(userId, clock(), ...chatIds, userId).changes;
  };
  const unreadWhere = "t.status='completed' AND t.message_id IS NOT NULL AND r.turn_id IS NULL";
  const unreadByChat = userId => Object.fromEntries(db.prepare(`SELECT t.chat_id AS chat, COUNT(*) AS n
    FROM private_turns t LEFT JOIN private_reply_reads r ON r.turn_id=t.id
    WHERE t.user_id=? AND ${unreadWhere} GROUP BY t.chat_id`).all(userId).map(x => [x.chat, x.n]));
  // Opening a conversation reads every finished reply in it.
  const markChatRead = (chatId, userId) => db.prepare(`INSERT OR IGNORE INTO private_reply_reads
    SELECT t.id, ? FROM private_turns t WHERE t.chat_id=? AND t.user_id=? AND t.status='completed'`).run(clock(), chatId, userId).changes;
  // "Mark all as read": every finished reply in the author's own conversations.
  const markAllChatsRead = userId => db.prepare(`INSERT OR IGNORE INTO private_reply_reads
    SELECT t.id, ? FROM private_turns t WHERE t.user_id=? AND t.status='completed'`).run(clock(), userId).changes;
  const row = id => db.prepare('SELECT * FROM private_turns WHERE id=?').get(id);
  const view = t => t && ({ id: t.id, chatId: t.chat_id, status: t.status,
    accepted: !!t.accepted, text: t.text, assistantText: t.assistant_text, messageId: t.message_id,
    canStop: active(t.status) && (t.status === 'queued' || !!t.run_id),
    // A message sent now can join this reply. False until the worker has asked its agent.
    canSteer: steerable(t.status) && !!t.can_steer,
    steerRequested: !!t.steer_requested, steeredInto: t.steered_into || null, activity: active(t.status) ? t.activity || null : null,
    // The steps ride along while the reply runs. Afterwards the list only counts them; detail() has them.
    steps: active(t.status) ? JSON.parse(t.steps || '[]') : [], stepCount: JSON.parse(t.steps || '[]').length,
    startedAt: t.started_at ?? null, finishedAt: active(t.status) || t.status === 'steered' ? null : t.finished_at ?? t.updated_at,
    // While it runs, and only when the history could say: how long replies like it usually work, and the time
    // this one has spent waiting for an OK (pausedAt while it waits now), which the app leaves out of the count.
    ...(active(t.status) && t.usual_ms ? { usualMs: t.usual_ms, pausedMs: t.waited_ms || 0, pausedAt: t.waiting_since ?? null } : {}),
    approval: t.approval ? JSON.parse(t.approval) : null,
    createdAt: t.created_at, updatedAt: t.updated_at });
  // How long this person's finished replies worked, newest first: ones that ran past the first minute, less the
  // time they waited for an OK. Only their own replies are read, and only the times.
  const worked = (where, ...args) => db.prepare(`SELECT finished_at - started_at - waited_ms AS ms FROM private_turns
    WHERE ${where} AND status='completed' AND finished_at - started_at - waited_ms >= ? ORDER BY seq DESC LIMIT ?`).all(...args, LONG_REPLY_MS, SAMPLE).map(found => found.ms);
  // This chat's replies, and the same person's on the same agent for a chat that has too few of its own.
  const usualFor = t => usualWork({ here: worked('chat_id=? AND user_id=?', t.chat_id, t.user_id), mine: worked('user_id=? AND role=?', t.user_id, t.role) });
  // One turn with every step it took, for "Worked for 12 seconds" opened after the reply.
  const detail = t => t && ({ ...view(t), steps: JSON.parse(t.steps || '[]') });
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
      // The wait for an OK is timed apart from the work: it starts at the first ask and is added up when answered.
      if (name === 'approval') db.prepare("UPDATE private_turns SET approval=?,approval_choice=NULL,status='waiting_for_approval',waiting_since=COALESCE(waiting_since,?),updated_at=? WHERE id=?")
        .run(JSON.stringify(payload.approval), clock(), clock(), id);
      if (name === 'approval_resolved') db.prepare("UPDATE private_turns SET approval=NULL,approval_choice=NULL,status='running',waited_ms=waited_ms+COALESCE(?-waiting_since,0),waiting_since=NULL,updated_at=? WHERE id=?").run(clock(), clock(), id);
      event(id, name, payload);
      if (name === 'approval' || name === 'approval_resolved') event(id, 'turn', { turn: view(row(id)) });
    });
  }
  function finish(id, status, message, notification) {
    tx(() => {
      const t = row(id);
      if (!t || !active(t.status)) return;
      // Records preservation: before the payload and approval are blanked, keep WHAT was attached (name, type, size; the bytes are in chat-media.db
      // once the turn was accepted) and the full approval record (what the agent asked to run and what the person decided).
      if (keepRecords) {
        const sent = t.payload && t.payload !== '{}' ? (JSON.parse(t.payload).attachments || []).map(a => ({ name: a.name, mime: a.mime, bytes: a.data ? Buffer.from(a.data, 'base64').length : undefined })) : [];
        event(id, 'record_snapshot', { attachments: sent, approval: t.approval ? JSON.parse(t.approval) : null, approvalChoice: t.approval_choice ?? null });
      }
      // A reply that ends while it waits (stopped, or cut off) closes that wait too.
      db.prepare('UPDATE private_turns SET status=?,payload=\'{}\',approval=NULL,approval_choice=NULL,waited_ms=waited_ms+COALESCE(?-waiting_since,0),waiting_since=NULL,finished_at=?,updated_at=? WHERE id=?').run(status, clock(), clock(), clock(), id);
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
      if (db.prepare("SELECT COUNT(*) AS n FROM private_turns WHERE chat_id=? AND status='queued'").get(chat.id).n >= MAX_QUEUED) {
        throw fault(409, 'queue_full', `Up to ${WORDS[MAX_QUEUED] ?? MAX_QUEUED} messages can wait. Remove one, or wait for the reply`);
      }
      const id = `turn_${crypto.randomBytes(12).toString('base64url')}`;
      db.prepare(`INSERT INTO private_turns(id,chat_id,user_id,role,device_id,session_id,text,payload,status,created_at,updated_at,request_id,request_hash,source_device_kind)
        VALUES (?,?,?,?,?,?,?,?,'queued',?,?,?,?,?)`).run(id, chat.id, user.id, chat.role, device.id, chat.hermesSessionId, text, payload, clock(), clock(), requestId || null, fingerprint, sourceDeviceKind(device));
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
  // One tap: fold a waiting message into the reply that's running now. The
  // worker running that reply delivers it; if the reply finishes first, the
  // message simply runs next as its own turn, so nothing is lost.
  function requestSteer(id) {
    return tx(() => {
      const t = row(id);
      if (!t) throw fault(404, 'not_found', 'No such turn');
      if (t.status !== 'queued' || t.run_id) throw fault(409, 'steer_unavailable', 'That message is no longer waiting');
      if ((JSON.parse(t.payload).attachments || []).length || !t.text.trim()) throw fault(409, 'steer_files', 'Messages with files run next, after this reply');
      const running = db.prepare("SELECT can_steer FROM private_turns WHERE chat_id=? AND status IN ('running','waiting_for_approval')").get(t.chat_id);
      if (!running) throw fault(409, 'nothing_to_steer', 'The agent already finished. Your message will run next');
      // Its worker never said the agent takes messages mid-task (a member's agent, an older bridge, or a reply
      // that has only just started), so nothing would deliver this. The message keeps its place and runs next.
      if (!running.can_steer) throw fault(409, 'steer_unsupported', "This reply can't take a message partway. Yours will run next");
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
      if (keepRecords) event(id, 'approval_decision', { approvalId, choice, at: clock() });
      return view(row(id));
    });
  }
  const tasks = new Set();
  function processNext() {
    if (tasks.size >= concurrency) return Promise.resolve(false);
    const t = tx(() => {
      // Oldest waiting message in a chat that isn't already running a turn.
      const next = db.prepare(`SELECT * FROM private_turns q WHERE q.status='queued' AND NOT EXISTS (
        SELECT 1 FROM private_turns r WHERE r.chat_id=q.chat_id AND r.status IN ('running','waiting_for_approval','stopping'))
        ORDER BY q.seq LIMIT 1`).get();
      if (!next) return;
      // The estimate is made once, as the reply starts, so it holds still while the reply runs. One picked up
      // again after a restart keeps the start and the estimate it had.
      const usual = next.started_at ? next.usual_ms : usualFor(next);
      db.prepare('UPDATE private_turns SET status=?,started_at=COALESCE(started_at,?),usual_ms=?,updated_at=? WHERE id=?').run(next.stop_requested ? 'stopping' : next.approval ? 'waiting_for_approval' : 'running', clock(), usual ?? null, clock(), next.id);
      event(next.id, 'turn', { turn: view(row(next.id)) });
      return row(next.id);
    });
    if (!t) return Promise.resolve(false);
    const payload = JSON.parse(t.payload);
    const task = Promise.resolve().then(async () => {
      const result = await execute({ ...t, attachments: (payload.attachments || []).map(a => ({ ...a, data: Buffer.from(a.data, 'base64') })) }, {
        emit: (name, payload) => emit(t.id, name, payload),
        checkpoint: runId => tx(() => {
          if (!row(t.id)) return; // the chat was deleted while this answer was running
          db.prepare('UPDATE private_turns SET run_id=?,updated_at=? WHERE id=?').run(runId, clock(), t.id);
          event(t.id, 'turn', { turn: view(row(t.id)) });
        }),
        controls: () => { const current = row(t.id); if (!current) return { stop: true, choice: null, approval: null }; return { stop: !!current.stop_requested, choice: current.approval_choice, approval: current.approval && JSON.parse(current.approval), steers: current.stop_requested ? [] : pendingSteers(t.id) }; },
        steered: id => markSteered(id, t.id),
        // The worker has asked its agent: messages sent from now on can (or can't) join this reply.
        steerable: on => tx(() => {
          if (!row(t.id)) return;
          db.prepare('UPDATE private_turns SET can_steer=?,updated_at=? WHERE id=?').run(on ? 1 : 0, clock(), t.id);
          event(t.id, 'turn', { turn: view(row(t.id)) });
        }),
        controlError: message => emit(t.id, 'error', { message }),
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
  const messageKey = t => `msg_${crypto.createHash('sha256').update(`${t.chat_id}:user:${t.id}`).digest('hex').slice(0, 32)}`;
  const sourceMap = rows => new Map(rows.map(t => [messageKey(t), t.source_device_kind]));
  // Who really posted each message (turn.user_id is the person who sent it, even in someone else's chat).
  const posterMap = rows => new Map(rows.map(t => [messageKey(t), t.user_id]));
return { unreadByChat, markChatRead, unreadOthers, markViewed, markAllChatsRead, enqueue, replay, processNext, recoverInterrupted, requestStop, requestApproval, requestSteer, markSteered, requeueSteer, drainOutbox,
    messageSources: chatId => sourceMap(db.prepare('SELECT id,chat_id,source_device_kind FROM private_turns WHERE chat_id=?').all(chatId)),
    messagePosters: chatId => posterMap(db.prepare('SELECT id,chat_id,user_id FROM private_turns WHERE chat_id=?').all(chatId)),
    turnMessagePosters: id => posterMap(db.prepare('SELECT id,chat_id,user_id FROM private_turns WHERE id=?').all(id)),
    turnMessageSources: id => sourceMap(db.prepare('SELECT id,chat_id,source_device_kind FROM private_turns WHERE id=?').all(id)),
    get: id => view(row(id)),
    /**
     * Something outside the worker has a line for the reply that is running in this chat (the server is waiting on a
     * manager to allow what the agent was about to do). It shows as the reply's progress line and as a step, like the
     * agent's own. Nothing happens when no reply is running there.
     */
    noteForChat(chatId, text) {
      const running = db.prepare("SELECT id FROM private_turns WHERE chat_id=? AND status IN ('running','waiting_for_approval')").get(String(chatId ?? ''));
      if (!running) return false;
      const line = String(text || '').slice(0, 80);
      emit(running.id, 'step', { label: line });
      emit(running.id, 'status', { text: line });
      return true;
    },
    /** Whose agent is working right now (the outbound gate judges unattributed traffic for all of them). */
    workingFor: () => db.prepare("SELECT DISTINCT user_id FROM private_turns WHERE status IN ('running','waiting_for_approval','stopping')").all().map(r => r.user_id),
    detail: id => detail(row(id)),
    owns: (id, chatId, userId) => { const t = row(id); return !!t && t.chat_id === chatId && t.user_id === userId; },
    latest: chatId => db.prepare('SELECT * FROM private_turns WHERE chat_id=? ORDER BY seq DESC LIMIT 20').all(chatId).map(view),
    drafts: chatId => db.prepare("SELECT * FROM private_turns WHERE chat_id=? AND accepted=1 AND assistant_text<>'' AND message_id IS NULL ORDER BY seq").all(chatId).map(view),
    events: (id, after = 0) => db.prepare('SELECT seq,event,payload FROM private_turn_events WHERE turn_id=? AND seq>? ORDER BY seq LIMIT 250').all(id, after).map(e => ({ ...e, payload: JSON.parse(e.payload) })),
    /** The chat was deleted: its prompts, replies, every streamed event, outbox entry and read mark go with it
     * (the events, outbox and read marks cascade from the turn). A turn still running for it is told to stop and
     * finds nothing to write to. */
    /** Every turn (prompt, reply, status, times) for a chat, for records preservation before the chat is deleted. */
    preservable: chatId => db.prepare('SELECT id,user_id,role,text,assistant_text,status,created_at,updated_at,message_id FROM private_turns WHERE chat_id=? ORDER BY seq').all(String(chatId)),
    deleteChat: chatId => tx(() => { db.prepare('DELETE FROM private_turns WHERE chat_id=?').run(String(chatId)); }),
    whenIdle: async () => { while (tasks.size) await Promise.allSettled([...tasks]); },
    close: () => db.close(),
  };
}
