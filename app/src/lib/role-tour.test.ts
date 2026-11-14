import assert from "node:assert/strict";
import test from "node:test";
import { UX_ROLES } from "./onboarding.ts";
import { roleStartTasks } from "./role-start.ts";
import { HELD_NOTE, READY_NOTE, TOUR_DEMOS, tourPage, tourPages } from "./role-tour.ts";

test("every starting point of every role has a demo", () => {
  for (const role of UX_ROLES) {
    const tasks = roleStartTasks({ role: role.id, goals: [] });
    assert.ok(tasks.length > 0, role.id);
    for (const task of tasks) assert.ok(TOUR_DEMOS[task.id], `${role.id}: ${task.id}`);
    assert.equal(tourPages(tasks, false).length, tasks.length, role.id);
  }
});

test("demo copy stays short", () => {
  for (const [id, demo] of Object.entries(TOUR_DEMOS)) {
    assert.ok(demo.lead.length <= 55, `${id} lead`);
    assert.equal(demo.how.length, 2);
    for (const line of demo.how) assert.ok(line.length <= 80, `${id}: ${line}`);
  }
});

test("only the research agent's synthesis and design review wait on the research hold", () => {
  const held = Object.entries(TOUR_DEMOS).filter(([, d]) => d.held).map(([id]) => id).sort();
  assert.deepEqual(held, ["research-design-review", "research-synthesis"]);
});

test("pages carry the start page's locks, and the hold only when it's on", () => {
  const researcher = roleStartTasks({ role: "ux-researcher", goals: ["synthesize"] }, { agentTier: 4, canCreateDesign: true });
  const open = tourPages(researcher, false);
  assert.ok(open.every(p => p.status === "ready" && p.note === READY_NOTE));
  // Recommended first, as on the start page.
  assert.equal(open[0].task.id, "research-synthesis");
  const paused = tourPages(researcher, true);
  assert.equal(paused.find(p => p.task.id === "research-synthesis")?.status, "held");
  assert.equal(paused.find(p => p.task.id === "research-synthesis")?.note, HELD_NOTE);
  assert.equal(paused.find(p => p.task.id === "research-study")?.status, "ready");

  const noAgent = roleStartTasks({ role: "ux-researcher", goals: [] }, { agentTier: 0, canCreateDesign: false });
  const locked = tourPages(noAgent, true);
  assert.ok(locked.every(p => p.status === "locked"));
  assert.match(locked[0].note, /Researcher access is required/);
});

test("page index is clamped", () => {
  assert.equal(tourPage(-2, 4), 0);
  assert.equal(tourPage(9, 4), 3);
  assert.equal(tourPage(Number.NaN, 4), 0);
  assert.equal(tourPage(1, 0), 0);
});
