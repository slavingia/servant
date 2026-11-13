import { test } from "node:test";
import assert from "node:assert/strict";
import { anyBusy, clockText, durationText, extensionOf, meetingBusy, peopleText, statusLabel } from "./meetings.ts";

test("durations and the timer read like people say them", () => {
  assert.equal(durationText(20_000), "1 min");
  assert.equal(durationText(12 * 60_000), "12 min");
  assert.equal(durationText(65 * 60_000), "1 h 05 min");
  assert.equal(durationText(null), "");
  assert.equal(durationText(0), "");
  assert.equal(clockText(0), "0:00");
  assert.equal(clockText(187_000), "3:07");
  assert.equal(clockText(3_727_000), "1:02:07");
});

test("status lines: live, writing, ready, to-dos, failed", () => {
  assert.equal(statusLabel({ status: "live", openSteps: 0 }), "Live now");
  assert.equal(statusLabel({ status: "recorded", openSteps: 0 }), "Writing notes");
  assert.equal(statusLabel({ status: "processing", openSteps: 0 }), "Writing notes");
  assert.equal(statusLabel({ status: "uploading", openSteps: 0 }), "Sending");
  assert.equal(statusLabel({ status: "done", openSteps: 0 }), "Notes ready");
  assert.equal(statusLabel({ status: "done", openSteps: 3 }), "3 to do");
  assert.equal(statusLabel({ status: "failed", openSteps: 0 }), "Couldn't make notes");
  assert.deepEqual((["live", "recorded", "processing", "uploading", "done", "failed"] as const).map(status => meetingBusy({ status })), [true, true, true, true, false, false]);
  assert.equal(anyBusy([{ status: "done" }, { status: "processing" }]), true);
  assert.equal(anyBusy([{ status: "done" }, { status: "failed" }]), false);
  assert.equal(anyBusy([]), false);
});

test("people lines name you first and count the rest", () => {
  const ann = { id: "ann", name: "Ann" }, bo = { id: "bo", name: "Bo" }, cy = { id: "cy", name: "Cy" }, di = { id: "di", name: "Di" };
  assert.equal(peopleText([], "me"), "");
  assert.equal(peopleText([ann], "ann"), "You");
  assert.equal(peopleText([ann, bo], "bo"), "Ann and You");
  assert.equal(peopleText([ann, bo, cy], "me"), "Ann, Bo and Cy");
  assert.equal(peopleText([ann, bo, cy, di], "me"), "Ann, Bo and 2 others");
});

test("the file extension comes from the uri and falls back to m4a", () => {
  assert.equal(extensionOf("file:///var/mobile/Caches/recording-ABC.m4a"), "m4a");
  assert.equal(extensionOf("file:///data/user/0/app/cache/rec.3gp?x=1"), "3gp");
  assert.equal(extensionOf("content://media/12345"), "m4a");
  assert.equal(extensionOf("file:///tmp/noext", "webm"), "webm");
});
