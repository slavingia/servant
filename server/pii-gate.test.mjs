import test from "node:test";
import assert from "node:assert/strict";
import { screenText, typesToWarn, warningText, piiWarningEnabled } from "./pii-gate.mjs";

const fake = spans => ({ check: async () => ({ verdict: spans === "allow" ? "ALLOW" : "BLOCK", spans: spans === "allow" ? [] : spans }) });

test("a message with a phone number warns and names it", async () => {
  const w = await screenText("x", fake([{ type: "PHONE" }]));
  assert.deepEqual(w.types, ["PHONE"]);
  assert.match(w.message, /a phone number/);
});
test("a full name alone does not warn", async () => {
  assert.equal(await screenText("Ask Dana Whitfield", fake([{ type: "NAME" }])), null);
});
test("a name next to an SSN warns about the SSN only", async () => {
  const w = await screenText("x", fake([{ type: "NAME" }, { type: "GOV_ID" }, { type: "GOV_ID" }]));
  assert.deepEqual(w.types, ["GOV_ID"]);
});
test("an allowed message does not warn", async () => { assert.equal(await screenText("hi", fake("allow")), null); });
test("a failing check lets the message through", async () => {
  assert.equal(await screenText("x", { check: async () => { throw new Error("boom"); } }), null);
});
test("the wording joins several kinds in plain words", () => {
  assert.equal(warningText(["PHONE", "EMAIL", "GOV_ID"]), "This looks like it has a phone number, a personal email address and a government ID number. Servant isn't approved for personal or sensitive information.");
  assert.deepEqual(typesToWarn([{ type: "NAME" }, { type: "ZZZ" }]), []);
});
test("it is off unless config turns it on", () => {
  assert.equal(piiWarningEnabled(undefined), false);
  assert.equal(piiWarningEnabled({ enabled: "yes" }), false);
  assert.equal(piiWarningEnabled({ enabled: true }), true);
});
test("the real model, when installed here, warns on an SSN and lets a plan question through", { skip: !process.env.SERVANT_PII_REAL }, async () => {
  assert.ok((await screenText("My SSN is 452-78-1934."))?.types.includes("GOV_ID"));
  assert.equal(await screenText("Plans for next year's filing season"), null);
  assert.equal(await screenText("Ask Marcus Delgado about the deposit."), null);
});
