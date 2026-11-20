// Personal access tokens: the store alone.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { accessTokenSettings, createAccessTokens, looksLikeToken, MAX_TOKENS_PER_PERSON } from "./access-tokens.mjs";

const DAY = 86_400_000;
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "servant-tokens-"));
  const time = { now: 1_800_000_000_000 };
  const file = path.join(dir, "access-tokens.db");
  const store = createAccessTokens(file, { clock: () => time.now });
  return { store, time, file, done: () => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
const fails = (fn, status, code) => assert.throws(fn, error => error.status === status && error.code === code);

test("the door is shut unless an owner opens it", () => {
  assert.deepEqual(accessTokenSettings(undefined), { enabled: false, requestsPerMinute: 60 });
  assert.equal(accessTokenSettings({ enabled: "true" }).enabled, false);
  assert.deepEqual(accessTokenSettings({ enabled: true, requestsPerMinute: 5000 }), { enabled: true, requestsPerMinute: 600 });
});

test("a token is shown once, kept only as a hash, and stands for its person until it ends", () => {
  const { store, time, file, done } = setup();
  fails(() => store.create("usr_pat", { name: "  " }), 400, "bad_request");
  fails(() => store.create("usr_pat", { name: "Laptop", days: 0 }), 400, "bad_request");
  fails(() => store.create("usr_pat", { name: "Laptop", days: 400 }), 400, "bad_request");
  const made = store.create("usr_pat", { name: "  Work   laptop " });
  assert.equal(looksLikeToken(made.token), true);
  assert.deepEqual([made.record.name, made.record.state, made.record.expiresAt - made.record.createdAt, made.record.hint], ["Work laptop", "active", 90 * DAY, `${made.token.slice(0, 8)}…${made.token.slice(-4)}`]);
  assert.equal("token" in made.record, false);
  // The file never holds the token itself.
  const raw = new DatabaseSync(file).prepare("SELECT * FROM tokens").all();
  assert.equal(JSON.stringify(raw).includes(made.token), false);
  assert.equal(JSON.stringify(store.list("usr_pat")).includes(made.token.slice(8, 40)), false);

  assert.deepEqual(store.check(made.token), { userId: "usr_pat", id: made.record.id });
  assert.equal(store.list("usr_pat")[0].lastUsedAt, time.now);
  for (const wrong of ["", "svt_short", made.token.slice(0, -1) + (made.token.endsWith("A") ? "B" : "A"), made.token.replace("svt_", "xyz_"), null]) assert.equal(store.check(wrong), null);
  assert.deepEqual(store.list("usr_jo"), [], "one person's tokens are not another's");

  // It ends on its day.
  time.now += 90 * DAY;
  assert.equal(store.check(made.token), null);
  assert.equal(store.list("usr_pat")[0].state, "expired");
  // Or when revoked, by its own person only; and it stays on the list.
  const second = store.create("usr_pat", { name: "Script", days: 1 });
  assert.equal(store.revoke(second.record.id, "usr_jo"), false);
  assert.equal(store.revoke(second.record.id, "usr_pat"), true);
  assert.equal(store.revoke(second.record.id, "usr_pat"), false);
  assert.equal(store.check(second.token), null);
  assert.deepEqual(store.list("usr_pat").map(t => [t.name, t.state]), [["Script", "revoked"], ["Work laptop", "expired"]]);
  // Or when the person leaves.
  const third = store.create("usr_pat", { name: "Other", days: 30 });
  store.forget("usr_pat", "server");
  assert.equal(store.check(third.token), null);
  assert.throws(() => new DatabaseSync(file).exec("DELETE FROM tokens"), /revoked, not deleted/);
  done();
});

test("a person has a limited number of live tokens, and each has a limited number of requests a minute", () => {
  const { store, time, done } = setup();
  for (let i = 0; i < MAX_TOKENS_PER_PERSON; i++) store.create("usr_pat", { name: `Token ${i}` });
  fails(() => store.create("usr_pat", { name: "One more" }), 400, "bad_request");
  store.revoke(store.list("usr_pat")[0].id, "usr_pat");
  assert.equal(store.create("usr_pat", { name: "One more" }).record.state, "active", "a revoked one makes room");
  assert.deepEqual([1, 2, 3, 4].map(() => store.allow("tok_a", 3)), [true, true, true, false]);
  assert.equal(store.allow("tok_b", 3), true, "each token has its own minute");
  time.now += 61_000;
  assert.equal(store.allow("tok_a", 3), true);
  done();
});
