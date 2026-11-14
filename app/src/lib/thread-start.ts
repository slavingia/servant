// A thread is opened from its first message, which is already on screen in the conversation. The thread
// starts with that message, and with the conversation's people, instead of a spinner; the replies load
// under it. A message nobody has replied to is the whole thread, so nothing is left to wait for.
import type { Conversation, Post } from "./server";

/** `replies` is null when only the first message is known yet: the thread shows it and loads the replies under it. */
export type ThreadSnapshot = { conversation: Conversation | null; joined: boolean; head: Post | null; replies: Post[] | null };

/** What a thread shows before its replies have loaded. */
export const threadStart = (root: Post, from: { conversation: Conversation | null; joined: boolean }): ThreadSnapshot =>
  ({ conversation: from.conversation, joined: from.joined, head: root, replies: root.replyCount > 0 ? null : [] });

/** How many replies to say there are: the first message's own count until the replies have loaded, then what is on screen. */
export const shownReplyCount = (head: Pick<Post, "replyCount"> | null, replies: readonly unknown[] | null, sending: number) =>
  replies === null ? head?.replyCount ?? 0 : replies.length + sending;
