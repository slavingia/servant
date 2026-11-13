import { test } from "node:test";
import assert from "node:assert/strict";
import { describeCadence, cadenceGroup, shapeLoops } from "./loops.mjs";

test("cron schedules read as plain words", () => {
  const c = expr => describeCadence({ kind: "cron", expr });
  assert.equal(c("0 * * * *"), "Every hour");
  assert.equal(c("*/15 * * * *"), "Every 15 minutes");
  assert.equal(c("0 */3 * * *"), "Every 3 hours");
  assert.equal(c("0 7 * * *"), "Every day at 7am");
  assert.equal(c("30 18 * * *"), "Every day at 6:30pm");
  assert.equal(c("0 0 * * *"), "Every day at 12am");
  assert.equal(c("0 9 * * 1"), "Every Monday at 9am");
  assert.equal(c("0 9 1 * *"), "Monthly on the 1st at 9am");
  assert.equal(c("0 9 22 * *"), "Monthly on the 22nd at 9am");
  assert.equal(c("5 4 1,15 * *"), "On a schedule");
  assert.equal(describeCadence({ kind: "interval", display: "every 30m", expr: "every 30m" }), "Every 30 minutes");
  assert.equal(describeCadence({ expr: "every 2h" }), "Every 2 hours");
  assert.equal(describeCadence({ kind: "once" }), "Once");
  assert.equal(describeCadence(undefined), "On a schedule");
});

test("loops group by how often they run", () => {
  assert.equal(cadenceGroup("Every hour"), "hourly");
  assert.equal(cadenceGroup("Every 15 minutes"), "hourly");
  assert.equal(cadenceGroup("Every day at 7am"), "daily");
  assert.equal(cadenceGroup("Every Monday at 9am"), "weekly");
  assert.equal(cadenceGroup("Monthly on the 1st at 9am"), "monthly");
  assert.equal(cadenceGroup("On a schedule"), "other");
});

test("only name, cadence, status and times leave the server", () => {
  const [loop] = shapeLoops([{
    id: "abc", name: "Daily tester release (7am, diff-gated)", prompt: "SECRET prompt", script: "x.sh", workdir: "/Users/you/app",
    deliver: "telegram:123", model: "m", schedule: { kind: "cron", expr: "0 7 * * *" }, enabled: true, state: "scheduled",
    last_run_at: "2026-11-12T07:00:39-05:00", last_status: "error", next_run_at: "2026-11-13T07:00:00-05:00",
  }]);
  assert.deepEqual(Object.keys(loop).sort(), ["cadence", "group", "id", "lastOk", "lastRunAt", "name", "nextRunAt", "on"]);
  assert.equal(loop.name, "Daily tester release");
  assert.equal(loop.cadence, "Every day at 7am");
  assert.equal(loop.lastOk, false);
  assert.ok(!JSON.stringify(loop).includes("SECRET"));
});

test("paused loops are off and have no next run; on ones sort first; junk is dropped", () => {
  const list = shapeLoops([
    { id: "1", name: "Zed", schedule: { expr: "0 * * * *" }, enabled: false, state: "paused", next_run_at: "2026-11-13T07:00:00Z" },
    { id: "2", name: "Alpha", schedule: { expr: "0 * * * *" }, enabled: true, state: "scheduled", next_run_at: "2026-11-13T07:00:00Z" },
    null, { id: "3" },
  ]);
  assert.deepEqual(list.map(l => [l.name, l.on, l.nextRunAt === null]), [["Alpha", true, false], ["Zed", false, true]]);
  assert.deepEqual(shapeLoops(undefined), []);
});
