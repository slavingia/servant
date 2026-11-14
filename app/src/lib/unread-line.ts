// The "New" line in a channel or a direct conversation. It sits above the first message from someone else that
// came after the place this person had read to when they arrived, and stays there for the visit: reading the
// new messages does not move it, and a message that arrives while they are looking draws no line. Leaving the
// conversation and coming back (another screen, another tab, the app in the background) starts a new visit.
//
// The place read to comes from the server (`readThrough` on a conversation, a message id): the same place its
// unread count is taken from, so the line and the badge agree. A server that does not send it gets no line.
import type { Post } from "./server";

/** The read place a server sent, as a number, or null from a server that sends none. */
export function readPlace(value: unknown): number | null {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) return null;
  const place = Number(value);
  return Number.isSafeInteger(place) ? place : null;
}

// What the server counts as unread: someone else's message that is not deleted and not an activity line.
const counts = (post: Post, me: string) => post.user.id !== me && !post.deleted && !post.activity;
const place = (post: Post) => Number(post.id);

/** Where a visit counts from: the place read to when it began, or null when nothing after it is new. */
export function startVisit(posts: readonly Post[], readThrough: number | null, me: string): number | null {
  if (readThrough === null) return null;
  return posts.some(post => place(post) > readThrough && counts(post, me)) ? readThrough : null;
}

/**
 * The message the "New" line goes above, or null for no line. `posts` are in order, oldest first. While older
 * messages are still to be loaded (`more`) and none as old as the place read to is here yet, the first new
 * message may be on a page that has not arrived, so the line waits rather than sit above the wrong one.
 */
export function unreadLineAbove(posts: readonly Post[], mark: number | null, me: string, more: boolean): string | null {
  if (mark === null) return null;
  const first = posts.find(post => place(post) > mark && counts(post, me));
  if (!first) return null;
  if (more && !posts.some(post => place(post) <= mark)) return null;
  return first.id;
}

/** One open conversation's visits: what the line counts from, decided once per visit. */
export function createUnreadVisits(me: string) {
  // How far this person is known to have read: what the server said, and what this screen has told it since.
  let through: number | null = null;
  // The place this visit counts from. The first visit takes the server's; a later one takes `through` as it
  // stood on coming back, before anything on screen is marked read.
  let from: number | null = null;
  let waiting = true;
  let mark: number | null = null;
  const note = (value: number | null) => { if (value !== null) through = through === null ? value : Math.max(through, value); };
  return {
    /**
     * A fresh copy of the conversation: the server's read place and the messages it brought. The first one of
     * a visit decides the line, since only it has what arrived while away. Returns what the line counts from.
     */
    loaded(serverPlace: number | null, posts: readonly Post[]): number | null {
      const start = from ?? serverPlace;
      if (waiting && start !== null) { mark = startVisit(posts, start, me); waiting = false; }
      note(serverPlace);
      return mark;
    },
    /** Messages this screen told the server were seen. */
    read(messageIds: readonly string[]) { for (const id of messageIds) note(readPlace(id)); },
    /** Back on this conversation after being away from it: the next fresh copy decides a new line. */
    returned() { from = through; waiting = true; },
  };
}
