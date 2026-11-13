import type { SavedMessage } from "./server.ts";
import type { Features } from "./features.ts";

export type SavedMessageFilter = "open" | "completed";

/** A delayed mutation response must never restore source text from before a deletion or access change. */
export function applySavedCompletion(items: readonly SavedMessage[], changed: SavedMessage): SavedMessage[] {
  return items.map(item => item.messageId === changed.messageId ? { ...item, completedAt: changed.completedAt } : item);
}

/** Feature flags hide the source without discarding the saved reference. */
export function visibleSavedMessages(items: readonly SavedMessage[], features: Features): SavedMessage[] {
  return items.map(item => !item.conversation
    || (item.conversation.kind === "channel" ? features.channels : features.directMessages)
    ? item : { ...item, message: null, conversation: null });
}

/** Newest saves first; completed items are ordered by the time they were checked off. */
export function savedMessagesFor(items: readonly SavedMessage[], filter: SavedMessageFilter): SavedMessage[] {
  return items.filter(item => (item.completedAt !== null) === (filter === "completed"))
    .sort((a, b) => (filter === "completed" ? b.completedAt! - a.completedAt! : b.savedAt - a.savedAt)
      || b.savedAt - a.savedAt || a.messageId.localeCompare(b.messageId));
}

/** A thread opens any message, including old top-level posts outside the recent conversation page. */
export function savedMessageHref(item: SavedMessage) {
  const { message, conversation } = item;
  if (!message || message.deleted || !conversation) return null;
  return {
    pathname: "/thread" as const,
    params: {
      conv: conversation.id,
      root: message.threadRoot ?? message.id,
      focus: message.id,
      from: "saved",
      title: `${conversation.kind === "channel" ? "#" : ""}${conversation.name}`,
    },
  };
}

export function savedMessagePreview(item: SavedMessage): string {
  if (!item.message || item.message.deleted || !item.conversation) return "This message is no longer available.";
  const text = item.message.text.trim();
  if (text) return text;
  const attachments = item.message.attachments ?? [];
  return attachments.length ? attachments.map(file => file.name).join(", ") : "Message";
}

/** Where a saved message is and who wrote it: "#launch · Pat Tester". A direct message from the person it is named after says the name once. */
export function savedMessageSource(item: SavedMessage): string | null {
  const { message, conversation } = item;
  if (!message || message.deleted || !conversation) return null;
  const place = `${conversation.kind === "channel" ? "#" : ""}${conversation.name}`;
  const parts = conversation.kind === "dm" && conversation.name === message.user.name ? [place] : [place, message.user.name];
  if (message.threadRoot) parts.push("Thread");
  return parts.join(" · ");
}
