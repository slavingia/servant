import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

// #82: once the box held an @mention, the blue copy drawn over it took every click on the web, so a click back
// into the box did not focus it and typing went nowhere. The copy must let pointer events through to the box.
// Browser check: scripts/mention-typing-e2e.mjs.
const source = readFileSync(path.join(import.meta.dirname, "../components/Messaging.tsx"), "utf8");

test("the mention highlight over the composer lets clicks through to the box", () => {
  const style = source.match(/inputMirror:\s*\{([^}]*)\}/)?.[1];
  assert.ok(style, "inputMirror style exists");
  assert.match(style, /position:\s*"absolute"/, "the copy is laid over the box");
  assert.match(style, /pointerEvents:\s*"none"/, "so it must not take pointer events");
});

// The same report said "no caret", and that stayed true after the clicks were let through: the copy has the box's
// background, and a browser draws a positioned copy over a box that is not positioned. The caret blinked behind it
// and selected text showed no highlight. Positioned too, and later in the markup, the box is drawn on top.
test("the box is drawn over its colored copy, so the caret and selected text show", () => {
  const box = source.match(/inputOverlay:\s*\{([^}]*)\}/)?.[1];
  assert.ok(box, "inputOverlay style exists");
  assert.match(box, /position:\s*"relative"/, "the see-through box is positioned, like the copy");
  assert.match(box, /caretColor:\s*colors\.ink/, "and keeps a caret that can be seen");
  const copyAt = source.indexOf("styles.inputMirror]");
  const boxAt = source.indexOf("highlight && styles.inputOverlay");
  assert.ok(copyAt > 0 && boxAt > copyAt, "the copy comes first in the markup, so the box is the one on top");
});
