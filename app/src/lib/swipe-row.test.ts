import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { SETTLE_MS, swipePosition, swipeReveals } from "./swipe-row.ts";

const source = readFileSync(new URL("../components/SwipeChannelRow.tsx", import.meta.url), "utf8");

// Archiving or deleting one row must not dim every row: a dimmed row lets the
// Archive and Delete buttons behind it show through the whole list.
test("only the open row dims while an action runs, and closed rows hide their buttons", () => {
  assert.doesNotMatch(source, /opacity: busy \? /);
  assert.match(source, /opacity: busy && open \? /);
  assert.match(source, /styles\.actions, \{ width \}, actionsOpacity\]/);
  assert.match(source, /opacity: interpolate\(x\.get\(\), \[-1, 0\], \[1, 0\], "clamp"\)/, "invisible until the row has moved");
});

test("a dragged row stays between closed and fully open", () => {
  assert.equal(swipePosition(0, -40, 96), -40);
  assert.equal(swipePosition(0, 40, 96), 0, "never right of closed");
  assert.equal(swipePosition(0, -400, 96), -96, "never left of fully open");
  assert.equal(swipePosition(-96, 30, 96), -66, "an open row is dragged from where it is");
  assert.equal(swipePosition(-184, -10, 184), -184);
});

test("let go: a flick decides, otherwise a third of the way", () => {
  assert.equal(swipeReveals(-10, -401, 96), true, "a flick left opens it from anywhere");
  assert.equal(swipeReveals(-90, 401, 96), false, "a flick right closes it from anywhere");
  assert.equal(swipeReveals(-33, 0, 96), true);
  assert.equal(swipeReveals(-32, 0, 96), false);
  assert.equal(swipeReveals(-62, 0, 184), true);
  assert.equal(swipeReveals(-61, 0, 184), false);
  assert.equal(swipeReveals(-40, 400, 96), true, "a slow drift right is not a flick");
  assert.equal(SETTLE_MS, 180);
});

test("the drag is handled off the app's script, and only sideways", () => {
  assert.match(source, /from "react-native-gesture-handler";/);
  assert.match(source, /from "react-native-reanimated";/);
  assert.doesNotMatch(source, /PanResponder/);
  assert.match(source, /enabled: !busy && !locked,/);
  assert.match(source, /activeOffsetX: \[-12, 12\],\n\s+failOffsetY: \[-12, 12\],/);
  assert.match(source, /const reveal = !e\.canceled && swipeReveals\(from\.get\(\) \+ e\.translationX, e\.velocityX, width\);/, "a drag taken away by something else closes the row");
  assert.match(source, /runOnJS\(settled\)\(reveal\);/);
  assert.match(readFileSync(new URL("../app/_layout.tsx", import.meta.url), "utf8"), /<GestureHandlerRootView style=\{styles\.gestures\}>/);
});
