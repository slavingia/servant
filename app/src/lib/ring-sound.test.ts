import { test } from "node:test";
import assert from "node:assert/strict";
import { startRingSound } from "./ring-sound.ts";

test("without a DOM (phones) the ring is a silent no-op", () => {
  const stop = startRingSound("incoming");
  assert.equal(typeof stop, "function");
  stop();
});

test("on the Mac app and web it plays two-tone rings until stopped", () => {
  const started: number[] = [];
  let closed = false;
  class FakeCtx {
    currentTime = 0; state = "running"; destination = {};
    createOscillator() { return { frequency: { value: 0 }, connect: (g: any) => g, start: (at: number) => started.push(at), stop() {} }; }
    createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {} }, connect: (d: any) => d }; }
    resume() { return Promise.resolve(); }
    close() { closed = true; return Promise.resolve(); }
  }
  const g = globalThis as any;
  g.window = { AudioContext: FakeCtx }; g.document = {};
  try {
    const stop = startRingSound("incoming");
    assert.equal(started.length, 4, "a double ring of two tones each starts at once");
    stop();
    assert.equal(closed, true);
    startRingSound("outgoing")();
    assert.equal(started.length, 6, "ringback is one two-tone ring");
  } finally { delete g.window; delete g.document; }
});
