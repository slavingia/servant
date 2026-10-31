export type Shortcut = { id: string; title: string; detail: string; path: "/new-message" | "/new-channel" | "/agent" | "/members" | "/archived-channels" | "/notifications" | "/invite" | "/you"; keywords: string; owner?: boolean };

const shortcuts: Shortcut[] = [
  { id: "new-message", title: "New message", detail: "Start a direct or group conversation", path: "/new-message", keywords: "create compose dm" },
  { id: "new-channel", title: "New channel", detail: "Make a space for a team or topic", path: "/new-channel", keywords: "create team topic" },
  { id: "agent", title: "Ask the agent", detail: "Open your private agent chats", path: "/agent", keywords: "assistant ai help" },
  { id: "members", title: "Find a teammate", detail: "Browse the member directory", path: "/members", keywords: "people members directory" },
  { id: "archive", title: "Archived channels", detail: "Browse past conversations", path: "/archived-channels", keywords: "archive restore" },
  { id: "notifications", title: "Notifications", detail: "Manage alerts and message previews", path: "/notifications", keywords: "settings preferences pause alerts" },
  { id: "invite", title: "Invite teammates", detail: "Share an invite to your server", path: "/invite", keywords: "people invite join link", owner: true },
  { id: "you", title: "Your settings", detail: "Account, preferences, and help", path: "/you", keywords: "you profile settings account feedback" },
];

export function matchesQuery(query: string, ...values: (string | null | undefined)[]) {
  const terms = query.normalize("NFKC").trim().toLowerCase().replace(/^[#@]/, "").split(/\s+/).filter(Boolean);
  const text = values.filter(Boolean).join(" ").normalize("NFKC").toLowerCase();
  return terms.every(term => text.includes(term));
}

export function omnibarShortcuts(query: string, owner: boolean) {
  return shortcuts.filter(item => (!item.owner || owner) && matchesQuery(query, item.title, item.detail, item.keywords));
}

// Keep the match visible even when a message is longer than the result preview.
export function searchExcerpt(text: string, query: string, length = 160) {
  const flattened = text.replace(/\s+/g, " ").trim();
  const match = flattened.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase());
  const start = match > 48 ? match - 48 : 0;
  const fragment = flattened.slice(start, start + length);
  return `${start ? "…" : ""}${fragment}${start + length < flattened.length ? "…" : ""}`;
}
