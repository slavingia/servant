// Roughly what a daily token limit comes to in dollars, for the owner's person sheet.
//
// A role's limit is a number of tokens; an owner thinks in money. Each role runs on one of the server's agents
// (owner, member or researcher: `upstreams` in config.json), and each agent runs whatever model its own profile
// names. The server cannot see that model, so the owner may say it here, with what it costs:
//
//   "upstreams": { "owner": { "url": "…", "key": "…", "model": "example-model", "usdPerMillion": { "input": 3, "output": 15 } } }
//
// A model this file knows (KNOWN_MODELS) needs no `usdPerMillion`. A role whose agent has neither field is
// taken to run DEFAULT_ROLE_MODEL. Anything else uses the same figures the usage report does and names no
// model. Nothing here changes a limit or what an agent runs; these two fields only price an estimate.
import { AGENT_TIERS } from "./usage.mjs";

// The usage report's estimate (app/src/lib/token-format.ts): dollars per million tokens in and out.
export const DEFAULT_USD_PER_MILLION = { input: 3, output: 15 };
// A limit counts tokens in and out together, and the two cost differently. Until this server has enough usage of
// its own to go by, one token in ten is taken to be output.
export const DEFAULT_OUTPUT_SHARE = 0.1;
const MIX_MINIMUM = 100_000;
const MAX_PRICE = 10_000;

const price = value => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_PRICE ? value : null;

// Published prices for the models this project's owner runs, in dollars per million tokens in and out, so that
// naming one of them is enough to price it. Anthropic's own API rates as of 2026-11; no discount is applied.
// Another provider, a reseller or an agreed rate differs: say so with `usdPerMillion`.
export const KNOWN_MODELS = [
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", input: 2, output: 10 },
  { id: "claude-opus-5-5", name: "Claude Opus 5.5", input: 4, output: 20 },
  { id: "claude-fable-5-2", name: "Claude Fable 5.2", input: 8, output: 40 },
];
// What a role's agent is taken to run until config.json says otherwise. A role is only ever given to someone
// other than the owner, and the owner has no daily limit to price, so this never describes the owner's own work.
export const DEFAULT_ROLE_MODEL = "claude-sonnet-5-5";
const known = model => { const key = String(model || "").toLowerCase().replace(/[^a-z0-9]+/g, "-"); return KNOWN_MODELS.find(m => key.includes(m.id) || key.includes(m.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"))) || null; };

/**
 * What one agent costs, and the model if known. The owner's own figures win; a named model this file knows is
 * priced from the list; with nothing said about the agent, `assumed` (a model from the list) is used when given;
 * anything else gets the usage report's estimate.
 */
export function agentPrice(up, assumed = "") {
  const input = price(up?.usdPerMillion?.input), output = price(up?.usdPerMillion?.output);
  const own = input !== null && output !== null;
  const named = typeof up?.model === "string" ? up.model.replace(/[\u0000-\u001F\u007F]+/g, " ").trim().slice(0, 80) : "";
  if (own) return { model: named || null, input, output, priced: true };
  const listed = named ? known(named) : assumed ? known(assumed) : null;
  if (listed) return { model: named || listed.name, input: listed.input, output: listed.output, priced: true };
  return { model: named || null, input: DEFAULT_USD_PER_MILLION.input, output: DEFAULT_USD_PER_MILLION.output, priced: false };
}

/** The share of tokens that were output, from this server's own recent totals when there are enough of them. */
export function outputShare(mix) {
  const input = Number(mix?.input) || 0, output = Number(mix?.output) || 0;
  if (input < 0 || output < 0 || input + output < MIX_MINIMUM) return DEFAULT_OUTPUT_SHARE;
  return output / (input + output);
}

/** Dollars per million tokens when `share` of them are output. */
export const blendedPerMillion = (cost, share) => cost.input * (1 - share) + cost.output * share;

/**
 * For each role with an agent: the model its agent runs (if named), that agent's prices, and the blended dollars
 * per million tokens. `laneOf(tier)` says which agent a role runs on; `mix` is the recent input and output totals.
 */
export function tierCosts({ upstreams = {}, laneOf, mix }) {
  const share = outputShare(mix);
  const costs = {};
  for (const tier of Object.keys(AGENT_TIERS).map(Number)) {
    if (tier === 0) continue;
    const cost = agentPrice(upstreams[laneOf(tier)], DEFAULT_ROLE_MODEL);
    costs[tier] = { model: cost.model, input: cost.input, output: cost.output, priced: cost.priced, perMillion: Math.round(blendedPerMillion(cost, share) * 1000) / 1000 };
  }
  return costs;
}
