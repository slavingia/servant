import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

// "Reconnecting…" means a connection that was up has dropped. Before the first list has arrived the app is
// still opening: saying "Reconnecting…" then flashed it under the name in the sidebar on every launch.
test("nothing says Reconnecting while the app is still opening", () => {
  const sidebar = read("../components/Sidebar.tsx");
  assert.match(sidebar, /const here = connected \|\| \(conversations === null && !error && !sessionExpired\);/);
  assert.match(sidebar, /\{here \? deepWork \? "Deep work" : account\.user\.role === "owner" \? "Owner" : "Member" : sessionExpired \? "Session ended" : "Reconnecting…"\}/);
  assert.match(sidebar, /<PresenceDot status=\{!here \? "off" : deepWork \? "deepWork" : "online"\}/);
  assert.doesNotMatch(sidebar, /\{connected \? deepWork \?/);
  for (const file of ["../components/ChannelList.tsx", "../app/(tabs)/messages.tsx", "../app/(tabs)/members.tsx"]) {
    const source = read(file);
    assert.match(source, /const reconnecting = !connected && \w+ !== null/, file);
  }
});
