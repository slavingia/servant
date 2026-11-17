import { test } from "node:test";
import assert from "node:assert/strict";
import { commentCount, commentWhere, looksLikeEmail, orderShares, shareLine, shareStatus } from "./prototype-reviews.ts";

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
