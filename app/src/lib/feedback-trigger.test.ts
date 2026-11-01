import { test } from "node:test";
import assert from "node:assert/strict";
import { createShakeDetector, feedbackGestureHint, feedbackPromptAllowed, supportsScreenshotFeedback, SHAKE } from "./feedback-trigger.ts";

const still = (t: number) => ({ x: 0, y: 0, z: 1, t });
const jolt = (t: number, g = 2.6) => ({ x: g, y: 0, z: 1, t });
const swing = (push: ReturnType<typeof createShakeDetector>, t: number) => {
  assert.equal(push(still(t - 50)), false);
  return push(jolt(t));
};

test("three strong swings within a second count as a shake", () => {
  const push = createShakeDetector();
  assert.equal(swing(push, 0), false);
  assert.equal(swing(push, 200), false);
  assert.equal(swing(push, 400), true);
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
  assert.equal(swing(push, 0), false);
  assert.equal(swing(push, 700), false);
  assert.equal(swing(push, 1500), false);
});

test("one long jolt sampled many times is still one peak", () => {
  const push = createShakeDetector();
  // Longer than both the peak window and cooldown; the old detector fired
  // at 300ms because it counted every third sample as another peak.
  for (let t = 0; t <= 5000; t += 50) assert.equal(push(jolt(t)), false);
});

test("a peak rejected by the gap cannot become a new peak just by staying high", () => {
  const push = createShakeDetector();
  assert.equal(swing(push, 0), false);
  assert.equal(swing(push, 100), false);
  assert.equal(push(jolt(200)), false);
  assert.equal(swing(push, 300), false);
  assert.equal(swing(push, 500), true);
});

test("after a shake, a cooldown stops it re-opening immediately", () => {
  const push = createShakeDetector();
  swing(push, 0); swing(push, 200); assert.equal(swing(push, 400), true);
  for (const t of [600, 800, 1000]) assert.equal(swing(push, t), false);
  const later = 400 + SHAKE.cooldown + 10;
  assert.equal(swing(push, later), false);
  assert.equal(swing(push, later + 200), false);
  assert.equal(swing(push, later + 400), true);
});

test("holding the final swing through cooldown requires three fresh swings", () => {
  const push = createShakeDetector();
  swing(push, 0); swing(push, 200); assert.equal(swing(push, 400), true);
  for (let t = 450; t <= 5000; t += 50) assert.equal(push(jolt(t)), false);
  assert.equal(swing(push, 5200), false);
  assert.equal(swing(push, 5400), false);
  assert.equal(swing(push, 5600), true);
});

test("screenshot feedback only uses permission-free native platforms", () => {
  assert.equal(supportsScreenshotFeedback("ios", "18.0"), true);
  for (const version of [24, 32, 33]) assert.equal(supportsScreenshotFeedback("android", version), false);
  for (const version of [34, 36, "34"]) assert.equal(supportsScreenshotFeedback("android", version), true);
  assert.equal(supportsScreenshotFeedback("android", "unknown"), false);
  assert.equal(supportsScreenshotFeedback("web", 99), false);
});

test("gesture hints match screenshot support and avoid advertising phone gestures on web", () => {
  assert.match(feedbackGestureHint("ios", "18.0"), /screenshot/);
  assert.match(feedbackGestureHint("android", 34), /screenshot/);
  assert.match(feedbackGestureHint("android", 33), /shake/);
  assert.doesNotMatch(feedbackGestureHint("android", 33), /screenshot/);
  assert.equal(feedbackGestureHint("web", 99), "");
});

test("prompt only where it makes sense", () => {
  assert.equal(feedbackPromptAllowed("/channels", true), true);
  assert.equal(feedbackPromptAllowed("/c/ch_1", true), true);
  assert.equal(feedbackPromptAllowed("/feedback", true), false);
  assert.equal(feedbackPromptAllowed("/welcome", false), false);
  assert.equal(feedbackPromptAllowed("/channels", false), false);
});
