// Every message row shows a time, and every list row a time or a day. Asking the date for its own local
// string (toLocaleTimeString, toLocaleDateString) builds a new formatter on every call: on the engine
// the phones run, about a tenth of a millisecond each on a fast device, two or three times per row,
// on the thread that draws the screen. One formatter per format is kept instead and reused; the words
// it gives are the same.
//
// A formatter remembers the locale, the 12 or 24 hour choice and the time zone it was made with, so
// the kept ones are remade when the zone's offset changes and, in any case, every minute: a change in
// the phone's settings shows the next time the app is looked at.

export const FORMATS = {
  /** 3:42 PM */
  time: { hour: "numeric", minute: "2-digit" },
  /** Friday */
  weekday: { weekday: "long" },
  /** Nov 2 */
  monthDay: { month: "short", day: "numeric" },
  /** Nov 2, 2025 */
  monthDayYear: { month: "short", day: "numeric", year: "numeric" },
  /** Friday, Nov 2 */
  weekdayMonthDay: { weekday: "long", month: "short", day: "numeric" },
  /** Friday, Nov 2, 2025 */
  weekdayMonthDayYear: { weekday: "long", month: "short", day: "numeric", year: "numeric" },
} as const satisfies Record<string, Intl.DateTimeFormatOptions>;
export type LocalFormat = keyof typeof FORMATS;

const KEEP_MS = 60_000;
let kept: { since: number; offset: number; formatters: Partial<Record<LocalFormat, Intl.DateTimeFormat>> } | null = null;

/** `date` in the device's own words, as toLocaleTimeString or toLocaleDateString would say it with the same options. */
export function localFormat(format: LocalFormat, date: Date, now = Date.now()): string {
  const offset = new Date(now).getTimezoneOffset();
  if (!kept || offset !== kept.offset || now - kept.since >= KEEP_MS || now < kept.since) kept = { since: now, offset, formatters: {} };
  return (kept.formatters[format] ??= new Intl.DateTimeFormat([], FORMATS[format])).format(date);
}
