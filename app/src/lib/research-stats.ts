// Planning statistics ported from Civic Research Studio v0.3.24 (src/abstats.js,
// ash-webb/research-studio, CC0). Pure functions, no dependencies. Keep these in
// step with Research Studio: its study builder computes the same numbers, and a
// plan drafted here should match what the researcher sees there.

// Inverse standard normal CDF (Acklam's rational approximation, |error| < 1.2e-9).
export function qnorm(p: number): number {
  if (!(p > 0 && p < 1)) return p === 0 ? -Infinity : p === 1 ? Infinity : NaN;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425, hi = 1 - lo;
  let q: number, r: number;
  if (p < lo) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  if (p > hi) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
  q = p - 0.5; r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export type WilsonInterval = { p: number; lo: number; hi: number; k: number; n: number };

// Wilson score interval: well behaved for small samples and rates near 0% or 100%.
export function wilson(k: number, n: number, conf = 0.95): WilsonInterval | null {
  if (!n || !(k >= 0) || k > n) return null;
  const z = qnorm(1 - (1 - conf) / 2), p = k / n, z2 = z * z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / (1 + z2 / n);
  return { p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half), k, n };
}

// People per design needed to detect a change from p1 to p2 (two-sided test of two proportions,
// normal approximation without continuity correction; Fleiss). alpha is per comparison.
export function sampleSizePerGroup(p1: number, p2: number, { alpha = 0.05, power = 0.8 } = {}): number | null {
  if (!(p1 >= 0 && p1 <= 1 && p2 >= 0 && p2 <= 1) || p1 === p2) return null;
  const za = qnorm(1 - alpha / 2), zb = qnorm(power), pbar = (p1 + p2) / 2;
  const n = (za * Math.sqrt(2 * pbar * (1 - pbar)) + zb * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))) ** 2 / (p1 - p2) ** 2;
  return Math.ceil(n);
}

export type AbPlanSize = { perDesign: number; total: number; alpha: number; confidence: number; power: number; target: number; direction: "up" | "down" };
export type PlanningDirection = "higher" | "lower" | "different";
// The planning direction decides which change the sample is sized to detect:
// "higher" plans baseline + difference, "lower" plans baseline − difference,
// and "different" plans whichever of the two needs more people. A direction
// whose target falls outside 0–100% has no plan (never a silently swapped one).
// The test itself stays two-sided. With more than two designs, each treatment
// is compared with the control at alpha ÷ (designs − 1) (Bonferroni).
// This differs from Research Studio v0.3.24, which ignored the direction.
export function planStudy({ baseline, difference, designs = 2, power = 0.8, alpha = 0.05, direction = "higher" }: { baseline: number; difference: number; designs?: number; power?: number; alpha?: number; direction?: PlanningDirection }): AbPlanSize | null {
  if (!(baseline > 0 && baseline < 1) || !(difference > 0 && difference < 1) || designs < 2) return null;
  const perComparison = designs <= 2 ? alpha : alpha / (designs - 1);
  const candidates = (direction === "higher" ? [baseline + difference] : direction === "lower" ? [baseline - difference] : [baseline + difference, baseline - difference])
    .filter(target => target > 0 && target < 1)
    .map(target => ({ target, n: sampleSizePerGroup(baseline, target, { alpha: perComparison, power }) }))
    .filter((c): c is { target: number; n: number } => !!c.n)
    .sort((a, b) => b.n - a.n);
  const best = candidates[0];
  if (!best) return null;
  return { perDesign: best.n, total: best.n * designs, alpha: perComparison, confidence: 1 - perComparison, power, target: best.target, direction: best.target > baseline ? "up" : "down" };
}

// Loss allowance: the share of recruits expected not to reach analysis (for
// A/B tests, people lost before randomization: screen-outs and technical
// failures). Recruiting n ÷ (1 − loss) "allows for" that loss; it is applied
// once, to the final target. Percent in, whole people out; integer arithmetic
// so 100 at 20% is exactly 125.
export const DEFAULT_LOSS_ALLOWANCE = 20;
export const MAX_LOSS_ALLOWANCE = 50;
export function allowingForLoss(n: number, lossPercent: number): number {
  if (!(n > 0) || !Number.isInteger(lossPercent) || lossPercent < 0 || lossPercent > MAX_LOSS_ALLOWANCE) return Math.ceil(n);
  return Math.ceil((n * 100) / (100 - lossPercent));
}

// People needed so a 95% interval around a rate near p is about ±margin wide (normal approximation).
export function sampleSizeForMargin(p: number, margin: number, conf = 0.95): number | null {
  if (!(p > 0 && p < 1) || !(margin > 0 && margin < 0.5)) return null;
  const z = qnorm(1 - (1 - conf) / 2);
  return Math.ceil(z * z * p * (1 - p) / (margin * margin));
}

// Half-width of the 95% Wilson interval for n people at rate p (for "with n people, about ±x").
export function marginAt(n: number, p = 0.5, conf = 0.95): number | null {
  if (!(n > 0)) return null;
  const w = wilson(Math.round(p * n), n, conf);
  return w ? (w.hi - w.lo) / 2 : null;
}

// Two options: people needed to tell a split of p (e.g. 0.6) from 50/50 (two-sided one-sample test).
export function sampleSizeVsHalf(p: number, { power = 0.8, alpha = 0.05 } = {}): number | null {
  if (!(p > 0 && p < 1) || p === 0.5) return null;
  const za = qnorm(1 - alpha / 2), zb = qnorm(power);
  return Math.ceil(((za * 0.5 + zb * Math.sqrt(p * (1 - p))) / (p - 0.5)) ** 2);
}
