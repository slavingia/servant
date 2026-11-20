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
