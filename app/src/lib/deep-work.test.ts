import { test } from "node:test";
import assert from "node:assert/strict";
import { DEEP_WORK_HINT, MISSED_TITLE, deepWorkFromServer, missedDetail, missedLabel, normalizeMissed, type MissedCall } from "./deep-work.ts";

test("the switch is on only when the server says exactly true; an older server says nothing", () => {
  assert.equal(deepWorkFromServer(true), true);
  for (const raw of [false, undefined, null, "true", 1, {}, []]) assert.equal(deepWorkFromServer(raw), false);
});

test("the missed list keeps what is well-formed and drops the rest", () => {
  const call: MissedCall = { id: "meet_1", conversationId: "dm_1", place: "", by: { id: "ben", name: "Ben Okafor" }, startedAt: 1_700_000_000_000, live: false };
  assert.deepEqual(normalizeMissed([call]), [call]);
  // Older or partial answers: no list, or entries missing what the row needs.
  assert.deepEqual(normalizeMissed(undefined), []);
  assert.deepEqual(normalizeMissed({ missed: [call] }), []);
  assert.deepEqual(normalizeMissed([null, {}, { ...call, id: 7 }, { ...call, by: {} }, { ...call, startedAt: "now" }]), []);
  // Optional fields fall back instead of failing: no place is a direct call, an unknown liveness is not live.
  const { place: _place, live: _live, ...bare } = call;
  assert.deepEqual(normalizeMissed([{ ...bare, by: { name: "Ben Okafor" } }]), [{ ...call, by: { id: "", name: "Ben Okafor" } }]);
  assert.deepEqual(normalizeMissed([{ ...call, live: "yes", place: 3 }]), [call]);
});

test("one plain line per missed call, read after deep work ended: a missed call from whom, or a meeting started where", () => {
  const call: MissedCall = { id: "meet_1", conversationId: "dm_1", place: "", by: { id: "ben", name: "Ben Okafor" }, startedAt: 0, live: false };
  assert.equal(missedLabel(call), "Missed call from Ben Okafor");
  // Still going: it never reads as ringing now; the row offers Join instead.
  assert.equal(missedLabel({ ...call, live: true }), "Missed call from Ben Okafor, still going");
  assert.equal(missedLabel({ ...call, place: "#refund-desk" }), "Meeting started in #refund-desk");
  assert.equal(missedLabel({ ...call, place: "#refund-desk", live: true }), "Meeting in #refund-desk, still going");
  // The second line keeps who started a meeting; a missed call already names them.
  assert.equal(missedDetail(call, "3:40 PM"), "3:40 PM");
  assert.equal(missedDetail({ ...call, place: "#refund-desk" }, "3:40 PM"), "Ben Okafor · 3:40 PM");
  assert.equal(MISSED_TITLE, "Missed while in deep work");
  assert.match(DEEP_WORK_HINT, /^Hides channels, direct messages, meetings, the secure inbox and People\./);
});
