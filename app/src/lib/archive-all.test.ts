import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { allLabel, forEachRow, rowsToMove } from "./archive-all.ts";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("a hold moves only the rows not already there", () => {
  const rows = [{ id: "a" }, { id: "b", archived: true }, { id: "c", archived: false }];
  assert.deepEqual(rowsToMove(rows, true).map(r => r.id), ["a", "c"]);
  assert.deepEqual(rowsToMove(rows, false).map(r => r.id), ["b"]);
  assert.equal(allLabel(false), "Archive all");
  assert.equal(allLabel(true), "Restore all");
});

test("every row is asked for, a few at a time, and the refused ones come back in order", async () => {
  let running = 0, most = 0;
  const seen: number[] = [];
  const failed = await forEachRow([1, 2, 3, 4, 5, 6, 7, 8, 9], async n => {
    running++; most = Math.max(most, running);
    await new Promise(r => setTimeout(r, 2));
    seen.push(n); running--;
    if (n % 3 === 0) throw new Error("no");
  }, 4);
  assert.deepEqual(seen.sort(), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.ok(most <= 4);
  assert.deepEqual(failed, [3, 6, 9]);
  assert.deepEqual(await forEachRow([], async () => {}), []);
});

test("holding Archive archives the whole list in channels, chats and the Agent tab", () => {
  const row = read("../components/SwipeChannelRow.tsx");
  assert.match(row, /onLongPress=\{onArchiveAll/);
  assert.match(row, /onArchiveAll: group/);
  const home = read("../components/ChannelList.tsx"), dms = read("../app/(tabs)/messages.tsx"), agent = read("../app/(tabs)/agent.tsx");
  assert.match(home, /rowProps\(c, shownChannels\)/);
  assert.match(dms, /rowProps\(item, list\)/);
  assert.match(agent, /onArchiveAll=\{/);
});
