import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { BOX, FAR_SCALE, LOADER_DELAY_MS, LOADER_FADE_MS, serveFrame, serveKeyframes } from "./serve-loop.ts";

const close = (a: number, b: number) => Math.abs(a - b) < 1e-9;

test("the loop ends where it starts, resting on the ground at full size", () => {
  const start = serveFrame(0), end = serveFrame(1);
  for (const key of ["scale", "shadowY", "shadowScale", "shadowOpacity", "scaleX", "scaleY"] as const) assert.ok(close(start[key], end[key]), key);
  // The squash keeps the ball's foot on the ground.
  assert.ok(close(start.y - start.scaleY / 2, -0.5));
  assert.equal(end.rotate % 360, 0);
});

test("it bounces before the serve: up and back down at full size, its shadow paler and smaller up high", () => {
  const top = serveFrame(0.06), ground = serveFrame(0.12 - 0.02);
  assert.equal(top.scale, 1);
  assert.ok(top.y > 0.6, `peak ${top.y}`);
  assert.ok(top.shadowScale < ground.shadowScale && top.shadowOpacity < ground.shadowOpacity);
});

test("served, it gets tiny far away, then comes back full size", () => {
  const far = serveFrame(0.67);
  assert.ok(close(far.scale, FAR_SCALE), `far ${far.scale}`);
  assert.ok(far.shadowY > 1, "the far court is up the screen");
  assert.equal(serveFrame(0.88).scale, 1);
  let smallest = 1;
  for (let t = 0; t <= 1; t += 0.001) smallest = Math.min(smallest, serveFrame(t).scale);
  assert.ok(close(smallest, FAR_SCALE));
});

test("nothing leaves the box it is drawn in", () => {
  for (let t = 0; t <= 1; t += 0.001) {
    const f = serveFrame(t);
    const top = 0.5 + f.y + (f.scale * f.scaleY) / 2;
    assert.ok(top <= BOX.height - 0.15, `t=${t.toFixed(3)} top ${top}`);
    assert.ok(0.5 + f.y - (f.scale * f.scaleY) / 2 >= -1e-9, `t=${t.toFixed(3)} below ground`);
  }
});

test("the keyframes rise in time and sample every squash", () => {
  const k = serveKeyframes();
  assert.equal(k.input[0], 0);
  assert.equal(k.input.at(-1), 1);
  for (let i = 1; i < k.input.length; i++) assert.ok(k.input[i]! > k.input[i - 1]!);
  for (const key of ["y", "scale", "rotate", "shadowOpacity"] as const) assert.equal(k[key].length, k.input.length);
  assert.ok(Math.min(...k.scaleY) < 0.85, "the squash is in the samples");
});

test("loading on a page is the serving ball, not a system spinner", () => {
  // The standalone spinners (a page, a list or a picture loading) are the ball; a spinner inside a button,
  // a check box, a badge or a row's end stays small and system.
  const src = path.join(import.meta.dirname, "..");
  const read = (file: string) => fs.readFileSync(path.join(src, file), "utf8");
  for (const file of ["app/wiki.tsx", "app/thread.tsx", "app/inbox.tsx", "app/pair.tsx", "components/WikiPage.tsx", "components/VideoMedia.tsx"]) {
    assert.match(read(file), /<ServeLoader/, file);
    assert.doesNotMatch(read(file), /ActivityIndicator/, file);
  }
  assert.match(read("components/Button.tsx"), /<ActivityIndicator/);
});

test("it keeps serving: the component restarts each loop itself, and rests round when motion is reduced", () => {
  const loader = fs.readFileSync(path.join(import.meta.dirname, "../components/ServeLoader.tsx"), "utf8");
  // Animated.loop plays once on the web and freezes on the last frame, mid-squash.
  assert.doesNotMatch(loader, /Animated\.loop/);
  assert.match(loader, /if \(finished\) serve\(\)/);
  assert.match(loader, /reduced \? null : ball\b/);
});

test("it waits a moment before it shows, in its place, so a quick load never flashes a ball", () => {
  const loader = fs.readFileSync(path.join(import.meta.dirname, "../components/ServeLoader.tsx"), "utf8");
  assert.ok(LOADER_DELAY_MS >= 200 && LOADER_DELAY_MS <= 400, "long enough to cover a quick answer, short enough that a slow one is not left unexplained");
  assert.ok(LOADER_FADE_MS > 0 && LOADER_FADE_MS <= 250);
  assert.match(loader, /new Animated\.Value\(0\)/, "starts not drawn");
  assert.match(loader, /Animated\.timing\(shown, \{ toValue: 1, duration: LOADER_FADE_MS, delay: LOADER_DELAY_MS,/);
  // Its box is laid out from the first frame, so nothing moves when it appears, and the role is on the outer
  // view, so a screen reader hears "Loading" without waiting.
  assert.match(loader, /<Animated\.View style=\{\[box, \{ opacity: shown \}\]\} \{\.\.\.hidden\}>/);
  assert.match(loader, /accessibilityRole="progressbar"\n\s+accessibilityLabel=\{accessibilityLabel\}/);
});

test("loading rows wait the same moment; the launch shapes do not", () => {
  const skeleton = fs.readFileSync(path.join(import.meta.dirname, "../components/Skeleton.tsx"), "utf8");
  const rows = skeleton.slice(skeleton.indexOf("export function SkeletonRows"));
  assert.match(rows, /Animated\.timing\(shown, \{ toValue: 1, duration: LOADER_FADE_MS, delay: LOADER_DELAY_MS,/);
  assert.match(rows, /accessibilityRole="progressbar" accessibilityLabel=\{label\}[^\n]*\n\s+<Animated\.View style=\{\{ opacity: shown \}\}>/, "in their place and named from the first frame");
  // Home's loading rows and the launch screen take over from a still frame of the same shapes (launch-skeleton.json).
  const pulse = skeleton.slice(skeleton.indexOf("export function Pulse"), skeleton.indexOf("// Rows for a list that is loading"));
  assert.doesNotMatch(pulse, /LOADER_DELAY_MS/);
  assert.match(skeleton, /new Animated\.Value\(1\)/, "the pulse starts at full strength");
});
