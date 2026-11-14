import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { FORMATS, localFormat, type LocalFormat } from "./local-format.ts";
import { dayLabel, shortTime } from "./time-label.ts";
import { statusTime } from "./message-status.ts";

const dates = [new Date(2026, 10, 3, 0, 5), new Date(2026, 10, 3, 9, 30), new Date(2026, 10, 3, 12, 0), new Date(2026, 10, 3, 23, 59), new Date(2025, 0, 1, 15, 7), new Date(2026, 6, 4, 6, 45)];
const names = Object.keys(FORMATS) as LocalFormat[];

test("a kept formatter says exactly what the date's own local string says", () => {
  for (const date of dates) {
    assert.equal(localFormat("time", date), date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
    assert.equal(localFormat("weekday", date), date.toLocaleDateString([], { weekday: "long" }));
    assert.equal(localFormat("monthDay", date), date.toLocaleDateString([], { month: "short", day: "numeric" }));
    assert.equal(localFormat("monthDayYear", date), date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }));
    assert.equal(localFormat("weekdayMonthDay", date), date.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" }));
    assert.equal(localFormat("weekdayMonthDayYear", date), date.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric", year: "numeric" }));
  }
});

test("a row's time and day labels build no formatter of their own", t => {
  // The date's own local string builds a formatter on every call; a list of messages asked for hundreds.
  const time = t.mock.method(Date.prototype, "toLocaleTimeString");
  const day = t.mock.method(Date.prototype, "toLocaleDateString");
  const made = t.mock.method(Intl, "DateTimeFormat");
  const now = new Date(2026, 10, 3, 12, 0).getTime();
  // Far enough from every other test's clock that the kept formatters are remade once here, then reused.
  const later = now + 10 * 60_000;
  t.mock.method(Date, "now", () => later);
  for (let i = 0; i < 200; i++) {
    shortTime(now - i * 60_000, now);                 // today: a time
    shortTime(now - (2 + (i % 4)) * 86_400_000, now); // this week: a weekday
    dayLabel(now - (30 + i) * 86_400_000, now);       // older: a date
    statusTime(now - i * 3_600_000, now);             // "last seen"
    for (const name of names) localFormat(name, new Date(now - i * 1000), later);
  }
  assert.equal(time.mock.callCount(), 0);
  assert.equal(day.mock.callCount(), 0);
  assert.ok(made.mock.callCount() <= names.length, `${made.mock.callCount()} formatters for ${names.length} formats`);
});

test("a change of time zone shows at once, and a change of settings within a minute", t => {
  const zone = process.env.TZ;
  const at = new Date(Date.UTC(2026, 10, 3, 17, 30));
  try {
    process.env.TZ = "America/New_York";
    const now = Date.now();
    assert.equal(localFormat("time", at, now), at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
    const eastern = localFormat("time", at, now);
    // The phone lands in another zone: the very next label is in it.
    process.env.TZ = "Asia/Tokyo";
    assert.equal(localFormat("time", at, now), at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
    assert.notEqual(localFormat("time", at, now), eastern);
  } finally {
    if (zone === undefined) delete process.env.TZ; else process.env.TZ = zone;
  }
  // Kept formatters are remade after a minute, so a new locale or 12/24 hour choice is picked up.
  const made = t.mock.method(Intl, "DateTimeFormat");
  const start = Date.now() + 3_600_000;
  localFormat("time", at, start);
  localFormat("time", at, start + 59_000);
  assert.equal(made.mock.callCount(), 1);
  localFormat("time", at, start + 60_000);
  assert.equal(made.mock.callCount(), 2);
});

test("message rows, list rows and day separators use the kept formatters", () => {
  const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, "..", file), "utf8");
  for (const file of ["lib/time-label.ts", "lib/message-status.ts", "components/Messaging.tsx"]) {
    assert.doesNotMatch(read(file), /toLocale(Time|Date)String\(/, file);
    assert.match(read(file), /localFormat\(/, file);
  }
});
