// The Meetings screen: one list for everything the person can see, newest first.
// Calls the server hosted (meetings.mjs) and recordings made in the room
// (recordings.mjs) come from different tables; this merges their summaries
// into one shape so the app shows them side by side.
//
// Item: { kind: "call" | "recording", id, title, startedAt, endedAt, durationMs,
//         status, summary, people: [{ id, name }], peopleCount, openSteps, conversationId, error }

/** Live calls first (so Join is at the top), then newest first. */
export function mergeMeetingList(...groups) {
  const items = groups.flat().filter(Boolean);
  return items.sort((a, b) => {
    const liveA = a.status === "live" ? 1 : 0, liveB = b.status === "live" ? 1 : 0;
    if (liveA !== liveB) return liveB - liveA;
    return (b.startedAt || 0) - (a.startedAt || 0) || String(a.id).localeCompare(String(b.id));
  });
}
