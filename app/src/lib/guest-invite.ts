// Pure helpers for the guest door in a call (components/GuestInvite.tsx): the share text, the
// knock banner and the short summary pill. No React, so they are tested on their own.
import type { MeetingGuests } from "./server";

/** The text that goes with the link when it is shared from a phone. */
export function guestShareMessage(url: string, hostName: string): string {
  const who = hostName.trim() || "Someone";
  return `${who} invited you to a meeting. Open this link in your browser to join: ${url}`;
}

/** The one knock the host should see right now, and how many more are behind it. */
export function knockBanner(pending: { id: string; name: string }[] | undefined, decided: ReadonlySet<string> = new Set()): { id: string; name: string; title: string; more: number } | null {
  const waiting = (pending ?? []).filter(p => !decided.has(p.id));
  const first = waiting[0];
  if (!first) return null;
  return { id: first.id, name: first.name, title: `${first.name} wants to join`, more: waiting.length - 1 };
}

/** "Guests · 2 · 1 waiting", or null when there is nothing to show. */
export function guestsSummary(g: Pick<MeetingGuests, "count" | "pendingCount"> | undefined, host: boolean): string | null {
  if (!g) return null;
  const parts: string[] = [];
  if (g.count) parts.push(g.count === 1 ? "1 guest" : `${g.count} guests`);
  if (host && g.pendingCount) parts.push(`${g.pendingCount} waiting`);
  return parts.length ? parts.join(" · ") : null;
}

/** What "Invite guests" does once there is a link: copy on a computer, share sheet on a phone. */
export function inviteLabel(hasLink: boolean, copied: boolean, web: boolean): string {
  if (copied) return "Link copied";
  if (!hasLink) return "Invite guests";
  return web ? "Copy guest link" : "Share guest link";
}
