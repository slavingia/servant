// The tour's facts (tour.mjs) and the role list (job-roles.mjs), without a server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { JOB_ROLES, jobRoleOf, validJobRole } from "./job-roles.mjs";
import { tourFacts } from "./tour.mjs";
import { TIER_TOKEN_LIMITS, TOKEN_LIMIT_CHOICES } from "./usage.mjs";

const limitFor = user => TOKEN_LIMIT_CHOICES.includes(user.tokenLimit) ? user.tokenLimit : TIER_TOKEN_LIMITS[user.agentTier];
const costs = Object.fromEntries([1, 2, 3, 4, 5].map(tier => [tier, { model: "example-model", input: 2, output: 10, priced: true, perMillion: 2.8 }]));
const today = { totals: { input: 900_000, output: 100_000, total: 1_000_000 }, people: [
  { userId: "usr_pat", input: 270_000, output: 30_000, total: 300_000 },
  { userId: "usr_ana", input: 630_000, output: 70_000, total: 700_000 },
] };
const tiers = { usr_pat: 3, usr_ana: 3 };
const facts = (user, more = {}) => tourFacts({ user, lane: "owner", limitFor, costs, today, tierOf: id => tiers[id] ?? 0, serverName: "Example team", ...more });
const pat = { id: "usr_pat", name: "Pat Tester", role: "member", agentTier: 3 };

test("the role list is short, plain and complete", () => {
  assert.deepEqual(JOB_ROLES.map(role => role.label), ["Designer", "Researcher", "Engineer", "Content", "Product", "Manager", "Other"]);
  assert.equal(new Set(JOB_ROLES.map(role => role.id)).size, JOB_ROLES.length);
  for (const role of JOB_ROLES) {
    assert.match(role.id, /^[a-z]+$/);
    assert.ok(role.task && role.asks.length >= 2, role.id);
    for (const ask of role.asks) assert.ok(ask.length <= 120 && /[.?]$/.test(ask), ask);
    // A role carries words only: nothing in it names an access level, a limit or an entitlement.
    assert.deepEqual(Object.keys(role).sort(), ["asks", "id", "label", "task"]);
  }
  assert.equal(validJobRole("designer"), true);
  for (const bad of ["owner", "Designer", "", null, 3, "__proto__", "constructor"]) assert.equal(validJobRole(bad), false, String(bad));
  assert.deepEqual(jobRoleOf({ jobRole: "content" }), { id: "content", label: "Content" });
  assert.equal(jobRoleOf({ jobRole: "gone" }), null);
  assert.equal(jobRoleOf({}), null);
});

test("a member sees their own level, limit, price and today's use", () => {
  const out = facts({ ...pat, jobRole: "designer", tourDue: true });
  assert.equal(out.jobRole, "designer");
  assert.equal(out.seen, false);
  assert.deepEqual(out.agent, { tier: 3, name: "Software engineer", kind: "full" });
  assert.deepEqual(out.limit, { tokens: 20_000_000, unlimited: false });
  assert.deepEqual(out.price, { perMillion: 2.8 });
  // 270K in at $2 and 30K out at $10 per million.
  assert.deepEqual(out.today, { tokens: 300_000, usd: 0.84 });
  assert.equal(out.team, undefined, "the team's total is the owner's to see");
  assert.deepEqual(out.levels.find(level => level.tier === 4), { tier: 4, name: "User researcher", tokens: 5_000_000, perMillion: 2.8 });
  assert.equal(out.levels.some(level => level.tier === 0), false);
});

test("the limit is the one the server enforces", () => {
  assert.deepEqual(facts({ ...pat, agentTier: 1 }).limit, { tokens: 1_000_000, unlimited: false });
  assert.deepEqual(facts({ ...pat, agentTier: 2, tokenLimit: 5_000_000 }).limit, { tokens: 5_000_000, unlimited: false });
  assert.deepEqual(facts({ ...pat, tokenLimit: 50_000_000 }).limit, { tokens: 50_000_000, unlimited: false });
  assert.deepEqual(facts({ ...pat, unlimitedTokens: true }).limit, { tokens: null, unlimited: true });
});

test("an owner has no limit and sees what the team used", () => {
  const out = facts({ id: "usr_ana", name: "Ana Ruiz", role: "owner" });
  assert.equal(out.owner, true);
  assert.deepEqual(out.limit, { tokens: null, unlimited: true });
  assert.deepEqual(out.today, { tokens: 700_000, usd: 1.96 });
  assert.deepEqual(out.team, { tokens: 1_000_000, usd: 2.8 });
  assert.deepEqual(out.approvals, { asks: false, logged: false, networkGate: false });
});

test("someone with no agent has nothing to limit or price", () => {
  const out = facts({ ...pat, agentTier: 0 });
  assert.deepEqual(out.agent, { tier: 0, name: "No agent", kind: "none" });
  assert.deepEqual(out.limit, { tokens: 0, unlimited: false });
  assert.equal(out.price, undefined);
  assert.equal(out.today, undefined);
});

test("approvals are claimed only where the agent is actually checked", () => {
  const manager = { name: "Ana Ruiz" };
  assert.deepEqual(facts(pat, { manager }).approvals, { asks: false, logged: false, networkGate: false, manager });
  assert.deepEqual(facts(pat, { manager, capabilities: "ask", egress: "ask" }).approvals, { asks: true, logged: true, networkGate: true, manager });
  // An owner's own agent is logged, never held back.
  assert.deepEqual(facts({ id: "usr_ana", role: "owner" }, { capabilities: "ask" }).approvals, { asks: false, logged: true, networkGate: false });
  // The restricted agents have no file tools or shell to check.
  assert.equal(facts(pat, { lane: "member", capabilities: "ask" }).approvals.asks, false);
  assert.equal(facts(pat, { lane: "member" }).agent.kind, "restricted");
  assert.equal(facts({ ...pat, agentTier: 4 }, { lane: "researcher", capabilities: "ask" }).approvals.asks, false);
  assert.equal(facts({ ...pat, agentTier: 4 }, { lane: "researcher" }).agent.kind, "researcher");
});

test("a number that isn't known is left out, not guessed", () => {
  const out = facts(pat, { costs: null, today: null });
  assert.equal(out.price, undefined);
  assert.equal(out.today, undefined);
  assert.equal("perMillion" in out.levels[0], false);
  assert.deepEqual(out.limit, { tokens: 20_000_000, unlimited: false });
  const unpriced = facts({ id: "usr_ana", role: "owner" }, { costs: null });
  assert.deepEqual(unpriced.team, { tokens: 1_000_000 });
  assert.deepEqual(unpriced.today, { tokens: 700_000 });
  // Nobody has used the agent yet today: zero is known.
  assert.deepEqual(facts(pat, { today: { totals: { total: 0 }, people: [] } }).today, { tokens: 0, usd: 0 });
});

test("the role a person chose changes nothing but the role", () => {
  const plain = facts(pat);
  for (const role of JOB_ROLES) {
    const chosen = facts({ ...pat, jobRole: role.id });
    assert.deepEqual({ ...chosen, jobRole: null }, plain, role.id);
  }
  // Calling yourself an engineer or a manager is not the Software engineer level or being someone's manager.
  assert.equal(facts({ ...pat, agentTier: 1, jobRole: "engineer" }).agent.name, "Tester");
  assert.equal(facts({ ...pat, agentTier: 0, jobRole: "manager" }).agent.kind, "none");
});
