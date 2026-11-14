// The live connection hands out four things that change at different times: what a screen can ask it to do
// (never changes), the conversation list, presence and the unread badges. One hook for all four made every
// screen that touched the connection re-render on every list refresh: an open conversation drew all of its
// messages again each time a message arrived anywhere, though it only listens. Each screen now reads the part
// it uses, and the provider keeps values that did not change.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const files = fs.readdirSync(root, { recursive: true, encoding: "utf8" }).filter(file => /\.tsx?$/.test(file) && !/\.test\.ts$/.test(file)).map(file => file.split(path.sep).join("/"));

test("no screen reads the whole live connection through one hook", () => {
  const all = files.filter(file => /\buseLive\s*\(/.test(read(file)));
  assert.deepEqual(all, [], "use useLiveActions, useLiveList, useLivePresence or useLiveUnread");
  assert.doesNotMatch(read("lib/live.tsx"), /export (function|const) useLive\b/);
});

test("screens that only listen or refresh take the part that never re-renders them", () => {
  // An open conversation, a thread, an agent chat and the typing line draw long lists.
  for (const file of ["app/c/[id].tsx", "app/thread.tsx", "app/chat/[id].tsx", "lib/typing.tsx"]) {
    const source = read(file);
    assert.match(source, /useLiveActions\(\)/, file);
    assert.doesNotMatch(source, /useLiveList\(\)|useLiveUnread\(\)/, file);
  }
});

test("the provider gives each part its own context and keeps what a refresh did not change", () => {
  const source = read("lib/live.tsx");
  for (const context of ["ActionsCtx", "ListCtx", "PresenceCtx", "UnreadCtx"]) assert.match(source, new RegExp(`<${context}\\.Provider value=`), context);
  // A refetched list, a presence snapshot and a polled count that say the same thing set nothing.
  assert.match(source, /setConversations\(current => reuseEqual\(current, /);
  assert.equal(source.match(/setPresenceState\(current => (current\.identity !== identity \? current : )?reuseEqual\(current, /g)?.length, 3);
  assert.doesNotMatch(source, /setAgentUnread\(\{/);
  assert.doesNotMatch(source, /setPresenceState\(\{/);
});
