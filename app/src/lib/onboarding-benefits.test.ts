import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_TIERS, TIER_TOKEN_LIMITS } from "../../../server/usage.mjs";
import { agentAccessLabel } from "./onboarding.ts";
import { USD_PER_M_OUTPUT } from "./token-format.ts";
import { AGENT_LEVELS, BENEFITS, MAX_USD_PER_M, agentLevel, benefitPage, capText, dailyLimitText, maxDailyDollars } from "./onboarding-benefits.ts";

test("agent levels and caps match the server", () => {
  const tiers = AGENT_LEVELS.map(level => level.tier).sort();
  assert.deepEqual(tiers, Object.keys(AGENT_TIERS).map(Number).sort());
  for (const level of AGENT_LEVELS) {
    assert.equal(level.dailyTokens, (TIER_TOKEN_LIMITS as Record<number, number>)[level.tier], `tier ${level.tier} limit`);
    assert.equal(level.label, agentAccessLabel(level.tier), `tier ${level.tier} label`);
  }
});

test("five short pages, in charge first and time saved last", () => {
  assert.deepEqual(BENEFITS.map(b => b.id), ["charge", "access", "cost", "data", "time"]);
  for (const b of BENEFITS) {
    const text = `${b.title} ${b.lead} ${b.points.join(" ")}`;
    assert.doesNotMatch(text, /complian|certif|FedRAMP|\bATO\b|secure/i);
    // Plain words for people new to AI: no tool names or jargon.
    assert.doesNotMatch(text, /token|GitHub|\bgit\b|PowerShell|Jira|agent/i, b.id);
    assert.ok(b.title.length <= 40, `${b.id} title`);
    assert.ok(b.lead.length <= 60, `${b.id} lead`);
    assert.ok(b.points.length <= 2 && b.points.every(p => p.length <= 55), `${b.id} points`);
  }
});

test("page index is clamped", () => {
  assert.equal(benefitPage(-1), 0);
  assert.equal(benefitPage(2.7), 2);
  assert.equal(benefitPage(99), BENEFITS.length - 1);
  assert.equal(benefitPage(Number.NaN), 0);
});

test("caps are shown in dollars, as a ceiling", () => {
  // $15 per million output tokens, the app's list-price estimate.
  assert.equal(MAX_USD_PER_M, USD_PER_M_OUTPUT);
  assert.equal(maxDailyDollars(1_000_000), 15);
  assert.equal(maxDailyDollars(5_000_000), 75);
  assert.equal(maxDailyDollars(20_000_000), 300);
  assert.equal(capText(0), "—");
  assert.equal(capText(5_000_000), "up to $75/day");
  assert.equal(dailyLimitText(4, false), "Your cap: about $75 a day at most");
  assert.equal(dailyLimitText(3, true), "You're the owner: no daily cap");
  assert.match(dailyLimitText(0, false) ?? "", /No AI access yet/);
  assert.equal(dailyLimitText(null, false), null);
  assert.equal(agentLevel(7), null);
});
