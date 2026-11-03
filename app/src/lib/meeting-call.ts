// The call engine for a meeting. The same code runs on the web (browser
// WebRTC) and on phones (react-native-webrtc). Each person sends their camera
// and microphone to the server once, and receives everyone else on separate
// connections, so people can come and go without renegotiating.
import { Platform } from "react-native";
import { api, type Account, type Meeting } from "./server";

type Stream = any;
type Peer = any;

type Native = { RTCPeerConnection: any; mediaDevices: any };
let native: Native | null = null;
function rtc(): Native {
  if (Platform.OS === "web") return { RTCPeerConnection: (globalThis as any).RTCPeerConnection, mediaDevices: (globalThis as any).navigator?.mediaDevices };
  // Loaded lazily so the web bundle never pulls in the native module.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  native ??= require("react-native-webrtc") as Native;
  return native;
}

export function callsSupported() {
  try { const r = rtc(); return !!r.RTCPeerConnection && !!r.mediaDevices?.getUserMedia; } catch { return false; }
}

export type Remote = { participantId: string; name: string; stream: Stream; hasVideo: boolean };
export type CallState = {
  status: "starting" | "connecting" | "live" | "ended" | "failed";
  error: string | null;
  local: Stream | null;
  remotes: Remote[];
  muted: boolean;
  cameraOff: boolean;
};

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

export function createCall(account: Account, meetingId: string, onChange: (s: CallState) => void) {
  const state: CallState = { status: "starting", error: null, local: null, remotes: [], muted: false, cameraOff: false };
  const emit = () => onChange({ ...state, remotes: [...state.remotes] });
  let pc: Peer | null = null;
  let participantId: string | null = null;
  let closed = false;
  let poll: ReturnType<typeof setTimeout> | null = null;
  const watching = new Map<string, Peer>();
  const iceConfig = (m: Meeting) => ({ iceServers: m.iceServers.length ? m.iceServers : [{ urls: "stun:stun.l.google.com:19302" }] });

  async function getMedia() {
    const { mediaDevices } = rtc();
    try { return await mediaDevices.getUserMedia({ audio: true, video: { width: 640, height: 480, frameRate: 24 } }); }
    catch {
      // No camera, or the camera was refused: join with audio only.
      try { state.cameraOff = true; return await mediaDevices.getUserMedia({ audio: true, video: false }); }
      catch { return null; }
    }
  }

  // Video comes from the server's list: the watch connection always offers a
  // video slot, so a browser reports a video track even when nobody sends one.
  async function watch(m: Meeting, publisherId: string, name: string, hasVideo: boolean) {
    if (closed || !participantId || watching.has(publisherId)) return;
    const { RTCPeerConnection } = rtc();
    const peer = new RTCPeerConnection(iceConfig(m));
    watching.set(publisherId, peer);
    peer.addTransceiver("audio", { direction: "recvonly" });
    peer.addTransceiver("video", { direction: "recvonly" });
    const remote: Remote = { participantId: publisherId, name, stream: null, hasVideo };
    peer.addEventListener("track", (e: any) => {
      const stream = e.streams?.[0] ?? remote.stream ?? null;
      if (stream) remote.stream = stream;
      else if (Platform.OS === "web") { remote.stream ??= new (globalThis as any).MediaStream(); remote.stream.addTrack(e.track); }
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
      const others = m.participants.filter(p => !p.you && p.id !== participantId && p.publishing);
      for (const p of others) {
        const known = state.remotes.find(r => r.participantId === p.id);
        if (known) known.hasVideo = p.hasVideo;
        else void watch(m, p.id, p.user.name, p.hasVideo);
      }
      for (const id of [...watching.keys()]) if (!others.some(p => p.id === id)) unwatch(id);
      emit();
    } catch { /* keep the call going through a missed poll */ }
    if (!closed) poll = setTimeout(sync, 2000);
  }

  async function start() {
    try {
      const m = await api.meeting(account, meetingId);
      if (m.status !== "live") { state.status = "ended"; emit(); return; }
      state.local = await getMedia();
      if (!state.local) throw new Error("Allow the microphone to join the meeting");
      if (closed) { stopTracks(); return; }
      state.status = "connecting"; emit();
      const { RTCPeerConnection } = rtc();
      pc = new RTCPeerConnection(iceConfig(m));
      for (const track of state.local.getTracks()) pc.addTrack(track, state.local);
      pc.addEventListener("connectionstatechange", () => {
        if (pc?.connectionState === "connected") { state.status = "live"; emit(); }
        if (pc?.connectionState === "failed" && !closed) { state.status = "failed"; state.error = "The call dropped. Check your connection and join again"; emit(); }
      });
      await pc.setLocalDescription(await pc.createOffer());
      await gathered(pc);
      const joined = await api.joinMeeting(account, meetingId, pc.localDescription.sdp);
      participantId = joined.participantId;
      await pc.setRemoteDescription({ type: "answer", sdp: joined.sdp });
      if (closed) { void api.leaveMeeting(account, meetingId, participantId); return; }
      void sync();
    } catch (e: any) {
      state.status = "failed";
      state.error = e?.message || "Couldn't join the meeting";
      emit();
      await stop(false);
    }
  }

  function stopTracks() { for (const t of state.local?.getTracks?.() ?? []) t.stop(); }

  async function stop(leave = true) {
    if (closed) return;
    closed = true;
    if (poll) clearTimeout(poll);
    for (const id of [...watching.keys()]) unwatch(id);
    pc?.close();
    stopTracks();
    if (leave && participantId) await api.leaveMeeting(account, meetingId, participantId);
    emit();
  }

  return {
    start,
    leave: () => stop(true),
    end: async () => { await stop(true); return api.endMeeting(account, meetingId); },
    toggleMute() {
      state.muted = !state.muted;
      for (const t of state.local?.getAudioTracks?.() ?? []) t.enabled = !state.muted;
      emit();
    },
    toggleCamera() {
      const tracks = state.local?.getVideoTracks?.() ?? [];
      if (!tracks.length) return;
      state.cameraOff = !state.cameraOff;
      for (const t of tracks) t.enabled = !state.cameraOff;
      emit();
    },
  };
}
