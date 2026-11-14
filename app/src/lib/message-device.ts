export type SourceDevice = { kind: "mobile" | "computer" | "web" | "agent" | "unknown"; label: string };
type MessageDevice = { sourceDevice?: unknown; role?: string; user?: { agent?: boolean }; activity?: string; pending?: boolean };
type GroupedPost = MessageDevice & { user: { id: string; agent?: boolean }; createdAt: number; replyCount?: number };

const labels = { mobile: "Mobile", computer: "Computer", web: "Browser", agent: "Posted by agent" } as const;

// Render canonical labels only. Older records and unknown device kinds never
// inherit the sender's current device or an arbitrary client-supplied name.
export function parseSourceDevice(value: unknown): SourceDevice | undefined {
  if (!value || typeof value !== "object") return undefined;
  const kind = (value as { kind?: unknown }).kind;
  if (kind !== "mobile" && kind !== "computer" && kind !== "web" && kind !== "agent") return undefined;
  return { kind, label: labels[kind] };
}

/** What the server says of a message sent from this kind of device, for a message shown before the server has answered. */
export const sourceDeviceOf = (kind: "mobile" | "computer" | "web"): SourceDevice => ({ kind, label: labels[kind] });

export function messageDeviceLabel(viewerRole: string | undefined, message: MessageDevice): string | null {
  if (message.user?.agent || message.activity || message.pending || (message.role && message.role !== "user")) return null;
  const device = parseSourceDevice(message.sourceDevice);
  // Mobile, computer and browser are the owner's. "Posted by agent" is shown to everyone: readers need to know
  // the message was written by an agent signed in as that person, not typed by them.
  return device && (device.kind === "agent" || viewerRole === "owner") ? device.label : null;
}

// A device-category switch starts a new author group for the owner. Members
// retain their ordinary grouping even if a stale cached payload has metadata.
export function canCompactPost(above: GroupedPost | undefined, current: GroupedPost, viewerRole?: string): boolean {
  if (!above || above.activity || current.activity || above.replyCount || above.user.id !== current.user.id) return false;
  const elapsed = current.createdAt - above.createdAt;
  return elapsed >= 0 && elapsed < 5 * 60 * 1000
    && new Date(current.createdAt).toDateString() === new Date(above.createdAt).toDateString()
    && messageDeviceLabel(viewerRole, above) === messageDeviceLabel(viewerRole, current);
}
