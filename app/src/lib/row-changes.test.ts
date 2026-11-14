import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { setRowChange, withRowChanges, type RowChanges } from "./row-changes.ts";

const rows = () => [{ id: "a", title: "general", archived: false }, { id: "b", title: "launch", archived: false }, { id: "c", title: "old", archived: true }];
const none: RowChanges = new Map();

test("with nothing waiting the list is untouched", () => {
  const list = rows();
  assert.equal(withRowChanges(list, none), list);
  assert.equal(withRowChanges(list, setRowChange(none, "zzz", { archived: true })), list, "a change to a row that is not in this list");
});

test("an archived row reads as archived at once, a restored one as active, a deleted one is gone", () => {
  const list = rows();
  const archived = withRowChanges(list, setRowChange(none, "b", { archived: true }));
  assert.deepEqual(archived.map(r => [r.id, r.archived]), [["a", false], ["b", true], ["c", true]]);
  assert.equal(archived[0], list[0], "the other rows are the same rows");
  assert.equal(list[1]!.archived, false, "the list from the server is not changed");
  const restored = withRowChanges(list, setRowChange(none, "c", { archived: false }));
  assert.equal(restored[2]!.archived, false);
  const deleted = withRowChanges(list, setRowChange(none, "a", { deleted: true }));
  assert.deepEqual(deleted.map(r => r.id), ["b", "c"]);
});

test("a copy of the list that arrives before the server has answered keeps the change", () => {
  const waiting = setRowChange(none, "b", { archived: true });
  // A poll answered from before the archive: the row would flicker back without this.
  assert.equal(withRowChanges(rows(), waiting)[1]!.archived, true);
  // Once the server's copy agrees, the row is the server's own.
  const agreed = rows().map(r => r.id === "b" ? { ...r, archived: true } : r);
  assert.equal(withRowChanges(agreed, waiting)[1], agreed[1]);
});

test("a refused change is taken off and the row is where it was", () => {
  const list = rows();
  const waiting = setRowChange(none, "a", { deleted: true });
  assert.equal(withRowChanges(list, waiting).length, 2);
  const after = setRowChange(waiting, "a", null);
  assert.equal(after.size, 0);
  assert.equal(withRowChanges(list, after), list);
  assert.equal(withRowChanges(list, after)[0]!.title, "general");
  // Taking off a change that is not there is nothing.
  assert.equal(setRowChange(after, "a", null), after);
  assert.equal(waiting.size, 1, "the earlier map is not changed");
});

test("several changes wait side by side", () => {
  let waiting = setRowChange(none, "a", { archived: true });
  waiting = setRowChange(waiting, "c", { deleted: true });
  assert.deepEqual(withRowChanges(rows(), waiting).map(r => [r.id, r.archived]), [["a", true], ["b", false]]);
  waiting = setRowChange(waiting, "a", null);
  assert.deepEqual(withRowChanges(rows(), waiting).map(r => [r.id, r.archived]), [["a", false], ["b", false]]);
});

// The lists that use it: the change is shown before the server is asked, and taken off however the request ends.
const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, "..", file), "utf8");
for (const [file, shown] of [["components/SwipeChannelRow.tsx", "change(c.id,"], ["app/(tabs)/agent.tsx", "setChanges(waiting => setRowChange(waiting, chat.id,"]] as const) {
  test(`${file} archives, restores and deletes at once, and puts the row back on a refusal`, () => {
    const source = read(file);
    const start = source.indexOf("const act = async");
    const body = source.slice(start, source.indexOf("\n  };", start));
    const first = body.indexOf(shown), asked = body.search(/await api\.(delete|restore|archive)/);
    assert.ok(first > 0 && first < asked, "the change shows before the server is asked");
    assert.match(body.slice(body.indexOf("catch")), /setActionError\(/, "a refusal says why");
    const end = body.slice(body.indexOf("finally"));
    assert.ok(end.includes(shown.replace(/,$/, ", ").trim()) && /null\)/.test(end), "the waiting change is taken off when the request ends, so a refused row returns");
  });
}
