// The wide layout's sidebar: rows scrolled past an end of the list go under a line drawn at that end. Without one,
// the top row was cut off in mid-air under the search field, and the bottom row above the Deep work switch.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { listEdges, NO_EDGES, sameEdges } from "./list-edges.ts";

test("a list at its start has rows below it only", () => {
  assert.deepEqual(listEdges(0, 342, 1206), { above: false, below: true });
});

test("a list scrolled part of the way has rows past both ends", () => {
  assert.deepEqual(listEdges(140, 342, 1206), { above: true, below: true });
});

test("a list at its end has rows above it only", () => {
  assert.deepEqual(listEdges(864, 342, 1206), { above: true, below: false });
});

test("a list that fits has no rows past either end", () => {
  assert.deepEqual(listEdges(0, 684, 420), NO_EDGES);
  assert.deepEqual(listEdges(0, 684, 684), NO_EDGES);
});

test("a fraction of a point is not a row: zoomed browsers lay lists out between whole points", () => {
  assert.deepEqual(listEdges(0.4, 342.5, 1206), { above: false, below: true });
  assert.deepEqual(listEdges(863.6, 342, 1206), { above: true, below: false });
});

test("a list that has not been measured yet draws no line", () => {
  assert.deepEqual(listEdges(0, 0, 1206), NO_EDGES);
  assert.deepEqual(listEdges(0, 342, 0), NO_EDGES);
});

test("edges are compared by what they say, so scrolling within the list changes nothing", () => {
  assert.equal(sameEdges(listEdges(10, 342, 1206), listEdges(500, 342, 1206)), true);
  assert.equal(sameEdges(listEdges(0, 342, 1206), listEdges(500, 342, 1206)), false);
});

test("the sidebar measures its list and draws the lines around it", () => {
  const sidebar = fs.readFileSync(path.join(import.meta.dirname, "../components/Sidebar.tsx"), "utf8");
  // The list reports how far it is scrolled, how much of it shows and how long it is.
  assert.match(sidebar, /onScroll=\{event => measured\(\{ offset: event\.nativeEvent\.contentOffset\.y \}\)\}/);
  assert.match(sidebar, /onLayout=\{event => measured\(\{ viewport: event\.nativeEvent\.layout\.height \}\)\}/);
  assert.match(sidebar, /onContentSizeChange=\{\(_width, height\) => measured\(\{ content: height \}\)\}/);
  assert.match(sidebar, /scrollEventThrottle=\{16\}/, "a browser reports scrolling as it happens only when asked to");
  // The frame around it takes a line's color at an end with rows past it.
  assert.match(sidebar, /<View style=\{\[styles\.list, edges\.above && styles\.rowsAbove, edges\.below && styles\.rowsBelow\]\}>\s*<ScrollView/);
  const frame = sidebar.match(/\n  list:\s*\{([^}]*)\}/)?.[1];
  assert.ok(frame, "the frame's style is found");
  assert.match(frame, /borderTopWidth: StyleSheet\.hairlineWidth, borderBottomWidth: StyleSheet\.hairlineWidth, borderColor: "transparent"/, "both lines are always there, so the list never moves when one shows");
  assert.match(sidebar, /rowsAbove: \{ borderTopColor: onBrandTint\.\w+ \}/);
  assert.match(sidebar, /rowsBelow: \{ borderBottomColor: onBrandTint\.\w+ \}/);
  // The state is set only when an end gains or loses rows: scrolling within the list draws nothing again.
  assert.match(sidebar, /if \(sameEdges\(list\.edges, now\)\) return;\s*list\.edges = now;\s*setEdges\(now\);/);
});
