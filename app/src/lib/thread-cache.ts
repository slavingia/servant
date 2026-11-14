// A thread you have opened is kept in memory (lib/screen-cache.ts), so going back to it shows its
// replies at once while a fresh copy loads behind them, and opening one starts its request when
// "Reply in thread" or the reply count is pressed, before the screen has been built.
import { accountId, api, type Account, type Conversation, type Post } from "./server";
import { liveEventCount } from "./live";
import { createEarlyRequests, createScreenCache } from "./screen-cache";

export type ThreadSnapshot = { conversation: Conversation | null; joined: boolean; head: Post | null; replies: Post[] };
type Fetched = [{ root: Post; replies: Post[] }, { conversation: Conversation; joined: boolean }];

const kept = createScreenCache<ThreadSnapshot>(30);
const early = createEarlyRequests<Promise<Fetched>>();
const key = (account: Account, conversationId: string, root: string) => `${accountId(account)}:${account.token}:${conversationId}:${root}`;

export const fetchThread = (account: Account, conversationId: string, root: string): Promise<Fetched> => Promise.all([api.thread(account, conversationId, root), api.conversation(account, conversationId)]);

export const keptThread = (account: Account, conversationId: string, root: string) => kept.get(key(account, conversationId, root));
export const keepThread = (account: Account, conversationId: string, root: string, snapshot: ThreadSnapshot) => kept.set(key(account, conversationId, root), snapshot);
export const forgetThread = (account: Account, conversationId: string, root: string) => kept.delete(key(account, conversationId, root));

/** Call when a thread is about to open, before navigating: its request leaves now. */
export function openingThread(account: Account, conversationId: string, root: string) {
  early.start(key(account, conversationId, root), liveEventCount(conversationId), () => {
    const result = fetchThread(account, conversationId, root);
    // The screen may never open; a failure then is nobody's error. A screen that takes it sees the failure, like any load.
    result.catch(() => {});
    return result;
  });
}
/** The request started at the press, once: `mark` is the conversation's live event count when it left. */
export const earlyThread = (account: Account, conversationId: string, root: string) => early.take(key(account, conversationId, root));
