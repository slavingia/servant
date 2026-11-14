import assert from "node:assert/strict";
import test from "node:test";
import {
  ONBOARDING_VERSION,
  agentAccessLabel,
  chooseRole,
  completeOnboarding,
  completeRoleIntro,
  firstActionForRole,
  moveOnboarding,
  normalizeOnboarding,
  onboardingRequired,
  roleIntroRequired,
  startOnboarding,
  toggleGoal,
} from "./onboarding.ts";

test("legacy accounts without onboarding state are not interrupted", () => {
  assert.equal(onboardingRequired(undefined), false);
  assert.equal(onboardingRequired(startOnboarding(10)), true);
});

test("unknown and malformed versions restart with the current model", () => {
  assert.deepEqual(normalizeOnboarding({ version: 99, completedAt: 1 }, 20), startOnboarding(20));
  assert.deepEqual(normalizeOnboarding("broken", 30), startOnboarding(30));
});

test("normalization keeps only supported selections and repairs the step", () => {
  const state = normalizeOnboarding({
    version: ONBOARDING_VERSION,
    step: "ready",
    role: "ux-researcher",
    goals: ["synthesize", "unknown", "synthesize"],
    startedAt: 10,
    updatedAt: 5,
  }, 50);
  assert.equal(state.step, "ready");
  assert.equal(state.role, "ux-researcher");
  assert.deepEqual(state.goals, ["synthesize"]);
  assert.equal(state.updatedAt, 10);

  const missingGoal = normalizeOnboarding({ ...state, goals: [] }, 60);
  assert.equal(missingGoal.step, "goals");

  const badCompletion = normalizeOnboarding({ ...state, completedAt: "yesterday" }, 60);
  assert.equal(badCompletion.completedAt, undefined);
});

test("admin-granted access labels are separate from role preferences", () => {
  assert.equal(agentAccessLabel(0), "No agent");
  assert.equal(agentAccessLabel(2), "Design prototyper");
  assert.equal(agentAccessLabel(4), "Researcher");
  assert.equal(agentAccessLabel(9), null);
  assert.equal(agentAccessLabel("3"), null);
});

test("role and goal choices are resumable until completion", () => {
  let state = startOnboarding(10);
  state = chooseRole(state, "product-designer", 20);
  state = moveOnboarding(state, "goals", 30);
  state = toggleGoal(state, "prototype", 40);
  state = moveOnboarding(state, "ready", 50);
  assert.equal(onboardingRequired(state), true);
  assert.equal(state.startedAt, 10);
  assert.equal(state.step, "ready");
  assert.deepEqual(state.goals, ["prototype"]);

  state = completeOnboarding(state, 60);
  assert.equal(state.completedAt, 60);
  assert.equal(onboardingRequired(state), false);
  assert.equal(roleIntroRequired(state), true);

  state = completeRoleIntro(state, 70);
  assert.equal(state.roleIntroCompletedAt, 70);
  assert.equal(roleIntroRequired(state), false);
});

test("legacy accounts skip role introduction and milestone-one accounts receive it once", () => {
  assert.equal(roleIntroRequired(undefined), false);
  const completed = completeOnboarding(toggleGoal(chooseRole(startOnboarding(1), "ux-researcher", 2), "research-design-review", 3), 4);
  assert.equal(roleIntroRequired(completed), true);
  const normalized = normalizeOnboarding({ ...completed, roleIntroCompletedAt: 5 }, 6);
  assert.equal(normalized.roleIntroCompletedAt, 5);
  assert.equal(roleIntroRequired(normalized), false);
});

test("new onboarding opens on the benefits tour and can go back to it", () => {
  const fresh = startOnboarding(10);
  assert.equal(fresh.step, "why");
  assert.equal(normalizeOnboarding(fresh, 20).step, "why");
  const toRole = moveOnboarding(fresh, "role", 30);
  assert.equal(toRole.step, "role");
  assert.equal(moveOnboarding(toRole, "why", 40).step, "why");
  // Without a role, later steps still fall back to the role step.
  assert.equal(moveOnboarding(fresh, "goals", 50).step, "role");
  // Older saved state without a step and without a role resumes at the role step.
  assert.equal(normalizeOnboarding({ version: ONBOARDING_VERSION, role: null, goals: [], startedAt: 1, updatedAt: 1 }, 2).step, "role");
});

test("completion requires both a role and a goal", () => {
  const blank = startOnboarding(10);
  assert.equal(completeOnboarding(blank, 20).completedAt, undefined);
  const roleOnly = chooseRole(blank, "content-designer", 30);
  assert.equal(completeOnboarding(roleOnly, 40).completedAt, undefined);
});

test("first actions reflect the selected discipline without implying access", () => {
  assert.deepEqual(firstActionForRole("ux-researcher"), {
    label: "Open Research Studio",
    description: "Plan studies and synthesize evidence with the Researcher agent, and build study prototypes with the prototype agent.",
    href: "/research",
  });
  assert.deepEqual(firstActionForRole("product-designer"), {
    label: "Create your first design",
    description: "Open Design Studio to start an interactive prototype and shape it through conversation.",
    href: "/designs",
  });
  assert.deepEqual(firstActionForRole("product-designer", { canCreateDesign: false, agentTier: 1 }), {
    label: "Open team designs",
    description: "Review designs shared with your team. A workspace owner can grant Design prototyper, Design engineer, or Researcher access when you need to create one.",
    href: "/designs",
  });
  assert.equal(firstActionForRole("ux-researcher", { agentTier: 0 }).href, "/research");
  assert.equal(firstActionForRole("ux-researcher", { agentTier: 4 }).href, "/research");
  assert.equal(firstActionForRole("content-designer", { agentTier: 1 }).href, "/channels");
  assert.equal(firstActionForRole("content-designer", { agentTier: 3 }).href, "/agent");
  assert.equal(firstActionForRole("content-designer").href, "/agent");
});
