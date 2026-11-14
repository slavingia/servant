// A thread you have opened is kept in memory (lib/screen-cache.ts), so going back to it shows its
// replies at once while a fresh copy loads behind them, and opening one starts its request when
// "Reply in thread" or the reply count is pressed, before the screen has been built.
import { accountId, api, type Account, type Conversation, type Post } from "./server";
import { liveEventCount } from "./live";
import { createEarlyRequests, createScreenCache } from "./screen-cache";
import { threadStart, type ThreadSnapshot } from "./thread-start";

export type { ThreadSnapshot } from "./thread-start";
type Fetched = [{ root: Post; replies: Post[] }, { conversation: Conversation; joined: boolean }];

const kept = createScreenCache<ThreadSnapshot>(30);
const early = createEarlyRequests<Promise<Fetched>>();
const key = (account: Account, conversationId: string, root: string) => `${accountId(account)}:${account.token}:${conversationId}:${root}`;

export const fetchThread = (account: Account, conversationId: string, root: string): Promise<Fetched> => Promise.all([api.thread(account, conversationId, root), api.conversation(account, conversationId)]);

export const keptThread = (account: Account, conversationId: string, root: string) => kept.get(key(account, conversationId, root));
export const keepThread = (account: Account, conversationId: string, root: string, snapshot: ThreadSnapshot) => kept.set(key(account, conversationId, root), snapshot);
export const forgetThread = (account: Account, conversationId: string, root: string) => kept.delete(key(account, conversationId, root));

/**
 * Call when a thread is about to open from its first message, before navigating. Its request leaves now, and
 * the message that was pressed is already on screen in the conversation, so the thread starts with it (and with
 * the conversation's people) instead of a spinner. A message with no replies yet is the whole thread.
 */
export function openingThread(account: Account, conversationId: string, root: Post, from: { conversation: Conversation | null; joined: boolean }) {
  const id = key(account, conversationId, root.id);
  early.start(id, liveEventCount(conversationId), () => {
    const result = fetchThread(account, conversationId, root.id);
    // The screen may never open; a failure then is nobody's error. A screen that takes it sees the failure, like any load.
    result.catch(() => {});
    return result;
  });
  const before = kept.get(id);
  kept.set(id, before ? { ...before, head: root } : threadStart(root, from));
}
/** The request started at the press, once: `mark` is the conversation's live event count when it left. */
export const earlyThread = (account: Account, conversationId: string, root: string) => early.take(key(account, conversationId, root));
