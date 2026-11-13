// Decisions about call audio that are the same everywhere and need no device or browser to test:
// which microphone constraints to ask for, where the "Noise reduction" switch takes effect, when
// the page's own noise filter can run, and what to do when the same person is on the call twice.

/**
 * Where "Noise reduction" takes effect.
 * - "filter": the page runs its own noise filter (an RNNoise AudioWorklet) between the microphone
 *   and the call. Browsers and the Mac app.
 * - "native": the phone's own noise suppressor, set when the microphone opens. Android:
 *   react-native-webrtc passes every audio constraint to libwebrtc's createAudioSource as a
 *   mandatory constraint, and libwebrtc reads the goog* names (sdk/media_constraints.cc).
 * - "none": nothing we can change from JavaScript. iPhone: react-native-webrtc's createAudioTrack
 *   ignores the constraints and takes the factory's default source, so the switch would do nothing.
 */
export type NoiseMode = "filter" | "native" | "none";

export function noiseMode(platform: string): NoiseMode {
  if (platform === "web") return "filter";
  if (platform === "android") return "native";
  return "none";
}

/**
 * The audio part of getUserMedia. Echo cancellation and level control always stay on: they are
 * what keeps the other side from hearing themselves. On the web the browser's own noise
 * suppression also stays on whatever the switch says: it runs in the same processing module as
 * the echo canceller, costs nothing, and is the fallback when the page's filter can't load. The
 * filter is an extra stage on top of it. On Android the switch sets the phone's suppressor itself
 * (both names, so whichever layer reads them agrees).
 */
export function micConstraints(platform: string, noiseOn: boolean): Record<string, boolean> {
  if (platform === "web") {
    return { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceIsolation: true, googNoiseSuppression: true, googHighpassFilter: true };
  }
  return {
    echoCancellation: true, autoGainControl: true, noiseSuppression: noiseOn,
    googEchoCancellation: true, googAutoGainControl: true, googNoiseSuppression: noiseOn, googHighpassFilter: true,
  };
}

/** What the page must offer for the noise filter to run. Anything missing means: use the browser's own suppression. */
export type FilterCapabilities = {
  AudioContext?: unknown;
  AudioWorkletNode?: unknown;
  WebAssembly?: { instantiate?: unknown } | undefined;
  MediaStreamAudioDestinationNode?: unknown;
  /** Secure context: AudioWorklet is not offered on plain http pages other than localhost. */
  isSecureContext?: boolean;
};

export function filterSupported(caps: FilterCapabilities): boolean {
  return typeof caps.AudioContext === "function"
    && typeof caps.AudioWorkletNode === "function"
    && typeof caps.MediaStreamAudioDestinationNode === "function"
    && typeof caps.WebAssembly?.instantiate === "function"
    && caps.isSecureContext !== false;
}

/**
 * Whether a track swap keeps you muted: the track going out carries the mute state of the track
 * it replaces, and a track that isn't in the stream any more must not stay muted itself, or
 * unmuting the new one would still send silence (the filter reads the raw track).
 */
export function carryMute(from: { enabled: boolean } | undefined, to: { enabled: boolean }, raw?: { enabled: boolean }) {
  to.enabled = from ? from.enabled : true;
  if (raw && raw !== to) raw.enabled = true;
}

export type ParticipantLike = { id: string; you: boolean; joinedAt?: number; screen?: boolean };

/**
 * The same account on the call from another device (a Mac and a phone in the same room feed back
 * into each other, which no echo canceller can fix). `present` drives a note on the screen; the
 * device that joined later starts muted so that it never happens by default.
 * Before joining (`myId` null) any other device of yours already there makes you the later one.
 */
export function otherDevice(participants: ParticipantLike[], myId: string | null): { present: boolean; startMuted: boolean } {
  const others = participants.filter(p => p.you && p.id !== myId && !p.screen);
  if (!others.length) return { present: false, startMuted: false };
  if (myId === null) return { present: true, startMuted: true };
  const me = participants.find(p => p.id === myId);
  if (!me) return { present: true, startMuted: true };
  const later = others.some(o => (o.joinedAt ?? 0) < (me.joinedAt ?? 0) || ((o.joinedAt ?? 0) === (me.joinedAt ?? 0) && o.id < me.id));
  return { present: true, startMuted: later };
}

export const OTHER_DEVICE_NOTE = "You're also on this call from another device. Mute one to avoid echo.";
export const SPEAKER_TIP = "Echo? Wear headphones, or mute when others are in the same room";

/**
 * Whether sound is probably coming out of a speaker, from the audio output list a browser gives
 * after the microphone was allowed. Unknown means no tip: it must never nag.
 */
export function speakerLikely(outputs: { deviceId?: string; label?: string }[]): boolean {
  if (!outputs.length) return false;
  const current = outputs.find(o => o.deviceId === "default") ?? outputs[0];
  const label = (current.label ?? "").toLowerCase();
  if (!label) return false;
  if (/headphone|headset|airpod|earbud|buds|earphone|bluetooth|usb|hands-free|hfp|beats|bose|sony|jabra|sennheiser/.test(label)) return false;
  return /speaker|built-in|macbook|imac|internal|display audio|studio display|mac mini|mac studio/.test(label);
}
