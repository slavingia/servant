// The onboarding tour's words. The server says what is true for this person (GET /v1/tour, server/tour.mjs):
// the agent they have, whether anything asks before it acts for them, their daily limit, today's use and about
// what that costs. This file turns those into the pages. It claims nothing the facts don't say: approvals are
// described only where this person's agent is actually checked, and a figure the server left out is a line the
// page leaves out.
//
// The role a person chooses (server/job-roles.mjs) reaches two things here: the example on the first page and
// the asks on the last. No other page takes it, so it cannot change what a page says about access or cost.
import { AGENT_ROLES, roleLabel } from "./agent-roles.ts";
import { formatTokens } from "./token-format.ts";
import { costWords, dailyCost, limitWords } from "./token-limit.ts";

export type TourRole = { id: string; label: string; task: string; asks: string[] };
export type TourFacts = {
  server: { name: string };
  agentName: string;
  roles: TourRole[];
  jobRole: string | null;
  seen: boolean;
  owner: boolean;
  /** `kind` is the agent their chats really run on: the full one, the one with no tools, the researcher's, or none. */
  agent: { tier: number; name: string; kind: "none" | "full" | "restricted" | "researcher" };
  approvals: { asks: boolean; logged: boolean; networkGate: boolean; manager?: { name: string } };
  limit: { tokens: number | null; unlimited: boolean };
  price?: { perMillion: number };
  today?: { tokens: number; usd?: number };
  team?: { tokens: number; usd?: number };
  levels: { tier: number; name: string; tokens: number; perMillion?: number }[];
};

/** A title and a sentence or two under it. */
export type TourPoint = { title: string; body: string };

// ---------- the role ----------

const text = (value: unknown, max: number) => typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";

/** The role list as the server sent it, keeping only complete entries. A list this build can't read is an empty one. */
export function tourRoles(raw: unknown): TourRole[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const roles: TourRole[] = [];
  for (const entry of raw) {
    const id = text(entry?.id, 40), label = text(entry?.label, 40);
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);
    const asks = Array.isArray(entry?.asks) ? entry.asks.map((ask: unknown) => text(ask, 200)).filter(Boolean).slice(0, 4) : [];
    roles.push({ id, label, task: text(entry?.task, 80), asks });
  }
  return roles;
}

/** The role this person chose, if it is still on the list. */
export const chosenRole = (facts: Pick<TourFacts, "roles" | "jobRole">, chosen: string | null = facts.jobRole) => facts.roles.find(role => role.id === chosen) ?? null;

/** Said wherever a role is chosen or shown in the tour. */
export const ROLE_NOTE = "Your role tailors tips. Your owner sets what the agent can do.";

// ---------- the steps ----------

export const TOUR_STEPS = ["role", "charge", "access", "limit", "data", "try"] as const;
export type TourStep = typeof TOUR_STEPS[number];
export const STEP_TITLE: Record<TourStep, string> = {
  role: "What's your role?",
  charge: "You stay in charge",
  access: "Your access level",
  limit: "Your daily limit",
  data: "Where your data goes",
  try: "Try asking @agent",
};
/** "Step 2 of 6: You stay in charge", for the progress line and a screen reader. */
export const stepLabel = (index: number) => `Step ${index + 1} of ${TOUR_STEPS.length}: ${STEP_TITLE[TOUR_STEPS[index]!]}`;
/** The step a swipe, a button or an arrow key lands on: never before the first or past the last. */
export const stepAfter = (index: number, by: 1 | -1) => Math.min(TOUR_STEPS.length - 1, Math.max(0, index + by));

/** Which way a finger's travel turns the page: a clear sideways swipe only, so a page still scrolls up and down. */
export function swipeTurn(dx: number, dy: number): 1 | -1 | 0 {
  if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 2) return 0;
  return dx < 0 ? 1 : -1;
}

// ---------- when it opens ----------

/** Screens the tour never opens over: joining, signing in, and confirming it's you. */
const BUSY = /^\/(welcome|pair|sign-in|join-server|scan|reverify|tour)(\/|$)/;

/**
 * Whether the tour opens by itself. `due` is the server's word that this person just joined and has not finished
 * or skipped it (kept on the person, so it is once for them and not once per device). `dismissed` is this app's
 * own memory of having closed it, for when the server could not be told.
 */
export const tourOpens = (state: { paired: boolean; due: boolean | undefined; dismissed: boolean; pathname: string }) =>
  state.paired && state.due === true && !state.dismissed && !BUSY.test(state.pathname);

// ---------- you stay in charge ----------

/** The first page's opening line: the chosen role's example, or a plain one. */
export function chargeLead(facts: TourFacts, role: TourRole | null): string {
  if (facts.agent.kind === "none") return "You have no agent on this server yet. This is how it works once an owner turns it on.";
  return role?.task ? `Ask for ${role.task}, then watch the agent work.` : "Ask for what you need, then watch the agent work.";
}

export function chargePoints(facts: TourFacts): TourPoint[] {
  const { agent, approvals, owner } = facts;
  const points: TourPoint[] = [{ title: "Stop at any time", body: "While the agent is replying, Send becomes Stop. What it wrote so far stays." }];
  if (agent.kind === "none") return points;
  const manager = approvals.manager?.name || "your manager";
  if (approvals.asks) points.push({ title: "It asks before it touches files or GitHub", body: `The first time the agent is about to read or change files or GitHub for you, it stops and ${manager} decides: allow once, allow always or decline.` });
  else if (owner) points.push({ title: "Your agent acts without asking", body: `As an owner you have the full agent with no approval step: it can read and change files and run commands on the server's computer.${approvals.logged ? " What it does with files and GitHub is written to Agent activity in Entitlements." : ""}` });
  else if (agent.kind === "full") points.push({ title: "No approval step on this server", body: "The agent acts on what you ask without checking first. It can read and change files and run commands on the server's computer, so ask for what you mean and stop it when it goes wrong." });
  else if (agent.kind === "researcher") points.push({ title: "Nothing to approve", body: "Your agent searches the web and uses skills. It has no files, commands or GitHub to act on." });
  else points.push({ title: "Nothing to approve", body: "Your agent reads and writes text and looks at images you send. It has no files, terminal, web or connected services to act on." });
  if (approvals.networkGate) points.push({ title: "Other systems need an entitlement", body: `The agent reaches a system outside the server for you only through an entitlement you asked for and ${owner ? "hold" : `${manager} granted`}.` });
  return points;
}

// ---------- access level ----------

const hintFor = (tier: number) => AGENT_ROLES.find(role => role.tier === tier)?.hint ?? "";

/** This person's level and what it lets their agent do, here. */
export function accessSummary(facts: TourFacts): TourPoint {
  const { agent, owner } = facts;
  if (owner) return { title: "Owner", body: "The full agent: files, the terminal, the web and connected services on the server's computer. You set everyone else's level in People." };
  if (agent.kind === "none") return { title: "No agent", body: "You can message people, but you don't have agent access yet. Ask an owner to turn it on." };
  const title = roleLabel(agent.tier);
  if (agent.kind === "restricted") return { title, body: "On this server, members' agents work with text and the images you send. No files, terminal, web or connected services." };
  if (agent.tier === 3) return { title, body: "Full access: files, the terminal, the web and connected services on the server's computer." };
  return { title, body: hintFor(agent.tier) };
}

export type LevelRow = { tier: number; label: string; hint: string; cost: string; mine: boolean };

/**
 * Every level, with this person's marked, in the order People lists them. `cost` is about what a full day of
 * that level's own limit comes to, when the server priced it. Empty where levels don't describe the agent people
 * get: an owner sets them rather than has one, and on a restricted server every member's agent is the same.
 */
export function levelRows(facts: TourFacts): LevelRow[] {
  if (facts.agent.kind === "restricted") return [];
  return AGENT_ROLES.filter(role => role.tier !== 0).flatMap(role => {
    const level = facts.levels.find(entry => entry.tier === role.tier);
    if (!level) return [];
    const cost = costWords(dailyCost(level.tokens, level.perMillion === undefined ? undefined : priced(level.perMillion)));
    return [{ tier: role.tier, label: role.label, hint: role.hint, cost: cost ? `up to ${cost}` : `up to ${limitWords(level.tokens)}`, mine: !facts.owner && facts.agent.tier === role.tier }];
  });
}

// ---------- daily limit ----------

const priced = (perMillion: number) => ({ model: null, input: 0, output: 0, priced: false, perMillion });
/** "about $56", "under $0.10", "$0": an amount with no "a day" after it. Empty when there is nothing to say. */
export function aboutUsd(usd: number | null | undefined): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd) || usd < 0) return "";
  return usd === 0 ? "$0" : costWords(usd).replace(/ a day$/, "");
}

export type LimitPage = { headline: string; lines: string[]; note: string };

/**
 * The daily limit page: this person's own limit, about what it costs, and today so far. Dollars appear only
 * when the server sent a price; without one the page speaks in tokens, and without today's count it says
 * nothing about today.
 */
export function limitPage(facts: TourFacts): LimitPage {
  const { agent, owner, limit, price, today, team } = facts;
  const rough = "Dollar figures are estimates from token counts, not a bill.";
  if (agent.kind === "none") return { headline: "No agent, so nothing to spend", lines: ["You don't have agent access yet. Ask an owner to turn it on; your daily limit comes with the level they choose."], note: "" };
  const spent = (use: { tokens: number; usd?: number }) => aboutUsd(use.usd) || `${formatTokens(use.tokens)} tokens`;
  const anyDollars = (...uses: ({ tokens: number; usd?: number } | undefined)[]) => uses.some(use => use?.usd !== undefined);
  if (owner) {
    return { headline: "No limit; you pay for what the team uses",
      lines: [team ? `Team today: ${spent(team)}` : "", today ? `You today: ${spent(today)}` : "", "You set each person's daily limit in People."].filter(Boolean),
      note: anyDollars(team, today) ? rough : "" };
  }
  if (limit.unlimited) {
    return { headline: "No daily limit", lines: [today ? `Today: ${spent(today)} so far` : "", "An owner turned your limit off. They pay for what you use."].filter(Boolean), note: anyDollars(today) ? rough : "" };
  }
  if (!limit.tokens) return { headline: "", lines: [], note: "" };
  const cap = price ? dailyCost(limit.tokens, priced(price.perMillion)) : null;
  const capWords = costWords(cap);
  const lines = [capWords ? `Your limit is ${limitWords(limit.tokens)}. It resets at midnight.` : "It resets at midnight."];
  if (today) lines.push(capWords && today.usd !== undefined ? `Today: ${aboutUsd(today.usd)} of ${aboutUsd(cap)}` : `Today: ${formatTokens(today.tokens)} of ${formatTokens(limit.tokens)} tokens`);
  lines.push("At the limit the agent stops for the day. An owner can change it.");
  return { headline: capWords ? `${capWords[0]!.toUpperCase()}${capWords.slice(1)} at most` : `${limitWords(limit.tokens)[0]!.toUpperCase()}${limitWords(limit.tokens).slice(1)}`, lines, note: capWords ? rough : "" };
}

// ---------- where data goes ----------

export function dataPoints(facts: TourFacts): TourPoint[] {
  const points: TourPoint[] = [
    { title: "It stays on your team's server", body: `Messages and files are kept on ${facts.server.name || "your server"}, which your owner runs on a computer they control. The owner can read what is on it.` },
    { title: "Encrypted from the app to the server", body: "The app encrypts what it sends with the server's key from your invite. Anything that passes it along in between can't read it." },
  ];
  if (facts.agent.kind !== "none") {
    points.push({ title: "The agent sits behind the server", body: "Only the server can reach the agent. What you ask it goes to the AI model your owner set up." });
    points.push({ title: "Agent chats start private", body: "You and the owner can read your agent chats. Others see one only if you share it." });
  }
  points.push({ title: "Your own logins are never shown back", body: facts.agent.kind === "full"
    ? "A token you save in Connections is never shown again, to you or anyone else. Only your own agent's commands can use it."
    : "A token you save in Connections is never shown again, to you or anyone else." });
  return points;
}

// ---------- try asking ----------

export type TryPage = { lead: string; asks: string[]; canAsk: boolean };

/** The last page: first asks for the chosen role. With no agent they are shown to read, not to press. */
export function tryPage(facts: TourFacts, role: TourRole | null): TryPage {
  const from = role ?? facts.roles.find(entry => entry.id === "other") ?? null;
  const canAsk = facts.agent.kind !== "none";
  return {
    asks: from?.asks ?? [],
    canAsk,
    lead: !canAsk ? "You don't have agent access yet. Once an owner turns it on, these are good first asks."
      : "Choose one to open a new agent chat with the words filled in. Nothing is sent until you press Send.",
  };
}
