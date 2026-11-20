import assert from "node:assert/strict";
import test from "node:test";
import { agoLabel, cellLabel, connectionLine, pictureLine, dayKey, lengthLine, monthGrid, monthRange, parseWhen, replyBadge, replyLine, replyTarget, scheduleDays, socialDayLabel, socialWhen, sourceLine, stepMonth, undrafted, whenChoices, xLength, type SocialPost, type SocialReply } from "./social.ts";
import { DESTINATIONS, destinationGroups, reachable } from "./destinations.ts";
import { ALL_FEATURES, normalizeFeatures, sameFeatures, withDeepWork } from "./features.ts";
import { wikiMarkLabel, wikiMarkNote, wikiRows, type WikiPageSummary } from "./wiki.ts";

// Friday 20 November 2026, 2:00 PM, local time.
const NOW = new Date(2026, 10, 20, 14, 0, 0).getTime();
const at = (day: number, hour = 9, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();
const reply = (id: string, fields: Partial<SocialReply> = {}): SocialReply => ({ id, postId: "x_1", text: "Thanks.", status: "scheduled", byAgent: true, edited: false, createdByName: "Pat Tester", updatedAt: NOW, ...fields });
const post = (id: string, fields: Partial<SocialPost> = {}): SocialPost => ({ id, kind: "mention", author: { name: "Jo Park", handle: "jopark" }, text: "Where is the form?", url: "https://x.com/jopark/status/1", postedAt: NOW, likes: 0, reposts: 0, replies: 0, reply: null, ...fields });

test("length is counted the way X counts it, the same as the server", () => {
  assert.equal(xLength("Hello"), 5);
  assert.equal(xLength("See https://example.gov/a/very/long/address/that/goes/on/and/on?with=things for more"), 36);
  assert.equal(xLength("日本語"), 6);
  assert.equal(xLength("ok 👍"), 5);
  assert.deepEqual(lengthLine("  Hello  ", 280), { text: "5 of 280", over: false });
  assert.deepEqual(lengthLine("x".repeat(281), 280), { text: "281 of 280", over: true });
});

test("social media shows only on a server that says it has it, and Deep work hides it", () => {
  assert.equal(normalizeFeatures({}).social, undefined);
  assert.equal(normalizeFeatures({ social: "true" }).social, undefined);
  assert.deepEqual(normalizeFeatures(undefined), ALL_FEATURES, "a server from before social media is unchanged");
  const on = normalizeFeatures({ social: true });
  assert.equal(on.social, true);
  assert.ok(!sameFeatures(ALL_FEATURES, on), "turning it on is a change the app picks up");
  const place = DESTINATIONS.find(item => item.id === "social")!;
  assert.deepEqual([place.label, place.path, place.group, place.sidebar, place.you], ["Social", "/social", "talk", true, true]);
  assert.equal(reachable(place, { features: ALL_FEATURES, owner: true }), false);
  assert.equal(reachable(place, { features: on, owner: false }), true);
  assert.equal(reachable(place, { features: withDeepWork(on, true), owner: false }), false);
  assert.deepEqual(destinationGroups("sidebar", { features: on, owner: false })[0].places.map(item => item.id), ["home", "agent", "messages", "inbox", "social"]);
  assert.equal(new Set(DESTINATIONS.map(item => item.icon)).size, DESTINATIONS.length, "no two places share an icon");
});

test("the guide is marked in the wiki's tree and says what reads it", () => {
  const page = (id: string, kind?: string): WikiPageSummary => ({ id, parentId: null, title: id, position: 1, createdAt: 1, updatedAt: 1, updatedByName: null, version: 1, canDelete: !kind, ...(kind ? { kind } : {}) });
  const rows = wikiRows([page("Guide", "social-guide"), page("Notes")]);
  assert.deepEqual(rows.map(row => [row.id, row.kind ?? null]), [["abbreviations", null], ["Guide", "social-guide"], ["Notes", null]]);
  assert.equal(wikiMarkLabel("social-guide"), "Used for social media replies");
  assert.match(wikiMarkNote("social-guide")!, /^Agent writes social media replies from this page\./);
  assert.deepEqual([wikiMarkLabel(undefined), wikiMarkNote("something-else")], [null, null]);
});

test("days and times are said in plain words", () => {
  assert.deepEqual([socialDayLabel(NOW, NOW), socialDayLabel(at(21), NOW), socialDayLabel(at(19), NOW), socialDayLabel(at(24), NOW)], ["Today", "Tomorrow", "Yesterday", "Tue, Nov 24"]);
  assert.equal(socialDayLabel(new Date(2027, 0, 4).getTime(), NOW), "Mon, Jan 4, 2027");
  assert.deepEqual([socialWhen(at(20, 15, 42), NOW), socialWhen(at(21, 9), NOW)], ["3:42 PM", "Tomorrow, 9:00 AM"]);
  assert.deepEqual([NOW - 20_000, NOW - 5 * 60_000, NOW - 3 * 3_600_000, NOW - 2 * 86_400_000, NOW - 20 * 86_400_000].map(time => agoLabel(time, NOW)), ["now", "5m", "3h", "2d", "Oct 31"]);
  assert.equal(dayKey(at(3, 23, 59)), "2026-11-03");
});

test("a reply says where it stands and what it answers", () => {
  assert.equal(replyLine(reply("a", { status: "draft" }), NOW), "Agent's draft");
  assert.equal(replyLine(reply("a", { status: "draft", edited: true }), NOW), "Agent's draft, edited");
  assert.equal(replyLine(reply("a", { status: "draft", byAgent: false }), NOW), "Written by Pat Tester");
  assert.equal(replyLine(reply("a", { status: "draft", error: "Ana Ruiz approved this but no longer holds Social media, so it was not posted. It needs approving again" }), NOW).startsWith("Ana Ruiz approved this"), true);
  assert.equal(replyLine(reply("a", { scheduledFor: at(20, 14, 6), approvedByName: "Ana Ruiz" }), NOW), "Goes out 2:06 PM · approved by Ana Ruiz");
  assert.equal(replyLine(reply("a", { status: "posted", postedAt: at(19, 16, 30), approvedByName: "Ana Ruiz" }), NOW), "Posted Yesterday, 4:30 PM · approved by Ana Ruiz");
  assert.equal(replyLine(reply("a", { status: "failed", error: "X refused this: duplicate content" }), NOW), "Not posted. X refused this: duplicate content");
  assert.deepEqual(["scheduled", "posting", "posted", "failed"].map(status => replyBadge({ status: status as SocialReply["status"] })), ["Scheduled", "Posting", "Posted", "Not posted"]);
  assert.equal(replyTarget(reply("a", { post: post("x_1") })), "Reply to Jo Park (@jopark)");
  assert.equal(replyTarget(reply("a", { postId: null })), "Post");
  assert.deepEqual([sourceLine(post("1")), sourceLine(post("2", { kind: "search", search: "\"Example Org\"" }))], ["Mention", "Search: \"Example Org\""]);
});

test("the list groups the schedule by day, in time order", () => {
  const days = scheduleDays([reply("late", { scheduledFor: at(21, 16) }), reply("posted", { status: "posted", postedAt: at(20, 10), scheduledFor: at(20, 9) }), reply("soon", { scheduledFor: at(20, 15) }), reply("early", { scheduledFor: at(21, 8) })], NOW);
  assert.deepEqual(days.map(day => [day.key, day.label, day.replies.map(item => item.id)]), [["2026-11-20", "Today", ["posted", "soon"]], ["2026-11-21", "Tomorrow", ["early", "late"]]]);
  assert.deepEqual(scheduleDays([], NOW), []);
});

test("the calendar is whole weeks, Sunday first, with each day's replies", () => {
  const grid = monthGrid(2026, 10, [reply("a", { scheduledFor: at(20, 15) }), reply("b", { scheduledFor: at(20, 16) }), reply("c", { scheduledFor: new Date(2026, 11, 2, 9).getTime() })], NOW);
  assert.equal(grid.length, 5);
  assert.ok(grid.every(week => week.length === 7));
  assert.deepEqual([grid[0][0].key, grid[0][0].inMonth, grid[4][6].key, grid[4][6].inMonth], ["2026-11-01", true, "2026-12-05", false]);
  const today = grid.flat().find(cell => cell.today)!;
  assert.deepEqual([today.key, today.day, today.replies.map(item => item.id)], ["2026-11-20", 20, ["a", "b"]]);
  assert.deepEqual(grid.flat().find(cell => cell.key === "2026-12-02")!.replies.map(item => item.id), ["c"], "the days of next month that show carry theirs too");
  assert.equal(cellLabel(today), "Friday, Nov 20, 2 replies");
  assert.equal(cellLabel(grid[0][0]), "Sunday, Nov 1, nothing scheduled");
  // A month that starts midweek is padded from the one before, and the range asked of the server covers the padding.
  const august = monthGrid(2026, 7, [], NOW);
  assert.deepEqual([august.length, august[0][0].key, august[0][6].key, august.at(-1)![6].key], [6, "2026-07-26", "2026-08-01", "2026-09-05"]);
  const range = monthRange(2026, 7);
  assert.deepEqual([dayKey(range.from), dayKey(range.to)], ["2026-07-26", "2026-09-06"]);
  assert.deepEqual([stepMonth(2026, 11, 1), stepMonth(2026, 0, -1)], [{ year: 2027, month: 0 }, { year: 2025, month: 11 }]);
});

test("a time is chosen from three quick ones or typed", () => {
  const choices = whenChoices(NOW);
  assert.deepEqual(choices.map(choice => [choice.id, choice.label, choice.at]), [["next", "Next opening", null], ["hour", "In an hour (3:00 PM)", at(20, 15)], ["tomorrow", "Tomorrow, 9:00 AM", at(21, 9)]]);
  assert.deepEqual(parseWhen("2026-11-21", "9:30 am", NOW), { at: at(21, 9, 30) });
  assert.deepEqual(parseWhen("11/21", "14:05", NOW), { at: at(21, 14, 5) });
  assert.deepEqual(parseWhen("11/20", "2pm", NOW), { at: at(20, 14) });
  assert.deepEqual(parseWhen("11/21/2026", "12 AM", NOW), { at: at(21, 0) });
  assert.deepEqual(parseWhen("1/4", "9:00", NOW), { at: new Date(2027, 0, 4, 9).getTime() }, "a January date typed in November is next January");
  assert.deepEqual(parseWhen("tomorrow", "9:00", NOW), { error: "Write the date like 2026-11-21 or 11/21" });
  assert.deepEqual(parseWhen("11/21", "soon", NOW), { error: "Write the time like 9:30 AM or 14:05" });
  assert.deepEqual(parseWhen("11/21", "13 pm", NOW), { error: "Write the time like 9:30 AM or 14:05" });
  assert.deepEqual(parseWhen("2026-11-31", "9:00", NOW), { error: "That date isn't on the calendar. Check the month and day" });
  assert.deepEqual(parseWhen("2026-11-20", "9:00", NOW), { error: "That time has passed. Choose a later one" });
});

test("the connection line and the posts left to draft", () => {
  assert.equal(connectionLine({ account: null, error: null, syncedAt: null }, NOW), "Connecting to X…");
  assert.deepEqual([pictureLine({ id: "i", name: "closed.png", mime: "image/png", size: 9, byAgent: false }), pictureLine({ id: "i", name: "agent-image.png", mime: "image/png", size: 9, byAgent: true, prompt: "a closed sign" }), pictureLine({ id: "i", name: "agent-image.png", mime: "image/png", size: 9, byAgent: true })], ["closed.png", "Made by Agent from: a closed sign", "Made by Agent"]);
  // A server with no X account says so, and an approved post is never described as about to go out.
  assert.equal(connectionLine({ account: null, error: null, syncedAt: null, connected: false }, NOW), "No X account is connected, so nothing is posted. Write and approve posts here, then copy them to where they go.");
  assert.equal(replyBadge({ status: "scheduled" }, false), "Approved");
  assert.equal(replyLine({ status: "scheduled", scheduledFor: NOW + 60 * 60_000 } as SocialReply, NOW, false).startsWith("Approved for "), true);
  assert.equal(replyLine({ status: "scheduled", scheduledFor: NOW + 60 * 60_000 } as SocialReply, NOW).startsWith("Goes out "), true);
  assert.equal(connectionLine({ account: { handle: "exampleorg", name: "Example Org" }, error: null, syncedAt: NOW - 4 * 60_000 }, NOW), "@exampleorg on X · checked 4m ago");
  assert.equal(connectionLine({ account: { handle: "exampleorg", name: "Example Org" }, error: null, syncedAt: NOW }, NOW), "@exampleorg on X · checked just now");
  assert.equal(connectionLine({ account: null, error: "X refused this server's keys. Ask an owner to check the four X values in config.json", syncedAt: null }, NOW).startsWith("X refused"), true);
  const posts = [post("1"), post("2", { reply: reply("r") }), post("3", { suggestion: "spam" }), post("4"), post("5", { skipped: { at: NOW, byName: "Ana Ruiz" } })];
  assert.deepEqual(undrafted(posts).map(item => item.id), ["1", "4"]);
  assert.deepEqual(undrafted(posts, 1).map(item => item.id), ["1"]);
});
