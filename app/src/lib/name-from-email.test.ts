import test from "node:test";
import assert from "node:assert/strict";
import { nameFromEmail } from "./name-from-email.ts";

test("guesses a name from a work email", () => {
  assert.equal(nameFromEmail("pat.tester@irs.gov"), "Pat Tester");
  assert.equal(nameFromEmail("Pat_Tester2@IRS.gov"), "Pat Tester");
  assert.equal(nameFromEmail("mary-ann.smith+servant@mail.irs.gov"), "Mary Ann Smith");
  assert.equal(nameFromEmail("jlee@irs.gov"), "Jlee");
  assert.equal(nameFromEmail("1234@irs.gov"), "");
  assert.equal(nameFromEmail(""), "");
});
