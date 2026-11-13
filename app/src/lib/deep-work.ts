// Deep work (server/deep-work.mjs, docs/features.md "Deep work"): your own quiet mode, kept on the server against
// you, so every device you use agrees. While it is on, the app hides channels, direct messages and
// meetings and the secure inbox (features.ts withDeepWork) and lands on the agent; everyone else sees "Deep work" as your
// status; messages still arrive and count as unread, but nothing rings or buzzes. It ends only when you
// switch it off, and then the calls and meeting invites that didn't ring are listed once.

/** A call or meeting invite that didn't ring while deep work was on (server: meetings.mjs missedSince). */
export type MissedCall = { id: string; conversationId: string; place: string; by: { id: string; name: string }; startedAt: number; live: boolean };

/** The server's word on the switch: on only when it says exactly `true`. An older server says nothing, meaning off. */
export const deepWorkFromServer = (raw: unknown): boolean => raw === true;

/** The missed list as the server sent it, dropping anything malformed; an older server sends none. */
export function normalizeMissed(raw: unknown): MissedCall[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(item => {
    const m = item as Partial<MissedCall> | null;
    if (!m || typeof m.id !== "string" || typeof m.conversationId !== "string" || typeof m.by?.name !== "string" || typeof m.startedAt !== "number") return [];
    return [{ id: m.id, conversationId: m.conversationId, place: typeof m.place === "string" ? m.place : "", by: { id: typeof m.by.id === "string" ? m.by.id : "", name: m.by.name }, startedAt: m.startedAt, live: m.live === true }];
  });
}

/**
 * One line per missed call, read after deep work has ended: a missed call from whom, or a meeting that started
 * where. One still going says so (its row offers Join) instead of reading as if it were ringing now.
 */
export function missedLabel(m: MissedCall): string {
  if (m.place) return m.live ? `Meeting in ${m.place}, still going` : `Meeting started in ${m.place}`;
  return m.live ? `Missed call from ${m.by.name}, still going` : `Missed call from ${m.by.name}`;
}

/** The line under it: when, and for a meeting who started it (its first line names only the channel). */
export function missedDetail(m: MissedCall, time: string): string {
  return m.place ? `${m.by.name} · ${time}` : time;
}

export const MISSED_TITLE = "Missed while in deep work";
export const DEEP_WORK_HINT = "Hides channels, direct messages, meetings and the secure inbox. Messages still arrive, nothing rings or buzzes, and others see you're in deep work. Your agent and projects stay.";
