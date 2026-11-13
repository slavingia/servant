// Research during a call. Someone says "hey servant, what's the standard mileage rate?" and the
// agent looks it up and shows the answer as a small card in the call's Research tray. Nothing is
// spoken, nothing covers the video, and the host has to switch it on (everyone is told).
//
// Each person's microphone is also written to a small audio-only file (see meetings.mjs). Every
// few seconds this reads the new part of each file, transcribes it, and looks for the wake phrase.
// The pure helpers here are tested without any audio; the engine takes injected `transcribe` and
// `research` so tests need neither whisper nor a model.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { findBinary, parseWhisperJson } from "./meetings.mjs";

export const TICK_MS = 8000;
export const MIN_CHUNK_SEC = 3;
export const MAX_CARDS = 30;
export const MAX_QUEUE = 3;
export const MAX_QUESTION = 600;
const CONTEXT_MS = 2 * 60 * 1000;
const FOLLOW_MS = 25 * 1000;

// Whisper writes "Hey, Servant." "hey servant" "Hey S." "Hey agent". Same handles as @agent.
export const WAKE = /\b(?:hey|hay|hi|ok|okay)[\s,.!-]+(?:servants?|serve\s?ant|agent|s)\b[\s,.:;!-]*/i;
const NOISE = /^(thank you\.?|thanks for watching\.?|you\.?|bye\.?)$/i;

/** The words after "hey servant", or null when the phrase isn't there. */
export function findAsk(text) {
  const m = WAKE.exec(String(text || ""));
  return m ? String(text).slice(m.index + m[0].length).trim() : null;
}

/** The last couple of minutes of the call, for the agent to read. */
export function recentContext(lines, nowMs, ms = CONTEXT_MS) {
  return lines.filter(l => nowMs - l.seenAt <= ms).map(l => `${l.name}: ${l.text}`).join("\n").slice(-6000);
}

function run(file, args, timeout = 60000) {
  return new Promise((resolve, reject) => execFile(file, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (e, out) => e ? reject(e) : resolve(out)));
}

/** Transcribe a growing audio-only webm from `fromSec`. Returns { seconds, segments: [{fromMs, text}] }. */
export async function liveTranscribe(file, fromSec, { workdir, language, config = {} } = {}) {
  const ffmpeg = findBinary("ffmpeg", config.ffmpeg);
  const whisper = findBinary("whisper-cli", config.whisper);
  const model = config.model || path.join(os.homedir(), ".local/share/servant/models/ggml-base.en.bin");
  if (!ffmpeg || !whisper || !fs.existsSync(model)) throw Object.assign(new Error("Transcription isn't set up on this server"), { code: "no_transcriber" });
  const base = path.join(workdir, `live-${path.basename(file, ".webm")}-${Math.round(fromSec)}`);
  try {
    // A file still being written ends mid-way; ffmpeg keeps what it could read.
    await run(ffmpeg, ["-y", "-v", "quiet", "-ss", String(fromSec), "-i", file, "-vn", "-ar", "16000", "-ac", "1", `${base}.wav`]).catch(() => {});
    const bytes = fs.existsSync(`${base}.wav`) ? fs.statSync(`${base}.wav`).size : 0;
    const seconds = Math.max(0, (bytes - 44) / 32000);
    if (seconds < MIN_CHUNK_SEC) return { seconds: 0, segments: [] };
    await run(whisper, ["-m", model, "-f", `${base}.wav`, "-l", language || "en", "-np", "-oj", "-of", base, "-t", String(Math.max(1, Math.min(4, os.cpus().length - 2)))]);
    const segments = fs.existsSync(`${base}.json`) ? parseWhisperJson(fs.readFileSync(`${base}.json`, "utf8")) : [];
    return { seconds, segments };
  } finally { fs.rmSync(`${base}.wav`, { force: true }); fs.rmSync(`${base}.json`, { force: true }); }
}

/**
 * One engine per live call that has Research on.
 * @param {object} o
 * @param {() => Array<{id:string,userId:string,name:string,muted:boolean,liveFile:string|null}>} o.people
 * @param {(file:string, fromSec:number) => Promise<{seconds:number, segments:Array<{fromMs:number,text:string}>}>} o.transcribe
 * @param {(o:{question:string, context:string, asker:string}) => Promise<string>} o.research
 * @param {(cards:object[]) => void} o.onCards   cards changed (persist + refresh)
 * @param {() => number} [o.now]
 */
export function createAssist({ people, transcribe, research, onCards, log = console, now = Date.now, cards = [] }) {
  const lines = [];
  const progress = new Map(); // participant id -> seconds already read
  const queue = [];
  let pending = null;
  let busy = false;
  let ticking = false;
  let stopped = false;
  let seq = cards.reduce((n, c) => Math.max(n, c.n || 0), 0);
  const state = { cards };

  const emit = () => { state.cards = state.cards.slice(-MAX_CARDS); onCards(state.cards); };

  async function work() {
    if (busy || stopped) return;
    const job = queue.shift();
    if (!job) return;
    busy = true;
    try {
      const answer = String(await research({ question: job.card.question, context: job.context, asker: job.card.asker }) || "").trim();
      if (answer) { job.card.answer = answer.slice(0, 2000); job.card.status = "done"; }
      else { job.card.status = "failed"; job.card.answer = "The agent had no answer for that"; }
    } catch (e) {
      log.error?.("[servant] meeting research:", e?.message || e);
      job.card.status = "failed"; job.card.answer = "Couldn't look that up. Say it again to retry";
    }
    busy = false;
    emit();
    void work();
  }

  function ask(who, question) {
    const text = String(question || "").replace(/\s+/g, " ").trim().slice(0, MAX_QUESTION);
    if (text.length < 4) return;
    if (queue.length >= MAX_QUEUE) return;
    const card = { n: ++seq, id: `r${seq}`, askerId: who.userId, asker: who.name, question: text, answer: null, status: "working", at: now() };
    state.cards.push(card);
    queue.push({ card, context: recentContext(lines, now()) });
    emit();
    void work();
  }

  /** Read what's new from every microphone, then act on the wake phrase. */
  async function tick() {
    if (ticking || stopped) return;
    ticking = true;
    try {
      let addedToPending = false;
      for (const p of people()) {
        if (!p.liveFile || p.muted) continue;
        const from = progress.get(p.id) || 0;
        let out;
        try { out = await transcribe(p.liveFile, from); } catch (e) { log.error?.("[servant] live transcript:", e?.message || e); continue; }
        if (!out.seconds) continue;
        progress.set(p.id, from + out.seconds);
        for (const seg of out.segments) {
          const text = String(seg.text || "").replace(/\s+/g, " ").trim();
          if (!text || NOISE.test(text) || /^[\[(].*[\])]$/.test(text)) continue;
          lines.push({ userId: p.userId, name: p.name, text, seenAt: now() });
          const found = findAsk(text);
          if (found !== null) {
            if (pending) ask(pending.who, pending.text);
            pending = { who: { userId: p.userId, name: p.name }, text: found, last: now(), fresh: true };
            addedToPending = true;
          } else if (pending && pending.who.userId === p.userId && now() - pending.last < FOLLOW_MS) {
            pending.text += " " + text; pending.last = now(); pending.fresh = true; addedToPending = true;
          }
        }
      }
      while (lines.length > 400) lines.shift();
      // Fire once a whole tick passes with nothing more from the asker.
      if (pending && !addedToPending) {
        if (pending.fresh) pending.fresh = false;
        else { ask(pending.who, pending.text); pending = null; }
      }
      if (pending && !pending.fresh && now() - pending.last > FOLLOW_MS) { ask(pending.who, pending.text); pending = null; }
    } finally { ticking = false; }
  }

  return { tick, lines, get cards() { return state.cards; }, stop() { stopped = true; }, flush: async () => { while (busy || queue.length) await new Promise(r => setTimeout(r, 5)); } };
}
