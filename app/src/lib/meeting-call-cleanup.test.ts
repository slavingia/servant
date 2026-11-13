// A call that fails before it adopts the camera/microphone you checked must still switch them off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

// meeting-call.ts imports react-native and its neighbours Metro-style (no extensions). The hook finds the .ts
// files and swaps the pieces that need a device or a server for small stubs; the call logic itself is real.
const g = globalThis as any;
g.__calls = [];
g.__meeting = { status: "live", participants: [], iceServers: [] };
const stubs: Record<string, string> = {
  "react-native": "export const Platform = { OS: 'web' };",
  "./call-speaker": "export const setSpeaker = () => {};",
  "./noise-filter": "export const createNoiseFilter = async () => null;",
  "./noise-store": "export const getNoisePref = () => false; export const subscribeNoisePref = () => () => {};",
  "./server": `export class ServerError extends Error {}
    export const api = {
      meeting: async () => { const m = globalThis.__meeting; if (m instanceof Error) throw m; return m; },
      joinMeeting: async () => { globalThis.__calls.push('join'); if (globalThis.__join) return globalThis.__join(); throw new Error('join failed'); },
      leaveMeeting: async () => { globalThis.__calls.push('leave'); },
      meetingState: async () => {},
    };`,
};
registerHooks({
  resolve(specifier, context, next) {
    if (specifier in stubs && context.parentURL?.endsWith("/meeting-call.ts"))
      return { url: `data:text/javascript,${encodeURIComponent(stubs[specifier])}`, shortCircuit: true };
    if (specifier.startsWith(".") && !/\.\w+$/.test(specifier) && context.parentURL) {
      const file = fileURLToPath(new URL(`${specifier}.ts`, context.parentURL));
      if (fs.existsSync(file)) return next(`${specifier}.ts`, context);
    }
    return next(specifier, context);
  },
});
const { createCall } = await import("./meeting-call.ts");

function fakeStream() {
  const track = (kind: string) => ({ kind, enabled: true, stopped: false, stop() { this.stopped = true; } });
  const tracks = [track("audio"), track("video")];
  return { tracks, getTracks: () => tracks, getAudioTracks: () => tracks.filter(t => t.kind === "audio"), getVideoTracks: () => tracks.filter(t => t.kind === "video") };
}
const preset = (stream: any) => ({ stream, muted: false, cameraOff: false });

test("the stream checked on the pre-call screen is switched off when the call fails to load", async () => {
  const stream = fakeStream();
  g.__meeting = new Error("network down"); // the first call to the server fails, before the stream is adopted
  await createCall({} as any, "m1", () => {}, preset(stream)).start();
  assert.deepEqual(stream.tracks.map(t => t.stopped), [true, true], "camera and microphone indicators go off");
});

test("the stream is switched off when the meeting has already ended", async () => {
  const stream = fakeStream();
  g.__meeting = { status: "ended", participants: [], iceServers: [] };
  await createCall({} as any, "m2", () => {}, preset(stream)).start();
  assert.deepEqual(stream.tracks.map(t => t.stopped), [true, true]);
});

test("leaving before the call ever started also switches the stream off", async () => {
  const stream = fakeStream();
  await createCall({} as any, "m3", () => {}, preset(stream)).leave();
  assert.deepEqual(stream.tracks.map(t => t.stopped), [true, true]);
});

// Leaving while the join request is in flight: the server still adds this person, so it has to be told they left
// (otherwise they sit in the meeting as a ghost until the server times them out after 45 seconds).
test("leaving while the join is in flight still tells the server this person left", async () => {
  const stream = fakeStream();
  g.__meeting = { status: "live", participants: [], iceServers: [] };
  g.__calls.length = 0;
  let finishJoin: (v: any) => void = () => {};
  g.__join = () => new Promise(r => { finishJoin = r; });
  g.RTCPeerConnection = class {
    localDescription = { sdp: "offer" }; connectionState = "new"; closedNow = false;
    addTrack() {} addEventListener() {} close() { this.closedNow = true; }
    async createOffer() { return {}; } async setLocalDescription() {}
    get iceGatheringState() { return "complete"; }
    async setRemoteDescription() { if (this.closedNow) throw new Error("closed"); }
  };
  g.MediaStream = class { tracks: any[]; constructor(t: any[] = []) { this.tracks = [...t]; } addTrack(t: any) { this.tracks.push(t); } getTracks() { return this.tracks; } getAudioTracks() { return this.tracks.filter(t => t.kind === "audio"); } getVideoTracks() { return this.tracks.filter(t => t.kind === "video"); } };
  g.navigator ??= {};
  let last: any = null;
  const call = createCall({} as any, "m4", st => { last = st; }, preset(stream));
  const started = call.start();
  for (let i = 0; i < 50 && !g.__calls.includes("join"); i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(g.__calls.includes("join"), `the join request is in flight (status ${last?.status}: ${last?.error})`);
  await call.leave();
  finishJoin({ participantId: "p1", sdp: "answer" });
  await started;
  g.__join = undefined;
  assert.ok(g.__calls.includes("leave"), `the server was told: ${g.__calls.join()}`);
  assert.deepEqual(stream.tracks.map(t => t.stopped), [true, true]);
});
