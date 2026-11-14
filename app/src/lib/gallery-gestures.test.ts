import assert from "node:assert/strict";
import test from "node:test";
import { canStartGalleryDismiss, isZoomedIn, shouldDismissGallery } from "./gallery-gestures.ts";

test("gallery dismissal leaves taps, carousel swipes and multi-touch gestures alone", () => {
  assert.equal(canStartGalleryDismiss({ dx: 0, dy: 8, numberActiveTouches: 1 }), false);
  assert.equal(canStartGalleryDismiss({ dx: -90, dy: 30, numberActiveTouches: 1 }), false);
  assert.equal(canStartGalleryDismiss({ dx: 45, dy: 50, numberActiveTouches: 1 }), false);
  assert.equal(canStartGalleryDismiss({ dx: 40, dy: 90, numberActiveTouches: 1 }), false);
  assert.equal(canStartGalleryDismiss({ dx: 2, dy: 90, numberActiveTouches: 2 }), false);
  assert.equal(canStartGalleryDismiss({ dx: 2, dy: -90, numberActiveTouches: 1 }), false);
  assert.equal(canStartGalleryDismiss({ dx: 4, dy: 24, numberActiveTouches: 1 }), true);
});

test("a deliberate downward pull or flick closes on compact and tall screens", () => {
  assert.equal(shouldDismissGallery({ dx: 4, dy: 80, vy: 0.1 }, 300), true);
  assert.equal(shouldDismissGallery({ dx: 4, dy: 130, vy: 0.1 }, 1000), true);
  assert.equal(shouldDismissGallery({ dx: 3, dy: 40, vy: 0.9 }, 700), true);
});

test("short, reversed, or horizontally redirected drags return to the preview", () => {
  assert.equal(shouldDismissGallery({ dx: 2, dy: 35, vy: 2 }, 700), false);
  assert.equal(shouldDismissGallery({ dx: 2, dy: 70, vy: 0.1 }, 700), false);
  assert.equal(shouldDismissGallery({ dx: 2, dy: -40, vy: -1 }, 700), false);
  assert.equal(shouldDismissGallery({ dx: 140, dy: 150, vy: 0.8 }, 700), false);
});

test("pinch zoom is on by default and only a real zoom locks swiping", () => {
  assert.equal(isZoomedIn(undefined), false);
  assert.equal(isZoomedIn(1), false);
  assert.equal(isZoomedIn(1.005), false);
  assert.equal(isZoomedIn(1.5), true);
  assert.equal(isZoomedIn(4), true);
});

test("the image viewer is zoomable without pressing a Zoom button first", async () => {
  const { readFileSync } = await import("node:fs");
  const source = readFileSync(new URL("../components/MediaGallery.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /"Zoom image"|\? "Fit" : "Zoom"/);
  assert.match(source, /maximumZoomScale=\{4\}/);
  assert.doesNotMatch(source, /\{zoomMode \? <ScrollView/);
});
