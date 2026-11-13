import test from "node:test";
import assert from "node:assert/strict";
import { scanOptions } from "./scan-mode.ts";

const paired = { serverKey: "02" + "ab".repeat(32) };

test("legacy accounts scan reconnect invites and can return to the invite screen after camera denial", () => {
  for (const account of [{}, { serverKey: "" }, { serverKey: "old-key" }]) {
    assert.deepEqual(scanOptions(undefined, account), { computer: false, returnTo: "/welcome" });
  }
});

test("a paired account keeps computer scanning as its default", () => {
  assert.deepEqual(scanOptions(undefined, paired), { computer: true, returnTo: "/you" });
});

test("explicit computer links stay in computer mode while signed out or reconnecting", () => {
  assert.deepEqual(scanOptions("computer", null), { computer: true, returnTo: "/welcome" });
  assert.deepEqual(scanOptions("computer", {}), { computer: true, returnTo: "/welcome" });
  assert.deepEqual(scanOptions("computer", paired), { computer: true, returnTo: "/you" });
});

test("an ordinary signed-out scan remains an invite scan", () => {
  assert.deepEqual(scanOptions(undefined, null), { computer: false, returnTo: "/welcome" });
});
