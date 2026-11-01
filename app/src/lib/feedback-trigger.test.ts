import { test } from "node:test";
import assert from "node:assert/strict";
import { createShakeDetector, feedbackPromptAllowed, SHAKE } from "./feedback-trigger.ts";

const still = (t: number) => ({ x: 0, y: 0, z: 1, t });
const jolt = (t: number, g = 2.6) => ({ x: g, y: 0, z: 1, t });

test("three strong swings within a second count as a shake", () => {
  const push = createShakeDetector();
  assert.equal(push(jolt(0)), false);
  assert.equal(push(jolt(200)), false);
  assert.equal(push(jolt(400)), true);
});

test("holding the phone still, or normal handling, never fires", () => {
  const push = createShakeDetector();
  for (let t = 0; t < 5000; t += 16) assert.equal(push(still(t)), false);
  // A single bump (dropping it on a table) is one peak, not a shake.
  assert.equal(push(jolt(6000, 3.5)), false);
  for (let t = 6016; t < 8000; t += 16) assert.equal(push(still(t)), false);
});

test("swings spread over more than a second don't add up", () => {
  const push = createShakeDetector();
  assert.equal(push(jolt(0)), false);
  assert.equal(push(jolt(700)), false);
  assert.equal(push(jolt(1500)), false);
});

test("one long jolt sampled many times is still one peak", () => {
  const push = createShakeDetector();
  for (let t = 0; t < 100; t += 16) assert.equal(push(jolt(t)), false);
});

test("after a shake, a cooldown stops it re-opening immediately", () => {
  const push = createShakeDetector();
  push(jolt(0)); push(jolt(200)); assert.equal(push(jolt(400)), true);
  assert.equal(push(jolt(600)) || push(jolt(800)) || push(jolt(1000)), false);
  const later = 400 + SHAKE.cooldown + 10;
  push(jolt(later)); push(jolt(later + 200));
  assert.equal(push(jolt(later + 400)), true);
});

test("prompt only where it makes sense", () => {
  assert.equal(feedbackPromptAllowed("/channels", true), true);
  assert.equal(feedbackPromptAllowed("/c/ch_1", true), true);
  assert.equal(feedbackPromptAllowed("/feedback", true), false);
  assert.equal(feedbackPromptAllowed("/welcome", false), false);
  assert.equal(feedbackPromptAllowed("/channels", false), false);
});
