// Record a voice memo in the browser and the Mac app with MediaRecorder (see web-recorder.ts).
// Same engine shape as recording-engine.ts, which phones use.
import { useCallback, useEffect, useRef, useState } from "react";
import type { RecordingEngine, RecordingResult } from "./recording-engine";
import { startWebRecording, systemAudioSupported, webRecordingSupported, type WebRecording } from "./web-recorder";
export type { RecordingEngine, RecordingResult } from "./recording-engine";

export function useRecordingEngine(): RecordingEngine {
  const active = useRef<WebRecording | null>(null);
  const startedAt = useRef(0);
  const [elapsedMs, setElapsed] = useState(0);
  const [recording, setRecording] = useState(false);
  const [supported] = useState(() => webRecordingSupported());
  const [systemAudioOffered] = useState(() => systemAudioSupported());

  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => setElapsed(Date.now() - startedAt.current), 500);
    return () => clearInterval(timer);
  }, [recording]);
  // Leaving the screen mid-recording stops the microphone.
  useEffect(() => () => { void active.current?.stop().catch(() => {}); active.current = null; }, []);

  const start = useCallback(async ({ systemAudio }: { systemAudio: boolean }) => {
    const r = await startWebRecording({ systemAudio });
    active.current = r;
    startedAt.current = Date.now();
    setElapsed(0);
    setRecording(true);
    return { systemAudio: r.systemAudio, note: r.note };
  }, []);

  const stop = useCallback(async (): Promise<RecordingResult> => {
    const r = active.current;
    active.current = null;
    setRecording(false);
    if (!r) throw new Error("Nothing is recording");
    const { blob, durationMs, ext } = await r.stop();
    return {
      size: blob.size, ext, durationMs,
      read: async (offset, count) => new Uint8Array(await blob.slice(offset, offset + count).arrayBuffer()),
      discard: () => {},
    };
  }, []);

  return { supported, systemAudioOffered, start, stop, elapsedMs, recording };
}
