import { test } from "node:test";
import assert from "node:assert/strict";
import { dayTitle, feedMeta, groupFeed } from "./feed-format.ts";
import type { FeedItem } from "./server";

const NOW = new Date(2026, 10, 16, 17, 0).getTime();
const item = (o: Partial<FeedItem>): FeedItem => ({ id: "1:0", kind: "sent", text: "Messaged Ann", time: "4:45pm", url: null, at: NOW, ...o });

test("days read in plain words", () => {
  assert.equal(dayTitle(NOW - 3600_000, NOW), "Today");
  assert.equal(dayTitle(NOW - 24 * 3600_000, NOW), "Yesterday");
  assert.equal(dayTitle(new Date(2026, 10, 9, 12).getTime(), NOW), "Monday, November 9");
});

test("items group by day, newest first, keeping order", () => {
  const g = groupFeed([item({ id: "a" }), item({ id: "b", text: "Messaged Bo" }), item({ id: "c", at: NOW - 86400_000 })], NOW);
  assert.deepEqual(g.map(x => [x.title, x.items.map(i => i.id)]), [["Today", ["a", "b"]], ["Yesterday", ["c"]]]);
});

test("the line under an item says when and what kind; a note without a time uses when it was posted", () => {
  const [day] = groupFeed([item({ kind: "shipped" }), item({ id: "n", kind: "note", text: "Hi", time: null, at: new Date(2026, 10, 16, 16, 46).getTime() })], NOW);
  assert.deepEqual(day.items.map(feedMeta), ["4:45pm · Shipped", "4:46pm · Note"]);
});

test("the same run back to back is one row with every time", () => {
  const ran = (id: string, time: string) => item({ id, kind: "ran", text: "Servant DMs: answered messages", time });
  const [day] = groupFeed([ran("a", "4:46pm"), ran("b", "4:45pm"), item({ id: "c" }), ran("d", "4:20pm"), ran("e", "3:42pm"), ran("f", "2:45pm")], NOW);
  assert.deepEqual(day.items.map(feedMeta), ["4:46pm and 4:45pm · Ran", "4:45pm · Sent", "4:20pm, 3:42pm and 2:45pm · Ran"]);
});
