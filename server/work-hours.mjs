// Work hours: during the workday Servant reminds people that official
// business belongs in Microsoft Teams. Posting stays open; the app shows the
// reminder above the text box. Configured per instance with "workHours" in
// config.json; absent means no reminder.
const DEFAULTS = { start: "08:30", end: "16:30", timeZone: "America/New_York", days: [1, 2, 3, 4, 5] };
const DAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const minutes = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm));
  if (!m || +m[1] > 24 || +m[2] > 59) throw new Error(`workHours time must be HH:MM, got ${hhmm}`);
  return +m[1] * 60 + +m[2];
};

export function workHoursConfig(raw) {
  if (!raw || raw.enabled === false) return null;
  const rule = { ...DEFAULTS, ...raw };
  minutes(rule.start), minutes(rule.end);
  new Intl.DateTimeFormat("en-US", { timeZone: rule.timeZone }); // throws on an unknown zone
  return rule;
}

export function postingClosed(rule, at = Date.now()) {
  if (!rule) return false;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: rule.timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(at).map((p) => [p.type, p.value]),
  );
  if (!rule.days.includes(DAY[parts.weekday])) return false;
  const now = +parts.hour * 60 + +parts.minute;
  return now >= minutes(rule.start) && now < minutes(rule.end);
}

const clock = (hhmm) => {
  const t = minutes(hhmm), h = Math.floor(t / 60) % 24, m = t % 60;
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "am" : "pm"}`;
};

export function workHoursMessage(rule) {
  const weekdays = [1, 2, 3, 4, 5].every((d) => rule.days.includes(d)) && rule.days.length === 5 ? " on weekdays" : "";
  return `Work hours (${clock(rule.start)} to ${clock(rule.end)}${weekdays}): use Microsoft Teams for official business.`;
}

// What the app shows above the text box right now, or null.
export function workHoursNotice(rule, at = Date.now()) {
  return postingClosed(rule, at) ? { message: workHoursMessage(rule) } : null;
}
