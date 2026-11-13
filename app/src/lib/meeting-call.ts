// The call engine for a meeting. The same code runs on the web (browser
// WebRTC) and on phones (react-native-webrtc). Each person sends their camera
// and microphone to the server once, and receives everyone else on separate
// connections, so people can come and go without renegotiating.
import { Platform } from "react-native";
import { setSpeaker } from "./call-speaker";
import { api, ServerError, type Account, type Meeting, type ResearchCard } from "./server";
import { carryMute, micConstraints, otherDevice } from "./call-audio";
import { createNoiseFilter, type NoiseFilter } from "./noise-filter";
import { getNoisePref, subscribeNoisePref } from "./noise-store";

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
export type Person = { id: string; name: string; you: boolean; muteSeq: number; hasAudio: boolean; hasVideo: boolean; muted: boolean };
export type CallState = {
  status: "starting" | "connecting" | "live" | "ended" | "failed";
  error: string | null;
  local: Stream | null;
  remotes: Remote[];
  /** Everyone in the call, you included, for the people list. */
  people: Person[];
  muted: boolean;
  /** Sound plays from the loudspeaker instead of the earpiece (phones only). */
  speaker?: boolean;
  /** You started the call, so you can mute others. */
  host?: boolean;
  /** Research during the call ("hey servant"). */
  research?: { available: boolean; on: boolean; cards: ResearchCard[] };
  cameraOff: boolean;
  /** Your own screen share, while it is on. */
  sharing: boolean;
  /** When the call started, for the running time. */
  startedAt?: number;
  /** The conversation the call belongs to. */
  conversationId?: string;
  /** You're on this call from another device too: a note on screen, and the later device starts muted. */
  otherDevice?: boolean;
  /** Browsers and the Mac app: the page's own noise filter is running, switched off, or couldn't start (the browser's own suppression is on either way). */
  noiseFilter?: "running" | "off" | "unavailable";
  /** Guests from a link, when the server has them on (components/GuestInvite.tsx). */
  guests?: Meeting["guests"];
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
    if (e.code === "session_expired") return `Couldn't ${where}: your session ended. Confirm it's you, then try again`;
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

// Voice processing in the microphone itself: echo cancellation, level control and the browser's or
// phone's own noise suppression (see micConstraints). Browsers and the Mac app add the page's own
// noise filter on top of that, after the microphone is open (see noise-filter.ts).
async function voice(): Promise<any> { return micConstraints(Platform.OS, await getNoisePref()); }
// What a preview stream's microphone was opened with, so joining can tell if the choice changed since.
const openedWith = new WeakMap<object, boolean>();

/** What you chose on the check-your-camera screen: the open camera and mic, and whether each is off. */
export type CallPreset = { stream: Stream; muted: boolean; cameraOff: boolean };

/** Opens your camera and mic for the check screen. No camera or no permission still gives a clear answer. */
export async function openPreview(): Promise<{ stream: Stream | null; hasCamera: boolean; error: string | null }> {
  const { mediaDevices } = rtc();
  const noiseOn = await getNoisePref();
  const audio = micConstraints(Platform.OS, noiseOn);
  try {
    const stream = await mediaDevices.getUserMedia({ audio, video: { width: 640, height: 480, frameRate: 24 } });
    openedWith.set(stream, noiseOn);
    return { stream, hasCamera: !!stream.getVideoTracks?.().length, error: null };
  } catch {
    try {
      const stream = await mediaDevices.getUserMedia({ audio, video: false });
      openedWith.set(stream, noiseOn);
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
  // The microphone and camera as the device gives them. On the web state.local carries the
  // filtered microphone instead, so muting works on what is actually sent.
  let raw: Stream | null = null;
  let filter: NoiseFilter | null = null;
  let unsubNoise: (() => void) | null = null;
  let noiseWork: Promise<void> = Promise.resolve();
  const iceConfig = (m: Meeting) => ({ iceServers: m.iceServers.length ? m.iceServers : [{ urls: "stun:stun.l.google.com:19302" }] });

  async function getMedia() {
    const { mediaDevices } = rtc();
    if (preset?.stream) {
      // The stream you checked is the one you join with, so the camera isn't opened twice.
      const stream = await reopenMicIfChoiceChanged(preset.stream);
      for (const t of stream.getAudioTracks?.() ?? []) t.enabled = !state.muted;
      for (const t of stream.getVideoTracks?.() ?? []) t.enabled = !preset.cameraOff;
      return stream;
    }
    const audio = await voice();
    let stream: Stream = null;
    try { stream = await mediaDevices.getUserMedia({ audio, video: { width: 640, height: 480, frameRate: 24 } }); }
    catch {
      // No camera, or the camera was refused: join with audio only.
      try { state.cameraOff = true; stream = await mediaDevices.getUserMedia({ audio, video: false }); }
      catch (e) { micError = e; return null; }
    }
    for (const t of stream.getAudioTracks?.() ?? []) t.enabled = !state.muted;
    return stream;
  }

  // Android applies "Noise reduction" when the microphone opens. If the switch moved after the
  // check screen opened it, open the microphone again (before anything is connected) so the choice
  // counts; if that fails, join with the microphone as it is rather than not at all.
  async function reopenMicIfChoiceChanged(stream: Stream): Promise<Stream> {
    if (Platform.OS !== "android") return stream;
    const was = openedWith.get(stream), now = await getNoisePref();
    if (was === undefined || was === now) return stream;
    const { mediaDevices, MediaStream } = rtc();
    try {
      const fresh = await mediaDevices.getUserMedia({ audio: micConstraints(Platform.OS, now), video: false });
      for (const t of stream.getAudioTracks?.() ?? []) t.stop();
      const next = new MediaStream([...fresh.getAudioTracks(), ...(stream.getVideoTracks?.() ?? [])]);
      openedWith.set(next, now);
      return next;
    } catch { return stream; }
  }

  // Browsers and the Mac app: the microphone goes through the page's noise filter when the switch
  // is on. The filtered track is what state.local holds and what the call sends; the raw microphone
  // keeps feeding the filter. Switching mid-call swaps the sender's track, nothing else changes.
  async function outgoing(stream: Stream): Promise<Stream> {
    if (Platform.OS !== "web") return stream;
    const mic = stream.getAudioTracks?.()[0];
    if (!mic) return stream;
    const { MediaStream } = rtc();
    const out = new MediaStream(stream.getVideoTracks());
    const on = await getNoisePref();
    if (on) filter = await createNoiseFilter(mic, filterBroke);
    state.noiseFilter = filter ? "running" : on ? "unavailable" : "off";
    if (filter) carryMute(mic, filter.track, mic);
    out.addTrack(filter ? filter.track : mic);
    unsubNoise = subscribeNoisePref(next => { noiseWork = noiseWork.then(() => setNoise(next)).catch(() => {}); });
    return out;
  }

  async function setNoise(on: boolean) {
    if (closed || Platform.OS !== "web" || !raw || !state.local) return;
    const mic = raw.getAudioTracks()[0];
    if (!mic) return;
    const current = state.local.getAudioTracks()[0];
    let next = mic;
    if (on) {
      try {
        filter ??= await createNoiseFilter(mic, filterBroke);
        if (filter) { await filter.resume(); next = filter.track; }
      } catch { await filter?.close(); filter = null; }
      if (!filter) { state.noiseFilter = "unavailable"; emit(); return; }
    }
    if (next !== current) {
      carryMute(current, next, mic);
      const sender = pc?.getSenders?.().find((s: any) => s.track === current || s.track?.kind === "audio");
      if (sender) await sender.replaceTrack(next);
      if (current) state.local.removeTrack(current);
      state.local.addTrack(next);
    }
    if (!on) await filter?.pause();
    state.noiseFilter = on ? "running" : "off";
    emit();
  }

  // The filter stopped producing sound (suspended for good, or never started): send the raw
  // microphone, and say so. The browser's own suppression is still on it.
  function filterBroke() {
    const f = filter; filter = null;
    noiseWork = noiseWork.then(async () => { await setNoise(false); if (!closed) { state.noiseFilter = "unavailable"; emit(); } await f?.close(); }).catch(() => {});
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
      // Only trust a stream the sender named. Reusing remote.stream here kept the audio-only stream
      // the first track made, so the video track that came next never reached the tile on phones.
      const stream = e.streams?.[0] ?? null;
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

  let seenMuteSeq = 0;
  async function sync() {
    if (closed) return;
    try {
      const m = await api.meeting(account, meetingId);
      if (m.status !== "live") { state.status = "ended"; emit(); await stop(false); return; }
      state.startedAt = m.startedAt; state.conversationId = m.conversationId;
      state.people = m.participants.filter(p => !p.screen).map(p => ({ id: p.id, name: p.id === participantId ? "You" : p.you ? `${p.user.name} (other device)` : p.user.name, you: p.id === participantId, muteSeq: p.muteSeq || 0, hasAudio: p.hasAudio, hasVideo: p.hasVideo, muted: !!p.muted || !p.hasAudio }))
        .sort((a, b) => Number(b.you) - Number(a.you));
      state.host = !!m.host;
      state.research = m.research;
      state.otherDevice = otherDevice(m.participants, participantId).present;
      state.guests = m.guestsEnabled ? m.guests : undefined;
      // The host muted you: mute your own mic, once per ask. You can unmute yourself afterwards.
      const me = m.participants.find(p => p.id === participantId);
      if (me && (me.muteSeq || 0) > seenMuteSeq) {
        seenMuteSeq = me.muteSeq || 0;
        if (!state.muted) { state.muted = true; for (const t of state.local?.getAudioTracks?.() ?? []) t.enabled = false; report(); }
      }
      // Same person on another device (Android + Mac) is still someone to watch: match this connection, not the account.
      const others = m.participants.filter(p => p.id !== participantId && p.publishing);
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
      if (m.status !== "live") { state.status = "ended"; emit(); stopTracks(); return; }
      // Already on this call from another device (a Mac and a phone in one room feed back into
      // each other): this one starts muted, and the screen says why. You can unmute.
      const twice = otherDevice(m.participants, null);
      if (twice.present) { state.otherDevice = true; if (twice.startMuted) state.muted = true; }
      step = "microphone";
      raw = await getMedia();
      if (!raw) throw Object.assign(new Error("microphone"), { name: micError?.name || "NotAllowedError" });
      if (closed) { stopTracks(); return; }
      state.local = await outgoing(raw);
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
      // Left while the join was in flight: the server has still added this person, so say they left (stop()
      // ran before we had a participant id, and setRemoteDescription would throw on the closed connection).
      if (closed) { void api.leaveMeeting(account, meetingId, participantId).catch(() => {}); return; }
      await pc.setRemoteDescription({ type: "answer", sdp: joined.sdp });
      if (state.cameraOff || state.muted) report();
      if (closed) { void api.leaveMeeting(account, meetingId, participantId).catch(() => {}); return; }
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

  // Both the microphone as opened and what was sent: nothing stays open after a call.
  function stopTracks() {
    // preset.stream is the one checked on the pre-call screen. That screen hands it over and stops cleaning it up,
    // so if the call fails or ends before it is adopted as `raw`, nobody else owns it and the camera light stays on.
    for (const t of [...(raw?.getTracks?.() ?? []), ...(state.local?.getTracks?.() ?? []), ...(preset?.stream?.getTracks?.() ?? [])]) t.stop();
    unsubNoise?.(); unsubNoise = null;
    const f = filter; filter = null;
    void f?.close();
  }

  async function stop(leave = true) {
    if (closed) return;
    closed = true;
    if (poll) clearTimeout(poll);
    for (const id of [...watching.keys()]) unwatch(id);
    await stopScreen();
    pc?.close();
    stopTracks();
    if (state.speaker) setSpeaker(false);
    if (leave && participantId) await api.leaveMeeting(account, meetingId, participantId);
    emit();
  }

  return {
    start,
    leave: () => stop(true),
    startResearch: () => api.startMeetingResearch(account, meetingId).then((m) => { state.research = m.research; emit(); }),
    muteOther: (id: string) => api.muteParticipant(account, meetingId, id).then(() => undefined),
    end: async () => { await stop(true); return api.endMeeting(account, meetingId); },
    toggleScreen: () => (screenPc ? stopScreen() : startScreen()),
    toggleMute() {
      state.muted = !state.muted;
      for (const t of state.local?.getAudioTracks?.() ?? []) t.enabled = !state.muted;
      report();
      emit();
    },
    toggleSpeaker() {
      state.speaker = !state.speaker;
      setSpeaker(state.speaker);
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
