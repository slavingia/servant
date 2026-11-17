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

export type BenefitId = "charge" | "example" | "access" | "cost" | "data" | "evidence";

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
    kicker: "Faster, in control",
    title: "Faster work, and you stay in charge",
    lead: "The AI does the legwork. A person approves every action.",
    points: [
      "It drafts the work; your team reviews it",
      "Nothing runs without a person’s OK",
    ],
  },
  {
    id: "example",
    kicker: "A real example",
    title: "One roadmap feature, start to finish",
    lead: "From the product owner’s ask to reviewing the build.",
    points: [
      "Planning, building and reporting take days, not weeks",
      "Recruiting and testing still take the time they do",
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
      "What you ask the AI goes to Treasury Claude Code",
    ],
  },
  {
    id: "evidence",
    kicker: "Research that lasts",
    title: "Decisions backed by evidence",
    lead: "Ask what past research found, before paying for more.",
    points: [
      "Every answer names the study it came from",
      "Gaps are named, not guessed",
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

// The real-world example: one roadmap feature, from the product owner's ask
// to reviewing the build. "Today" is the UX team's own account of each step.
// "With Servant" is a pilot estimate, to be measured. Planning and reporting
// use the Research Hub skills and Research Studio; steps Servant doesn't speed
// up (recruiting, testing and the build review) keep today's time.
export type FeatureStep = { step: string; today: string; servant: string; how?: string };
export const FEATURE_EXAMPLE = {
  ask: "Product owner asks UX to take on a roadmap feature",
  steps: [
    { step: "Plan the study", today: "1 wk", servant: "1–2 hrs", how: "Research Studio drafts it; a researcher edits it" },
    { step: "Build the prototype", today: "2–3 wks", servant: "2–3 days", how: "Built from the app’s own code, not redrawn" },
    { step: "Recruit participants", today: "1 wk", servant: "1 wk" },
    { step: "Run the usability test", today: "1 wk", servant: "1 wk" },
    { step: "Report results", today: "1 wk", servant: "1 day", how: "AI drafts the report; a researcher checks it" },
    { step: "Iterate the designs", today: "1–2 wks", servant: "1–2 days", how: "Edit the prototype directly" },
    { step: "Hand off to developers", today: "1 wk", servant: "1–2 days", how: "Developers get working code to start from" },
    { step: "Review the build", today: "1 wk", servant: "1 wk" },
  ] satisfies FeatureStep[],
  total: { today: "9–11 wks", servant: "4–5 wks" },
  note: "With Servant: pilot estimates, to be measured",
} as const;
