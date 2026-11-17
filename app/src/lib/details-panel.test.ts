import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const details = read("../app/channel-info.tsx");
const channel = read("../app/c/[id].tsx");

// Opening a channel in the wide layout used to draw twice: the Details panel loaded at half the window's
// width, then shrank to 320 points, and every message beside it was wrapped again.
test("the Details panel is its own width while it loads", () => {
  assert.match(details, /if \(!account \|\| !conv\) return <View testID=\{panel \? "details-panel" : undefined\} style=\{\[styles\.root, panel && styles\.panel, styles\.loading\]\}>/);
  assert.match(details, /panel: \{ flex: 0, flexGrow: 0, flexShrink: 0, flexBasis: 320, width: 320,/);
});

test("Details opens with what the channel already knows, then a fresh copy", () => {
  assert.match(details, /const \[conv, setConv\] = useState<Conversation \| null>\(initial \?\? null\);/);
  assert.match(channel, /<ChannelDetails key=\{id\} id=\{id\} panel initial=\{conv\} /, "the panel beside a channel");
  assert.match(details, /keptConversation\(account, id\)\?\.conversation : null\) \?\? peek\(id\) \?\? null/, "the page on a phone");
  assert.match(details, /return <ChannelDetails id=\{id\} initial=\{known\} \/>;/);
  assert.match(details, /setConv\(c\.conversation\);/, "the fresh copy still replaces it");
});

test("the panel is beside a channel from its first frame, before the channel has loaded", () => {
  assert.match(channel, /const sideDetails = wide && detailsOpen && \(conv \? isChannel : id\.startsWith\("ch_"\)\);/);
});
