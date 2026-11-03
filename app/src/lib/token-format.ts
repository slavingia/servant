// "950", then "9.5K", "12.3K", "4.5M" — one style down a leaderboard column.
export function formatTokens(n: number): string {
  const value = Math.max(0, Math.round(Number(n) || 0));
  if (value < 1_000) return value.toString();
  if (value < 1_000_000) return `${trim(value / 1000)}K`;
  if (value < 1_000_000_000) return `${trim(value / 1_000_000)}M`;
  return `${trim(value / 1_000_000_000)}B`;
}
function trim(x: number) {
  return (x >= 100 ? Math.round(x).toString() : x.toFixed(1).replace(/\.0$/, ""));
}
// Share of the org total as a whole percent, never "0%" for a nonzero share.
export function sharePercent(part: number, total: number): string {
  if (!total || !part) return "0%";
  const pct = (part / total) * 100;
  return pct < 1 ? "<1%" : `${Math.round(pct)}%`;
}
