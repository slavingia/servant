import { DESTINATIONS } from "./destinations.ts";
import { ALL_FEATURES, anyTalk, type FeatureName, type Features } from "./features.ts";

// `needs`: a server feature (features.ts) without which the shortcut would be a dead link; "talk" means channels or DMs.
export type Shortcut = { id: string; title: string; detail: string; path: string; keywords: string; owner?: boolean; needs?: FeatureName | "talk" };

// A place from the one list (destinations.ts), under the name it has everywhere.
const place = (id: string): Shortcut => {
  const found = DESTINATIONS.find(item => item.id === id)!;
  return { id: found.id, title: found.label, detail: found.detail, path: found.path, keywords: found.keywords, ...(found.needs ? { needs: found.needs } : {}), ...(found.owner ? { owner: true } : {}) };
};
// Search shows the first four before anything is typed, so two things to start and the two everyday places lead.
const LEADING = ["agent", "members"];

// In the order they are offered: what to start, then every place, then settings. Every place is found by its name.
const shortcuts: Shortcut[] = [
  { id: "new-message", title: "New message", detail: "Start a direct or group conversation", path: "/new-message", keywords: "create compose dm", needs: "directMessages" },
  { id: "new-channel", title: "New channel", detail: "Make a space for a team", path: "/new-channel", keywords: "create team", needs: "channels" },
  { ...place("agent"), title: "Ask the agent", detail: "Open your private agent chats" },
  place("members"),
  ...DESTINATIONS.filter(item => !LEADING.includes(item.id)).map(item => place(item.id)),
  { id: "notifications", title: "Notifications", detail: "Manage alerts and message previews", path: "/notifications", keywords: "settings preferences pause alerts" },
  { id: "you", title: "Your settings", detail: "Account, preferences, and help", path: "/you", keywords: "you profile settings account feedback" },
];

export function matchesQuery(query: string, ...values: (string | null | undefined)[]) {
  const terms = query.normalize("NFKC").trim().toLowerCase().replace(/^[#@]/, "").split(/\s+/).filter(Boolean);
  const text = values.filter(Boolean).join(" ").normalize("NFKC").toLowerCase();
  return terms.every(term => text.includes(term));
}

const offered = (item: Shortcut, features: Features) => !item.needs || (item.needs === "talk" ? anyTalk(features) : features[item.needs]);

export function omnibarShortcuts(query: string, owner: boolean, features: Features = ALL_FEATURES) {
  return shortcuts.filter(item => (!item.owner || owner) && offered(item, features) && matchesQuery(query, item.title, item.detail, item.keywords));
}

// Filters the server understands (server/search.mjs): they narrow messages, so with one typed only messages
// are listed. `words` is what is left to find.
const SEARCH_FILTER = /^(?:in|from):.+$|^has:(?:links?|files?|attachments?)$|^is:threads?$/i;
export const SEARCH_FILTERS_HINT = "Narrow messages with in:#channel, from:@name, has:link, has:file or is:thread.";
export function splitSearch(query: string): { words: string; filtered: boolean } {
  const parts = query.normalize("NFKC").match(/"[^"]*"|\S+/g) ?? [];
  const words = parts.filter(part => !SEARCH_FILTER.test(part));
  return { words: words.join(" ").replace(/"/g, "").trim(), filtered: words.length !== parts.length };
}

// Keep the match visible even when a message is longer than the result preview.
export function searchExcerpt(text: string, query: string, length = 160) {
  const flattened = text.replace(/\s+/g, " ").trim();
  const match = flattened.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase());
  const start = match > 48 ? match - 48 : 0;
  const fragment = flattened.slice(start, start + length);
  return `${start ? "…" : ""}${fragment}${start + length < flattened.length ? "…" : ""}`;
}
