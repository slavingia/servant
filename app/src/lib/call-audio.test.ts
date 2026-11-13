import { test } from "node:test";
import assert from "node:assert/strict";
import { carryMute, filterSupported, micConstraints, noiseMode, otherDevice, speakerLikely } from "./call-audio.ts";

test("the switch runs the page filter on the web, the phone's suppressor on Android, nothing on iPhone", () => {
  assert.equal(noiseMode("web"), "filter");
  assert.equal(noiseMode("android"), "native");
  assert.equal(noiseMode("ios"), "none");
  assert.equal(noiseMode("macos"), "none");
});

test("web constraints keep the browser's echo cancellation and suppression on whatever the switch says", () => {
  for (const on of [true, false]) {
    const c = micConstraints("web", on);
    assert.equal(c.echoCancellation, true);
    assert.equal(c.noiseSuppression, true);
    assert.equal(c.autoGainControl, true);
  }
});

test("Android constraints set the suppressor under both names and never touch echo cancellation", () => {
  const on = micConstraints("android", true), off = micConstraints("android", false);
  assert.equal(on.noiseSuppression, true); assert.equal(on.googNoiseSuppression, true);
  assert.equal(off.noiseSuppression, false); assert.equal(off.googNoiseSuppression, false);
  for (const c of [on, off]) { assert.equal(c.echoCancellation, true); assert.equal(c.googEchoCancellation, true); assert.equal(c.autoGainControl, true); }
  assert.deepEqual(micConstraints("ios", false), off);
});

test("the filter needs AudioWorklet, WebAssembly and a stream destination in a secure page", () => {
  const full = { AudioContext() {}, AudioWorkletNode() {}, MediaStreamAudioDestinationNode() {}, WebAssembly: { instantiate() {} }, isSecureContext: true };
  assert.equal(filterSupported(full), true);
  assert.equal(filterSupported({ ...full, AudioWorkletNode: undefined }), false);
  assert.equal(filterSupported({ ...full, WebAssembly: undefined }), false);
  assert.equal(filterSupported({ ...full, MediaStreamAudioDestinationNode: undefined }), false);
  assert.equal(filterSupported({ ...full, isSecureContext: false }), false);
  assert.equal(filterSupported({}), false);
  // A page that doesn't say (older browsers) is not refused for that alone.
  assert.equal(filterSupported({ ...full, isSecureContext: undefined }), true);
});

test("a swapped-in track keeps the mute state, and the raw track behind the filter is left live", () => {
  const raw = { enabled: false }, processed = { enabled: true };
  carryMute(raw, processed, raw);
  assert.equal(processed.enabled, false, "muted stays muted");
  assert.equal(raw.enabled, true, "the raw track feeds the filter, so it must not stay muted");
  carryMute(processed, raw, raw);
  assert.equal(raw.enabled, false, "back to the raw track: still muted");
  carryMute(undefined, processed);
  assert.equal(processed.enabled, true);
});

test("no other device of yours: no note, no automatic mute", () => {
  const list = [{ id: "a", you: true, joinedAt: 10 }, { id: "b", you: false, joinedAt: 5 }];
  assert.deepEqual(otherDevice(list, "a"), { present: false, startMuted: false });
  assert.deepEqual(otherDevice([{ id: "b", you: false }], null), { present: false, startMuted: false });
});

test("before joining, another device of yours already on the call makes this one start muted", () => {
  assert.deepEqual(otherDevice([{ id: "mac", you: true, joinedAt: 10 }], null), { present: true, startMuted: true });
});

test("after joining, only the device that joined later starts muted; the earlier one just sees the note", () => {
  const list = [{ id: "mac", you: true, joinedAt: 10 }, { id: "phone", you: true, joinedAt: 20 }, { id: "ben", you: false, joinedAt: 1 }];
  assert.deepEqual(otherDevice(list, "mac"), { present: true, startMuted: false });
  assert.deepEqual(otherDevice(list, "phone"), { present: true, startMuted: true });
});

test("your own screen share is not another device", () => {
  const list = [{ id: "me", you: true, joinedAt: 10 }, { id: "me-screen", you: true, joinedAt: 12, screen: true }];
  assert.deepEqual(otherDevice(list, "me"), { present: false, startMuted: false });
});

test("a tie on join time is broken the same way on both devices", () => {
  const list = [{ id: "a", you: true, joinedAt: 10 }, { id: "b", you: true, joinedAt: 10 }];
  const a = otherDevice(list, "a"), b = otherDevice(list, "b");
  assert.equal(a.startMuted !== b.startMuted, true, "exactly one of them starts muted");
});

test("the headphones tip shows for built-in speakers, not for headsets, and never without a label", () => {
  assert.equal(speakerLikely([{ deviceId: "default", label: "Default - MacBook Pro Speakers (Built-in)" }]), true);
  assert.equal(speakerLikely([{ deviceId: "default", label: "Default - AirPods Pro" }, { deviceId: "x", label: "MacBook Pro Speakers" }]), false);
  assert.equal(speakerLikely([{ deviceId: "x", label: "USB Audio Device" }]), false);
  assert.equal(speakerLikely([{ deviceId: "default", label: "" }]), false);
  assert.equal(speakerLikely([]), false);
  assert.equal(speakerLikely([{ deviceId: "default", label: "Default - Jabra Evolve 65" }]), false);
});
