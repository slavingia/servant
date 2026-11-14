import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// Archiving or deleting one row must not dim every row: a dimmed row lets the
// Archive and Delete buttons behind it show through the whole list.
test("only the open row dims while an action runs, and closed rows hide their buttons", () => {
  const source = readFileSync(new URL("../components/SwipeChannelRow.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /opacity: busy \? /);
  assert.match(source, /opacity: busy && open \? /);
  assert.match(source, /styles\.actions, \{ width, opacity: actionsOpacity \}/);
});
