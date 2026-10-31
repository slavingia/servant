import assert from "node:assert/strict";
import test from "node:test";
import { keyboardOverlap } from "./keyboard-layout.ts";

const keyboard = { screenX: 0, screenY: 510, width: 390, height: 334 };

test("keeps a composer above the keyboard regardless of chrome or presence height", () => {
  assert.equal(keyboardOverlap({ x: 0, y: 170, width: 390, height: 674 }, keyboard), 334);
  assert.equal(keyboardOverlap({ x: 0, y: 220, width: 390, height: 624 }, keyboard), 334);
});

test("does not double-count keyboard space in a resized Android window", () => {
  assert.equal(keyboardOverlap({ x: 0, y: 170, width: 390, height: 340 }, keyboard), 0);
  assert.equal(keyboardOverlap({ x: 0, y: 170, width: 390, height: 364 }, keyboard), 24);
});

test("tracks keyboard frame changes and restores the full frame when dismissed", () => {
  const view = { x: 0, y: 170, width: 390, height: 674 };
  assert.equal(keyboardOverlap(view, { ...keyboard, screenY: 466, height: 378 }), 378);
  assert.equal(keyboardOverlap(view, { ...keyboard, screenY: 844 }), 0);
  assert.equal(keyboardOverlap(view, null), 0);
});

test("ignores keyboards outside the pane and clamps overlap to the available height", () => {
  const view = { x: 0, y: 170, width: 390, height: 674 };
  assert.equal(keyboardOverlap(view, { ...keyboard, screenX: 400 }), 0);
  assert.equal(keyboardOverlap(view, { ...keyboard, height: 0 }), 0);
  assert.equal(keyboardOverlap(view, { ...keyboard, screenY: 100 }), 674);
});
