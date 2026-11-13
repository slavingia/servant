// Record a meeting on iPhone and Android with expo-audio. The Mac app and the browser use
// recording-engine.web.ts (MediaRecorder) instead; both give the Meetings screen the same engine.
import { useCallback, useEffect, useRef } from "react";
import { RecordingPresets, requestRecordingPermissionsAsync, setAudioModeAsync, useAudioRecorder, useAudioRecorderState } from "expo-audio";
import { File } from "expo-file-system";
import type { ChunkReader } from "./document-upload";
import { extensionOf } from "./meetings";

/** A finished recording, ready to upload. `discard` deletes the local copy once it is safely on the server. */
export type RecordingResult = { read: ChunkReader; size: number; ext: string; durationMs: number; discard: () => void };
export type RecordingEngine = {
  /** This device can record at all. */
  supported: boolean;
  /** This platform can also take the sound of a meeting playing on the computer (browser and Mac app). */
  systemAudioOffered: boolean;
  start: (o: { systemAudio: boolean }) => Promise<{ systemAudio: boolean; note: string | null }>;
  stop: () => Promise<RecordingResult>;
  /** How long the current recording has run, for the timer. */
  elapsedMs: number;
  recording: boolean;
};

export function useRecordingEngine(): RecordingEngine {
  const recorder = useAudioRecorder(RecordingPresets.HIGH_QUALITY);
  const state = useAudioRecorderState(recorder, 500);
  // The length at the moment Stop is tapped (the recorder state resets once it stops).
  const elapsed = useRef(0);
  useEffect(() => { if (state.isRecording) elapsed.current = state.durationMillis; }, [state.isRecording, state.durationMillis]);
  // Leaving the screen mid-recording stops the microphone.
  useEffect(() => () => { if (recorder.isRecording) void recorder.stop().catch(() => {}); }, [recorder]);

  const start = useCallback(async () => {
    const permission = await requestRecordingPermissionsAsync();
    if (!permission.granted) throw new Error("Allow the microphone in Settings to record a meeting");
    await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    await recorder.prepareToRecordAsync();
    recorder.record();
    return { systemAudio: false, note: null };
  }, [recorder]);

  const stop = useCallback(async (): Promise<RecordingResult> => {
    const durationMs = elapsed.current;
    await recorder.stop();
    await setAudioModeAsync({ allowsRecording: false }).catch(() => {});
    const uri = recorder.uri;
    if (!uri) throw new Error("Couldn't find the recording. Try again");
    const file = new File(uri);
    return {
      size: file.size, ext: extensionOf(uri), durationMs,
      read: async (offset, count) => { const handle = new File(uri).open(); try { handle.offset = offset; return await handle.readBytes(count); } finally { handle.close(); } },
      discard: () => { try { file.delete(); } catch { /* the cache is cleaned by the system */ } },
    };
  }, [recorder]);

  return { supported: true, systemAudioOffered: false, start, stop, elapsedMs: state.isRecording ? state.durationMillis : 0, recording: state.isRecording };
}
