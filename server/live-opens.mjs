// How often one device may open the live connection (/v1/events).
//
// An app opens it once and keeps it. When the connection keeps being cut (a tunnel dropping, a server that is too
// busy), every open app reconnects, and each reconnect is followed by a round of refetching. Enough devices doing
// that at once keep the server too busy to hold a connection, which cuts them again: a loop that feeds itself.
// So a device that has opened the connection too many times in a minute is refused before any work is done for
// it, and told when to come back. Apps wait longer after each refusal, which lets the server catch up.
export const LIVE_OPENS_PER_MINUTE = 6;
const WINDOW_MS = 60_000;

/**
 * take(deviceId) answers { ok: true } and counts the open, or { ok: false, retryAfter } (whole seconds until the
 * oldest counted open leaves the window). Memory only; a restart forgets it, which is the generous direction.
 */
export function createLiveOpens({ perMinute = LIVE_OPENS_PER_MINUTE, clock = Date.now } = {}) {
  const opens = new Map();
  let swept = clock();
  const recent = (list, at) => list.filter(time => at - time < WINDOW_MS);
  return {
    take(deviceId) {
      const at = clock();
      // Forget devices that have been quiet, so the map stays the size of what is active.
      if (at - swept >= WINDOW_MS) { swept = at; for (const [id, list] of opens) if (!recent(list, at).length) opens.delete(id); }
      const key = String(deviceId || "");
      const list = recent(opens.get(key) || [], at);
      if (list.length >= perMinute) { opens.set(key, list); return { ok: false, retryAfter: Math.max(1, Math.ceil((WINDOW_MS - (at - list[0])) / 1000)) }; }
      list.push(at); opens.set(key, list);
      return { ok: true };
    },
    size: () => opens.size,
  };
}
