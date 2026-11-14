// How many live events have touched each conversation, and how many times the stream started over.
// A request made a moment before its screen was listening compares the number before and after: if
// it moved, something may have been missed and the screen looks again (lib/conversation-cache.ts).
import type { LiveEvent } from "./server";

const touched = new Map<string, number>();
let restarts = 0;

export const liveEventCount = (conversationId: string) => restarts * 1_000_000 + (touched.get(conversationId) ?? 0);

export function countLiveEvent(e: LiveEvent) {
  if (e.event === "ready") { if (e.data.reset !== false) { restarts++; touched.clear(); } return; }
  const id = e.event === "message.created" || e.event === "message.updated" || e.event === "messages.read" ? e.data.conversationId
    : e.event === "conversation.updated" || e.event === "conversation.read" ? e.data.id : null;
  if (id) touched.set(id, (touched.get(id) ?? 0) + 1);
}
