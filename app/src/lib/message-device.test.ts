import test from "node:test";
import assert from "node:assert/strict";
import { canCompactPost, messageDeviceLabel, parseSourceDevice } from "./message-device.ts";

const at = new Date(2026, 10, 2, 12).getTime();
const mobile = { kind: "mobile", label: "Mobile" };
const computer = { kind: "computer", label: "Computer" };
const post = { user: { id: "member" }, createdAt: at, sourceDevice: mobile };

test("only owners see canonical device categories on human messages", () => {
  for (const [kind, label] of [["mobile", "Mobile"], ["computer", "Computer"], ["web", "Browser"]]) {
    const message = { ...post, sourceDevice: { kind, label: "Untrusted arbitrary device name" } };
    assert.equal(messageDeviceLabel("owner", message), label);
    assert.equal(messageDeviceLabel("member", message), null);
    assert.equal(messageDeviceLabel(undefined, message), null);
  }
});

test("legacy, unknown, activity, pending and agent messages never get a guessed device", () => {
  for (const message of [
    { sourceDevice: undefined }, { sourceDevice: { kind: "unknown", label: "Unknown device" } },
    { sourceDevice: { kind: "Mac", label: "Computer" } }, { sourceDevice: "mobile" },
    { ...post, activity: "joined" }, { ...post, pending: true },
    { ...post, user: { id: "agent", agent: true } }, { ...post, role: "assistant" },
    { ...post, role: "system" },
  ]) assert.equal(messageDeviceLabel("owner", message), null);
  assert.equal(messageDeviceLabel("owner", { role: "user", sourceDevice: computer }), "Computer");
  assert.equal(parseSourceDevice(null), undefined);
});

test("compact rows retain their label and owner grouping breaks on a device change", () => {
  const next = { ...post, createdAt: at + 1000 };
  assert.equal(canCompactPost(post, next, "owner"), true);
  assert.equal(messageDeviceLabel("owner", next), "Mobile");
  const switched = { ...next, sourceDevice: computer };
  assert.equal(canCompactPost(post, switched, "owner"), false);
  assert.equal(canCompactPost(post, switched, "member"), true);
  assert.equal(canCompactPost({ ...post, sourceDevice: undefined }, next, "owner"), false);
  assert.equal(canCompactPost({ ...post, sourceDevice: undefined }, { ...next, sourceDevice: undefined }, "owner"), true);
});

test("compact grouping preserves author, date, reply and five-minute boundaries", () => {
  assert.equal(canCompactPost(undefined, post, "owner"), false);
  assert.equal(canCompactPost(post, { ...post, user: { id: "other" } }, "owner"), false);
  assert.equal(canCompactPost(post, { ...post, createdAt: at + 300000 }, "owner"), false);
  assert.equal(canCompactPost(post, { ...post, createdAt: at - 1 }, "owner"), false);
  assert.equal(canCompactPost({ ...post, replyCount: 1 }, post, "owner"), false);
  assert.equal(canCompactPost(post, { ...post, activity: "left" }, "owner"), false);
  const midnight = new Date(2026, 10, 3).getTime();
  assert.equal(canCompactPost({ ...post, createdAt: midnight - 1 }, { ...post, createdAt: midnight + 1 }, "owner"), false);
});
