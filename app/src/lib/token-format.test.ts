import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateCost, formatCost, formatTokens, sharePercent } from "./token-format.ts";

test("formatTokens stays short and readable", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(950), "950");
  assert.equal(formatTokens(9_504), "9.5K");
  assert.equal(formatTokens(12_345), "12.3K");
  assert.equal(formatTokens(250_000), "250K");
  assert.equal(formatTokens(4_500_000), "4.5M");
  assert.equal(formatTokens(2_000_000_000), "2B");
  assert.equal(formatTokens(-5), "0");
});

test("sharePercent never rounds a real share down to zero", () => {
  assert.equal(sharePercent(0, 100), "0%");
  assert.equal(sharePercent(1, 1000), "<1%");
  assert.equal(sharePercent(333, 1000), "33%");
  assert.equal(sharePercent(5, 0), "0%");
});

test("estimated cost uses list prices and formats small and large amounts", () => {
  assert.equal(estimateCost(1_000_000, 1_000_000), 18);
  assert.equal(formatCost(estimateCost(0, 0)), "$0");
  assert.equal(formatCost(0.004), "<$0.01");
  assert.equal(formatCost(18), "$18.00");
  assert.equal(formatCost(1234.5), "$1,235");
});
