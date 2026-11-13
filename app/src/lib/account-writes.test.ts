import test from "node:test";
import assert from "node:assert/strict";
import { createAccountWrites } from "./account-writes.ts";

test("cancelled desktop completion restores the previous account before newer pairing", async () => {
  let value: string | null = "original";
  let active = true;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const writing = new Promise<void>(resolve => { started = resolve; });
  const writes = createAccountWrites({
    read: async () => value,
    write: async next => { if (next === "desktop") { started(); await pending; } value = next; },
    remove: async () => { value = null; },
  });
  const desktop = writes.save("desktop", () => active);
  await writing;
  active = false;
  const newerPairing = writes.save("newer");
  release();
  assert.equal(await desktop, false);
  await newerPairing;
  assert.equal(value, "newer");
});

test("abandoned sign-in on an empty device leaves no saved account", async () => {
  let value: string | null = null;
  let active = true;
  const writes = createAccountWrites({
    read: async () => value,
    write: async next => { value = next; active = false; },
    remove: async () => { value = null; },
  });
  assert.equal(await writes.save("desktop", () => active), false);
  assert.equal(value, null);
});

test("write errors do not block retry or subsequent sign-out", async () => {
  let value: string | null = null;
  let fail = true;
  const writes = createAccountWrites({
    read: async () => value,
    write: async next => { if (fail) throw new Error("Keychain locked"); value = next; },
    remove: async () => { value = null; },
  });
  await assert.rejects(writes.save("first"), /Keychain locked/);
  fail = false;
  assert.equal(await writes.save("second"), true);
  await writes.clear();
  assert.equal(value, null);
});
