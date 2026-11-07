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

export type AbPlanSize = { perDesign: number; total: number; alpha: number; power: number; target: number; direction: "up" | "down" };

// The target is baseline + difference; when that would pass 100% the drop baseline − difference
// is planned instead (never a silently capped, impossible target).
export function planStudy({ baseline, difference, designs = 2, power = 0.8, alpha = 0.05 }: { baseline: number; difference: number; designs?: number; power?: number; alpha?: number }): AbPlanSize | null {
  if (!(baseline > 0 && baseline < 1) || !(difference > 0 && difference < 1)) return null;
  let target = baseline + difference;
  if (target >= 1) target = baseline - difference;
  if (!(target > 0 && target < 1)) return null;
  const perComparison = designs <= 2 ? alpha : alpha / (designs - 1);
  const n = sampleSizePerGroup(baseline, target, { alpha: perComparison, power });
  return n ? { perDesign: n, total: n * designs, alpha: perComparison, power, target, direction: target > baseline ? "up" : "down" } : null;
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
