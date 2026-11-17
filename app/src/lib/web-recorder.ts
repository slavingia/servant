// Record a voice memo in the browser or the Mac app: the microphone, and when the person asks for it
// the sound playing on this computer (a browser tab, a window, or the whole screen's audio),
// mixed into one stream and recorded with MediaRecorder. The pure parts are tested; the rest needs a browser.

export type RecordingFormat = { mime: string; ext: string };

// In order of preference. The extension is one the server accepts (server/recordings.mjs);
// ffmpeg reads webm/opus and mp4/aac without trouble. Safari records audio/mp4.
const FORMATS: RecordingFormat[] = [
  { mime: "audio/webm;codecs=opus", ext: "webm" },
  { mime: "audio/webm", ext: "webm" },
  { mime: "audio/mp4;codecs=mp4a.40.2", ext: "mp4" },
  { mime: "audio/mp4", ext: "mp4" },
];

/** The first recording format this browser can make that the server can read, or null. */
export function pickRecordingFormat(isSupported: (mime: string) => boolean): RecordingFormat | null {
  for (const f of FORMATS) { try { if (isSupported(f.mime)) return f; } catch { /* some browsers throw on unknown types */ } }
  return null;
}

const g = globalThis as any;
export function webRecordingSupported(): boolean {
  try { return typeof g.MediaRecorder === "function" && typeof g.navigator?.mediaDevices?.getUserMedia === "function" && !!pickRecordingFormat(m => g.MediaRecorder.isTypeSupported(m)); } catch { return false; }
}
/** Browsers and the Mac app can share a tab's or the screen's audio; phones can't. */
export function systemAudioSupported(): boolean {
  try { return typeof g.navigator?.mediaDevices?.getDisplayMedia === "function"; } catch { return false; }
}

export type WebRecording = {
  /** True when the computer's audio is in the recording, not only the microphone. */
  systemAudio: boolean;
  /** A plain-words reason when the computer audio could not be included. */
  note: string | null;
  stop: () => Promise<{ blob: Blob; durationMs: number; ext: string }>;
};

/** Ask for the microphone (and the computer audio when wanted) and start recording. */
export async function startWebRecording({ systemAudio, onSystemAudioEnded }: { systemAudio: boolean; onSystemAudioEnded?: () => void }): Promise<WebRecording> {
  const format = pickRecordingFormat(m => g.MediaRecorder.isTypeSupported(m));
  if (!format) throw new Error("This browser can't record audio. Use a current Chrome, Edge or Safari");
  let mic: MediaStream;
  try { mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); }
  catch { throw new Error("Allow the microphone to record a voice memo"); }

  let note: string | null = null;
  let system: MediaStream | null = null;
  if (systemAudio) {
    try {
      // The browser asks what to share; the person ticks "share audio". Only the sound is kept.
      const display: MediaStream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
      for (const t of display.getVideoTracks()) t.stop();
      const audio = display.getAudioTracks();
      if (audio.length) system = new MediaStream(audio);
      else note = "No computer audio was shared, so this records the microphone only";
    } catch {
      note = "Computer audio wasn't shared, so this records the microphone only";
    }
  }

  // Two sources into one stream; with the microphone alone, record it as it is.
  let context: AudioContext | null = null;
  let stream = mic;
  if (system) {
    context = new (g.AudioContext || g.webkitAudioContext)();
    const out = context!.createMediaStreamDestination();
    context!.createMediaStreamSource(mic).connect(out);
    context!.createMediaStreamSource(system).connect(out);
    stream = out.stream;
    const sysTrack = system.getAudioTracks()[0];
    if (sysTrack) sysTrack.addEventListener("ended", () => onSystemAudioEnded?.());
  }

  const chunks: Blob[] = [];
  const recorder: MediaRecorder = new g.MediaRecorder(stream, { mimeType: format.mime });
  recorder.addEventListener("dataavailable", (e: BlobEvent) => { if (e.data && e.data.size) chunks.push(e.data); });
  const startedAt = Date.now();
  recorder.start(1000);

  const cleanup = () => {
    for (const t of mic.getTracks()) t.stop();
    for (const t of system?.getTracks() ?? []) t.stop();
    void context?.close().catch(() => {});
  };
  return {
    systemAudio: !!system,
    note,
    stop: () => new Promise((resolve, reject) => {
      const finish = () => {
        cleanup();
        const blob = new Blob(chunks, { type: format.mime.split(";")[0] });
        if (!blob.size) { reject(new Error("Nothing was recorded. Check the microphone and try again")); return; }
        resolve({ blob, durationMs: Date.now() - startedAt, ext: format.ext });
      };
      if (recorder.state === "inactive") { finish(); return; }
      recorder.addEventListener("stop", finish, { once: true });
      try { recorder.stop(); } catch { finish(); }
    }),
  };
}
