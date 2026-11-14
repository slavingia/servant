// The "New" line: above the first message from someone else after the place you had read to, fixed for a visit.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { Post } from "./server.ts";
import { createUnreadVisits, readPlace, startVisit, unreadLineAbove } from "./unread-line.ts";

const ME = "pat";
const post = (id: number, from = "jo", extra: Partial<Post> = {}) => ({ id: String(id), conversationId: "ch_1", user: { id: from, name: from }, text: "", createdAt: id, deleted: false, pending: false, ...extra }) as Post;
const from = (first: number, last: number, who = "jo") => Array.from({ length: last - first + 1 }, (_, i) => post(first + i, who));

test("the read place is a message id, and anything else means no line", () => {
  assert.equal(readPlace("42"), 42);
  assert.equal(readPlace("0"), 0);
  for (const value of [undefined, null, 42, "", "4.2", "-1", "abc", "9".repeat(30)]) assert.equal(readPlace(value), null);
});

test("the line goes above the first message from someone else after the place read to", () => {
  const posts = from(1, 6);
  assert.equal(unreadLineAbove(posts, startVisit(posts, 4, ME), ME, false), "5");
  // Read to the end, or to a place past the end: nothing is new.
  assert.equal(startVisit(posts, 6, ME), null);
  assert.equal(unreadLineAbove(posts, startVisit(posts, 9, ME), ME, false), null);
  // Never read anything: the line is above the first message.
  assert.equal(unreadLineAbove(posts, startVisit(posts, 0, ME), ME, false), "1");
  // A server that sends no place gets no line.
  assert.equal(startVisit(posts, null, ME), null);
  assert.equal(unreadLineAbove(posts, null, ME, false), null);
});

test("my own messages, deleted messages and activity lines are not new, as in the unread count", () => {
  const posts = [post(1), post(2, ME), post(3, "jo", { deleted: true }), post(4, "jo", { activity: "joined" }), post(5), post(6, ME)];
  assert.equal(unreadLineAbove(posts, startVisit(posts, 1, ME), ME, false), "5");
  // Only my own messages after the place: no line.
  const mine = [post(1), post(2, ME), post(3, ME)];
  assert.equal(startVisit(mine, 1, ME), null);
  // An agent's reply still being written is new.
  assert.equal(unreadLineAbove([post(1), post(2, "agent", { pending: true })], 1, ME, false), "2");
});

test("with more unread than one page, the line waits for the page that holds the place", () => {
  // Read to 10; the newest page holds 41 to 90, all new, and older ones are still to load.
  const page = from(41, 90);
  const mark = startVisit(page, 10, ME);
  assert.equal(mark, 10, "something is new, so the visit counts from the place");
  assert.equal(unreadLineAbove(page, mark, ME, true), null, "41 is not the first new message");
  // The page with the place arrives: the line is above the first message after it.
  assert.equal(unreadLineAbove([...from(1, 40), ...page], mark, ME, true), "11");
  // Everything loaded and the place never seen (the first message is already new): above the first.
  assert.equal(unreadLineAbove(page, mark, ME, false), "41");
});

test("the line stays where it was for the visit", () => {
  const visits = createUnreadVisits(ME);
  let posts = from(1, 6);
  const mark = visits.loaded(4, posts);
  assert.equal(unreadLineAbove(posts, mark, ME, false), "5");
  // Reading the new messages, a later copy with the place moved on, and a message arriving: the line holds.
  visits.read(["5", "6"]);
  posts = [...posts, post(7)];
  assert.equal(visits.loaded(6, posts), mark);
  assert.equal(unreadLineAbove(posts, mark, ME, false), "5");
});

test("a message that arrives while you are looking draws no line", () => {
  const visits = createUnreadVisits(ME);
  const mark = visits.loaded(6, from(1, 6));
  assert.equal(mark, null);
  assert.equal(unreadLineAbove([...from(1, 6), post(7)], visits.loaded(6, [...from(1, 6), post(7)]), ME, false), null);
});

test("coming back starts a new visit: the line moves to what arrived while away", () => {
  const visits = createUnreadVisits(ME);
  let posts = from(1, 6);
  visits.loaded(4, posts);
  visits.read(["5", "6"]);
  // Away (in a thread, another tab, the app in the background). Two messages arrive, then you return.
  posts = [...posts, post(7), post(8)];
  visits.returned();
  // The copy fetched on return may already count what is on screen as read (its request and the read
  // receipts race). The line still starts from the place known on coming back.
  const mark = visits.loaded(8, posts);
  assert.equal(unreadLineAbove(posts, mark, ME, false), "7");
});

test("coming back to nothing new clears the line", () => {
  const visits = createUnreadVisits(ME);
  const posts = from(1, 6);
  assert.equal(unreadLineAbove(posts, visits.loaded(4, posts), ME, false), "5");
  visits.read(["5", "6"]);
  visits.returned();
  assert.equal(visits.loaded(6, posts), null);
});

test("a copy from a server that sends no place decides nothing; the next one with a place does", () => {
  const visits = createUnreadVisits(ME);
  const posts = from(1, 6);
  assert.equal(visits.loaded(null, posts), null);
  assert.equal(unreadLineAbove(posts, visits.loaded(4, posts), ME, false), "5");
});

test("what was read on another device counts when you come back", () => {
  const visits = createUnreadVisits(ME);
  let posts = from(1, 6);
  visits.loaded(6, posts);
  // 7 and 8 arrive while this screen is hidden; 7 is read on the phone, and a copy fetched meanwhile says so.
  posts = [...posts, post(7), post(8)];
  visits.loaded(7, posts);
  visits.returned();
  assert.equal(unreadLineAbove(posts, visits.loaded(7, posts), ME, false), "8");
});

test("the conversation screen draws the line where these say, and never groups the message under it", () => {
  const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, "..", file), "utf8");
  const screen = read("app/c/[id].tsx");
  assert.match(screen, /visits\.loaded\(readPlace\(c\.conversation\.readThrough\), recovered\)/, "a fresh copy decides the line");
  assert.match(screen, /unreadLineAbove\(posts \?\? \[\], unreadMark, me, more\)/);
  assert.match(screen, /useOnReturn\(focused, \(\) => visits\.returned\(\)\)/, "coming back starts a new visit");
  assert.match(screen, /posts \?\? undefined, ids => visits\.read\(ids\)\)/, "what this screen marks read moves the place");
  assert.match(screen, /const isNew = item\.id === newAbove;/);
  assert.match(screen, /const compact = !isNew && canCompactPost\(above, item, role\);/, "the first new message shows who wrote it");
  assert.match(screen, /\{isNew \? <UnreadLine \/> : null\}\s*\{newDay \? <MessageDate/, "the line is above the day, when both fall on one message");
  const line = read("components/Messaging.tsx");
  assert.match(line, /export function UnreadLine\(\)/);
  assert.match(line, /accessibilityRole="header" accessibilityLabel="New messages"/);
});
