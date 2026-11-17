// No hairline under the filter tabs at the top of Home, Chats, Agent and People: the selected pill already marks
// where the header ends, and the list starts on white. People never had one; the other three now match it.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const style = (file: string, key: string) => {
  const line = fs.readFileSync(path.join(root, file), "utf8").split("\n").find(l => l.startsWith(`  ${key}: {`));
  assert.ok(line, `${file} has a ${key} style`);
  return line;
};

const HEADERS: [string, string][] = [
  ["components/ChannelList.tsx", "filters"],
  ["app/(tabs)/messages.tsx", "filters"],
  ["app/(tabs)/agent.tsx", "filters"],
  ["app/(tabs)/agent.tsx", "markAll"],
  ["app/(tabs)/members.tsx", "sorts"],
];

test("the tab headers have no divider under them", () => {
  for (const [file, key] of HEADERS) assert.doesNotMatch(style(file, key), /border(Bottom)?Width/, `${file} ${key}`);
});
