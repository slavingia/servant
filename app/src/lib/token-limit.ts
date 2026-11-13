// An owner's choices for one person's daily agent limit, as one list: their role's own limit, one of the server's
// fixed steps (usage.mjs TOKEN_LIMIT_CHOICES), or none. The server keeps two fields (`tokenLimit`, `unlimitedTokens`);
// the person sheet shows one choice, so a limit and "no limit" can never both look chosen.
import { AGENT_ROLES, roleLabel } from "./agent-roles.ts";
import type { Person } from "./server";

export type LimitChoice = {
  key: string;
  /** On the chip. */
  label: string;
  /** For a screen reader: "1M" alone is read out as a letter. */
  name: string;
  tokenLimit: number | null;
  unlimited: boolean;
};

export const LIMIT_CHOICES: LimitChoice[] = [
  { key: "default", label: "Role default", name: "Role default limit", tokenLimit: null, unlimited: false },
  ...[1, 5, 20, 50].map(n => ({ key: String(n * 1_000_000), label: `${n}M`, name: `${n} million tokens a day`, tokenLimit: n * 1_000_000, unlimited: false })),
  { key: "none", label: "No limit", name: "No daily limit", tokenLimit: null, unlimited: true },
];

/** The choice a person has now. Null for a step this build doesn't know, so nothing is shown as chosen rather than the wrong one. */
export function chosenLimit(person: Pick<Person, "tokenLimit" | "unlimitedTokens">): LimitChoice | null {
  if (person.unlimitedTokens) return LIMIT_CHOICES.find(c => c.unlimited) ?? null;
  return LIMIT_CHOICES.find(c => !c.unlimited && c.tokenLimit === (person.tokenLimit ?? null)) ?? null;
}

/** The PATCH /v1/people/:id body that makes a choice true. Choosing a limit turns "no limit" off in the same request. */
export function limitChange(choice: LimitChoice): { unlimitedTokens: boolean; tokenLimit?: number | null } {
  return choice.unlimited ? { unlimitedTokens: true } : { unlimitedTokens: false, tokenLimit: choice.tokenLimit };
}

/** Someone with no agent has nothing to limit. */
export const limitApplies = (person: Pick<Person, "agentTier">) => (person.agentTier ?? 0) !== 0;

/** Each role's own daily limit in tokens, by tier, as the server sends it to an owner (`tierTokenLimits`). */
export type RoleLimits = Record<string, number>;

const millions = (tokens: number) => { const n = tokens / 1_000_000; return Number.isInteger(n) ? String(n) : n.toFixed(1); };
/** "5 million tokens a day": the amount in words, for a row and for a screen reader. */
export const limitWords = (tokens: number) => `${millions(tokens)} million tokens a day`;
/** "5M a day": the amount in a summary line. */
export const limitShort = (tokens: number) => `${millions(tokens)}M a day`;

const listed = (names: string[]) => names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/**
 * Roughly what a role's tokens cost, by tier, as the server sends it to an owner (`tierCosts`): the model that
 * role's agent runs if the owner named it, its prices per million tokens in and out, whether those are the
 * owner's own figures or the usage report's estimate, and dollars per million at this server's mix of the two.
 */
export type RoleCost = { model: string | null; input: number; output: number; priced: boolean; perMillion: number };
export type RoleCosts = Record<string, RoleCost>;

/** Dollars for one day if a daily amount were used in full. Null when the server sent no price. A limit is a day's, so its cost is said for a day. */
export const dailyCost = (tokensPerDay: number, cost: RoleCost | undefined): number | null =>
  cost && Number.isFinite(cost.perMillion) && cost.perMillion >= 0 ? (tokensPerDay / 1_000_000) * cost.perMillion : null;

/** "about $14 a day": two figures, because it is an estimate; dimes under ten dollars. Empty when there is nothing to say. */
export function costWords(usd: number | null): string {
  if (usd === null || !Number.isFinite(usd) || usd < 0) return "";
  if (usd > 0 && usd < 0.1) return "under $0.10 a day";
  if (usd < 9.95) { const dimes = Math.round(usd * 10) / 10; return `about $${Number.isInteger(dimes) ? dimes : dimes.toFixed(2)} a day`; }
  const step = 10 ** (Math.floor(Math.log10(usd)) - 1);
  return `about $${(Math.round(usd / step) * step).toLocaleString("en-US")} a day`;
}

const capital = (text: string) => text ? text[0]!.toUpperCase() + text.slice(1) : text;
const dollars = (n: number) => Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;

/** Under a role: its own daily limit, about what that costs, and the model its agent runs when the owner named it. */
export function roleCostLine(tier: number, roleLimits?: RoleLimits, roleCosts?: RoleCosts): string {
  const own = roleLimits?.[String(tier)], cost = roleCosts?.[String(tier)];
  if (!own) return "";
  const price = costWords(dailyCost(own, cost));
  return [price ? `${millions(own)}M tokens, ${price}` : `${millions(own)}M tokens a day`, cost?.model ?? ""].filter(Boolean).join(" · ");
}

/**
 * The same line for the screen, where it may only wrap between its parts: a model id is not cut at a hyphen and
 * "about $14 a day" is not left with "day" on a line of its own.
 */
export const unbroken = (line: string) => line.split(" · ").map(part => part.replace(/ /g, " ").replace(/-/g, "‑")).join(" · ");

/** What the dollar figures assume, in one sentence under the limits. Empty when the server sent no price. */
export function costNote(cost: RoleCost | undefined): string {
  if (!cost) return "";
  const prices = `${dollars(cost.input)} per million tokens in and ${dollars(cost.output)} out`;
  return `Dollar figures are rough: a day with the limit used in full, at ${cost.priced && cost.model ? `the prices set for ${cost.model} (${prices})` : prices}.`;
}

export type LimitRow = LimitChoice & { title: string; hint: string };

/** The limit list in the person sheet: every choice with what it means for this person. */
export function limitRows(person: Pick<Person, "agentTier">, roleLimits?: RoleLimits, roleCosts?: RoleCosts): LimitRow[] {
  const own = roleLimits?.[String(person.agentTier ?? 0)];
  // Priced by this person's role: the same amount costs more on a dearer agent.
  const said = (tokens: number) => costWords(dailyCost(tokens, roleCosts?.[String(person.agentTier ?? 0)]));
  return LIMIT_CHOICES.map(choice => {
    if (choice.unlimited) return { ...choice, title: "No limit", hint: "Never stops for the day" };
    if (choice.tokenLimit === null) return { ...choice, title: "Role default", hint: own ? [`${limitWords(own)} for a ${roleLabel(person.agentTier)}`, said(own)].filter(Boolean).join(", ") : "The limit that comes with their role" };
    // A set amount says about what it costs and which roles start there, so the steps mean something.
    const roles = AGENT_ROLES.filter(role => role.tier !== 0 && roleLimits?.[String(role.tier)] === choice.tokenLimit).map(role => role.label);
    return { ...choice, title: limitWords(choice.tokenLimit), hint: capital([said(choice.tokenLimit), roles.length ? `${listed(roles)} default` : ""].filter(Boolean).join(" · ")) };
  });
}

/** One line for the closed section: "Role default · 5M, about $14 a day", "20M a day", "No limit". */
export function limitSummary(person: Pick<Person, "agentTier" | "tokenLimit" | "unlimitedTokens">, roleLimits?: RoleLimits, roleCosts?: RoleCosts): string {
  const chosen = chosenLimit(person);
  const amount = (tokens: number) => {
    const price = costWords(dailyCost(tokens, roleCosts?.[String(person.agentTier ?? 0)]));
    return price ? `${millions(tokens)}M, ${price}` : limitShort(tokens);
  };
  if (!chosen) return person.tokenLimit ? amount(person.tokenLimit) : "";
  if (chosen.unlimited) return "No limit";
  if (chosen.tokenLimit !== null) return amount(chosen.tokenLimit);
  const own = roleLimits?.[String(person.agentTier ?? 0)];
  return own ? `Role default · ${amount(own)}` : "Role default";
}
