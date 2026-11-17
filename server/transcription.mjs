// Transcribe a voice recording with whisper.cpp and validate the agent's notes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

const MAX_STEPS = 8;
const BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
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

/** Validate the model's notes. */
export function parseNotes(text) {
  const match = String(text || "").match(/\{[\s\S]*\}/);
  if (!match) return null;
  let data;
  try { data = JSON.parse(match[0]); } catch { return null; }
  return {
    title: plain(data.title, 80) || "Voice memo",
    summary: plain(data.summary, 1200),
    notes: (Array.isArray(data.notes) ? data.notes : []).map(n => plain(n, 400)).filter(Boolean).slice(0, 12),
    steps: (Array.isArray(data.steps) ? data.steps : [])
      .map(s => typeof s === "string" ? { text: s } : s)
      .map(s => ({ text: plain(s?.text, 300), owner: plain(s?.owner, 60) || null }))
      .filter(s => s.text).slice(0, MAX_STEPS),
  };
}

export const NOTES_PROMPT = [
  "You write notes from a person's voice memo.",
  "You get a timestamped transcript.",
  'Reply with JSON only: {"title": "a few words", "summary": "two or three plain sentences", "notes": ["key point or decision", ...], "steps": [{"text": "one concrete next step, starting with a verb", "owner": "person name or null"}]}.',
  "The summary says what the memo was about in one or two sentences; notes add decisions and details, without repeating the summary. Steps are things an AI agent could start on or track if someone taps them; at most 8, only real ones from the memo.",
  "Write plainly. Spell out numbers one to nine. Do not invent anything that was not said.",
].join(" ");

/** Any audio file the server's ffmpeg can read, through whisper.cpp. Returns [{fromMs, text}]. */
export async function transcribeAudio(file, { workdir, language, config = {} }) {
  const ffmpeg = findBinary("ffmpeg", config.ffmpeg);
  const whisper = findBinary("whisper-cli", config.whisper);
  const model = config.model || path.join(os.homedir(), ".local/share/servant/models/ggml-base.en.bin");
  if (!ffmpeg || !whisper || !fs.existsSync(model)) throw httpError(503, "no_transcriber", "Transcription isn't set up on this server");
  const base = path.join(workdir, path.basename(file, path.extname(file)));
  await run(ffmpeg, ["-y", "-v", "error", "-protocol_whitelist", "file", "-i", file, "-vn", "-ar", "16000", "-ac", "1", `${base}.wav`]);
  try {
    await run(whisper, ["-m", model, "-f", `${base}.wav`, "-l", language || "en", "-np", "-oj", "-of", base, "-t", String(Math.max(1, Math.min(8, os.cpus().length - 1)))]);
    // A recording too short to hold speech makes whisper exit cleanly with no output.
    if (!fs.existsSync(`${base}.json`)) return [];
    return parseWhisperJson(fs.readFileSync(`${base}.json`, "utf8"));
  } finally { fs.rmSync(`${base}.wav`, { force: true }); fs.rmSync(`${base}.json`, { force: true }); }
}

