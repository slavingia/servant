// The "Why Servant" pages at the start of onboarding, written for someone new
// to AI: plain words, the person in charge first, cost in dollars, and a
// straight answer on where information goes. Every claim is checked against the
// server: levels and caps in server/usage.mjs, Stop and approvals in
// server/agent-turns.mjs, chat visibility in canReadChat (server/server.mjs),
// data paths in docs/ato-data-flows.md, email codes in docs/email-sign-in.md.
// Don't add a "compliant", "certified" or "secure" claim, and keep the caps in
// step with the server (onboarding-benefits.test.ts checks them).

/** Same as USD_PER_M_OUTPUT in token-format.ts (the test checks): the app's list-price estimate. */
export const MAX_USD_PER_M = 15;

export type BenefitId = "charge" | "access" | "cost" | "data" | "time";

export type Benefit = {
  id: BenefitId;
  /** Short label above the title. */
  kicker: string;
  title: string;
  lead: string;
  points: string[];
};

export const BENEFITS: readonly Benefit[] = [
  {
    id: "charge",
    kicker: "In control",
    title: "A person is always in charge",
    lead: "The AI drafts and suggests. You decide what happens.",
    points: [
      "It asks before it takes any action",
      "Stop it at any time",
    ],
  },
  {
    id: "access",
    kicker: "Access",
    title: "Access matches the job",
    lead: "Invited staff only. Owners set what each person can do.",
    points: [
      "Joining can require a work email code",
      "Owners can review any chat",
    ],
  },
  {
    id: "cost",
    kicker: "Cost control",
    title: "A daily cap, like a data plan",
    lead: "Every level has a spending cap. Everyone sees the usage.",
    points: [
      "Reports show totals, never what anyone typed",
      "Owners can raise or lower the caps",
    ],
  },
  {
    id: "data",
    kicker: "Your data",
    title: "Where your information goes",
    lead: "Plain answers, before you have to ask.",
    points: [
      "Messages and files are stored on the team's server",
      "What you ask the AI is sent to the AI provider",
    ],
  },
  {
    id: "time",
    kicker: "Your time",
    title: "Less admin, more research",
    lead: "Ask in plain words. The AI handles the busywork.",
    points: [
      "Bug reports, tickets and setup, handled",
      "More hours for design and research",
    ],
  },
];

export type AgentLevel = { tier: number; label: string; does: string; dailyTokens: number };

/** Mirrors AGENT_TIERS and TIER_TOKEN_LIMITS in server/usage.mjs, in the order people move up. */
export const AGENT_LEVELS: readonly AgentLevel[] = [
  { tier: 0, label: "No agent", does: "Messaging only", dailyTokens: 0 },
  { tier: 1, label: "Tester", does: "Report problems", dailyTokens: 1_000_000 },
  { tier: 2, label: "Design prototyper", does: "Build design mockups", dailyTokens: 5_000_000 },
  { tier: 4, label: "Researcher", does: "Research help and study mockups", dailyTokens: 5_000_000 },
  { tier: 3, label: "Design engineer", does: "Everything, including code", dailyTokens: 20_000_000 },
];

export function agentLevel(tier: unknown): AgentLevel | null {
  return typeof tier === "number" ? AGENT_LEVELS.find(level => level.tier === tier) ?? null : null;
}

/** Clamp a page index into the benefit pages. */
export function benefitPage(index: number): number {
  if (!Number.isFinite(index)) return 0;
  return Math.min(BENEFITS.length - 1, Math.max(0, Math.trunc(index)));
}

/**
 * The most a day's cap could cost at the list prices the app estimates with
 * (token-format.ts): every token priced as output, the dearest kind. Real
 * spend is lower; the contract rate may differ, so it's always "about".
 */
export function maxDailyDollars(tokens: number): number {
  return Math.round((Math.max(0, tokens) / 1_000_000) * MAX_USD_PER_M);
}

export function capText(tokens: number): string {
  return tokens ? `up to $${maxDailyDollars(tokens).toLocaleString("en-US")}/day` : "—";
}

/** What the cost page says about the person's own cap. Owners have none. */
export function dailyLimitText(tier: number | null | undefined, isOwner: boolean): string | null {
  if (isOwner) return "You're the owner: no daily cap";
  const level = agentLevel(tier);
  if (!level) return null;
  if (level.dailyTokens === 0) return "No AI access yet. Ask your owner";
  return `Your cap: about $${maxDailyDollars(level.dailyTokens)} a day at most`;
}
