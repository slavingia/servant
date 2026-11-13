import { test } from "node:test";
import assert from "node:assert/strict";
import { agentUnreadTotal, badgeText } from "./agent-unread.ts";

test("sums unread replies in open chats only", () => {
  assert.equal(agentUnreadTotal([{ unread: 2 }, { unread: 1, archived: true }, { unread: 3 }, {}]), 5);
});

test("ignores missing or invalid counts", () => {
  assert.equal(agentUnreadTotal([{ unread: -1 }, { unread: 1.5 }, { unread: Number.NaN }]), 0);
});

test("badge text caps at 99+ and hides zero", () => {
  assert.equal(badgeText(0), undefined);
  assert.equal(badgeText(7), "7");
  assert.equal(badgeText(120), "99+");
});
