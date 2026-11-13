// Dollars beside a daily token limit. An owner sets a limit in tokens and pays in dollars, and the person sheet
// gave no idea what 5 million tokens a day comes to.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { agentPrice, blendedPerMillion, DEFAULT_OUTPUT_SHARE, DEFAULT_ROLE_MODEL, DEFAULT_USD_PER_MILLION, KNOWN_MODELS, outputShare, tierCosts } from "./usage-cost.mjs";

const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? ""} ${actual} is not ${expected}`);

test("an agent is priced by what the owner says it costs, and by the usage report's estimate otherwise", () => {
  assert.deepEqual(agentPrice(undefined), { model: null, input: 3, output: 15, priced: false });
  assert.deepEqual(agentPrice({ url: "http://127.0.0.1:8642", key: "k" }), { model: null, input: 3, output: 15, priced: false });
  assert.deepEqual(agentPrice({ model: " example-model ", usdPerMillion: { input: 1, output: 5 } }), { model: "example-model", input: 1, output: 5, priced: true });
  assert.deepEqual(agentPrice({ usdPerMillion: { input: 0, output: 0 } }), { model: null, input: 0, output: 0, priced: true }, "a model that costs nothing is a price");
  // Half a price, or one that is not a sensible number, is no price: the estimate is used and says so.
  for (const usdPerMillion of [{ input: 1 }, { output: 5 }, { input: "1", output: 5 }, { input: -1, output: 5 }, { input: 1, output: NaN }, { input: 1, output: Infinity }, { input: 1, output: 10_001 }, null, "3/15", 3]) {
    assert.deepEqual(agentPrice({ model: "example-model", usdPerMillion }), { model: "example-model", input: 3, output: 15, priced: false }, JSON.stringify(usdPerMillion));
  }
  // The name is shown to owners: one line, not too long, and only if it is text.
  assert.equal(agentPrice({ model: "example\nmodel" }).model, "example model");
  assert.equal(agentPrice({ model: "x".repeat(200) }).model.length, 80);
  for (const model of ["", "   ", 7, null, {}, ["example-model"]]) assert.equal(agentPrice({ model }).model, null);
});

test("the estimate's default is the one the usage report already shows", () => {
  const report = fs.readFileSync(new URL("../app/src/lib/token-format.ts", import.meta.url), "utf8");
  assert.equal(Number(/USD_PER_M_INPUT = (\d+(?:\.\d+)?);/.exec(report)[1]), DEFAULT_USD_PER_MILLION.input);
  assert.equal(Number(/USD_PER_M_OUTPUT = (\d+(?:\.\d+)?);/.exec(report)[1]), DEFAULT_USD_PER_MILLION.output);
});

test("the share of output tokens comes from this server's own usage once there is enough of it", () => {
  assert.equal(DEFAULT_OUTPUT_SHARE, 0.1);
  for (const mix of [undefined, null, {}, { input: 0, output: 0 }, { input: 50_000, output: 49_999 }, { input: -5, output: 500_000 }, { input: "x", output: 1 }]) assert.equal(outputShare(mix), 0.1, JSON.stringify(mix));
  near(outputShare({ input: 600_000, output: 400_000 }), 0.4);
  near(outputShare({ input: 99_000, output: 1_000 }), 0.01, "exactly the minimum counts");
  near(outputShare({ input: 0, output: 200_000 }), 1);
});

test("a blended price weighs tokens in and out by that share", () => {
  near(blendedPerMillion({ input: 3, output: 15 }, 0.1), 4.2);
  near(blendedPerMillion({ input: 3, output: 15 }, 0), 3);
  near(blendedPerMillion({ input: 3, output: 15 }, 1), 15);
  near(blendedPerMillion({ input: 1, output: 5 }, 0.4), 2.6);
});

test("each role is priced by the agent it runs on: researchers on theirs, everyone else on the owner or the member agent", () => {
  const upstreams = {
    owner: { url: "u", key: "k", model: "example-large", usdPerMillion: { input: 5, output: 25 } },
    member: { url: "u", key: "k", model: "example-small", usdPerMillion: { input: 1, output: 5 } },
    researcher: { url: "u", key: "k" },
  };
  const full = tierCosts({ upstreams, laneOf: tier => tier === 4 ? "researcher" : "owner" });
  assert.deepEqual(Object.keys(full), ["1", "2", "3", "4", "5"], "every role with an agent, and not the role with none");
  for (const tier of [1, 2, 3, 5]) assert.deepEqual(full[tier], { model: "example-large", input: 5, output: 25, priced: true, perMillion: 7 }, `tier ${tier}`);
  assert.deepEqual(full[4], { model: "Claude Sonnet 5.5", input: 2, output: 10, priced: true, perMillion: 2.8 }, "a role whose agent says nothing is taken to run the default model");
  const limited = tierCosts({ upstreams, laneOf: tier => tier === 4 ? "researcher" : "member" });
  assert.deepEqual(limited[2], { model: "example-small", input: 1, output: 5, priced: true, perMillion: 1.4 });
  // This server's own mix replaces the assumed one.
  assert.equal(tierCosts({ upstreams, laneOf: () => "member", mix: { input: 600_000, output: 400_000 } })[1].perMillion, 2.6);
  // An agent that is not configured at all is still estimated, so the sheet never shows a blank.
  assert.deepEqual(tierCosts({ upstreams: {}, laneOf: () => "owner" })[3], { model: "Claude Sonnet 5.5", input: 2, output: 10, priced: true, perMillion: 2.8 });
  assert.deepEqual(tierCosts({ laneOf: () => "owner" })[3].perMillion, 2.8);
});

// The owner asked for every role to be priced as Claude Sonnet 5.5, and for their own agent (Claude Fable 5.2 and
// Claude Opus 5.5) to be priceable by name. Prices are the published ones; no discount is applied.
test("every role is priced as Claude Sonnet 5.5 until config.json says otherwise, and a known model prices itself", () => {
  assert.equal(DEFAULT_ROLE_MODEL, "claude-sonnet-5-5");
  assert.deepEqual(KNOWN_MODELS.map(m => [m.id, m.input, m.output]), [["claude-sonnet-5-5", 2, 10], ["claude-opus-5-5", 4, 20], ["claude-fable-5-2", 8, 40]]);
  const roles = tierCosts({ upstreams: { owner: { url: "u", key: "k" }, member: { url: "u", key: "k" } }, laneOf: tier => tier === 4 ? "researcher" : "member" });
  for (const tier of [1, 2, 3, 4, 5]) assert.deepEqual(roles[tier], { model: "Claude Sonnet 5.5", input: 2, output: 10, priced: true, perMillion: 2.8 }, `tier ${tier}`);
  // Naming a known model is enough, however the agent's profile spells it; the owner's spelling is what is shown.
  assert.deepEqual(agentPrice({ model: "claude-opus-5-5" }), { model: "claude-opus-5-5", input: 4, output: 20, priced: true });
  assert.deepEqual(agentPrice({ model: "anthropic/claude-fable-5-2" }), { model: "anthropic/claude-fable-5-2", input: 8, output: 40, priced: true });
  assert.deepEqual(agentPrice({ model: "Claude Sonnet 5.5" }), { model: "Claude Sonnet 5.5", input: 2, output: 10, priced: true });
  // The owner's own figures always win, over the list and over the default.
  assert.deepEqual(agentPrice({ model: "claude-opus-5-5", usdPerMillion: { input: 2, output: 10 } }), { model: "claude-opus-5-5", input: 2, output: 10, priced: true });
  assert.deepEqual(agentPrice({ usdPerMillion: { input: 1, output: 5 } }, DEFAULT_ROLE_MODEL), { model: null, input: 1, output: 5, priced: true }, "a price with no name is not given the default's name");
  // A model this file does not know is named and estimated, not passed off as the default.
  assert.deepEqual(agentPrice({ model: "example-model" }, DEFAULT_ROLE_MODEL), { model: "example-model", input: 3, output: 15, priced: false });
  // The owner's own agent is not a role: nothing is assumed about it.
  assert.deepEqual(agentPrice({ url: "u", key: "k" }), { model: null, input: 3, output: 15, priced: false });
});
