// The page's own noise filter for calls in browsers and the Mac app. The microphone runs through
// RNNoise (a small recurrent network compiled to WebAssembly, inside an AudioWorklet) before it
// reaches the call. The worklet and the WebAssembly are static files shipped with the app
// (public/noise, see LICENSE.txt there); nothing is fetched from anywhere else. Anything that fails
// here means: send the microphone as the browser gives it, with the browser's own suppression on.
import { filterSupported } from "./call-audio.ts";

const WORKLET = "/noise/rnnoise-worklet.js";
const PROCESSOR = "@sapphi-red/web-noise-suppressor/rnnoise";
export const WASM = { plain: "/noise/rnnoise.wasm", simd: "/noise/rnnoise_simd.wasm" } as const;
// A one-instruction SIMD module: valid only where SIMD runs. The same probe the package uses.
const SIMD_PROBE = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
/** RNNoise works on 48 kHz audio; the context resamples whatever the microphone gives. */
export const RATE = 48000;

export type NoiseFilter = {
  /** The cleaned microphone: this is the track to send. Muting it mutes you. */
  track: any;
  /** Stops the work while the raw microphone is being sent instead, and picks it up again. */
  pause(): Promise<void>;
  resume(): Promise<void>;
  close(): Promise<void>;
};

/** Which WebAssembly file to load. */
export function wasmFile(simd: boolean): string { return simd ? WASM.simd : WASM.plain; }

/**
 * Builds the filter on a live microphone track. Resolves null when the page can't run it (no
 * AudioWorklet or WebAssembly, blocked by policy, files missing, or the context won't start), so
 * the caller just sends the raw track. `onBroken` fires if the filter stops working later (the
 * context got suspended for good, or the worklet never produced sound): the caller swaps back.
 */
export async function createNoiseFilter(raw: any, onBroken?: () => void): Promise<NoiseFilter | null> {
  const g = globalThis as any;
  if (!filterSupported(g) || !raw || raw.readyState !== "live") return null;
  let ctx: any = null;
  try {
    ctx = new g.AudioContext({ sampleRate: RATE, latencyHint: "interactive" });
    const wasm: ArrayBuffer = await fetch(wasmFile(g.WebAssembly.validate(SIMD_PROBE))).then(r => { if (!r.ok) throw new Error(`wasm ${r.status}`); return r.arrayBuffer(); });
    // Compile once here too: the worklet has no way to tell us its compile was refused (a content
    // security policy without wasm-unsafe-eval), and would pass silence forever.
    await Promise.all([g.WebAssembly.compile(wasm), ctx.audioWorklet.addModule(WORKLET)]);
    const source = ctx.createMediaStreamSource(new g.MediaStream([raw]));
    const node = new g.AudioWorkletNode(ctx, PROCESSOR, {
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: "explicit",
      processorOptions: { maxChannels: 1, wasmBinary: wasm },
    });
    const dest = ctx.createMediaStreamDestination();
    dest.channelCount = 1;
    // Taps on both sides, so a worklet that never produces sound is noticed.
    const tapIn = ctx.createAnalyser(), tapOut = ctx.createAnalyser();
    tapIn.fftSize = 2048; tapOut.fftSize = 2048;
    source.connect(tapIn); source.connect(node); node.connect(tapOut); node.connect(dest);
    await started(ctx);
    const track = dest.stream.getAudioTracks()[0];
    if (!track) throw new Error("no output track");

    let gone = false, paused = false;
    const broke = () => { if (gone) return; gone = true; onBroken?.(); };
    ctx.onstatechange = () => {
      if (gone || paused || ctx.state === "running" || ctx.state === "closed") return;
      // A phone call or a tab switch can suspend it; one try to come back, then give up on it.
      ctx.resume().catch(() => {});
      setTimeout(() => { if (!gone && !paused && ctx.state !== "running" && ctx.state !== "closed") broke(); }, 1500);
    };
    const inBuf = new Float32Array(2048), outBuf = new Float32Array(2048);
    const checks = [2000, 5000, 12000].map(ms => setTimeout(() => {
      if (gone || paused || ctx.state !== "running" || raw.readyState !== "live" || !raw.enabled) return;
      tapIn.getFloatTimeDomainData(inBuf); tapOut.getFloatTimeDomainData(outBuf);
      if (inBuf.some(v => v !== 0) && outBuf.every(v => v === 0)) broke();
    }, ms));

    return {
      track,
      async pause() { paused = true; await ctx.suspend().catch(() => {}); },
      async resume() { paused = false; await started(ctx); },
      async close() {
        gone = true; ctx.onstatechange = null;
        for (const c of checks) clearTimeout(c);
        try { node.port.postMessage("destroy"); } catch { /* already gone */ }
        try { track.stop(); } catch { /* already stopped */ }
        try { source.disconnect(); node.disconnect(); } catch { /* fine */ }
        await ctx.close().catch(() => {});
      },
    };
  } catch {
    await ctx?.close?.().catch(() => {});
    return null;
  }
}

/** Resumes the context and makes sure it really runs (autoplay rules can leave it suspended). */
async function started(ctx: any) {
  await Promise.race([ctx.resume(), new Promise(r => setTimeout(r, 2500))]);
  if (ctx.state !== "running") throw new Error(`audio context ${ctx.state}`);
}
