// The call engine for a meeting. The same code runs on the web (browser
// WebRTC) and on phones (react-native-webrtc). Each person sends their camera
// and microphone to the server once, and receives everyone else on separate
// connections, so people can come and go without renegotiating.
import { Platform } from "react-native";
import { api, ServerError, type Account, type Meeting } from "./server";

type Stream = any;
type Peer = any;

type Native = { RTCPeerConnection: any; mediaDevices: any; MediaStream?: any };
let native: Native | null = null;
function rtc(): Native {
  if (Platform.OS === "web") return { RTCPeerConnection: (globalThis as any).RTCPeerConnection, mediaDevices: (globalThis as any).navigator?.mediaDevices, MediaStream: (globalThis as any).MediaStream };
  // Loaded lazily so the web bundle never pulls in the native module.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  native ??= require("react-native-webrtc") as Native;
  return native;
}

/** Only browsers and the Mac app can capture a screen; phones can watch one. */
export function screenShareSupported() {
  try { return Platform.OS === "web" && typeof (globalThis as any).navigator?.mediaDevices?.getDisplayMedia === "function"; } catch { return false; }
}

export function callsSupported() {
  try { const r = rtc(); return !!r.RTCPeerConnection && !!r.mediaDevices?.getUserMedia; } catch { return false; }
}

export type Remote = { participantId: string; name: string; stream: Stream; hasVideo: boolean; muted?: boolean; /** Someone's shared screen rather than their camera. */ screen?: boolean };
export type Person = { id: string; name: string; you: boolean; hasAudio: boolean; hasVideo: boolean; muted: boolean };
export type CallState = {
  status: "starting" | "connecting" | "live" | "ended" | "failed";
  error: string | null;
  local: Stream | null;
  remotes: Remote[];
  /** Everyone in the call, you included, for the people list. */
  people: Person[];
  muted: boolean;
  cameraOff: boolean;
  /** Your own screen share, while it is on. */
  sharing: boolean;
  /** When the call started, for the running time. */
  startedAt?: number;
  /** The conversation the call belongs to. */
  conversationId?: string;
};

export type CallStep = "start" | "load" | "microphone" | "join" | "connect";

/** Says what failed, at which step, and what to do next. Never a bare "Not found". */
export function callErrorText(e: unknown, step: CallStep): string {
  const where = { start: "start the call", load: "open the call", microphone: "use your microphone", join: "join the call", connect: "connect the call" }[step];
  if (e instanceof ServerError) {
    if (e.code === "meeting_ended") return "This call has ended. Start a new one from the conversation";
    if (e.code === "meeting_full") return "This call is full (12 people). Try again when someone leaves";
    if (e.code === "calls_unavailable" || e.status === 503) return `Couldn't ${where}: calls aren't running on this server right now. Try again in a minute, or ask your admin`;
    if (e.code === "unreachable" || e.code === "network" || e.status === 0) return `Couldn't ${where}: the server isn't reachable. Check your connection and try again`;
    if (e.status === 401) return `Couldn't ${where}: you're signed out. Open Servant again and sign in`;
    if (e.status === 404) return step === "start"
      ? `Couldn't ${where}: ${e.message}. If this keeps happening, this server may not support calls yet. Ask your admin to update it`
      : `Couldn't ${where}: ${e.message}`;
    if (e.code === "bad_sdp") return `Couldn't ${where}: the connection setup was rejected. Leave and try again`;
    return `Couldn't ${where}: ${e.message} (${e.status || e.code})`;
  }
  const name = (e as any)?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return "Servant doesn't have permission to use your microphone. Allow it in Settings, then try again";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No microphone found on this device. Connect one and try again";
  if (name === "NotReadableError") return "Your microphone is busy in another app. Close it and try again";
  const msg = (e as any)?.message;
  return msg ? `Couldn't ${where}: ${msg}` : `Couldn't ${where}. Check your connection and try again`;
}

// Gather the whole answer before sending it: signaling is a single HTTP request.
async function gathered(pc: Peer, timeoutMs = 3000) {
  if (pc.iceGatheringState === "complete") return;
  await new Promise<void>(resolve => {
    const done = () => { clearTimeout(t); pc.removeEventListener?.("icegatheringstatechange", check); resolve(); };
    const check = () => { if (pc.iceGatheringState === "complete") done(); };
    const t = setTimeout(done, timeoutMs);
    pc.addEventListener("icegatheringstatechange", check);
  });
}

// Voice processing: the browser's and the phone's own noise suppression, echo cancellation and
// level control, with Chrome's stronger voice isolation where available (the Mac app is Chrome).
const VOICE = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, voiceIsolation: true, googNoiseSuppression: true, googHighpassFilter: true } as any;

/** What you chose on the check-your-camera screen: the open camera and mic, and whether each is off. */
export type CallPreset = { stream: Stream; muted: boolean; cameraOff: boolean };

/** Opens your camera and mic for the check screen. No camera or no permission still gives a clear answer. */
export async function openPreview(): Promise<{ stream: Stream | null; hasCamera: boolean; error: string | null }> {
  const { mediaDevices } = rtc();
  try {
    const stream = await mediaDevices.getUserMedia({ audio: VOICE, video: { width: 640, height: 480, frameRate: 24 } });
    return { stream, hasCamera: !!stream.getVideoTracks?.().length, error: null };
  } catch {
    try {
      const stream = await mediaDevices.getUserMedia({ audio: VOICE, video: false });
      return { stream, hasCamera: false, error: "We can't see a camera. You can still join with sound only" };
    } catch {
      return { stream: null, hasCamera: false, error: "Servant can't use your camera or microphone. Allow both in your device settings, then try again" };
    }
  }
}

export function createCall(account: Account, meetingId: string, onChange: (s: CallState) => void, preset?: CallPreset) {
  const state: CallState = { status: "starting", error: null, local: null, remotes: [], people: [], muted: !!preset?.muted, cameraOff: !!preset?.cameraOff, sharing: false };
  const emit = () => onChange({ ...state, remotes: [...state.remotes], people: [...state.people] });
  let pc: Peer | null = null;
  let participantId: string | null = null;
  let closed = false;
  let micError: any = null;
  let poll: ReturnType<typeof setTimeout> | null = null;
  const watching = new Map<string, Peer>();
  let screenPc: Peer | null = null;
  let screenId: string | null = null;
  let screenStream: Stream | null = null;
  const iceConfig = (m: Meeting) => ({ iceServers: m.iceServers.length ? m.iceServers : [{ urls: "stun:stun.l.google.com:19302" }] });

  async function getMedia() {
    const { mediaDevices } = rtc();
    if (preset?.stream) {
      // The stream you checked is the one you join with, so the camera isn't opened twice.
      for (const t of preset.stream.getAudioTracks?.() ?? []) t.enabled = !preset.muted;
      for (const t of preset.stream.getVideoTracks?.() ?? []) t.enabled = !preset.cameraOff;
      return preset.stream;
    }
    try { return await mediaDevices.getUserMedia({ audio: VOICE, video: { width: 640, height: 480, frameRate: 24 } }); }
    catch {
      // No camera, or the camera was refused: join with audio only.
      try { state.cameraOff = true; return await mediaDevices.getUserMedia({ audio: VOICE, video: false }); }
      catch (e) { micError = e; return null; }
    }
  }

  // Video comes from the server's list: the watch connection always offers a
  // video slot, so a browser reports a video track even when nobody sends one.
  async function watch(m: Meeting, publisherId: string, name: string, hasVideo: boolean, screen = false) {
    if (closed || !participantId || watching.has(publisherId)) return;
    const { RTCPeerConnection } = rtc();
    const peer = new RTCPeerConnection(iceConfig(m));
    watching.set(publisherId, peer);
    peer.addTransceiver("audio", { direction: "recvonly" });
    peer.addTransceiver("video", { direction: "recvonly" });
    const remote: Remote = { participantId: publisherId, name: screen ? `${name}'s screen` : name, stream: null, hasVideo, ...(screen ? { screen: true } : {}) };
    peer.addEventListener("track", (e: any) => {
      const stream = e.streams?.[0] ?? remote.stream ?? null;
      if (stream) remote.stream = stream;
      else {
        // The server sends bare RTP with no stream id, so phones get no stream either: build one
        // from the tracks, or the tile (and the voice) never shows up.
        // A new stream per track: the phone's video view binds to a stream when it first draws, so a
        // video track added later to the same stream never appears (you saw only yourself).
        const { MediaStream } = rtc();
        remote.stream = new MediaStream([...(remote.stream?.getTracks?.() ?? []), e.track]);
      }
      if (!state.remotes.includes(remote)) state.remotes.push(remote);
      emit();
    });
    try {
      await peer.setLocalDescription(await peer.createOffer());
      await gathered(peer);
      const { sdp } = await api.watchMeeting(account, meetingId, participantId, publisherId, peer.localDescription.sdp);
      await peer.setRemoteDescription({ type: "answer", sdp });
    } catch {
      peer.close();
      watching.delete(publisherId);
    }
  }

  function unwatch(publisherId: string) {
    watching.get(publisherId)?.close();
    watching.delete(publisherId);
    state.remotes = state.remotes.filter(r => r.participantId !== publisherId);
  }

  async function sync() {
    if (closed) return;
    try {
      const m = await api.meeting(account, meetingId);
      if (m.status !== "live") { state.status = "ended"; emit(); await stop(false); return; }
      state.startedAt = m.startedAt; state.conversationId = m.conversationId;
      state.people = m.participants.filter(p => !p.screen).map(p => ({ id: p.id, name: p.you ? "You" : p.user.name, you: p.you, hasAudio: p.hasAudio, hasVideo: p.hasVideo, muted: !!p.muted || !p.hasAudio }))
        .sort((a, b) => Number(b.you) - Number(a.you));
      const others = m.participants.filter(p => !p.you && p.id !== participantId && p.publishing);
      for (const p of others) {
        const known = state.remotes.find(r => r.participantId === p.id);
        if (known) { known.hasVideo = p.hasVideo; known.muted = !!p.muted; }
        else void watch(m, p.id, p.user.name, p.hasVideo, !!p.screen);
      }
      for (const id of [...watching.keys()]) if (!others.some(p => p.id === id)) unwatch(id);
      emit();
    } catch { /* keep the call going through a missed poll */ }
    if (!closed) poll = setTimeout(sync, 2000);
  }

  async function start() {
    let step: CallStep = "load";
    try {
      const m = await api.meeting(account, meetingId);
      if (m.status !== "live") { state.status = "ended"; emit(); return; }
      step = "microphone";
      state.local = await getMedia();
      if (!state.local) throw Object.assign(new Error("microphone"), { name: micError?.name || "NotAllowedError" });
      if (closed) { stopTracks(); return; }
      step = "join";
      state.status = "connecting"; emit();
      const { RTCPeerConnection } = rtc();
      pc = new RTCPeerConnection(iceConfig(m));
      for (const track of state.local.getTracks()) pc.addTrack(track, state.local);
      pc.addEventListener("connectionstatechange", () => {
        if (pc?.connectionState === "connected") { state.status = "live"; emit(); }
        if (pc?.connectionState === "failed" && !closed) { state.status = "failed"; state.error = "The call dropped before audio connected. Check your connection (some Wi-Fi blocks calls) and join again"; emit(); }
      });
      await pc.setLocalDescription(await pc.createOffer());
      await gathered(pc);
      const joined = await api.joinMeeting(account, meetingId, pc.localDescription.sdp);
      participantId = joined.participantId;
      await pc.setRemoteDescription({ type: "answer", sdp: joined.sdp });
      if (state.cameraOff) report();
      if (closed) { void api.leaveMeeting(account, meetingId, participantId); return; }
      void sync();
    } catch (e: any) {
      state.status = "failed";
      state.error = callErrorText(e, step);
      emit();
      await stop(false);
    }
  }

  // Share your screen as a second, video-only connection in the same call. The browser (or the Mac
  // app) asks which screen or window; stopping from the system's own "Stop sharing" works too.
  async function startScreen() {
    if (closed || !participantId || screenPc || !screenShareSupported()) return;
    const md = rtc().mediaDevices;
    let stream: Stream;
    try { stream = await md.getDisplayMedia({ video: { frameRate: 15 }, audio: false }); }
    catch (e: any) {
      // Cancelling the picker is not an error.
      if (e?.name === "NotAllowedError" || e?.name === "AbortError") return;
      state.error = "Couldn't share your screen. Allow screen recording for Servant in System Settings, then try again"; emit(); return;
    }
    const track = stream.getVideoTracks()[0];
    if (!track) { for (const t of stream.getTracks()) t.stop(); return; }
    try {
      const { RTCPeerConnection } = rtc();
      const pcs = new RTCPeerConnection(iceConfig(await api.meeting(account, meetingId)));
      screenPc = pcs; screenStream = stream;
      pcs.addTrack(track, stream);
      track.addEventListener("ended", () => { void stopScreen(); });
      await pcs.setLocalDescription(await pcs.createOffer());
      await gathered(pcs);
      const joined = await api.joinMeeting(account, meetingId, pcs.localDescription.sdp, participantId);
      screenId = joined.participantId;
      await pcs.setRemoteDescription({ type: "answer", sdp: joined.sdp });
      state.sharing = true; state.error = null; emit();
    } catch (e) {
      await stopScreen();
      state.error = e instanceof ServerError && e.code === "already_sharing" ? "You're already sharing your screen from another window" : "Couldn't share your screen. Try again";
      emit();
    }
  }

  async function stopScreen() {
    const id = screenId, pcs = screenPc, stream = screenStream;
    screenPc = null; screenId = null; screenStream = null;
    for (const t of stream?.getTracks?.() ?? []) t.stop();
    pcs?.close();
    if (state.sharing) { state.sharing = false; emit(); }
    if (id) await api.leaveMeeting(account, meetingId, id);
  }

  const report = () => { if (participantId) void api.meetingState(account, meetingId, participantId, state.muted, state.cameraOff); };

  function stopTracks() { for (const t of state.local?.getTracks?.() ?? []) t.stop(); }

  async function stop(leave = true) {
    if (closed) return;
    closed = true;
    if (poll) clearTimeout(poll);
    for (const id of [...watching.keys()]) unwatch(id);
    await stopScreen();
    pc?.close();
    stopTracks();
    if (leave && participantId) await api.leaveMeeting(account, meetingId, participantId);
    emit();
  }

  return {
    start,
    leave: () => stop(true),
    end: async () => { await stop(true); return api.endMeeting(account, meetingId); },
    toggleScreen: () => (screenPc ? stopScreen() : startScreen()),
    toggleMute() {
      state.muted = !state.muted;
      for (const t of state.local?.getAudioTracks?.() ?? []) t.enabled = !state.muted;
      report();
      emit();
    },
    toggleCamera() {
      const tracks = state.local?.getVideoTracks?.() ?? [];
      if (!tracks.length) return;
      state.cameraOff = !state.cameraOff;
      for (const t of tracks) t.enabled = !state.cameraOff;
      report();
      emit();
    },
    get state() { return state; },
    meetingId,
  };
}
