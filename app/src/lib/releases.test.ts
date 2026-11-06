import assert from "node:assert/strict";
import test from "node:test";
import { localDate, myTodos, orderReleases, releaseDate, releaseProgress, shortStage } from "./releases.ts";
import type { ProjectRelease, StageCell } from "./server.ts";

const cell = (status: StageCell["status"], owner: string | null = null): StageCell => ({ status, owner, ownerName: owner ? "Someone" : "" });
const stages = ["Build", "Design", "Functional/508 QA", "SAT", "Content"];
const nov17: ProjectRelease = { id: "rel_nov", name: "November 17", date: "2026-11-17", items: [
  { id: "i1", title: "Account settings", stages: { Build: cell("done", "me"), SAT: cell("blocked", "me"), Content: cell("todo", "ben") } },
  { id: "i2", title: "Search", stages: { Build: cell("doing", "me") } },
] };
const oct1: ProjectRelease = { id: "rel_oct", name: "October 1", date: "2026-10-01", items: [{ id: "i3", title: "Guest mode", stages: { SAT: cell("todo", "me") } }] };
const dec: ProjectRelease = { id: "rel_dec", name: "December", date: "2026-12-15", items: [] };

test("dates: today in local time, and a short label with the year only when it isn't this year", () => {
  assert.equal(localDate(new Date(2026, 10, 4)), "2026-11-04");
  assert.equal(releaseDate("2026-11-17", new Date(2026, 10, 4)), "Nov 17");
  assert.equal(releaseDate("2027-03-01", new Date(2026, 10, 4)), "Mar 1, 2027");
  assert.equal(releaseDate("", new Date()), "No date");
});

test("releases: upcoming soonest first (today counts), then past most recent first", () => {
  const { upcoming, past } = orderReleases([dec, oct1, nov17], "2026-11-04");
  assert.deepEqual(upcoming.map(r => r.name), ["November 17", "December"]);
  assert.deepEqual(past.map(r => r.name), ["October 1"]);
  assert.deepEqual(orderReleases([nov17], "2026-11-17").upcoming.map(r => r.name), ["November 17"]);
  assert.deepEqual(orderReleases([nov17], "2026-11-18").past.map(r => r.name), ["November 17"]);
});

test("my to-dos: my cells that aren't done, soonest release first, in stage order", () => {
  const mine = myTodos({ stages, releases: [oct1, nov17, dec] }, "me", "2026-11-04");
  assert.deepEqual(mine.map(t => `${t.item.title} · ${t.stage} · ${t.release.name} · ${t.cell.status}`),
    ["Account settings · SAT · November 17 · blocked", "Search · Build · November 17 · doing", "Guest mode · SAT · October 1 · todo"]);
  assert.deepEqual(myTodos({ stages, releases: [nov17] }, "ben", "2026-11-04").map(t => t.stage), ["Content"]);
  assert.deepEqual(myTodos({ stages: [], releases: [nov17] }, "me"), [], "no stages, nothing to own");
  assert.deepEqual(releaseProgress(nov17, stages), { done: 1, total: 10 });
});

test("chip labels: short names stay, long ones shrink to their acronym or first word", () => {
  assert.deepEqual(stages.map(shortStage), ["Build", "Design", "QA", "SAT", "Content"]);
  assert.equal(shortStage("User acceptance"), "User");
  assert.equal(shortStage("Accessibility"), "Accessib");
});
