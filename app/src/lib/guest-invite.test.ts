import { test } from "node:test";
import assert from "node:assert/strict";
import { guestShareMessage, guestsSummary, inviteLabel, knockBanner } from "./guest-invite.ts";

test("the share text names the host and carries the link as the last thing", () => {
  assert.equal(guestShareMessage("https://x.example/m/abc", "Ana Ruiz"), "Ana Ruiz invited you to a meeting. Open this link in your browser to join: https://x.example/m/abc");
  assert.match(guestShareMessage("https://x.example/m/abc", "  "), /^Someone invited/);
});

test("the knock banner shows the first guest still waiting and counts the rest", () => {
  assert.equal(knockBanner(undefined), null);
  assert.equal(knockBanner([]), null);
  const pending = [{ id: "g1", name: "Pat" }, { id: "g2", name: "Sam" }, { id: "g3", name: "Lee" }];
  assert.deepEqual(knockBanner(pending), { id: "g1", name: "Pat", title: "Pat wants to join", more: 2 });
  // Once the host tapped Admit or Deny, the next knock comes up before the poll catches up.
  assert.deepEqual(knockBanner(pending, new Set(["g1"])), { id: "g2", name: "Sam", title: "Sam wants to join", more: 1 });
  assert.equal(knockBanner(pending, new Set(["g1", "g2", "g3"])), null);
});

test("the summary pill counts guests for everyone and the waiting only for the host", () => {
  assert.equal(guestsSummary(undefined, true), null);
  assert.equal(guestsSummary({ count: 0, pendingCount: 0 }, true), null);
  assert.equal(guestsSummary({ count: 1, pendingCount: 0 }, false), "1 guest");
  assert.equal(guestsSummary({ count: 2, pendingCount: 1 }, true), "2 guests · 1 waiting");
  assert.equal(guestsSummary({ count: 2, pendingCount: 1 }, false), "2 guests");
  assert.equal(guestsSummary({ count: 0, pendingCount: 3 }, true), "3 waiting");
  assert.equal(guestsSummary({ count: 0, pendingCount: 3 }, false), null);
});

test("the invite button says what it will do", () => {
  assert.equal(inviteLabel(false, false, true), "Invite guests");
  assert.equal(inviteLabel(true, false, true), "Copy guest link");
  assert.equal(inviteLabel(true, false, false), "Share guest link");
  assert.equal(inviteLabel(true, true, true), "Link copied");
});
