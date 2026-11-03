import { test } from "node:test";
import assert from "node:assert/strict";
import { shortTime } from "./time-label.ts";

const time = (d: Date) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const day = (d: Date) => d.toLocaleDateString([], { month: "short", day: "numeric" });

test("last night stays a time just after midnight", () => {
  const now = new Date(2026, 10, 3, 0, 20);
  const sent = new Date(2026, 10, 2, 23, 40);
  assert.equal(shortTime(sent.getTime(), now.getTime()), time(sent));
});

test("anything under 24 hours old shows the time", () => {
  const now = new Date(2026, 10, 3, 9, 0);
  const sent = new Date(2026, 10, 2, 9, 30);
  assert.equal(shortTime(sent.getTime(), now.getTime()), time(sent));
});

test("24 hours or older shows the date", () => {
  const now = new Date(2026, 10, 3, 9, 0);
  const sent = new Date(2026, 10, 2, 8, 59);
  assert.equal(shortTime(sent.getTime(), now.getTime()), day(sent));
});

test("earlier today always shows the time", () => {
  const now = new Date(2026, 10, 3, 23, 0);
  const sent = new Date(2026, 10, 3, 0, 5);
  assert.equal(shortTime(sent.getTime(), now.getTime()), time(sent));
});

test("older years include the year", () => {
  const now = new Date(2026, 10, 3, 9, 0);
  assert.match(shortTime(new Date(2025, 5, 1).getTime(), now.getTime()), /2025/);
});
