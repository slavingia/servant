import type { Loop, LoopGroup } from "./server";

export const GROUPS: { key: LoopGroup; title: string }[] = [
  { key: "hourly", title: "Every hour or more often" },
  { key: "daily", title: "Every day" },
  { key: "weekly", title: "Every week" },
  { key: "monthly", title: "Every month" },
  { key: "other", title: "Other schedules" },
];

/** "in 5 minutes", "in 3 hours", "tomorrow at 7am"; the same for the past. */
export function relativeTime(at: number, now: number): string {
  const diff = at - now, abs = Math.abs(diff), minutes = Math.round(abs / 60000);
  if (abs < 45_000) return "just now";
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  let span: string;
  if (minutes < 60) span = unit(minutes, "minute");
  else if (minutes < 60 * 48) span = unit(Math.round(minutes / 60), "hour");
  else span = unit(Math.round(minutes / 1440), "day");
  return diff >= 0 ? `in ${span}` : `${span} ago`;
}

/** Plain line under a loop's name: when it last ran and runs next. */
export function loopDetail(loop: Loop, now: number): string {
  if (!loop.on) return loop.lastRunAt ? `Paused · last ran ${relativeTime(loop.lastRunAt, now)}` : "Paused";
  const parts: string[] = [];
  if (loop.lastRunAt) parts.push(loop.lastOk === false ? `Last run had a problem ${relativeTime(loop.lastRunAt, now)}` : `Last ran ${relativeTime(loop.lastRunAt, now)}`);
  if (loop.nextRunAt) parts.push(`next ${relativeTime(loop.nextRunAt, now)}`);
  const line = parts.join(", ");
  return line ? line[0].toUpperCase() + line.slice(1) : "Waiting for its first run";
}

export function groupLoops(loops: Loop[]): { key: LoopGroup; title: string; loops: Loop[] }[] {
  return GROUPS.map(g => ({ ...g, loops: loops.filter(l => l.group === g.key) })).filter(g => g.loops.length > 0);
}
