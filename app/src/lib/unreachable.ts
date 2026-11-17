// The server could not be reached at all (no network, the tunnel or the Mac is down). Shown once, in the red bar
// at the very top (components/OfflineBanner.tsx), not as a line on each screen.
export const UNREACHABLE_MESSAGE = "The server isn't reachable right now";

// lib/server.ts says so with that message (no response) or code "unreachable" (a tunnel error page). The live
// stream calls fetch directly, so a dropped network reaches it as fetch's own TypeError. Other ServerErrors that
// carry the default "network" code ("Request cancelled", "No live updates") are not the server going away.
export function isUnreachable(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if ((e as { code?: unknown }).code === "unreachable" || e.message === UNREACHABLE_MESSAGE) return true;
  return e.name === "TypeError" && /fetch|network|load failed|internet/i.test(e.message);
}
