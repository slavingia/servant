import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { LIMIT_CHOICES, chosenLimit, costNote, costWords, limitApplies, limitChange, limitRows, limitSummary, dailyCost, roleCostLine, unbroken } from "./token-limit.ts";

test("one list: the role's default, the server's steps, then no limit", () => {
  assert.deepEqual(LIMIT_CHOICES.map(c => c.label), ["Role default", "1M", "5M", "20M", "50M", "No limit"]);
  assert.equal(new Set(LIMIT_CHOICES.map(c => c.key)).size, LIMIT_CHOICES.length);
});

test("the steps are the ones the server accepts", () => {
  const usage = fs.readFileSync(path.join(import.meta.dirname, "../../../server/usage.mjs"), "utf8");
  const steps = usage.match(/TOKEN_LIMIT_CHOICES = \[([^\]]+)\]/)![1]!.split(",").map(n => Number(n.replace(/_/g, "").trim()));
  assert.deepEqual(LIMIT_CHOICES.filter(c => c.tokenLimit !== null).map(c => c.tokenLimit), steps);
});

test("a screen reader hears the amount in words, not a letter", () => {
  assert.equal(LIMIT_CHOICES.find(c => c.label === "1M")?.name, "1 million tokens a day");
  assert.equal(LIMIT_CHOICES.find(c => c.label === "50M")?.name, "50 million tokens a day");
  for (const c of LIMIT_CHOICES) assert.doesNotMatch(c.name, /\d+M\b|tier/i, c.name);
});

test("exactly one choice is the person's, and no limit wins over a step left behind", () => {
  assert.equal(chosenLimit({})?.key, "default");
  assert.equal(chosenLimit({ tokenLimit: 5_000_000 })?.label, "5M");
  assert.equal(chosenLimit({ unlimitedTokens: true })?.key, "none");
  assert.equal(chosenLimit({ tokenLimit: 5_000_000, unlimitedTokens: true })?.key, "none");
  assert.equal(chosenLimit({ tokenLimit: 123 }), null, "an unknown step is not shown as some other choice");
});

test("choosing a limit turns no limit off in the same request; choosing no limit leaves the step alone", () => {
  const pick = (key: string) => limitChange(LIMIT_CHOICES.find(c => c.key === key)!);
  assert.deepEqual(pick("default"), { unlimitedTokens: false, tokenLimit: null });
  assert.deepEqual(pick("20000000"), { unlimitedTokens: false, tokenLimit: 20_000_000 });
  assert.deepEqual(pick("none"), { unlimitedTokens: true });
});

test("no agent, nothing to limit", () => {
  assert.equal(limitApplies({}), false);
  assert.equal(limitApplies({ agentTier: 0 }), false);
  assert.equal(limitApplies({ agentTier: 4 }), true);
});

// The list only helps if the sheet uses it, and uses nothing else for the limit. Guard that wiring.
test("the person sheet offers the limit as that one list, with no separate switch", () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, "../app/(tabs)/members.tsx"), "utf8");
  assert.match(source, /limitRows\(managed, directory\?\.roleLimits, directory\?\.roleCosts\)\.map/);
  assert.doesNotMatch(source, /limitChip/, "a list like the roles, not a row of chips");
  assert.match(source, /limitApplies\(managed\)/, "hidden for someone with no agent");
  assert.doesNotMatch(source, /<Switch\b/, "no switch beside the list");
  assert.doesNotMatch(source, /Tier default/, "the sheet calls these roles, not tiers");
});

// The sheet has room to say what each limit means (the owner asked for that), from the numbers the server sends.
const roleLimits = { 0: 0, 1: 1_000_000, 2: 5_000_000, 3: 20_000_000, 4: 5_000_000, 5: 5_000_000 };

test("each limit says what it means for this person", () => {
  assert.deepEqual(limitRows({ agentTier: 2 }, roleLimits).map(row => [row.title, row.hint]), [
    ["Role default", "5 million tokens a day for a Business owner"],
    ["1 million tokens a day", "Tester default"],
    ["5 million tokens a day", "Business owner, Product manager and User researcher default"],
    ["20 million tokens a day", "Software engineer default"],
    ["50 million tokens a day", ""],
    ["No limit", "Never stops for the day"],
  ]);
  assert.equal(limitRows({ agentTier: 3 }, roleLimits)[0]!.hint, "20 million tokens a day for a Software engineer");
  assert.equal(limitRows({ agentTier: 2 })[0]!.hint, "The limit that comes with their role", "a server that does not send the numbers");
  assert.deepEqual(limitRows({ agentTier: 2 }).map(row => row.key), LIMIT_CHOICES.map(choice => choice.key), "the same choices, in the same order");
});

test("the closed section says the limit in one line", () => {
  assert.equal(limitSummary({ agentTier: 2 }, roleLimits), "Role default · 5M a day");
  assert.equal(limitSummary({ agentTier: 2 }), "Role default");
  assert.equal(limitSummary({ agentTier: 2, tokenLimit: 20_000_000 }, roleLimits), "20M a day");
  assert.equal(limitSummary({ agentTier: 2, tokenLimit: 20_000_000, unlimitedTokens: true }, roleLimits), "No limit");
  assert.equal(limitSummary({ agentTier: 2, tokenLimit: 3_500_000 }, roleLimits), "3.5M a day", "a step this build does not offer is still said");
});

// An owner sets a limit in tokens and pays in dollars, and the sheet said nothing about money. The server now sends
// roughly what each role's tokens cost, priced by the model that role's agent runs when the owner has said so.
const estimate = { model: null, input: 3, output: 15, priced: false, perMillion: 4.2 };
const roleCosts = { 1: estimate, 2: { model: "example-model", input: 1, output: 5, priced: true, perMillion: 1.4 }, 3: estimate, 4: estimate, 5: estimate };

test("each limit says about what a day of it costs, priced for this person's role", () => {
  assert.deepEqual(limitRows({ agentTier: 2 }, roleLimits, roleCosts).map(row => [row.title, row.hint]), [
    ["Role default", "5 million tokens a day for a Business owner, about $7 a day"],
    ["1 million tokens a day", "About $1.40 a day · Tester default"],
    ["5 million tokens a day", "About $7 a day · Business owner, Product manager and User researcher default"],
    ["20 million tokens a day", "About $28 a day · Software engineer default"],
    ["50 million tokens a day", "About $70 a day"],
    ["No limit", "Never stops for the day"],
  ]);
  // The same amounts on a dearer agent cost more: a Software engineer here is on the estimate, three times the price.
  assert.equal(limitRows({ agentTier: 3 }, roleLimits, roleCosts)[0]!.hint, "20 million tokens a day for a Software engineer, about $84 a day");
  assert.equal(limitRows({ agentTier: 3 }, roleLimits, roleCosts)[1]!.hint, "About $4.20 a day · Tester default");
  assert.equal(limitRows({ agentTier: 2 }, undefined, roleCosts)[0]!.hint, "The limit that comes with their role", "no amount to price");
});

test("the closed section adds the cost, and says nothing about money to a server that sends no price", () => {
  assert.equal(limitSummary({ agentTier: 2 }, roleLimits, roleCosts), "Role default · 5M, about $7 a day");
  assert.equal(limitSummary({ agentTier: 2, tokenLimit: 20_000_000 }, roleLimits, roleCosts), "20M, about $28 a day");
  assert.equal(limitSummary({ agentTier: 2, tokenLimit: 3_500_000 }, roleLimits, roleCosts), "3.5M, about $4.90 a day");
  assert.equal(limitSummary({ agentTier: 2, tokenLimit: 20_000_000, unlimitedTokens: true }, roleLimits, roleCosts), "No limit");
  assert.equal(limitSummary({ agentTier: 2 }, undefined, roleCosts), "Role default");
  assert.equal(limitSummary({ agentTier: 2 }, roleLimits), "Role default · 5M a day");
});

// The owner asked for a day's dollars, not a month's: the limit is a daily one.
test("an estimate is for one day, said in two figures, and not at all when there is nothing to go on", () => {
  assert.equal(dailyCost(5_000_000, estimate), 21);
  assert.equal(dailyCost(5_000_000, undefined), null);
  assert.equal(dailyCost(5_000_000, { ...estimate, perMillion: NaN }), null);
  assert.equal(dailyCost(5_000_000, { ...estimate, perMillion: -1 }), null);
  for (const [usd, words] of [[null, ""], [NaN, ""], [-1, ""], [0, "about $0 a day"], [0.04, "under $0.10 a day"], [0.4, "about $0.40 a day"], [1, "about $1 a day"], [2.8, "about $2.80 a day"],
    [4.2, "about $4.20 a day"], [9.96, "about $10 a day"], [12.6, "about $13 a day"], [21, "about $21 a day"], [84, "about $84 a day"], [126, "about $130 a day"], [2520, "about $2,500 a day"]] as const) {
    assert.equal(costWords(usd), words, String(usd));
  }
});

test("under each role: its own limit, about what that costs, and its agent's model when the owner named one", () => {
  assert.equal(roleCostLine(2, roleLimits, roleCosts), "5M tokens, about $7 a day · example-model");
  assert.equal(roleCostLine(3, roleLimits, roleCosts), "20M tokens, about $84 a day");
  assert.equal(roleCostLine(1, roleLimits, roleCosts), "1M tokens, about $4.20 a day");
  assert.equal(roleCostLine(0, roleLimits, roleCosts), "", "no agent, nothing to limit or price");
  assert.equal(roleCostLine(2, roleLimits), "5M tokens a day", "a server that sends limits but no prices");
  assert.equal(roleCostLine(2), "");
});

// In a 420-point sheet the line broke inside the model's name ("example-" then "large") and could leave "day" alone.
test("on screen that line wraps only between its parts", () => {
  const shown = unbroken("5M tokens, about $7 a day · example-model");
  assert.equal(shown, "5M tokens, about $7 a day · example‑model");
  assert.deepEqual(shown.split(" "), ["5M tokens, about $7 a day", "·", "example‑model"], "the only places it can break");
  assert.equal(unbroken("5M tokens a day"), "5M tokens a day");
  assert.equal(unbroken(""), "");
});

test("one sentence under the limits says what the dollar figures assume", () => {
  assert.equal(costNote(roleCosts[2]), "Dollar figures are rough: a day with the limit used in full, at the prices set for example-model ($1 per million tokens in and $5 out).");
  assert.equal(costNote(estimate), "Dollar figures are rough: a day with the limit used in full, at $3 per million tokens in and $15 out.");
  assert.equal(costNote({ model: null, input: 0.25, output: 1.5, priced: true, perMillion: 0.375 }), "Dollar figures are rough: a day with the limit used in full, at $0.25 per million tokens in and $1.50 out.");
  assert.equal(costNote({ ...estimate, model: "example-model" }), "Dollar figures are rough: a day with the limit used in full, at $3 per million tokens in and $15 out.", "a model with no price of its own is not said to have set these");
  assert.equal(costNote(undefined), "");
});

test("the person sheet shows the cost under each role, beside each limit, and what it assumes", () => {
  const source = fs.readFileSync(path.join(import.meta.dirname, "../app/(tabs)/members.tsx"), "utf8");
  assert.match(source, /roleCosts: result\.tierCosts/, "taken from what the server sends an owner");
  assert.match(source, /const cost = roleCostLine\(t\.tier, directory\?\.roleLimits, directory\?\.roleCosts\);/);
  assert.match(source, /\{cost \? <Text testID=\{`tier-cost-\$\{t\.tier\}`\} style=\{styles\.optionHint\}>\{unbroken\(cost\)\}<\/Text> : null\}/);
  assert.match(source, /accessibilityHint=\{\[t\.hint, cost\]\.filter\(Boolean\)\.join\("\. "\)\}/, "a screen reader hears it too");
  assert.match(source, /limitSummary\(managed, directory\?\.roleLimits, directory\?\.roleCosts\)/);
  assert.match(source, /<Text testID="limit-cost-note" style=\{\[styles\.sectionNote, styles\.sectionFootnote\]\}>\{costNote\(directory\?\.roleCosts\?\.\[String\(managed\.agentTier \?\? 0\)\]\)\}<\/Text>/);
});
