// Meetings: audio and video calls inside a conversation.
//
// The server hosts every call itself. Each person sends their camera and
// microphone to the server once (a small SFU), the server forwards those
// streams to everyone else, and it records each person to their own WebM file
// while the call runs. That is how the agent "joins" every call it hosts: it
// is the call. When the call ends the recordings are transcribed per speaker,
// the agent writes notes and next steps, and posts them into the right rooms.
// Each next step is a one-tap suggestion: tapping "Do it" hands it to the agent.
//
// Live call state is in memory (media cannot survive a restart). Everything
// needed to finish the notes is on disk, so a restart or deploy mid-call or
// mid-transcription still produces notes from what was recorded.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const MAX_PARTICIPANTS = 12;
const MAX_MEETING_MS = 4 * 60 * 60 * 1000;
const EMPTY_END_MS = 60 * 1000; // a call with nobody in it ends after a minute
const MAX_SDP = 64 * 1024;
const MAX_STEPS = 8;
const DEFAULT_ICE = [{ urls: "stun:stun.l.google.com:19302" }];
const BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

const newId = (p) => `${p}_${crypto.randomBytes(9).toString("base64url")}`;
const httpError = (status, code, message) => Object.assign(new Error(message), { status, code });
const plain = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

export function findBinary(name, configured) {
  if (configured) return fs.existsSync(configured) ? configured : null;
  for (const dir of [...String(process.env.PATH || "").split(":").filter(Boolean), ...BIN_DIRS]) {
    const file = path.join(dir, name);
    try { fs.accessSync(file, fs.constants.X_OK); return file; } catch { /* keep looking */ }
  }
  return null;
}

function run(file, args, timeout = 30 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stderr: String(stderr).slice(-2000) }));
      else resolve(String(stdout));
    });
  });
}

// "m=audio" / "m=video" sections the browser actually sends. The recorder
// waits for exactly this many tracks before it writes anything, so a person
// with their camera off must still be recorded (audio only).
export function sentTrackCount(sdp) {
  return String(sdp).split(/\r?\nm=/).slice(1).filter(section =>
    /^(audio|video)\s/.test(section) && !/\na=(recvonly|inactive)\b/.test(section) && !/^\S+\s0\s/.test(section)).length;
}

/** Merge per-speaker whisper segments into one timeline. */
export function mergeTranscript(speakers) {
  const lines = [];
  for (const s of speakers) {
    for (const seg of s.segments || []) {
      const text = plain(seg.text, 2000);
      if (!text || /^\[(BLANK_AUDIO|MUSIC|NOISE|SILENCE|BEEP|INAUDIBLE)[^\]]*\]$/i.test(text) || /^\((.*)\)$/.test(text)) continue;
      lines.push({ at: Math.max(0, (s.offsetMs || 0) + (seg.fromMs || 0)), name: s.name, text });
    }
  }
  lines.sort((a, b) => a.at - b.at);
  // Join consecutive lines from the same person so the transcript reads well.
  const out = [];
  for (const l of lines) {
    const last = out[out.length - 1];
    if (last && last.name === l.name && l.at - last.end < 15000) { last.text += " " + l.text; last.end = l.at; }
    else out.push({ ...l, end: l.at });
  }
  return out;
}

export function transcriptText(lines) {
  const stamp = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
  return lines.map(l => `[${stamp(l.at)}] ${l.name}: ${l.text}`).join("\n");
}

export function parseWhisperJson(text) {
  try {
    const data = JSON.parse(text);
    return (data.transcription || []).map(t => ({ fromMs: Number(t.offsets?.from) || 0, text: t.text || "" }));
  } catch { return []; }
}

/** Validate the model's notes. Never trust room names it invents. */
export function parseNotes(text, rooms, homeRoomId) {
  const match = String(text || "").match(/\{[\s\S]*\}/);
  if (!match) return null;
  let data;
  try { data = JSON.parse(match[0]); } catch { return null; }
  const byName = new Map(rooms.map(r => [r.name.toLowerCase(), r.id]));
  const roomId = (name) => byName.get(String(name || "").replace(/^#/, "").trim().toLowerCase()) || homeRoomId;
  return {
    title: plain(data.title, 80) || "Meeting notes",
    summary: plain(data.summary, 1200),
    notes: (Array.isArray(data.notes) ? data.notes : []).map(n => plain(n, 400)).filter(Boolean).slice(0, 12),
    steps: (Array.isArray(data.steps) ? data.steps : [])
      .map(s => typeof s === "string" ? { text: s } : s)
      .map(s => ({ text: plain(s?.text, 300), owner: plain(s?.owner, 60) || null, roomId: roomId(s?.room) }))
      .filter(s => s.text).slice(0, MAX_STEPS),
  };
}

export const NOTES_PROMPT = [
  "You write meeting notes for a team chat app.",
  "You get a transcript with timestamps and speaker names, and the rooms the team uses.",
  'Reply with JSON only: {"title": "a few words", "summary": "two or three plain sentences", "notes": ["key point or decision", ...], "steps": [{"text": "one concrete next step, starting with a verb", "owner": "person name or null", "room": "the room name it belongs in"}]}.',
  "The summary says what the meeting was about in one or two sentences; notes add the decisions and details, without repeating the summary. Steps are things an AI agent could start on or track if someone taps them; at most 8, only real ones from the meeting.",
  "Put a step in another room only when it clearly belongs there; otherwise use the meeting's room.",
  "Write plainly. Spell out numbers one to nine. Do not invent anything that was not said.",
].join(" ");

/**
 * @param {object} o
 * @param {string} o.dir                 where meetings.db and recordings live
 * @param {object} o.messaging           messaging service (see the methods used below)
 * @param {() => Record<string, any>} o.users
 * @param {() => object} o.config        meetings config: { iceServers, whisper, ffmpeg, model, language, keepRecordings }
 * @param {(o:{transcript:string, rooms:Array, room:any, people:string[]}) => Promise<string>} o.summarize
 * @param {(file:string, o:object) => Promise<Array<{fromMs:number,text:string}>>} [o.transcribe]
 * @param {() => Promise<any>} [o.loadWebrtc]
 */
export function createMeetings({ dir, messaging, users, config = () => ({}), summarize, transcribe, loadWebrtc = () => import("./werift.mjs"), log = console, now = Date.now }) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(dir, "meetings.db"));
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS meetings (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, started_by TEXT NOT NULL,
      started_at INTEGER NOT NULL, ended_at INTEGER, status TEXT NOT NULL,
      owner_pid INTEGER, card_seq INTEGER, notes_seq INTEGER, title TEXT, error TEXT
    );
    CREATE INDEX IF NOT EXISTS meetings_conv ON meetings(conversation_id, status);
    CREATE TABLE IF NOT EXISTS recordings (
      meeting_id TEXT NOT NULL, participant_id TEXT NOT NULL, user_id TEXT NOT NULL,
      file TEXT NOT NULL, offset_ms INTEGER NOT NULL, PRIMARY KEY (meeting_id, participant_id)
    );
    CREATE TABLE IF NOT EXISTS steps (
      meeting_id TEXT NOT NULL, n INTEGER NOT NULL, text TEXT NOT NULL, owner TEXT,
      conversation_id TEXT NOT NULL, message_seq INTEGER, status TEXT NOT NULL DEFAULT 'open',
      acted_by TEXT, acted_seq INTEGER, PRIMARY KEY (meeting_id, n)
    );
    CREATE TABLE IF NOT EXISTS transcripts (meeting_id TEXT PRIMARY KEY, text TEXT NOT NULL);`);
  const q = (s) => db.prepare(s);
  const st = {
    get: q("SELECT * FROM meetings WHERE id = ?"),
    live: q("SELECT * FROM meetings WHERE conversation_id = ? AND status = 'live'"),
    insert: q("INSERT INTO meetings (id, conversation_id, started_by, started_at, status, owner_pid) VALUES (?, ?, ?, ?, 'live', ?)"),
    setCard: q("UPDATE meetings SET card_seq = ? WHERE id = ?"),
    setStatus: q("UPDATE meetings SET status = ?, error = ? WHERE id = ?"),
    end: q("UPDATE meetings SET status = 'recorded', ended_at = ? WHERE id = ? AND status = 'live'"),
    claim: q("UPDATE meetings SET status = 'processing', owner_pid = ? WHERE id = ? AND status IN ('recorded', 'processing')"),
    done: q("UPDATE meetings SET status = 'done', notes_seq = ?, title = ?, error = NULL WHERE id = ?"),
    unfinished: q("SELECT * FROM meetings WHERE status IN ('live', 'recorded', 'processing')"),
    addRecording: q("INSERT OR REPLACE INTO recordings VALUES (?, ?, ?, ?, ?)"),
    recordings: q("SELECT * FROM recordings WHERE meeting_id = ?"),
    addStep: q("INSERT OR REPLACE INTO steps (meeting_id, n, text, owner, conversation_id, message_seq) VALUES (?, ?, ?, ?, ?, ?)"),
    setStepMessage: q("UPDATE steps SET message_seq = ? WHERE meeting_id = ? AND n = ? AND message_seq IS NULL"),
    steps: q("SELECT * FROM steps WHERE meeting_id = ? ORDER BY n"),
    step: q("SELECT * FROM steps WHERE meeting_id = ? AND n = ?"),
    act: q("UPDATE steps SET status = ?, acted_by = ?, acted_seq = ? WHERE meeting_id = ? AND n = ? AND status = 'open'"),
    stepsForMessage: q("SELECT * FROM steps WHERE message_seq = ? ORDER BY n"),
    byCard: q("SELECT * FROM meetings WHERE card_seq = ? OR notes_seq = ?"),
    saveTranscript: q("INSERT OR REPLACE INTO transcripts VALUES (?, ?)"),
    transcript: q("SELECT text FROM transcripts WHERE meeting_id = ?"),
  };

  /** @type {Map<string, any>} meetingId -> live call */
  const calls = new Map();
  let closed = false;
  const processing = new Set();

  const person = (userId) => { const u = users()[userId]; return { id: userId, name: u?.name || "Someone" }; };
  const names = (ids) => {
    const list = [...new Set(ids)].map(id => person(id).name);
    return list.length <= 1 ? list.join("") : `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
  };
  const cfg = () => config() || {};
  const iceServers = () => Array.isArray(cfg().iceServers) && cfg().iceServers.length ? cfg().iceServers : DEFAULT_ICE;
  const meetingDir = (id) => path.join(dir, id);

  function requireMember(conversationId, userId) {
    if (!messaging.isMember(conversationId, userId)) throw httpError(404, "not_found", "That conversation doesn't exist or you can't see it");
  }
  function requireMeeting(id, userId) {
    const m = typeof id === "string" && st.get.get(id);
    if (!m) throw httpError(404, "not_found", "That meeting is gone");
    requireMember(m.conversation_id, userId);
    return m;
  }

  function view(m, userId) {
    const call = calls.get(m.id);
    const steps = st.steps.all(m.id).map(stepView);
    return {
      id: m.id,
      conversationId: m.conversation_id,
      status: m.status === "live" && !call ? "recorded" : m.status,
      startedBy: person(m.started_by),
      startedAt: m.started_at,
      endedAt: m.ended_at,
      title: m.title,
      error: m.error || null,
      iceServers: iceServers(),
      participants: call ? [...call.participants.values()].map(p => ({
        id: p.id, user: person(p.userId), publishing: p.tracks.size > 0, you: p.userId === userId, joinedAt: p.joinedAt,
        hasVideo: p.kinds.has("video"), hasAudio: p.kinds.has("audio"),
      })) : [],
      steps,
      transcript: m.status === "done" ? st.transcript.get(m.id)?.text || "" : null,
    };
  }
  const stepView = (s) => ({ n: s.n, text: s.text, owner: s.owner, conversationId: s.conversation_id, status: s.status,
    actedBy: s.acted_by ? person(s.acted_by) : null, threadId: s.acted_seq ? String(s.acted_seq) : null });

  // Extra fields on agent messages that belong to a meeting: the live card
  // (Join) and the notes card (one-tap next steps).
  function messageExtras(msg) {
    const steps = st.stepsForMessage.all(msg.seq);
    const m = st.byCard.get(msg.seq, msg.seq) || (steps[0] && st.get.get(steps[0].meeting_id));
    if (!m) return null;
    const live = m.status === "live" && calls.has(m.id);
    return { meeting: { id: m.id, kind: m.card_seq === msg.seq ? "call" : "notes", status: live ? "live" : m.status, steps: steps.map(stepView) } };
  }

  async function newPeer() {
    const w = await loadWebrtc();
    const codecs = {
      audio: [new w.RTCRtpCodecParameters({ mimeType: "audio/opus", clockRate: 48000, channels: 2 })],
      video: [new w.RTCRtpCodecParameters({ mimeType: "video/VP8", clockRate: 90000,
        rtcpFeedback: [{ type: "nack" }, { type: "nack", parameter: "pli" }, { type: "goog-remb" }] })],
    };
    const servers = iceServers().map(s => ({ ...s, urls: Array.isArray(s.urls) ? s.urls[0] : s.urls }));
    return { w, pc: new w.RTCPeerConnection({ codecs, iceServers: servers }) };
  }
  async function answer(pc, sdp) {
    await pc.setRemoteDescription({ type: "offer", sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    if (pc.iceGatheringState !== "complete") {
      await new Promise(resolve => {
        const t = setTimeout(resolve, 3000);
        pc.iceGatheringStateChange.subscribe(s => { if (s === "complete") { clearTimeout(t); resolve(); } });
      });
    }
    return pc.localDescription.sdp;
  }
  const checkSdp = (sdp) => {
    if (typeof sdp !== "string" || !sdp.startsWith("v=0") || sdp.length > MAX_SDP) throw httpError(400, "bad_sdp", "Invalid call setup");
    return sdp;
  };

  function changed(m) {
    if (m.card_seq) messaging.refreshMessage(m.card_seq);
    const call = calls.get(m.id);
    if (!call) return;
    if (call.participants.size) call.emptySince = null;
    else call.emptySince ??= now();
    if ((call.emptySince && now() - call.emptySince > EMPTY_END_MS) || now() - m.started_at > MAX_MEETING_MS) void finish(call.id, "auto");
  }

  // ---- call lifecycle ----
  async function start(user, conversationId) {
    if (closed) throw httpError(503, "draining", "Server restarting. Try again shortly");
    requireMember(conversationId, user.id);
    const existing = st.live.get(conversationId);
    if (existing && calls.has(existing.id)) return existing;
    if (existing) await finish(existing.id, "replaced");
    const id = newId("meet");
    st.insert.run(id, conversationId, user.id, now(), process.pid);
    fs.mkdirSync(meetingDir(id), { recursive: true, mode: 0o700 });
    const call = { id, conversationId, participants: new Map(), emptySince: now(), timer: null };
    calls.set(id, call);
    call.timer = setInterval(() => sweep(call), 5000);
    call.timer.unref?.();
    const card = messaging.agentPost(conversationId, `${person(user.id).name} started a meeting\n\nThe agent records it and posts notes when it ends`, { call: { id, by: user.id } });
    st.setCard.run(card.seq, id);
    messaging.refreshMessage(card.seq);
    return st.get.get(id);
  }

  function sweep(call) {
    const m = st.get.get(call.id);
    if (!m || m.status !== "live") return;
    for (const p of call.participants.values()) {
      if (["failed", "closed"].includes(p.pc.connectionState) || (p.pc.connectionState !== "connected" && now() - p.joinedAt > 45000)) void leave(call, p.id);
    }
    if (call.participants.size) call.emptySince = null;
    else call.emptySince ??= now();
    if ((call.emptySince && now() - call.emptySince > EMPTY_END_MS) || now() - m.started_at > MAX_MEETING_MS) void finish(call.id, "auto");
  }

  async function join(user, meetingId, sdp) {
    const m = requireMeeting(meetingId, user.id);
    const call = calls.get(m.id);
    if (!call || m.status !== "live") throw httpError(409, "meeting_ended", "This meeting has ended");
    if (call.participants.size >= MAX_PARTICIPANTS) throw httpError(409, "meeting_full", "This meeting is full");
    checkSdp(sdp);
    const tracks = sentTrackCount(sdp);
    const { w, pc } = await newPeer();
    const p = { id: newId("part"), userId: user.id, pc, tracks: new Map(), kinds: new Set(), recorder: null, joinedAt: now(), watchers: new Set(), pli: null };
    if (tracks) {
      const file = path.join(meetingDir(m.id), `${p.id}.webm`);
      p.recorder = new w.MediaRecorder({ path: file, numOfTracks: tracks });
      p.recorder.onError?.subscribe?.(e => log.error("[servant] meeting recorder:", e?.message || e));
      st.addRecording.run(m.id, p.id, user.id, file, p.joinedAt - m.started_at);
    }
    pc.onTransceiverAdded.subscribe(t => {
      t.onTrack.subscribe(track => {
        p.tracks.set(track.kind, { track, transceiver: t });
        p.kinds.add(track.kind);
        p.recorder?.addTrack(track).catch?.(e => log.error("[servant] meeting record track:", e.message));
        if (track.kind === "video") p.pli ??= setInterval(() => t.receiver.sendRtcpPLI(track.ssrc).catch(() => {}), 2000);
        changed(m);
      });
    });
    let sdpAnswer;
    try { sdpAnswer = await answer(pc, sdp); } catch (e) { await pc.close().catch(() => {}); throw httpError(400, "bad_sdp", "Couldn't set up the call"); }
    call.participants.set(p.id, p);
    call.emptySince = null;
    pc.connectionStateChange.subscribe(s => { if (s === "failed" || s === "closed") void leave(call, p.id); });
    changed(m);
    return { participantId: p.id, sdp: sdpAnswer };
  }

  // A participant receives each other person on its own connection, so people
  // can come and go without renegotiating anyone else's call.
  async function watch(user, meetingId, participantId, publisherId, sdp) {
    const m = requireMeeting(meetingId, user.id);
    const call = calls.get(m.id);
    const viewer = call?.participants.get(participantId);
    const source = call?.participants.get(publisherId);
    if (!call || !viewer || viewer.userId !== user.id) throw httpError(409, "meeting_ended", "Join the meeting first");
    if (!source || source === viewer) throw httpError(404, "not_found", "That person left the meeting");
    checkSdp(sdp);
    const { pc } = await newPeer();
    await pc.setRemoteDescription({ type: "offer", sdp });
    const subs = [];
    for (const t of pc.getTransceivers()) {
      t.setDirection("sendonly");
      const forward = (kind) => {
        const src = source.tracks.get(kind);
        if (!src) return false;
        subs.push(src.track.onReceiveRtp.subscribe(rtp => { t.sender.sendRtp(rtp).catch?.(() => {}); }));
        if (kind === "video") src.transceiver.receiver.sendRtcpPLI(src.track.ssrc).catch(() => {});
        return true;
      };
      if (!forward(t.kind)) {
        // The person's track may arrive a moment after they connect.
        const wait = setInterval(() => { if (forward(t.kind) || pc.connectionState === "closed") clearInterval(wait); }, 500);
        wait.unref?.();
      }
    }
    await pc.setLocalDescription(await pc.createAnswer());
    if (pc.iceGatheringState !== "complete") {
      await new Promise(resolve => { const t = setTimeout(resolve, 3000); pc.iceGatheringStateChange.subscribe(s => { if (s === "complete") { clearTimeout(t); resolve(); } }); });
    }
    const watcher = { pc, close: () => { for (const s of subs) s.unSubscribe(); pc.close().catch(() => {}); } };
    viewer.watchers.add(watcher);
    source.watchers.add(watcher);
    // Ask for a fresh keyframe once the viewer is connected so video starts at once.
    pc.connectionStateChange.subscribe(s => {
      if (s === "connected") { const v = source.tracks.get("video"); if (v) v.transceiver.receiver.sendRtcpPLI(v.track.ssrc).catch(() => {}); }
    });
    return { sdp: pc.localDescription.sdp };
  }

  async function leave(call, participantId) {
    const p = call.participants.get(participantId);
    if (!p) return;
    call.participants.delete(participantId);
    clearInterval(p.pli);
    for (const w of p.watchers) w.close();
    await p.recorder?.stop().catch(e => log.error("[servant] meeting recorder stop:", e.message));
    await p.pc.close().catch(() => {});
    if (!call.participants.size) call.emptySince = now();
    const m = st.get.get(call.id);
    if (m) changed(m);
  }

  async function finish(meetingId, reason = "ended") {
    const call = calls.get(meetingId);
    if (call) {
      calls.delete(meetingId);
      clearInterval(call.timer);
      await Promise.all([...call.participants.keys()].map(pid => leave(call, pid)));
    }
    if (!st.end.run(now(), meetingId).changes && !call) return;
    const m = st.get.get(meetingId);
    if (m?.card_seq) {
      const minutes = Math.max(1, Math.round(((m.ended_at || now()) - m.started_at) / 60000));
      const people = st.recordings.all(m.id).map(r => r.user_id);
      messaging.updateAgentMessage(m.card_seq, `Meeting${people.length ? ` with ${names(people)}` : ""} · ${minutes} min\n\nWriting the notes now`);
    }
    if (m) changed(m);
    if (!closed) void processMeeting(meetingId);
    return reason;
  }

  // ---- after the call ----
  async function defaultTranscribe(file, { workdir, language }) {
    const ffmpeg = findBinary("ffmpeg", cfg().ffmpeg);
    const whisper = findBinary("whisper-cli", cfg().whisper);
    const model = cfg().model || path.join(os.homedir(), ".local/share/servant/models/ggml-base.en.bin");
    if (!ffmpeg || !whisper || !fs.existsSync(model)) throw httpError(503, "no_transcriber", "Transcription isn't set up on this server");
    const base = path.join(workdir, path.basename(file, ".webm"));
    await run(ffmpeg, ["-y", "-v", "error", "-i", file, "-vn", "-ar", "16000", "-ac", "1", `${base}.wav`]);
    try {
      await run(whisper, ["-m", model, "-f", `${base}.wav`, "-l", language || "en", "-np", "-oj", "-of", base, "-t", String(Math.max(1, Math.min(8, os.cpus().length - 1)))]);
      // A recording too short to hold speech makes whisper exit cleanly with no output.
      if (!fs.existsSync(`${base}.json`)) return [];
      return parseWhisperJson(fs.readFileSync(`${base}.json`, "utf8"));
    } finally { fs.rmSync(`${base}.wav`, { force: true }); fs.rmSync(`${base}.json`, { force: true }); }
  }

  async function processMeeting(meetingId) {
    if (processing.has(meetingId) || closed) return;
    if (!st.claim.run(process.pid, meetingId).changes) return;
    processing.add(meetingId);
    const m = st.get.get(meetingId);
    try {
      const work = meetingDir(m.id);
      fs.mkdirSync(work, { recursive: true, mode: 0o700 });
      const speakers = [];
      for (const r of st.recordings.all(m.id)) {
        if (!fs.existsSync(r.file) || fs.statSync(r.file).size < 1024) continue;
        const segments = await (transcribe || defaultTranscribe)(r.file, { workdir: work, language: cfg().language });
        speakers.push({ name: person(r.user_id).name, offsetMs: r.offset_ms, segments });
      }
      const lines = mergeTranscript(speakers);
      const transcript = transcriptText(lines);
      st.saveTranscript.run(m.id, transcript);
      const people = [...new Set(st.recordings.all(m.id).map(r => r.user_id))];
      const room = messaging.conversationInfo(m.conversation_id);
      if (!room) throw new Error("conversation gone");
      let notes;
      if (!lines.length) {
        notes = { title: "Meeting", summary: "Nothing was said that the agent could transcribe", notes: [], steps: [] };
      } else {
        const rooms = messaging.roomsFor(m.started_by);
        const reply = await summarize({ transcript, rooms, room, people: people.map(id => person(id).name) });
        notes = parseNotes(reply, rooms, m.conversation_id);
        if (!notes) throw new Error("The agent's notes were unreadable");
      }
      const minutes = Math.max(1, Math.round(((m.ended_at || now()) - m.started_at) / 60000));
      const body = [
        `Notes · ${notes.title}`,
        `${people.length ? `With ${names(people)} · ` : ""}${minutes} min`,
        notes.summary,
        notes.notes.map(n => `• ${n}`).join("\n"),
      ].filter(Boolean).join("\n\n").slice(0, 7900);
      notes.steps.forEach((s, n) => st.addStep.run(m.id, n, s.text, s.owner, s.roomId, null));
      const home = messaging.agentPost(m.conversation_id, body);
      for (const s of st.steps.all(m.id)) if (s.conversation_id === m.conversation_id) st.setStepMessage.run(home.seq, m.id, s.n);
      // Steps that belong in another room are posted there too, each tappable.
      const elsewhere = Map.groupBy(st.steps.all(m.id).filter(s => s.conversation_id !== m.conversation_id), s => s.conversation_id);
      for (const [roomId, steps] of elsewhere) {
        try {
          const from = room.kind === "channel" ? `#${room.name}` : "a meeting";
          const msg = messaging.agentPost(roomId, `From the meeting in ${from} · ${notes.title}\n\nNext step${steps.length > 1 ? "s" : ""} for this room`);
          for (const s of steps) st.setStepMessage.run(msg.seq, m.id, s.n);
          messaging.refreshMessage(msg.seq);
        } catch (e) {
          log.error("[servant] meeting step routing:", e.message);
          for (const s of steps) { db.prepare("UPDATE steps SET conversation_id = ? WHERE meeting_id = ? AND n = ?").run(m.conversation_id, m.id, s.n); st.setStepMessage.run(home.seq, m.id, s.n); }
        }
      }
      st.done.run(home.seq, notes.title, m.id);
      messaging.refreshMessage(home.seq);
      if (m.card_seq) messaging.updateAgentMessage(m.card_seq, `Meeting${people.length ? ` with ${names(people)}` : ""} · ${minutes} min\n\nNotes are below`);
      if (!cfg().keepRecordings) { /* recordings stay; operators can prune data/meetings */ }
    } catch (e) {
      log.error("[servant] meeting notes failed:", e.message, e.stderr || "");
      st.setStatus.run("failed", plain(e.message, 300), meetingId);
      if (m.card_seq) messaging.updateAgentMessage(m.card_seq, `The meeting was recorded, but the notes couldn't be written\n\n${plain(e.message, 300)}`);
    } finally {
      processing.delete(meetingId);
      changed(st.get.get(meetingId));
    }
  }

  async function act(user, meetingId, n, action) {
    const m = requireMeeting(meetingId, user.id);
    const step = st.step.get(m.id, Number(n));
    if (!step) throw httpError(404, "not_found", "That step is gone");
    requireMember(step.conversation_id, user.id);
    if (step.status !== "open") return view(st.get.get(m.id), user.id);
    if (action === "skip") {
      st.act.run("skipped", user.id, null, m.id, step.n);
    } else if (action === "accept") {
      // Claim first so two taps can't start the same work twice.
      if (!st.act.run("accepted", user.id, null, m.id, step.n).changes) return view(st.get.get(m.id), user.id);
      try {
        const text = `@s ${step.text}${step.owner ? ` (owner: ${step.owner})` : ""}\n\nThis came out of the meeting "${m.title || "Meeting"}". Start on it, or tell me what you need.`;
        const msg = messaging.postFromUser(step.conversation_id, user, text, step.message_seq);
        db.prepare("UPDATE steps SET acted_seq = ? WHERE meeting_id = ? AND n = ?").run(msg.thread_root || msg.seq, m.id, step.n);
      } catch (e) {
        db.prepare("UPDATE steps SET status = 'open', acted_by = NULL WHERE meeting_id = ? AND n = ?").run(m.id, step.n);
        throw e;
      }
    } else throw httpError(400, "bad_action", "Choose Do it or Skip");
    if (step.message_seq) messaging.refreshMessage(step.message_seq);
    return view(st.get.get(m.id), user.id);
  }

  // ---- HTTP ----
  async function handle(req, res, { user, method, parts, send, fail, readBody }) {
    if (parts[1] !== "meetings") return false;
    const [, , id, sub, n] = parts;
    if (method === "POST" && parts.length === 2) {
      const body = await readBody(req);
      const m = await start(user, String(body?.conversationId || ""));
      return send(res, 200, { meeting: view(m, user.id) }), true;
    }
    if (!id) return fail(res, 404, "not_found", "Not found"), true;
    if (method === "GET" && !sub) return send(res, 200, { meeting: view(requireMeeting(id, user.id), user.id) }), true;
    if (method !== "POST") return fail(res, 405, "method_not_allowed", "Not allowed"), true;
    const body = (await readBody(req)) || {};
    if (sub === "join") return send(res, 200, await join(user, id, body.sdp)), true;
    if (sub === "watch") return send(res, 200, await watch(user, id, String(body.participantId || ""), String(body.publisherId || ""), body.sdp)), true;
    if (sub === "leave") {
      const m = requireMeeting(id, user.id);
      const call = calls.get(m.id);
      const p = call?.participants.get(String(body.participantId || ""));
      if (p && p.userId === user.id) await leave(call, p.id);
      return send(res, 200, { meeting: view(st.get.get(m.id), user.id) }), true;
    }
    if (sub === "end") {
      const m = requireMeeting(id, user.id);
      await finish(m.id, "ended");
      return send(res, 200, { meeting: view(st.get.get(m.id), user.id) }), true;
    }
    if (sub === "steps" && n !== undefined) return send(res, 200, { meeting: await act(user, id, n, body.action) }), true;
    return fail(res, 404, "not_found", "Not found"), true;
  }

  // A restart drops live media. Finish whatever earlier processes left behind.
  function recover() {
    for (const m of st.unfinished.all()) {
      if (calls.has(m.id) || processing.has(m.id)) continue;
      if (m.owner_pid && m.owner_pid !== process.pid && alive(m.owner_pid)) continue;
      if (m.status === "live") void finish(m.id, "restart");
      else void processMeeting(m.id);
    }
  }
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  async function close() {
    closed = true;
    // Flush recordings to disk; the next process writes the notes.
    await Promise.all([...calls.keys()].map(async id => {
      const call = calls.get(id);
      calls.delete(id);
      clearInterval(call.timer);
      await Promise.all([...call.participants.keys()].map(pid => leave(call, pid)));
      st.end.run(now(), id);
      db.prepare("UPDATE meetings SET owner_pid = NULL WHERE id = ?").run(id);
    }));
    const deadline = now() + 10000;
    while (processing.size && now() < deadline) await new Promise(r => setTimeout(r, 100));
    db.prepare("UPDATE meetings SET status = 'recorded', owner_pid = NULL WHERE status = 'processing' AND owner_pid = ?").run(process.pid);
    db.close();
  }

  return { handle, messageExtras, recover, close, start, finish, processMeeting, act, view: (id, userId) => view(st.get.get(id), userId), db, calls };
}
