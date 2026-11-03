const RECENT_MS = 14 * 60 * 60_000;

// Short list/message timestamp. Anything from today, or from the last 14 hours,
// shows the clock time so a message sent at 11 PM doesn't flip to "Nov 2" at midnight.
export function shortTime(at: number, now = Date.now()) {
  const date = new Date(at);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString() || Math.abs(now - at) < RECENT_MS) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric", ...(date.getFullYear() !== today.getFullYear() ? { year: "numeric" as const } : {}) });
}
