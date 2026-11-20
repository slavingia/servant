import { test } from "node:test";
import assert from "node:assert/strict";
import { commentBy, commentCount, commentWhere, looksLikeEmail, numberedComments, orderShares, pageOf, pinsOn, shareLine, shareStatus, commentAsked, waitingComments, waitingLine } from "./prototype-reviews.ts";

const share = (extra = {}) => ({ id: "rev_1", email: "jo@example.gov", createdAt: 10, comments: [], ...extra });
const comment = { id: "cmt_1", page: "index.html", anchor: "Pay now", text: "Say Pay in full", createdAt: 20 };

test("where a share stands", () => {
  assert.equal(shareStatus(share()), "Hasn't opened it yet");
  assert.equal(shareStatus(share({ verifiedAt: 11 })), "Has opened it");
  assert.equal(shareStatus(share({ verifiedAt: 11, endedAt: 12 })), "Ended");
  assert.equal(shareLine(share()), "Hasn't opened it yet");
  assert.equal(shareLine(share({ verifiedAt: 11, comments: [comment] })), "Has opened it · 1 comment");
  assert.equal(shareLine(share({ endedAt: 12, comments: [comment, comment] })), "Ended · 2 comments");
  assert.equal(commentCount(0), "0 comments");
});

test("where a comment was made, and the order of the list", () => {
  assert.equal(commentWhere(comment), "On \u201cPay now\u201d · index.html");
  assert.equal(commentWhere({ anchor: "", page: "plans/compare.html" }), "plans/compare.html");
  const list = [share({ id: "old", createdAt: 1 }), share({ id: "ended", createdAt: 9, endedAt: 10 }), share({ id: "new", createdAt: 5 })];
  assert.deepEqual(orderShares(list).map(s => s.id), ["new", "old", "ended"]);
  assert.equal(list[0]!.id, "old", "the list given is not changed");
});

test("a quick look at an address before sending", () => {
  assert.equal(looksLikeEmail(" jo@example.gov "), true);
  for (const bad of ["", "jo", "jo@", "jo@example", "jo example@example.gov"]) assert.equal(looksLikeEmail(bad), false, bad);
});

test("the builder's preview numbers every reviewer's comments in the order they were made, and pins them on their page", () => {
  const shares = [
    share({ id: "a", email: "jo@example.gov", comments: [{ ...comment, id: "c2", createdAt: 30, x: 0.4, y: 0.2 }, { ...comment, id: "c4", createdAt: 50, page: "plans/compare.html", x: 0.1, y: 0.9 }] }),
    share({ id: "b", email: "sam@example.gov", endedAt: 99, comments: [{ ...comment, id: "c1", createdAt: 10, x: 0.5, y: 0.5, anchor: "" }, { ...comment, id: "c3", createdAt: 40 }] }),
  ];
  const all = numberedComments(shares);
  assert.deepEqual(all.map(c => [c.n, c.id, c.email]), [[1, "c1", "sam@example.gov"], [2, "c2", "jo@example.gov"], [3, "c3", "sam@example.gov"], [4, "c4", "jo@example.gov"]]);
  assert.deepEqual(pinsOn(all, "index.html"), [{ id: "c1", n: 1, x: 0.5, y: 0.5 }, { id: "c2", n: 2, x: 0.4, y: 0.2 }], "a comment from an older server has no spot and no pin");
  assert.deepEqual(pinsOn(all, "plans/compare.html"), [{ id: "c4", n: 4, x: 0.1, y: 0.9 }]);
  assert.equal(commentBy(all[1]!), "jo@example.gov · On \u201cPay now\u201d · index.html");
  assert.equal(commentBy(all[0]!), "sam@example.gov · index.html");
  assert.equal(pageOf("/p/proto-0123456789abcdef01/"), "index.html");
  assert.equal(pageOf("/p/proto-0123456789abcdef01/plans/compare.html?review=1"), "plans/compare.html");
  assert.equal(pageOf("/p/proto-0123456789abcdef01/plans/"), "plans/index.html");
});

test("comments wait above the message box until they are handed to Agent, and say how that happened", () => {
  const share = (email: string, comments: { id: string; createdAt: number; askedAt?: number; askedBy?: "you" | "auto"; setAsideAt?: number }[]) => ({ id: email, email, createdAt: 1, comments: comments.map(c => ({ page: "index.html", anchor: "", text: c.id, ...c })) });
  const all = numberedComments([share("jo@example.gov", [{ id: "a", createdAt: 1, askedAt: 5, askedBy: "you" }, { id: "c", createdAt: 3 }]), share("sam@example.gov", [{ id: "b", createdAt: 2, askedAt: 2, askedBy: "auto" }, { id: "d", createdAt: 4 }, { id: "e", createdAt: 5, setAsideAt: 6 }])]);
  assert.deepEqual(waitingComments(all).map(c => [c.id, c.n, c.email]), [["c", 3, "jo@example.gov"], ["d", 4, "sam@example.gov"]], "they keep the number their pin has");
  assert.deepEqual(all.map(commentAsked), ["You asked Agent to work on it", "Agent started on it by itself", null, null, "You set it aside"]);
  assert.deepEqual([waitingLine(1), waitingLine(3)], ["1 comment from a reviewer", "3 comments from reviewers"]);
});
