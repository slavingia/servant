import test from "node:test";
import assert from "node:assert/strict";
import { nameFromEmail } from "./name-from-email.ts";

test("guesses a name from a work email", () => {
  assert.equal(nameFromEmail("pat.tester@example.gov"), "Pat Tester");
  assert.equal(nameFromEmail("Pat_Tester2@EXAMPLE.gov"), "Pat Tester");
  assert.equal(nameFromEmail("mary-ann.smith+servant@mail.example.gov"), "Mary Ann Smith");
  assert.equal(nameFromEmail("jlee@example.gov"), "Jlee");
  assert.equal(nameFromEmail("1234@example.gov"), "");
  assert.equal(nameFromEmail(""), "");
});
