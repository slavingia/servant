// A conversation you have opened is kept in memory (lib/screen-cache.ts), so going back to it shows
// its messages at once while a fresh copy loads behind them. Pressing a conversation's row also starts
// its request right away, before the screen has been built, so a first visit has its answer sooner.
import { accountId, api, type Account, type Conversation, type Post } from "./server";
import { liveEventCount } from "./live";
import { createEarlyRequests, createScreenCache, newestPage } from "./screen-cache";

export type ConversationSnapshot = { conversation: Conversation | null; joined: boolean; posts: Post[]; more: boolean };
type Fetched = [{ conversation: Conversation; joined: boolean }, { messages: Post[]; more: boolean }];

// The server's page of messages (server/messaging.mjs PAGE): what is kept matches a fresh first page.
const PAGE = 50;
const kept = createScreenCache<ConversationSnapshot>(30);
const early = createEarlyRequests<Promise<Fetched>>();
const key = (account: Account, id: string) => `${accountId(account)}:${account.token}:${id}`;

export const fetchConversation = (account: Account, id: string): Promise<Fetched> => Promise.all([api.conversation(account, id), api.posts(account, id)]);

export const keptConversation = (account: Account, id: string) => kept.get(key(account, id));
export function keepConversation(account: Account, id: string, snapshot: ConversationSnapshot) {
  const page = newestPage(snapshot.posts, snapshot.more, PAGE);
  kept.set(key(account, id), { ...snapshot, posts: page.items, more: page.more });
}
export const forgetConversation = (account: Account, id: string) => kept.delete(key(account, id));

/** Call when a conversation's row is pressed, before navigating: its request leaves now. */
export function openingConversation(account: Account, id: string) {
  early.start(key(account, id), liveEventCount(id), () => {
    const result = fetchConversation(account, id);
    // The screen may never open; a failure then is nobody's error. A screen that takes it sees the failure, like any load.
    result.catch(() => {});
    return result;
  });
}
/** The request started at the press, once: `mark` is the conversation's live event count when it left. */
export const earlyConversation = (account: Account, id: string) => early.take(key(account, id));
