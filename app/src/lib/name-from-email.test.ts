import test from "node:test";
import assert from "node:assert/strict";
import { nameFromEmail } from "./name-from-email.ts";

test("guesses a name from a work email", () => {
  assert.equal(nameFromEmail("pat.tester@agency.gov"), "Pat Tester");
  assert.equal(nameFromEmail("Pat_Tester2@AGENCY.gov"), "Pat Tester");
  assert.equal(nameFromEmail("mary-ann.smith+servant@mail.agency.gov"), "Mary Ann Smith");
  assert.equal(nameFromEmail("jlee@agency.gov"), "Jlee");
  assert.equal(nameFromEmail("1234@agency.gov"), "");
  assert.equal(nameFromEmail(""), "");
});
