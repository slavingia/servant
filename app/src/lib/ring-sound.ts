// A ring you can hear in the Mac app and browsers, where there's no phone buzz or call screen.
// "incoming": a quick double ring for a call to you; "outgoing": a slow ringback while you wait.
// Phones return a no-op: they ring through the system and haptics.
export function startRingSound(kind: "incoming" | "outgoing"): () => void {
  // Phones have no DOM; only the Mac app and browsers do.
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};
  const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
  if (!Ctx) return () => {};
  let ctx: AudioContext;
  try { ctx = new Ctx(); } catch { return () => {}; }
  const tone = (at: number, length: number) => {
    for (const freq of [440, 480]) {
      const osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.08, at + 0.03);
      gain.gain.setValueAtTime(0.08, at + length - 0.05);
      gain.gain.linearRampToValueAtTime(0, at + length);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at); osc.stop(at + length);
    }
  };
  const ring = () => {
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    const t = ctx.currentTime + 0.05;
    if (kind === "incoming") { tone(t, 0.4); tone(t + 0.6, 0.4); } else tone(t, 1.6);
  };
  ring();
  const timer = setInterval(ring, kind === "incoming" ? 2500 : 4000);
  return () => { clearInterval(timer); void ctx.close().catch(() => {}); };
}
