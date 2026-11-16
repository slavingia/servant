import assert from "node:assert/strict";
import { test } from "node:test";
import { clampZoom, doubleTapZoom, FIT, MAX_ZOOM, panZoom, pinchZoom } from "./zoom-gesture.ts";

test("pinching apart zooms in, together zooms back, and the scale stays between fit and 4x", () => {
  const from = { mid: { x: 0, y: 0 }, gap: 100 };
  assert.equal(pinchZoom(FIT, from, { mid: { x: 0, y: 0 }, gap: 200 }, 400, 600).scale, 2);
  assert.equal(pinchZoom(FIT, from, { mid: { x: 0, y: 0 }, gap: 5000 }, 400, 600).scale, MAX_ZOOM);
  assert.deepEqual(pinchZoom({ scale: 2, x: 0, y: 0 }, from, { mid: { x: 0, y: 0 }, gap: 10 }, 400, 600), FIT);
});

test("the spot under the fingers stays under the fingers", () => {
  // Fingers centred 100 right of the frame's centre: zooming 2x moves the picture 100 left.
  const zoom = pinchZoom(FIT, { mid: { x: 100, y: 0 }, gap: 50 }, { mid: { x: 100, y: 0 }, gap: 100 }, 400, 600);
  assert.deepEqual(zoom, { scale: 2, x: -100, y: 0 });
});

test("a picture cannot slide out of its frame, and cannot be moved at fit", () => {
  assert.deepEqual(clampZoom({ scale: 2, x: 999, y: -999 }, 400, 600), { scale: 2, x: 200, y: -300 });
  assert.deepEqual(panZoom(FIT, 50, 50, 400, 600), FIT);
  assert.deepEqual(panZoom({ scale: 2, x: 0, y: 0 }, -30, 10, 400, 600), { scale: 2, x: -30, y: 10 });
});

test("double tap zooms in where tapped, then back to fit", () => {
  const zoomed = doubleTapZoom(FIT, { x: 50, y: 0 }, 400, 600);
  assert.equal(zoomed.scale, 2.5);
  assert.equal(zoomed.x, -75);
  assert.deepEqual(doubleTapZoom(zoomed, { x: 0, y: 0 }, 400, 600), FIT);
});
