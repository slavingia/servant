import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { asDeleted, showChange, undoChange, withReaction } from "./post-changes.ts";
import type { Post } from "./server.ts";

const post = (id: string, extra: Partial<Post> = {}): Post => ({ id, conversationId: "c1", user: { id: "u2", name: "Jo Park" }, threadRoot: null, text: `message ${id}`, deleted: false, pending: false, replyCount: 0, lastReplyAt: null, createdAt: 1763000000000, editedAt: null, ...extra });

test("a reaction is added the way the server returns it", () => {
  const plain = post("1");
  const first = withReaction(plain, "👍", "u1", true);
  assert.deepEqual(first.reactions, [{ emoji: "👍", userIds: ["u1"] }]);
  assert.equal(plain.reactions, undefined, "the original is not changed");
  const joined = withReaction(post("1", { reactions: [{ emoji: "👍", userIds: ["u2"] }, { emoji: "🎉", userIds: ["u3"] }] }), "👍", "u1", true);
  assert.deepEqual(joined.reactions, [{ emoji: "👍", userIds: ["u2", "u1"] }, { emoji: "🎉", userIds: ["u3"] }]);
  const another = withReaction(joined, "✅", "u1", true);
  assert.deepEqual(another.reactions?.map(r => r.emoji), ["👍", "🎉", "✅"]);
});

test("a reaction is taken away, and an emoji nobody has left goes with it", () => {
  const before = post("1", { reactions: [{ emoji: "👍", userIds: ["u2", "u1"] }, { emoji: "🎉", userIds: ["u1"] }] });
  assert.deepEqual(withReaction(before, "👍", "u1", false).reactions, [{ emoji: "👍", userIds: ["u2"] }, { emoji: "🎉", userIds: ["u1"] }]);
  assert.deepEqual(withReaction(before, "🎉", "u1", false).reactions, [{ emoji: "👍", userIds: ["u2", "u1"] }]);
  assert.deepEqual(before.reactions?.[0]?.userIds, ["u2", "u1"], "the original is not changed");
});

test("asking for what is already so changes nothing", () => {
  const before = post("1", { reactions: [{ emoji: "👍", userIds: ["u1"] }] });
  assert.equal(withReaction(before, "👍", "u1", true), before);
  assert.equal(withReaction(before, "🎉", "u1", false), before);
  assert.equal(withReaction(post("2"), "👍", "u1", false).reactions, undefined);
});

test("adding then taking away a reaction is where it started", () => {
  const before = post("1", { reactions: [{ emoji: "👍", userIds: ["u2"] }] });
  assert.deepEqual(withReaction(withReaction(before, "👍", "u1", true), "👍", "u1", false).reactions, before.reactions);
  assert.deepEqual(withReaction(withReaction(before, "🎉", "u1", true), "🎉", "u1", false).reactions, before.reactions);
});

test("a deleted message keeps its place and loses its content", () => {
  const before = post("1", { text: "secret", reactions: [{ emoji: "👍", userIds: ["u2"] }], attachments: [{ id: "f1", name: "a.pdf", mime: "application/pdf", size: 3 }] });
  const gone = asDeleted(before);
  assert.deepEqual([gone.id, gone.deleted, gone.text, gone.attachments, gone.reactions], ["1", true, "", [], []]);
  assert.equal(before.text, "secret");
});

test("a change shows at once and is undone when the server refuses", () => {
  const first = post("1"), second = post("2", { text: "keep me" });
  const list = [first, second];
  const gone = asDeleted(second);
  const shown = showChange(list, gone)!;
  assert.deepEqual(shown.map(p => p.deleted), [false, true]);
  assert.equal(shown[0], first, "other rows are untouched");
  // Refused, for example because records preservation could not keep its copy: the message is back as it was.
  const undone = undoChange(shown, gone, second)!;
  assert.equal(undone[1], second);
  assert.equal(undone[1]!.text, "keep me");
  assert.equal(showChange(null, gone), null);
  assert.equal(undoChange(null, gone, second), null);
});

test("an undo leaves the server's own copy alone when it arrived in the meantime", () => {
  const original = post("2", { text: "keep me" });
  const gone = asDeleted(original);
  // A live update replaced the row while the request was out: someone edited it, or the server's delete landed.
  const fromServer = post("2", { text: "edited by the server's copy", editedAt: 1763000001000 });
  const list = [post("1"), fromServer];
  assert.equal(undoChange(list, gone, original)![1], fromServer);
});

// The screens: both show the change before they ask, and undo it when the server refuses.
for (const file of ["app/c/[id].tsx", "app/thread.tsx"]) {
  test(`${file} reacts and deletes at once, and takes it back on a refusal`, () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, "..", file), "utf8");
    for (const [name, call] of [["react", "api.reactToPost("], ["remove", "api.deletePost("]] as const) {
      const start = source.indexOf(`const ${name} = async`);
      assert.ok(start > 0, name);
      const body = source.slice(start, source.indexOf("\n  };", start));
      const shown = body.search(/showChange\(|show\(/), asked = body.indexOf(call), refused = body.indexOf("catch");
      assert.ok(shown > 0 && shown < asked, `${name}: the change shows before ${call}`);
      assert.ok(refused > asked && /undoChange\(|undo\(/.test(body.slice(refused)), `${name}: a refusal undoes it`);
      assert.match(body.slice(refused), /setError\(/, `${name}: and says why`);
    }
  });
}
