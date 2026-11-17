// The "New" line in a channel or a direct conversation. It sits above the first message from someone else that
// came after the place this person had read to when they opened the conversation, and it is placed once for
// the visit: reading the new messages does not move it, a fresh copy of the conversation does not add, move or
// take it away, and a message that arrives while they are here draws no line.
//
// A visit starts when the conversation is opened and ends when the person leaves it. A thread, Details or
// Files opened over the conversation is part of the same visit: coming back from one changes nothing. Leaving
// the app for a moment is too; staying away longer than AWAY_ENDS_VISIT_MS ends the visit, and the next one
// starts when they are back.
//
// The line is decided the moment a visit starts, from what is already on screen, so it is in the first frame
// and never arrives later to push the messages under it down. Only when nothing new is on screen yet (nothing
// was kept from before, or what came while away has not been fetched) does the first fresh copy decide.
//
// The place read to comes from the server (`readThrough` on a conversation, a message id): the same place its
// unread count is taken from, so the line and the badge agree. A server that does not send it gets no line.
import type { Post } from "./server";

/** Away from the app for longer than this, and coming back is a new visit. */
export const AWAY_ENDS_VISIT_MS = 5 * 60_000;

/** The read place a server sent, as a number, or null from a server that sends none. */
export function readPlace(value: unknown): number | null {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) return null;
  const place = Number(value);
  return Number.isSafeInteger(place) ? place : null;
}

// What the server counts as unread: someone else's message that is not deleted and not an activity line.
const counts = (post: Post, me: string) => post.user.id !== me && !post.deleted && !post.activity;
const place = (post: Post) => Number(post.id);
const later = (a: number | null, b: number | null) => a === null ? b : b === null ? a : Math.max(a, b);

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

/** One open conversation's visits: where the line is, decided once per visit. `now` is the clock, for tests. */
export function createUnreadVisits(me: string, now: () => number = Date.now) {
  // How far this person is known to have read: what the list and the server said, and what this screen has
  // told the server since.
  let through: number | null = null;
  // The place this visit counts from: what was known when it started.
  let from: number | null = null;
  // Not decided yet: nothing new was on screen when the visit started, so its first fresh copy decides.
  let waiting = true;
  let mark: number | null = null;
  // The message the line is above, once it has been found: it stays there even if that message is deleted.
  let above: string | null = null;
  let leftAt: number | null = null;
  const note = (value: number | null) => { through = later(through, value); };
  // A visit begins counting from `start`. With something new already on screen the line is settled now.
  const begin = (start: number | null, posts: readonly Post[] | null) => {
    from = start;
    mark = posts ? startVisit(posts, start, me) : null;
    waiting = mark === null;
    above = null;
    return mark;
  };
  return {
    /**
     * The conversation is opened. `listPlace` is how far the conversation list says this person has read,
     * `posts` what is on screen at once (kept from before), or null when nothing is. `noted` is how far this
     * device read here a moment ago, when the list may not have caught up (lib/read-cache.ts): the later of
     * the two is counted from. Returns what the line counts from, or null while there is none.
     */
    open(listPlace: number | null, posts: readonly Post[] | null, noted: number | null = null): number | null {
      const start = later(listPlace, noted);
      note(start);
      return begin(start, posts);
    },
    /**
     * A fresh copy of the conversation: the server's read place and the messages it brought. It decides the
     * line only for a visit that could not decide when it started. Returns what the line counts from.
     */
    loaded(serverPlace: number | null, posts: readonly Post[]): number | null {
      // The later of the two places: one may lag the other by a moment, and neither is ever ahead of the truth.
      const start = later(from, serverPlace);
      if (waiting && start !== null) { mark = startVisit(posts, start, me); waiting = false; }
      note(serverPlace);
      return mark;
    },
    /** Messages this screen told the server were seen. */
    read(messageIds: readonly string[]) { for (const id of messageIds) note(readPlace(id)); },
    /** The app is no longer in front. */
    away() { leftAt ??= now(); },
    /**
     * The app is in front again, with `posts` on screen. After a short absence nothing changes. After a long
     * one this is a new visit, counted from the place read to by now. Returns what the line counts from.
     */
    back(posts: readonly Post[] | null): number | null {
      const left = leftAt;
      leftAt = null;
      return left !== null && now() - left > AWAY_ENDS_VISIT_MS ? begin(through, posts) : mark;
    },
    /**
     * The message the line is above for `counted` (what open, loaded or back last returned), or null. Found
     * once per visit, as soon as the page that holds the place read to is here, and kept from then on.
     */
    lineAbove(posts: readonly Post[], counted: number | null, more: boolean): string | null {
      if (counted === null) return null;
      // Asked about a place that is not this visit's (a frame drawn across the change of visit): answer, and keep nothing.
      if (counted !== mark) return unreadLineAbove(posts, counted, me, more);
      above ??= unreadLineAbove(posts, counted, me, more);
      return above;
    },
  };
}
