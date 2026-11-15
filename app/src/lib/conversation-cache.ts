// A conversation you have opened is kept in memory (lib/screen-cache.ts), so going back to it shows
// its messages at once while a fresh copy loads behind them. Pressing a conversation's row also starts
// its request right away, before the screen has been built, so a first visit has its answer sooner.
import { showsInConversation } from "./also-in-channel";
import { AppState } from "react-native";
import { accountId, api, type Account, type Conversation, type LiveEvent, type Post } from "./server";
import { liveEventCount } from "./live-counts";
import { clearWithScreenCaches, createEarlyRequests, createScreenCache, newestPage } from "./screen-cache";
import { createWarmQueue, likelyNext } from "./likely-next";
import { mergePosts } from "./post-list";

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

/**
 * A message arrived or changed on the live connection. A conversation kept in memory takes it in, so what it
 * shows the next time it is opened is current, not what it showed when it was last on screen.
 */
export function followLive(account: Account, event: LiveEvent) {
  if (event.event === "ready") {
    // The stream started over, so messages may have been missed: what was kept can no longer be vouched for.
    if (event.data.reset !== false) { kept.clear(); warm.clear(); }
    return;
  }
  if (event.event !== "message.created" && event.event !== "message.updated") return;
  const post = event.data;
  // A reply belongs to its thread; the conversation shows its first message, which is updated on its own.
  // One its author also sent to the conversation is shown there too.
  if (!showsInConversation(post)) return;
  const id = key(account, post.conversationId);
  const snapshot = kept.peek(id);
  if (!snapshot) return;
  const page = newestPage(mergePosts(snapshot.posts, [post]), snapshot.more, PAGE);
  kept.update(id, { ...snapshot, posts: page.items, more: page.more });
}

// The conversations most likely to be opened next, loaded ahead of time: a few, one at a time, with a pause
// before each, and only while the app is in front. Each is loaded once; after that it follows the live
// connection like any kept conversation. Nothing is marked read by this: reading happens on screen.
const WARM = 4;
const warm = createWarmQueue({ idle: () => AppState.currentState === "active" });
clearWithScreenCaches(warm);

export function warmConversations(account: Account, conversations: readonly Conversation[]) {
  for (const conversation of likelyNext(conversations, WARM)) {
    const id = key(account, conversation.id);
    if (kept.peek(id)) continue;
    warm.add(id, async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        // Opened in the meantime: the screen has the newer copy.
        if (kept.peek(id)) return;
        const mark = liveEventCount(conversation.id);
        const [info, page] = await fetchConversation(account, conversation.id);
        if (kept.peek(id)) return;
        // A message arrived while this was on its way and nothing was kept yet to take it in: ask once more.
        if (liveEventCount(conversation.id) !== mark && attempt === 0) continue;
        keepConversation(account, conversation.id, { conversation: info.conversation, joined: info.joined, posts: page.messages, more: page.more });
        return;
      }
    });
  }
}

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
