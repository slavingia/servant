// What the onboarding tour says about one person on this server (GET /v1/tour): the role they chose, the agent
// they actually have, whether anything asks before it acts for them, their own daily limit, what today has used,
// and about what that costs. The app turns these into sentences (app/src/lib/tour.ts); nothing here is copy.
//
// Everything is read, nothing is decided: this file changes no access. A fact that isn't known is left out, so
// the tour says nothing rather than guess.
import { JOB_ROLES, jobRoleOf } from "./job-roles.mjs";
import { AGENT_TIERS, agentTierOf } from "./usage.mjs";

const dollars = (row, cost) => cost && Number.isFinite(cost.input) && Number.isFinite(cost.output)
  ? Math.round(((Number(row?.input) || 0) * cost.input + (Number(row?.output) || 0) * cost.output) / 1_000_000 * 100) / 100 : null;

/**
 * `user` is the person asking. `lane` is the agent their chats run on ("owner": the full agent, "member": the
 * restricted one with no tools, "researcher"). `limitFor(person)` is the usage store's. `costs` is usage-cost's
 * `tierCosts()` or null. `today` is the usage leaderboard since the start of the server's day. `tierOf(userId)`
 * is the access level of someone in `today`. `manager` is who decides this person's entitlement requests.
 */
export function tourFacts({ user, lane, limitFor, costs = null, today = null, tierOf = () => 0, manager = null, capabilities = "off", egress = "off", serverName = "", agentName = "Agent" }) {
  const owner = user.role === "owner";
  const tier = agentTierOf(user);
  const kind = tier === 0 ? "none" : lane === "researcher" ? "researcher" : lane === "member" ? "restricted" : "full";
  const cost = costs?.[tier];
  const perMillion = cost && Number.isFinite(cost.perMillion) ? cost.perMillion : null;
  const mine = today?.people?.find(row => row.userId === user.id);
  const used = today ? { tokens: Number(mine?.total) || 0, ...(dollars(mine, cost) !== null ? { usd: dollars(mine, cost) } : {}) } : null;
  // Everyone's tokens today, each priced at their own level's agent: what the owner pays for.
  let team = null;
  if (owner && today) {
    const priced = today.people.map(row => dollars(row, costs?.[tierOf(row.userId)]));
    team = { tokens: Number(today.totals?.total) || 0, ...(costs && priced.every(usd => usd !== null) ? { usd: Math.round(priced.reduce((sum, usd) => sum + usd, 0) * 100) / 100 } : {}) };
  }
  return {
    server: { name: serverName }, agentName,
    roles: JOB_ROLES, jobRole: jobRoleOf(user)?.id ?? null,
    seen: !user.tourDue,
    owner,
    agent: { tier, name: AGENT_TIERS[tier], kind },
    // Only the full agent is checked before it reads or changes files or GitHub, and an owner's is never held back
    // (docs/entitlements.md). `asks` is whether this person's agent stops to ask; `manager` is who answers.
    approvals: { asks: capabilities === "ask" && kind === "full" && !owner, logged: capabilities === "ask" && kind === "full", networkGate: egress === "ask" && kind !== "none", ...(manager ? { manager: { name: manager.name } } : {}) },
    limit: tier === 0 ? { tokens: 0, unlimited: false } : owner || user.unlimitedTokens ? { tokens: null, unlimited: true } : { tokens: limitFor(user), unlimited: false },
    ...(perMillion !== null && tier !== 0 ? { price: { perMillion } } : {}),
    ...(used && tier !== 0 ? { today: used } : {}),
    ...(team ? { team } : {}),
    // Each level's own daily limit and about what a full day of it costs, so a person sees where theirs sits.
    levels: Object.keys(AGENT_TIERS).map(Number).filter(level => level !== 0).map(level => ({ tier: level, name: AGENT_TIERS[level], tokens: limitFor({ role: "member", agentTier: level }),
      ...(Number.isFinite(costs?.[level]?.perMillion) ? { perMillion: costs[level].perMillion } : {}) })),
  };
}
