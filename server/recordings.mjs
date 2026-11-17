// Voice memos: someone records audio, the server transcribes it, and the agent writes
// notes and next steps. Each memo is private to the person who recorded it.
// Each next step can be handed to the agent, which starts a work chat for it.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { mergeTranscript, parseNotes, transcribeAudio, transcriptText } from "./transcription.mjs";

export const RECORDING_CHUNK = 3 * 1024 * 1024;
export const RECORDING_CHUNK_BODY = Math.ceil(RECORDING_CHUNK / 3) * 4 + 64 * 1024;
const MAX_BYTES = 400 * 1024 * 1024;
const fault = (status, code, message) => Object.assign(new Error(message), { status, code });
const plain = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const EXTS = new Set(["m4a", "mp4", "aac", "wav", "webm", "caf", "mp3", "3gp"]);

/**
 * @param {object} o
 * @param {string} o.dir
 * @param {(o:{transcript:string, person:string}) => Promise<string>} o.summarize
 * @param {(o:{userId:string, deviceId:string, title:string, where:string, transcript:string}) => Promise<{id:string}>} o.startWork
 * @param {() => object} [o.config]
 * @param {(file:string, o:object) => Promise<Array<{fromMs:number,text:string}>>} [o.transcribe]
 */
export function createRecordings({ dir, summarize, startWork, config = () => ({}), transcribe, users = () => ({}), todos = () => null, log = console, now = Date.now }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(dir, "recordings.db"));
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS recordings (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, title TEXT, status TEXT NOT NULL,
      created_at INTEGER NOT NULL, duration_ms INTEGER NOT NULL DEFAULT 0, size INTEGER NOT NULL,
      received INTEGER NOT NULL DEFAULT 0, ext TEXT NOT NULL, summary TEXT, notes TEXT, transcript TEXT, error TEXT
    );
    CREATE INDEX IF NOT EXISTS recordings_user ON recordings(user_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS recording_steps (
      recording_id TEXT NOT NULL, n INTEGER NOT NULL, text TEXT NOT NULL, owner TEXT,
      status TEXT NOT NULL DEFAULT 'open', chat_id TEXT, PRIMARY KEY (recording_id, n)
    );
    CREATE TABLE IF NOT EXISTS recording_work_log (
      recording_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, added_at INTEGER NOT NULL,
      duration_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS recording_work_log_user ON recording_work_log(user_id, added_at DESC);
    CREATE TRIGGER IF NOT EXISTS recording_work_log_no_update BEFORE UPDATE ON recording_work_log
      BEGIN SELECT RAISE(ABORT, 'Recording work log is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS recording_work_log_no_delete BEFORE DELETE ON recording_work_log
      BEGIN SELECT RAISE(ABORT, 'Recording work log is immutable'); END;
    INSERT OR IGNORE INTO recording_work_log (recording_id, user_id, added_at, duration_ms)
      SELECT id, user_id, created_at, duration_ms FROM recordings WHERE status <> 'uploading';`);
  // Records preservation (config.recordsPreservation): deleting a recording hides it from the person but keeps the audio, transcript and
  // notes, because a recording of work can be a federal record. `hidden_at` is added only when needed.
  if (!db.prepare("PRAGMA table_info(recordings)").all().some(c => c.name === "hidden_at")) db.exec("ALTER TABLE recordings ADD COLUMN hidden_at INTEGER");
  const q = s => db.prepare(s);
  const st = {
    get: q("SELECT * FROM recordings WHERE id = ? AND hidden_at IS NULL"),
    list: q("SELECT * FROM recordings WHERE user_id = ? AND hidden_at IS NULL ORDER BY created_at DESC LIMIT 200"),
    hide: q("UPDATE recordings SET hidden_at = ? WHERE id = ?"),
    insert: q("INSERT INTO recordings (id, user_id, status, created_at, duration_ms, size, ext) VALUES (?, ?, 'uploading', ?, ?, ?, ?)"),
    received: q("UPDATE recordings SET received = ? WHERE id = ?"),
    status: q("UPDATE recordings SET status = ?, error = ? WHERE id = ?"),
    done: q("UPDATE recordings SET status = 'done', title = ?, summary = ?, notes = ?, transcript = ?, error = NULL WHERE id = ?"),
    unfinished: q("SELECT id FROM recordings WHERE status = 'processing' AND hidden_at IS NULL"),
    steps: q("SELECT * FROM recording_steps WHERE recording_id = ? ORDER BY n"),
    step: q("SELECT * FROM recording_steps WHERE recording_id = ? AND n = ?"),
    addStep: q("INSERT OR REPLACE INTO recording_steps (recording_id, n, text, owner) VALUES (?, ?, ?, ?)"),
    claimStep: q("UPDATE recording_steps SET status = ? WHERE recording_id = ? AND n = ? AND status = 'open'"),
    stepChat: q("UPDATE recording_steps SET chat_id = ? WHERE recording_id = ? AND n = ?"),
    reopen: q("UPDATE recording_steps SET status = 'open' WHERE recording_id = ? AND n = ?"),
    del: q("DELETE FROM recordings WHERE id = ?"),
    delSteps: q("DELETE FROM recording_steps WHERE recording_id = ?"),
    logFinished: q("INSERT OR IGNORE INTO recording_work_log (recording_id, user_id, added_at, duration_ms) VALUES (?, ?, ?, ?)"),
    workLog: q(`SELECT w.*, r.title, r.summary, r.id AS source_id FROM recording_work_log w
      LEFT JOIN recordings r ON r.id = w.recording_id AND r.user_id = w.user_id AND r.hidden_at IS NULL
      WHERE w.user_id = ? ORDER BY w.added_at DESC, w.recording_id`),
  };
  const processing = new Set();
  let closed = false;
  const folder = id => path.join(dir, id);
  const audioFile = r => path.join(folder(r.id), `audio.${r.ext}`);

  const stepView = s => ({ n: s.n, text: s.text, owner: s.owner, status: s.status, chatId: s.chat_id });
  const summaryView = r => ({ id: r.id, title: r.title, status: r.status, createdAt: r.created_at, durationMs: r.duration_ms, summary: r.summary, error: r.error,
    openSteps: st.steps.all(r.id).filter(s => s.status === "open").length });
  const detail = (r, user) => {
    const store = todos();
    let list = [];
    if (store && user && r.status === "done") {
      // Older memos finished before to-dos existed: turn their steps into to-dos the first time they are opened.
      if (!store.forSource(user, "recording", r.id).length) {
        try { store.fromRecording(user, r.id, r.title, st.steps.all(r.id).filter(s => s.status === "open").map(s => ({ text: s.text, owner: s.owner }))); } catch (e) { log.error("[servant] to-dos from recording failed:", e.message); }
      }
      list = store.forSource(user, "recording", r.id);
    }
    return { ...summaryView(r), notes: r.notes ? JSON.parse(r.notes) : [], transcript: r.transcript || "", steps: st.steps.all(r.id).map(stepView), todos: list };
  };
  // The upload does not say when recording started or ended. Keep its known
  // duration and the time it was added, without inventing capture times.
  const workLog = user => st.workLog.all(user.id).map(r => ({
    kind: "recording", id: `recording:${r.recording_id}`, at: r.added_at,
    recordingId: r.recording_id, durationMs: r.duration_ms,
    source: r.source_id ? { title: r.title || null, summary: r.summary || null } : null,
  }));

  function mine(id, user) {
    const r = typeof id === "string" && st.get.get(id);
    if (!r || r.user_id !== user.id) throw fault(404, "not_found", "That recording is gone");
    return r;
  }

  function create(user, { size, durationMs, ext }) {
    const e = String(ext || "m4a").toLowerCase().replace(/^\./, "");
    if (!EXTS.has(e)) throw fault(400, "recording", "That recording format isn't supported");
    if (!Number.isSafeInteger(size) || size <= 0) throw fault(400, "recording", "That recording is empty");
    if (size > MAX_BYTES) throw fault(413, "recording", "That recording is too long");
    const id = `rec_${crypto.randomBytes(9).toString("base64url")}`;
    fs.mkdirSync(folder(id), { recursive: true, mode: 0o700 });
    st.insert.run(id, user.id, now(), Math.max(0, Math.round(Number(durationMs) || 0)), size, e);
    return { id, received: 0, chunkBytes: RECORDING_CHUNK };
  }

  function chunk(user, id, { offset, data }) {
    const r = mine(id, user);
    if (r.status !== "uploading") throw fault(409, "recording", "That recording is already uploaded");
    if (offset !== r.received) throw fault(409, "upload_offset", `Resume at ${r.received}`);
    const bytes = Buffer.from(String(data || ""), "base64");
    if (!bytes.length || r.received + bytes.length > r.size) throw fault(400, "recording", "That piece of the recording didn't fit");
    fs.appendFileSync(audioFile(r), bytes, { mode: 0o600 });
    st.received.run(r.received + bytes.length, r.id);
    return { received: r.received + bytes.length };
  }

  function finish(user, id, title) {
    const r = mine(id, user);
    if (r.status === "uploading") {
      if (r.received !== r.size) throw fault(409, "upload_offset", `Resume at ${r.received}`);
      db.exec("BEGIN");
      try {
        st.status.run("processing", null, r.id);
        st.logFinished.run(r.id, r.user_id, now(), r.duration_ms);
        if (title) db.prepare("UPDATE recordings SET title = ? WHERE id = ?").run(plain(title, 80), r.id);
        db.exec("COMMIT");
      } catch (e) { db.exec("ROLLBACK"); throw e; }
      void process_(r.id);
    }
    return detail(st.get.get(r.id), user);
  }

  async function process_(id) {
    if (processing.has(id) || closed) return;
    const r = st.get.get(id);
    if (!r) return;
    processing.add(id);
    try {
      const work = folder(id);
      const file = audioFile(r);
      if (!fs.existsSync(file) || fs.statSync(file).size < 1024) throw fault(400, "recording", "The recording was too short to hear anything");
      const speaker = users()[r.user_id]?.name || "Speaker";
      const segments = await (transcribe || ((f, o) => transcribeAudio(f, { ...o, config: config() })))(file, { workdir: work, language: config()?.language });
      const lines = mergeTranscript([{ name: "Speaker", offsetMs: 0, segments }]);
      const transcript = transcriptText(lines);
      let notes;
      if (!lines.length) notes = { title: "Voice memo", summary: "Nothing was said that the agent could transcribe", notes: [], steps: [] };
      else {
        const reply = await summarize({ transcript, person: speaker });
        notes = parseNotes(reply);
        if (!notes) throw new Error("The agent's notes were unreadable");
      }
      db.exec("BEGIN");
      try {
        // Removal can happen while transcription or notes are awaiting a reply.
        // Do not recreate steps or to-dos for a deleted or preservation-hidden source.
        if (!st.get.get(id)) { db.exec("ROLLBACK"); return; }
        st.delSteps.run(id);
        notes.steps.forEach((s, n) => st.addStep.run(id, n, s.text, s.owner));
        st.done.run(r.title || notes.title, notes.summary, JSON.stringify(notes.notes), transcript, id);
        db.exec("COMMIT");
      } catch (e) { db.exec("ROLLBACK"); throw e; }
      // The next steps become to-dos the person can edit, reorder, tag and hand to the agent. A failure here never
      // loses the notes: the to-dos are made again the next time the recording is opened.
      try { todos()?.fromRecording(users()[r.user_id] || { id: r.user_id, name: speaker }, id, r.title || notes.title, notes.steps); }
      catch (e) { log.error("[servant] to-dos from recording failed:", e.message); }
    } catch (e) {
      if (st.get.get(id)) {
        log.error("[servant] recording notes failed:", e.message, e.stderr || "");
        st.status.run("failed", plain(e.message, 300), id);
      }
    } finally { processing.delete(id); }
  }

  async function act(user, device, id, n, action) {
    const r = mine(id, user);
    if (r.status !== "done") throw fault(409, "recording", "The notes aren't ready yet");
    const targets = n === "all" ? st.steps.all(r.id).filter(s => s.status === "open") : [st.step.get(r.id, Number(n))];
    if (targets.some(s => !s)) throw fault(404, "not_found", "That step is gone");
    for (const step of targets) {
      if (step.status !== "open") continue;
      if (action === "skip") { st.claimStep.run("skipped", r.id, step.n); continue; }
      if (action !== "send") throw fault(400, "bad_action", "Choose Send to agent or Skip");
      // Claim first so two taps can't start the same work twice.
      if (!st.claimStep.run("accepted", r.id, step.n).changes) continue;
      try {
        const text = `${step.text}${step.owner ? ` (owner: ${step.owner})` : ""}\n\nThis came out of the voice memo "${r.title || "Voice memo"}". Start on it, or tell me what you need.\n\nMemo summary: ${r.summary || ""}`;
        const chat = await startWork({ userId: user.id, deviceId: device?.id, title: step.text, where: "a voice memo", transcript: text });
        st.stepChat.run(chat.id, r.id, step.n);
      } catch (e) { st.reopen.run(r.id, step.n); throw e; }
    }
    return detail(st.get.get(r.id), user);
  }

  async function retry(user, id) {
    const r = mine(id, user);
    if (r.status === "failed") { st.status.run("processing", null, r.id); void process_(r.id); }
    return detail(st.get.get(r.id), user);
  }

  function remove(user, id) {
    const r = mine(id, user);
    todos()?.removeSource("recording", r.id);
    if (config().recordsPreservation) { st.hide.run(now(), r.id); return; }   // gone from view, kept on disk and in the database
    st.delSteps.run(r.id); st.del.run(r.id);
    fs.rmSync(folder(r.id), { recursive: true, force: true });
  }

  async function handle(req, res, { user, device, method, parts, send, fail, readBody }) {
    if (parts[1] !== "recordings") return false;
    const [, , id, sub, n] = parts;
    if (!id) {
      if (method === "GET") return send(res, 200, { recordings: st.list.all(user.id).filter(r => r.status !== "uploading").map(summaryView) }), true;
      if (method === "POST") return send(res, 200, create(user, (await readBody(req)) || {})), true;
      return fail(res, 405, "method_not_allowed", "Not allowed"), true;
    }
    if (method === "GET" && !sub) return send(res, 200, { recording: detail(mine(id, user), user) }), true;
    if (method === "DELETE" && !sub) return remove(user, id), send(res, 200, { ok: true }), true;
    if (method !== "POST") return fail(res, 405, "method_not_allowed", "Not allowed"), true;
    const body = (await readBody(req, sub === "chunk" ? RECORDING_CHUNK_BODY : undefined)) || {};
    if (sub === "chunk") return send(res, 200, chunk(user, id, body)), true;
    if (sub === "finish") return send(res, 200, { recording: finish(user, id, body.title) }), true;
    if (sub === "retry") return send(res, 200, { recording: await retry(user, id) }), true;
    if (sub === "steps" && n !== undefined) return send(res, 200, { recording: await act(user, device, id, n, body.action) }), true;
    return fail(res, 404, "not_found", "Not found"), true;
  }

  function recover() { for (const { id } of st.unfinished.all()) void process_(id); }
  async function close() {
    closed = true;
    const deadline = now() + 10000;
    while (processing.size && now() < deadline) await new Promise(r => setTimeout(r, 100));
    db.close();
  }
  return { handle, recover, close, create, chunk, finish, act, remove, retry, workLog, detail: (id, user) => detail(mine(id, user), user), db };
}
