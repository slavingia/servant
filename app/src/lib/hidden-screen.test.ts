import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// hidden-screen.ts has a hook, so it is read rather than imported; the rule itself is one line.
const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, "..", file), "utf8");
const source = read("lib/hidden-screen.ts");
const whileHidden = <T,>(focused: boolean, current: T, settled: T): T => focused ? current : settled;

test("a screen in front is handed the current list; a hidden one what it last showed", () => {
  assert.match(source, /export const whileHidden = <T,>\(focused: boolean, current: T, settled: T\): T => focused \? current : settled;/);
  const shown = ["general"], newer = ["general", "launch"];
  assert.equal(whileHidden(true, newer, shown), newer);
  assert.equal(whileHidden(false, newer, shown), shown, "under another screen: no new list, so nothing is drawn");
  // Coming back with nothing changed hands back the very same list: the rows are not drawn again.
  assert.equal(whileHidden(true, shown, shown), shown);
});

test("a hidden list catches up once the changes pause, and remembers what it showed while in front", () => {
  // In front, what is on screen is remembered as it is shown, so going under another screen changes nothing.
  assert.match(source, /if \(focused && settled !== value\) setSettled\(value\);/);
  // Hidden, the current value is handed over only after a pause; every new change starts the wait again.
  assert.match(source, /if \(focused\) return;\n\s+const timer = setTimeout\(\(\) => setSettled\(value\), SETTLE_MS\);\n\s+return \(\) => clearTimeout\(timer\);\n\s+\}, \[focused, value\]\);/);
  const settle = Number(/export const SETTLE_MS = (\d+);/.exec(source)![1]);
  assert.ok(settle >= 500 && settle <= 3000, "long enough to sit out a burst of messages, short enough to be current on the way back");
});

test("the Home and Chats lists are drawn through a memo that only sees the list they are handed", () => {
  for (const [file, rows] of [["components/ChannelList.tsx", "ChannelRows"], ["app/(tabs)/messages.tsx", "MessageRows"]] as const) {
    const screen = read(file);
    assert.match(screen, /const list = useWhileHidden\(useLiveList\(\), useIsFocused\(\)\);/, file);
    assert.match(screen, new RegExp(`const ${rows} = memo\\(function ${rows}\\(`), file);
    assert.match(screen, new RegExp(`return <${rows} [^\\n]*conversations=\\{list\\.conversations\\} error=\\{list\\.error\\} connected=\\{list\\.connected\\} />;`), file);
    // The rows themselves do not follow the live list or the focus: only what they are handed.
    const body = screen.slice(screen.indexOf(`const ${rows} = memo(`));
    assert.doesNotMatch(body, /useLiveList\(\)|useIsFocused\(\)/, file);
  }
  assert.equal(fs.existsSync(path.join(import.meta.dirname, "../components/WhileFocused.tsx")), false);
});
