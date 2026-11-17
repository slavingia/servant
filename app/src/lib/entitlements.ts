// The Entitlements screen's words and rules (docs/entitlements.md). The server decides; this says what to show.
import type { Entitlement, EntitlementStanding } from "./server.ts";

/** One line about where you stand on an entitlement. */
export function standingLine(mine: EntitlementStanding | null, managerName: string | null): string {
  if (!mine) return "";
  const who = managerName || "an owner";
  switch (mine.status) {
    case "granted": return "You have this";
    case "requested": return `Waiting for ${who}`;
    case "denied": return mine.reason ? `Declined: ${mine.reason}` : "Declined";
    case "revoked": return mine.reason ? `Taken back: ${mine.reason}` : "Taken back";
  }
}

/** You can ask when you never did, or after a refusal or a revocation. */
export const canAsk = (mine: EntitlementStanding | null) => !mine || mine.status === "denied" || mine.status === "revoked";
export const askLabel = (mine: EntitlementStanding | null) => (mine ? "Ask again" : "Ask for this");

/** The requests that are yours to decide, oldest first, each with its entitlement. */
export function waitingOnYou(entitlements: readonly Entitlement[]): { entitlement: Entitlement; request: EntitlementStanding }[] {
  return entitlements.flatMap(entitlement => entitlement.people.filter(p => p.status === "requested").map(request => ({ entitlement, request })))
    .sort((a, b) => a.request.requestedAt - b.request.requestedAt);
}

/** The people who hold an entitlement, among those you decide for. */
export const holders = (entitlement: Entitlement) => entitlement.people.filter(p => p.status === "granted");

/** Hosts as typed, one per line or separated by commas or spaces: trimmed, lowercased, a pasted address reduced to its host, no repeats. */
export function parseHosts(text: string): string[] {
  const hosts: string[] = [];
  for (const raw of text.split(/[\s,]+/)) {
    const host = raw.trim().toLowerCase().replace(/^[a-z]+:\/\//, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "").replace(/\.$/, "");
    if (host && !hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}

/** What an entitlement opens, in words. */
export function hostsLine(hosts: readonly string[]): string {
  if (!hosts.length) return "Opens no hosts yet";
  return `Opens ${hosts.join(", ")}`;
}

/** A refused host, for the owner's list: "Pat Tester · api.example.gov · 3 tries". */
export const refusedLine = (r: { name: string; host: string; attempts: number }) => `${r.name} · ${r.host} · ${r.attempts} ${r.attempts === 1 ? "try" : "tries"}`;
