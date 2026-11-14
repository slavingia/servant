import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { SETTLE_MS, skipWhileHidden } from "./hidden-screen.ts";

test("a hidden list skips drawing until the changes have paused; a list in front always draws", () => {
  // Under another screen, with changes still arriving: nothing is drawn.
  assert.equal(skipWhileHidden({ focused: false, settled: 3 }, { focused: false, settled: 3 }), true);
  assert.equal(skipWhileHidden({ focused: true, settled: 3 }, { focused: false, settled: 3 }), true, "going under another screen draws nothing either");
  // The changes paused: it catches up once, so it is current before anyone goes back to it.
  assert.equal(skipWhileHidden({ focused: false, settled: 3 }, { focused: false, settled: 4 }), false);
  // In front, including the moment it comes back: every change is drawn.
  assert.equal(skipWhileHidden({ focused: false, settled: 4 }, { focused: true, settled: 4 }), false);
  assert.equal(skipWhileHidden({ focused: true, settled: 4 }, { focused: true, settled: 4 }), false);
  assert.ok(SETTLE_MS >= 500 && SETTLE_MS <= 3000, "long enough to sit out a burst of messages, short enough to be current on the way back");
});

test("the Home and Chats lists draw every change only while they are in front", () => {
  const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, "..", file), "utf8");
  const gate = read("components/WhileFocused.tsx");
  assert.match(gate, /memo\(function WhileFocused\([^)]*\) \{\n\s+return children;\n\}, skipWhileHidden\);/);
  // The cue to catch up waits for a pause, and only while hidden.
  assert.match(gate, /if \(focused\) return;\n\s+const timer = setTimeout\(\(\) => setSettled\(count => count \+ 1\), SETTLE_MS\);/);
  for (const file of ["components/ChannelList.tsx", "app/(tabs)/messages.tsx"]) {
    const source = read(file);
    assert.match(source, /const focused = useIsFocused\(\);/, file);
    assert.match(source, /const settled = useSettled\(focused, conversations\);/, file);
    const from = source.indexOf("<WhileFocused focused={focused} settled={settled}>"), to = source.indexOf("</WhileFocused>");
    assert.ok(from > 0 && to > from, `${file}: the list is inside WhileFocused`);
    assert.match(source.slice(from, to), /<FlatList /, file);
  }
});
