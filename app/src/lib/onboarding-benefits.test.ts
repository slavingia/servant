import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_TIERS, TIER_TOKEN_LIMITS } from "../../../server/usage.mjs";
import { agentAccessLabel } from "./onboarding.ts";
import { USD_PER_M_OUTPUT } from "./token-format.ts";
import { AGENT_LEVELS, BENEFITS, FEATURE_EXAMPLE, MAX_USD_PER_M, agentLevel, benefitPage, capText, dailyLimitText, maxDailyDollars } from "./onboarding-benefits.ts";

test("agent levels and caps match the server", () => {
  const tiers = AGENT_LEVELS.map(level => level.tier).sort();
  assert.deepEqual(tiers, Object.keys(AGENT_TIERS).map(Number).sort());
  for (const level of AGENT_LEVELS) {
    assert.equal(level.dailyTokens, (TIER_TOKEN_LIMITS as Record<number, number>)[level.tier], `tier ${level.tier} limit`);
    assert.equal(level.label, agentAccessLabel(level.tier), `tier ${level.tier} label`);
  }
});

test("six short pages: in charge first, then a real example, evidence last", () => {
  assert.deepEqual(BENEFITS.map(b => b.id), ["charge", "example", "access", "cost", "data", "evidence"]);
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

test("the roadmap example's totals add up from its steps", () => {
  // Each time is "N wk(s)", "N–M wks", "N day(s)", "N–M days" or "N–M hrs"; five working days to a week, eight hours to a day.
  const days = (t: string) => {
    const m = t.match(/^(\d+)(?:–(\d+))? (wks?|days?|hrs?)$/);
    assert.ok(m, t);
    const per = m[3].startsWith("wk") ? 5 : m[3].startsWith("hr") ? 1 / 8 : 1;
    return [Number(m[1]) * per, Number(m[2] ?? m[1]) * per];
  };
  const sum = (key: "today" | "servant") => FEATURE_EXAMPLE.steps.reduce(([lo, hi], s) => { const [a, b] = days(s[key]); return [lo + a, hi + b]; }, [0, 0]);
  assert.deepEqual(sum("today").map(d => d / 5), [9, 11]);
  assert.equal(FEATURE_EXAMPLE.total.today, "9–11 wks");
  // 3 weeks unchanged plus about 5 to 8 days: about 4 to 5 weeks.
  const [lo, hi] = sum("servant");
  assert.ok(Math.round(lo / 5) === 4 && Math.round(hi / 5) === 5, `${lo}–${hi} days`);
  assert.equal(FEATURE_EXAMPLE.total.servant, "4–5 wks");
});
