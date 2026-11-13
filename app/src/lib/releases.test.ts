import assert from "node:assert/strict";
import test from "node:test";
import { featureDone, localDate, myTodos, orderReleases, ownsCell, parseReviewers, releaseDate, releaseProgress, reviewerText, shortStage, stageReviewers } from "./releases.ts";
import type { ProjectRelease, StageCell } from "./server.ts";

const cell = (status: StageCell["status"], owner: string | null = null): StageCell => ({ status, owner, ownerName: owner ? "Someone" : "" });
const stages = ["Build", "Design", "Functional/508 QA", "SAT", "Content"];
const nov17: ProjectRelease = { id: "rel_nov", name: "November 17", date: "2026-11-17", items: [
  { id: "i1", title: "Payments v2", stages: { Build: cell("done", "me"), SAT: cell("blocked", "me"), Content: cell("todo", "ben") } },
  { id: "i2", title: "Dark mode", stages: { Build: cell("doing", "me") } },
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
    ["Payments v2 · SAT · November 17 · blocked", "Dark mode · Build · November 17 · doing", "Guest mode · SAT · October 1 · todo"]);
  assert.deepEqual(myTodos({ stages, releases: [nov17] }, "ben", "2026-11-04").map(t => t.stage), ["Content"]);
  assert.deepEqual(myTodos({ stages: [], releases: [nov17] }, "me"), [], "no stages, nothing to own");
  assert.deepEqual(releaseProgress(nov17, stages), { done: 0, total: 2, ready: false });
  assert.deepEqual(releaseProgress(dec, stages), { done: 0, total: 0, ready: false }, "an empty release can't ship");
});

test("reviewers: a stage's people own its unassigned cells, show up in my to-dos, and round-trip as @usernames", () => {
  const ash = { key: "ana-ruiz", id: "usr_ana", name: "Ana Ruiz", github: "ana-ruiz" };
  const mw = { key: "pat-tester", name: "pat-tester", github: "pat-tester" };
  const project = { reviewers: { UT: [mw, ash], Copy: [{ key: "annie-content", id: "usr_annie", name: "Annie", github: "annie-content" }] } };
  assert.deepEqual(stageReviewers(project, "UT"), [mw, ash]);
  assert.deepEqual(stageReviewers({}, "UT"), [], "a project from before reviewers");
  assert.equal(ownsCell(project, undefined, "UT", "usr_ana"), true, "no cell yet: the stage's reviewers");
  assert.equal(ownsCell(project, { status: "todo", owner: null, ownerName: "" }, "Copy", "usr_ana"), false);
  assert.equal(ownsCell(project, { status: "todo", owner: "usr_jo", ownerName: "Jo" }, "UT", "usr_ana"), false, "an assigned owner wins");
  const release = { id: "r", name: "November 18", date: "2099-11-18", items: [{ id: "i", title: "Paper notices", stages: { Copy: { status: "done", owner: null, ownerName: "" } }, parts: [] }] } as unknown as ProjectRelease;
  const todos = myTodos({ stages: ["Copy", "UT"], releases: [release], ...project }, "usr_ana", "2026-11-13");
  assert.deepEqual(todos.map(t => [t.item.title, t.stage]), [["Paper notices", "UT"]]);
  assert.deepEqual(myTodos({ stages: ["Copy", "UT"], releases: [release], ...project }, "usr_annie", "2026-11-13"), [], "Copy is done");
  assert.equal(reviewerText([mw, ash]), "@pat-tester @ana-ruiz");
  assert.deepEqual(parseReviewers(" @pat-tester, ana-ruiz @ana-ruiz\n"), ["pat-tester", "ana-ruiz"]);
});

test("features: checked when every stage is done and every part ticked; the final box opens when all are", () => {
  const all = Object.fromEntries(stages.map(s => [s, cell("done")]));
  const rel: ProjectRelease = { id: "r", name: "R", date: "2026-11-17", items: [
    { id: "a", title: "Refunds", stages: all, parts: [{ id: "p1", title: "Copy", done: true }, { id: "p2", title: "Spanish", done: false }] },
    { id: "b", title: "Payments", stages: all },
  ] };
  assert.deepEqual(rel.items.map(i => featureDone(i, stages)), [false, true]);
  assert.deepEqual(releaseProgress(rel, stages), { done: 1, total: 2, ready: false });
  rel.items[0].parts![1].done = true;
  assert.deepEqual(releaseProgress(rel, stages), { done: 2, total: 2, ready: true });
  assert.equal(featureDone({ id: "c", title: "Bare", stages: {} }, []), false, "no stages, no parts, no tick");
  assert.equal(featureDone({ id: "c", title: "Bare", stages: {}, done: true }, []), true, "the server's word wins");
  assert.equal(releaseProgress({ ...rel, ready: false }, stages).ready, false, "the server's word wins");
});

test("chip labels: short names stay, long ones shrink to their acronym or first word", () => {
  assert.deepEqual(stages.map(shortStage), ["Build", "Design", "QA", "SAT", "Content"]);
  assert.equal(shortStage("User acceptance"), "User");
  assert.equal(shortStage("Accessibility"), "Accessib");
});
