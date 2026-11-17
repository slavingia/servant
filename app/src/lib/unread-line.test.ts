// The "New" line: above the first message from someone else after the place you had read to, placed once when
// a visit to the conversation starts and left there until the visit ends.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import type { Post } from "./server.ts";
import { AWAY_ENDS_VISIT_MS, createUnreadVisits, readPlace, startVisit, unreadLineAbove } from "./unread-line.ts";

const ME = "pat";
const post = (id: number, from = "jo", extra: Partial<Post> = {}) => ({ id: String(id), conversationId: "ch_1", user: { id: from, name: from }, text: "", createdAt: id, deleted: false, pending: false, ...extra }) as Post;
const from = (first: number, last: number, who = "jo") => Array.from({ length: last - first + 1 }, (_, i) => post(first + i, who));
// A clock the test moves by hand.
const clock = () => { let at = 1_000_000; return { now: () => at, pass: (ms: number) => { at += ms; } }; };
const MINUTE = 60_000;

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
  // A visit does the same, and once the line is found it is not looked for again.
  const visits = createUnreadVisits(ME);
  const counted = visits.open(10, page);
  assert.equal(visits.lineAbove(page, counted, true), null);
  assert.equal(visits.lineAbove([...from(1, 40), ...page], counted, true), "11");
});

test("the line is placed the moment the conversation opens, from what is already on screen", () => {
  const visits = createUnreadVisits(ME);
  const kept = from(1, 6);
  // The list says read to 4, and the messages kept from before hold 5 and 6: the line is in the first frame.
  const mark = visits.open(4, kept);
  assert.equal(mark, 4);
  assert.equal(visits.lineAbove(kept, mark, false), "5");
  // The fresh copy that follows says the same thing, or that the place has moved on: nothing changes.
  assert.equal(visits.loaded(4, kept), mark);
  assert.equal(visits.loaded(6, kept), mark);
  assert.equal(visits.lineAbove(kept, mark, false), "5");
});

test("opened again before the list has caught up with what was just read: no line above what was seen", () => {
  const kept = from(1, 6);
  // Left a moment ago having seen 5 and 6; the list still says read to 4, and this device noted 6.
  const again = createUnreadVisits(ME);
  assert.equal(again.open(4, kept, 6), null);
  assert.equal(again.loaded(4, kept), null, "the server has not heard yet either: still nothing new");
  // A message that arrived since is new.
  const since = createUnreadVisits(ME);
  const posts = [...kept, post(7)];
  assert.equal(since.lineAbove(posts, since.open(4, posts, 6), false), "7");
  // The note never moves the place back: the list knows of more read than was noted.
  const ahead = createUnreadVisits(ME);
  assert.equal(ahead.lineAbove(posts, ahead.open(6, posts, 4), false), "7");
});

test("with nothing on screen yet, the first copy decides, and the line comes with the messages", () => {
  const visits = createUnreadVisits(ME);
  assert.equal(visits.open(4, null), null, "nothing kept: a loader is on screen");
  const posts = from(1, 6);
  const mark = visits.loaded(4, posts);
  assert.equal(visits.lineAbove(posts, mark, false), "5");
  // Opened before the list had loaded, so no place was known: the copy's own place is used.
  const cold = createUnreadVisits(ME);
  assert.equal(cold.open(null, null), null);
  assert.equal(cold.lineAbove(posts, cold.loaded(4, posts), false), "5");
});

test("messages that came while away and are only in the fresh copy get the line, above the first of them", () => {
  const visits = createUnreadVisits(ME);
  const kept = from(1, 6);
  assert.equal(visits.open(6, kept), null, "nothing new in what was kept");
  const fresh = [...kept, post(7), post(8)];
  const mark = visits.loaded(6, fresh);
  assert.equal(visits.lineAbove(fresh, mark, false), "7", "they arrive under what is on screen, the line with them");
});

test("the later of the list's place and the server's is the one counted from", () => {
  const posts = from(1, 8);
  // Read on another device since the list was fetched: the server knows better.
  const behind = createUnreadVisits(ME);
  behind.open(4, null);
  assert.equal(behind.lineAbove(posts, behind.loaded(6, posts), false), "7");
  // Read here a moment ago, and the server's copy left before it heard: the list knows better.
  const ahead = createUnreadVisits(ME);
  ahead.open(6, null);
  assert.equal(ahead.lineAbove(posts, ahead.loaded(4, posts), false), "7");
  // Read to the end as far as either knows: no line.
  const done = createUnreadVisits(ME);
  done.open(8, null);
  assert.equal(done.loaded(4, posts), null);
});

test("the line stays where it was for the visit", () => {
  const visits = createUnreadVisits(ME);
  let posts = from(1, 6);
  const mark = visits.open(4, posts);
  assert.equal(visits.lineAbove(posts, mark, false), "5");
  // Reading the new messages, a later copy with the place moved on, and a message arriving: the line holds.
  visits.read(["5", "6"]);
  posts = [...posts, post(7)];
  assert.equal(visits.loaded(6, posts), mark);
  assert.equal(visits.lineAbove(posts, mark, false), "5");
  // The message under it is deleted: the line stays above where it was, not above the next one.
  posts = posts.map(p => p.id === "5" ? post(5, "jo", { deleted: true }) : p);
  assert.equal(visits.lineAbove(posts, mark, false), "5");
  assert.equal(unreadLineAbove(posts, mark, ME, false), "6", "decided afresh it would have moved");
});

test("a message that arrives while you are looking draws no line", () => {
  const visits = createUnreadVisits(ME);
  const posts = from(1, 6);
  assert.equal(visits.open(6, posts), null);
  assert.equal(visits.loaded(6, posts), null, "the fresh copy has nothing new either: no line for this visit");
  const arrived = [...posts, post(7)];
  assert.equal(visits.loaded(6, arrived), null);
  assert.equal(visits.lineAbove(arrived, null, false), null);
});

test("a thread, Details or Files over the conversation is the same visit: coming back changes nothing", () => {
  const visits = createUnreadVisits(ME);
  let posts = from(1, 6);
  const mark = visits.open(4, posts);
  visits.read(["5", "6"]);
  // In the thread two messages arrive in the conversation; coming back fetches a fresh copy, as it always did.
  posts = [...posts, post(7), post(8)];
  assert.equal(visits.loaded(6, posts), mark, "the place counted from is still the one the visit started with");
  assert.equal(visits.lineAbove(posts, mark, false), "5", "the line has not moved to what arrived meanwhile");
  // With no line at the start, none appears on the way back either.
  const quiet = createUnreadVisits(ME);
  assert.equal(quiet.open(6, from(1, 6)), null);
  assert.equal(quiet.loaded(6, from(1, 6)), null);
  assert.equal(quiet.loaded(6, posts), null);
});

test("a short time away from the app is the same visit", () => {
  const time = clock();
  const visits = createUnreadVisits(ME, time.now);
  let posts = from(1, 6);
  const mark = visits.open(4, posts);
  visits.read(["5", "6"]);
  visits.away();
  time.pass(2 * MINUTE);
  posts = [...posts, post(7)];
  assert.equal(visits.back(posts), mark);
  assert.equal(visits.lineAbove(posts, mark, false), "5");
  // Exactly the limit is still short; the app says it is leaving more than once (inactive, then background).
  visits.away();
  time.pass(AWAY_ENDS_VISIT_MS - MINUTE);
  visits.away();
  time.pass(MINUTE);
  assert.equal(visits.back(posts), mark);
  // Coming to the front without having left changes nothing.
  assert.equal(visits.back(posts), mark);
});

test("a long time away ends the visit: back in the app, the line moves to what arrived meanwhile", () => {
  const time = clock();
  const visits = createUnreadVisits(ME, time.now);
  let posts = from(1, 6);
  const first = visits.open(4, posts);
  assert.equal(visits.lineAbove(posts, first, false), "5");
  visits.read(["5", "6"]);
  visits.away();
  time.pass(AWAY_ENDS_VISIT_MS + 1);
  // A computer kept receiving while its window was hidden: 7 and 8 are already on screen on coming back.
  posts = [...posts, post(7), post(8)];
  const second = visits.back(posts);
  assert.equal(second, 6, "counted from the place read to by now");
  assert.equal(visits.lineAbove(posts, second, false), "7", "placed at once, from what is on screen");
  // The copy fetched on coming back may already count what is on screen as read (its request and the read
  // receipts race). The line was decided before it and does not move.
  assert.equal(visits.loaded(8, posts), second);
  assert.equal(visits.lineAbove(posts, second, false), "7");
});

test("a phone that was cut off while away: the copy fetched on coming back brings the messages and the line", () => {
  const time = clock();
  const visits = createUnreadVisits(ME, time.now);
  let posts = from(1, 6);
  visits.open(4, posts);
  visits.read(["5", "6"]);
  visits.away();
  time.pass(20 * MINUTE);
  assert.equal(visits.back(posts), null, "nothing new on screen yet: the old line goes, and the next copy decides");
  posts = [...posts, post(7), post(8)];
  const mark = visits.loaded(6, posts);
  assert.equal(visits.lineAbove(posts, mark, false), "7");
});

test("coming back after a long time to nothing new clears the line", () => {
  const time = clock();
  const visits = createUnreadVisits(ME, time.now);
  const posts = from(1, 6);
  assert.equal(visits.lineAbove(posts, visits.open(4, posts), false), "5");
  visits.read(["5", "6"]);
  visits.away();
  time.pass(AWAY_ENDS_VISIT_MS + MINUTE);
  assert.equal(visits.back(posts), null);
  assert.equal(visits.loaded(6, posts), null);
  assert.equal(visits.lineAbove(posts, null, false), null);
});

test("what was read on another device counts when you come back after a long time", () => {
  const time = clock();
  const visits = createUnreadVisits(ME, time.now);
  let posts = from(1, 6);
  visits.open(6, posts);
  visits.away();
  // 7 and 8 arrive while this window is hidden; 7 is read on the phone, and a copy fetched meanwhile says so.
  posts = [...posts, post(7), post(8)];
  visits.loaded(7, posts);
  time.pass(AWAY_ENDS_VISIT_MS + MINUTE);
  assert.equal(visits.lineAbove(posts, visits.back(posts), false), "8");
});

test("a copy from a server that sends no place decides nothing; the next one with a place does", () => {
  const visits = createUnreadVisits(ME);
  const posts = from(1, 6);
  assert.equal(visits.open(null, null), null);
  assert.equal(visits.loaded(null, posts), null);
  assert.equal(visits.lineAbove(posts, visits.loaded(4, posts), false), "5");
  // With messages kept and no place from the list, nothing can be decided at the start either.
  const kept = createUnreadVisits(ME);
  assert.equal(kept.open(null, posts), null);
  assert.equal(kept.lineAbove(posts, kept.loaded(4, posts), false), "5");
});

test("the conversation screen places the line as it opens, and never groups the message under it", () => {
  const read = (file: string) => fs.readFileSync(path.join(import.meta.dirname, "..", file), "utf8");
  const screen = read("app/c/[id].tsx");
  // Decided in the first render, from the list's place and the messages kept from the last time: the line is
  // in the first frame, not put in when the fresh copy arrives.
  assert.match(screen, /useState<number \| null>\(\(\) => visits\.open\(readPlace\(peek\(id\)\?\.readThrough\), kept\?\.posts \?\? null, notedPlace\(readNotes, id\)\)\)/);
  assert.match(screen, /visits\.loaded\(readPlace\(c\.conversation\.readThrough\), recovered\)/, "a fresh copy decides only what the start could not");
  assert.match(screen, /visits\.lineAbove\(posts \?\? \[\], unreadMark, more\)/);
  assert.match(screen, /posts \?\? undefined, ids => visits\.read\(ids\)\)/, "what this screen marks read moves the place");
  // Only the app going away and coming back can end a visit; coming back from a screen opened over this one cannot.
  assert.match(screen, /if \(state === "active"\) setUnreadMark\(visits\.back\(shownPosts\.current\)\);\n\s+else visits\.away\(\);/);
  assert.doesNotMatch(screen, /visits\.returned|useOnReturn/);
  const visitCalls = screen.match(/visits\.(open|back|away|loaded)\(/g) ?? [];
  assert.deepEqual(visitCalls.sort(), ["visits.away(", "visits.back(", "visits.loaded(", "visits.open("], "each is called from one place");
  assert.match(screen, /const isNew = item\.id === newAbove;/);
  assert.match(screen, /const compact = !isNew && canCompactPost\(above, item, role\);/, "the first new message shows who wrote it");
  assert.match(screen, /\{isNew \? <UnreadLine \/> : null\}\s*\{newDay \? <MessageDate/, "the line is above the day, when both fall on one message");
  const line = read("components/Messaging.tsx");
  assert.match(line, /export function UnreadLine\(\)/);
  assert.match(line, /accessibilityRole="header" accessibilityLabel="New messages"/);
});
