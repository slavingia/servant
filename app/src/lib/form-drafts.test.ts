import assert from "node:assert/strict";
import test from "node:test";

test("form drafts are kept per person and server, cleared on request or sign-out, and old ones expire", async () => {
  const { clearFormDraft, clearFormDraftsFor, formDraftKey, readFormDraft, setFormDraftStorage, writeFormDraft } = await import("./form-drafts.ts");
  const memory = new Map<string, string>();
  const day = 24 * 60 * 60_000;
  const now = Date.now();
  // An old draft in storage is dropped when drafts are loaded.
  memory.set("servant.formDrafts", JSON.stringify({ "https://s|old|research-new:study": { savedAt: now - 90 * day, value: { title: "Old" } } }));
  setFormDraftStorage({ getItem: async key => memory.get(key) ?? null, setItem: async (key, value) => { memory.set(key, value); } });
  const rhea = { serverUrl: "https://s", user: { id: "usr_rhea" } };
  const other = { serverUrl: "https://s", user: { id: "usr_other" } };
  const mine = formDraftKey(rhea, "research-new:study");
  const theirs = formDraftKey(other, "research-new:study");
  assert.notEqual(mine, theirs);
  assert.notEqual(mine, formDraftKey({ ...rhea, serverUrl: "https://elsewhere" }, "research-new:study"));
  assert.equal(await readFormDraft("https://s|old|research-new:study"), null);
  await writeFormDraft(mine, { title: "Balance" }, now);
  await writeFormDraft(theirs, { title: "Other" }, now);
  assert.deepEqual(await readFormDraft(mine), { savedAt: now, value: { title: "Balance" } });
  assert.match(memory.get("servant.formDrafts")!, /Balance/, "kept in device storage");
  await clearFormDraft(mine);
  assert.equal(await readFormDraft(mine), null);
  await writeFormDraft(mine, { title: "Again" }, now);
  await clearFormDraftsFor(rhea);
  assert.equal(await readFormDraft(mine), null, "signing out clears that person's drafts");
  assert.deepEqual((await readFormDraft(theirs))?.value, { title: "Other" }, "someone else's draft stays");
  assert.doesNotMatch(memory.get("servant.formDrafts")!, /Again/);
});
