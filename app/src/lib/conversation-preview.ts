import type { Conversation } from "./server";

// The line under a conversation's name: who said it, then what they said. Every
// conversation names the sender, including a one-to-one DM, and "You" for your own.
export function conversationPreview(c: Pick<Conversation, "lastMessage">, me: string | undefined): string {
  const last = c.lastMessage;
  if (!last) return "No messages yet";
  if (last.deleted) return "Message deleted";
  const attachments = last.attachments?.length ?? 0;
  const body = last.pending && last.user.agent ? "Working on it…"
    : last.text || (attachments ? `${attachments} attachment${attachments === 1 ? "" : "s"}` : "Working on it…");
  if (last.activity) return body;
  return `${last.user.id === me ? "You" : last.user.name}: ${body}`;
}
