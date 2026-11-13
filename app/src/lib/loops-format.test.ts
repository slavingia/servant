import { test } from "node:test";
import assert from "node:assert/strict";
import { groupLoops, loopDetail, relativeTime } from "./loops-format.ts";
import type { Loop } from "./server";

const NOW = Date.parse("2026-11-12T12:00:00Z");
const loop = (o: Partial<Loop>): Loop => ({ id: "1", name: "Watch", cadence: "Every hour", group: "hourly", on: true, lastRunAt: null, lastOk: null, nextRunAt: null, ...o });

test("relative times read in plain words", () => {
  assert.equal(relativeTime(NOW + 20_000, NOW), "just now");
  assert.equal(relativeTime(NOW + 60_000, NOW), "in 1 minute");
  assert.equal(relativeTime(NOW - 5 * 60_000, NOW), "5 minutes ago");
  assert.equal(relativeTime(NOW + 3 * 3600_000, NOW), "in 3 hours");
  assert.equal(relativeTime(NOW - 30 * 3600_000, NOW), "30 hours ago");
  assert.equal(relativeTime(NOW + 4 * 86400_000, NOW), "in 4 days");
});

test("the line under a loop says what happened and what is next", () => {
  assert.equal(loopDetail(loop({ lastRunAt: NOW - 600_000, lastOk: true, nextRunAt: NOW + 3000_000 }), NOW), "Last ran 10 minutes ago, next in 50 minutes");
  assert.equal(loopDetail(loop({ lastRunAt: NOW - 600_000, lastOk: false, nextRunAt: NOW + 3000_000 }), NOW), "Last run had a problem 10 minutes ago, next in 50 minutes");
  assert.equal(loopDetail(loop({}), NOW), "Waiting for its first run");
  assert.equal(loopDetail(loop({ on: false, lastRunAt: NOW - 86400_000 }), NOW), "Paused · last ran 24 hours ago");
});

test("loops group by cadence, in order, skipping empty groups", () => {
  const g = groupLoops([loop({ id: "a", group: "daily" }), loop({ id: "b", group: "hourly" }), loop({ id: "c", group: "daily" })]);
  assert.deepEqual(g.map(x => [x.key, x.loops.length]), [["hourly", 1], ["daily", 2]]);
});
