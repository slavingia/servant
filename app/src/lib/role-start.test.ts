import assert from "node:assert/strict";
import test from "node:test";
import type { UXGoal, UXRole } from "./onboarding.ts";
import { roleStartTasks } from "./role-start.ts";

const state = (role: UXRole | null, goals: UXGoal[] = []) => ({ role, goals });
const titles = (role: UXRole, goals: UXGoal[] = [], access = {}) =>
  roleStartTasks(state(role, goals), access).map(task => task.title);

test("researcher activation exposes research workflows and the prototype agent", () => {
  const tasks = roleStartTasks(state("ux-researcher"), { agentTier: 4, canCreateDesign: true });
  assert.deepEqual(tasks.map(task => ({ title: task.title, href: task.href })), [
    { title: "Build a research study", href: "/research-new?kind=study" },
    { title: "Synthesize existing evidence", href: "/research-new?kind=synthesis" },
    { title: "Create an interactive prototype", href: "/designs" },
    { title: "Run a research-informed design review", href: "/research-new?kind=design-review" },
  ]);
  assert.ok(tasks.every(task => !task.locked && task.reason === undefined));
  assert.ok(tasks.every(task => task.recommended === false));
});

test("researcher goals move their corresponding workflow to the front", () => {
  assert.deepEqual(titles("ux-researcher", ["synthesize"], { agentTier: 4, canCreateDesign: true }), [
    "Synthesize existing evidence",
    "Build a research study",
    "Create an interactive prototype",
    "Run a research-informed design review",
  ]);
  assert.deepEqual(titles("ux-researcher", ["accessibility"], { agentTier: 4, canCreateDesign: true }), [
    "Run a research-informed design review",
    "Build a research study",
    "Synthesize existing evidence",
    "Create an interactive prototype",
  ]);
  assert.equal(titles("ux-researcher", ["research-design-review"], { agentTier: 4, canCreateDesign: true })[0], "Run a research-informed design review");
  assert.equal(titles("ux-researcher", ["prototype"], { agentTier: 4, canCreateDesign: true })[0], "Create an interactive prototype");
  assert.deepEqual(titles("ux-researcher", ["plan-research", "synthesize"], { agentTier: 4, canCreateDesign: true }), [
    "Build a research study",
    "Synthesize existing evidence",
    "Create an interactive prototype",
    "Run a research-informed design review",
  ]);
});

test("researcher tasks stay visible and explain missing or unverifiable access", () => {
  const unavailable = roleStartTasks(state("ux-researcher", ["plan-research"]), { agentTier: 2, canCreateDesign: false });
  assert.equal(unavailable.length, 4);
  assert.ok(unavailable.every(task => task.locked));
  assert.ok(unavailable.filter(task => task.id !== "research-prototype").every(task => task.reason === "Researcher access is required. Ask a workspace owner to grant it."));
  assert.match(unavailable.find(task => task.id === "research-prototype")?.reason ?? "", /Researcher access/);

  const unverified = roleStartTasks(state("ux-researcher"), { agentTier: null, canCreateDesign: null });
  assert.ok(unverified.every(task => task.locked));
  assert.ok(unverified.filter(task => task.id !== "research-prototype").every(task => task.reason === "Agent access couldn't be verified. Check your connection and try again."));
  assert.equal(unverified.find(task => task.id === "research-prototype")?.reason, "Design creation access couldn't be verified. Check your connection and try again.");

  const unchecked = roleStartTasks(state("ux-researcher"));
  assert.ok(unchecked.every(task => !task.locked));
});

test("design creation stays locked when access could not be verified", () => {
  const task = roleStartTasks(state("product-designer", ["prototype"]), { agentTier: null, canCreateDesign: null })
    .find(item => item.id === "product-prototype");
  assert.equal(task?.locked, true);
  assert.equal(task?.reason, "Design creation access couldn't be verified. Check your connection and try again.");
  assert.equal(task?.recommended, true);
});

test("product designer tasks use existing destinations and retain available work when creation is locked", () => {
  const tasks = roleStartTasks(state("product-designer", ["share"]), { agentTier: 1, canCreateDesign: false });
  assert.deepEqual(tasks.map(task => task.title), [
    "Share a design for feedback",
    "Create an interactive design",
    "Check a design's accessibility",
    "Review evidence with the agent",
  ]);
  assert.deepEqual(new Set(tasks.map(task => task.href)), new Set(["/channels", "/designs", "/agent"]));
  assert.equal(tasks.find(task => task.id === "product-prototype")?.locked, true);
  assert.match(tasks.find(task => task.id === "product-prototype")?.reason ?? "", /Design prototyper, Design engineer, or Researcher/);
  assert.equal(tasks.find(task => task.id === "product-review")?.locked, true);
  assert.equal(tasks.find(task => task.id === "product-accessibility")?.locked, true, "the check is in your own designs");
  assert.equal(tasks.find(task => task.id === "product-share")?.locked, false);
});

test("content designer goals prioritize drafting, review, and sharing without hiding locked work", () => {
  assert.equal(titles("content-designer", ["content"], { agentTier: 3 })[0], "Draft interface content");
  assert.equal(titles("content-designer", ["synthesize"], { agentTier: 3 })[0], "Review content in team designs");
  assert.equal(titles("content-designer", ["share"], { agentTier: 3 })[0], "Share content for feedback");

  const limited = roleStartTasks(state("content-designer", ["content"]), { agentTier: 1 });
  assert.equal(limited.length, 3);
  assert.equal(limited.find(task => task.id === "content-draft")?.locked, true);
  assert.equal(limited.find(task => task.id === "content-review")?.locked, false);
  assert.equal(limited.find(task => task.id === "content-share")?.locked, false);
});

test("research-informed review is a relevant recommendation for every non-research role", () => {
  const cases: [UXRole, string][] = [
    ["product-designer", "product-review"],
    ["content-designer", "content-review"],
    ["design-engineer", "engineer-review"],
  ];
  for (const [role, expected] of cases) {
    const tasks = roleStartTasks(state(role, ["research-design-review"]), { agentTier: 3, canCreateDesign: true });
    assert.equal(tasks[0].id, expected);
    assert.equal(tasks[0].recommended, true);
    assert.ok(tasks.slice(1).every(task => task.recommended === false));
  }
});

test("design engineer tasks prioritize goals and model design and agent access independently", () => {
  assert.equal(titles("design-engineer", ["prototype"], { agentTier: 3, canCreateDesign: true })[0], "Build an interactive prototype");
  assert.equal(titles("design-engineer", ["accessibility"], { agentTier: 3, canCreateDesign: true })[0], "Check a design's accessibility");
  assert.equal(titles("product-designer", ["accessibility"], { agentTier: 3, canCreateDesign: true })[0], "Check a design's accessibility", "the accessibility goal leads to Design Studio's check");
  assert.equal(titles("design-engineer", ["share"], { agentTier: 3, canCreateDesign: true })[0], "Coordinate project work");

  const limited = roleStartTasks(state("design-engineer"), { agentTier: 1, canCreateDesign: false });
  assert.equal(limited.find(task => task.id === "engineer-prototype")?.locked, true);
  assert.equal(limited.find(task => task.id === "engineer-review")?.locked, true);
  assert.equal(limited.find(task => task.id === "engineer-project")?.locked, false);
});

test("goal ordering is stable and does not mutate onboarding state", () => {
  const goals: UXGoal[] = ["share", "prototype"];
  Object.freeze(goals);
  const input = Object.freeze({ role: "product-designer" as const, goals });
  const tasks = roleStartTasks(input, Object.freeze({ agentTier: 3, canCreateDesign: true }));
  assert.deepEqual(tasks.map(task => task.id), ["product-prototype", "product-share", "product-accessibility", "product-review"]);
  assert.deepEqual(tasks.map(task => task.recommended), [true, true, false, false]);
  assert.deepEqual(goals, ["share", "prototype"]);
  assert.notStrictEqual(tasks, roleStartTasks(input, { agentTier: 3, canCreateDesign: true }));
});

test("an incomplete onboarding state has no role-specific activation tasks", () => {
  assert.deepEqual(roleStartTasks(state(null, ["prototype"]), { agentTier: 3, canCreateDesign: true }), []);
  assert.deepEqual(roleStartTasks(undefined, { agentTier: 4 }), []);
});
