import { localFormat } from "./local-format.ts";

const RECENT_MS = 24 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

// Calendar days between `at` and `now` (0 = today, 1 = yesterday).
function daysAgo(date: Date, today: Date) {
  return Math.round((startOfDay(today) - startOfDay(date)) / DAY_MS);
}

// "Yesterday", a weekday ("Friday") for the past week, otherwise "Nov 2" (with the year when it differs).
export function dayLabel(at: number, now = Date.now()) {
  const date = new Date(at);
  const today = new Date(now);
  const ago = daysAgo(date, today);
  if (ago === 0) return "Today";
  if (ago === 1) return "Yesterday";
  if (ago > 1 && ago < 7) return localFormat("weekday", date);
  return localFormat(date.getFullYear() !== today.getFullYear() ? "monthDayYear" : "monthDay", date);
}

// Short list/message timestamp. Anything from today, or from the last 24 hours,
// shows the clock time so a message sent at 11 PM doesn't flip to "Yesterday" at midnight.
export function shortTime(at: number, now = Date.now()) {
  const date = new Date(at);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString() || Math.abs(now - at) < RECENT_MS) {
    return localFormat("time", date);
  }
  return dayLabel(at, now);
}
