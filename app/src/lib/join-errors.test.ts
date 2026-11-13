import test from "node:test";
import assert from "node:assert/strict";
import { countdownText, describeJoinError, signInInstructions, SIGN_IN_LINK_STEPS } from "./join-errors.ts";

test("try again is offered only when trying again can work", () => {
  for (const code of ["invite_used", "invite_replaced", "invite_expired", "invalid_invite", "rate_limited", "encryption_required"]) {
    const problem = describeJoinError(code, "server words", { existing: true });
    assert.notEqual(problem.action, "retry", code);
    assert.notEqual(problem.actionLabel, "Try again", code);
  }
  for (const code of ["unreachable", "network", "draining", "server_error"]) assert.equal(describeJoinError(code, "").action, "retry", code);
});

test("a dead sign-in link says how to get a new one from the other device", () => {
  const used = describeJoinError("invite_used", "", { existing: true });
  assert.equal(used.title, "This link was already used");
  assert.match(used.message, /works once/);
  assert.match(used.message, /Link a computer/);
  assert.equal(used.action, "new-link");
  const replaced = describeJoinError("invite_replaced", "", { existing: true });
  assert.match(replaced.message, /cancels the old one/);
  const expired = describeJoinError("invite_expired", "", { existing: true });
  assert.match(expired.message, /ten minutes/);
});

test("a dead team invite points at the person who invited you", () => {
  const used = describeJoinError("invite_used", "");
  assert.match(used.message, /person who invited you/);
  assert.equal(used.action, "new-invite");
  assert.equal(describeJoinError("invite_expired", "").action, "new-invite");
});

test("unknown problems keep the server's words", () => {
  const other = describeJoinError("terms_required", "Agree to the terms to join");
  assert.equal(other.message, "Agree to the terms to join");
});

test("an outdated invite explains recovery without exposing protocol details", () => {
  const problem = describeJoinError("encryption_required", "This invite needs an encryption key");
  assert.match(problem.message, /older version of Servant/);
  assert.match(problem.message, /Ask for a new one/);
  assert.doesNotMatch(problem.message, /encryption|key/);
});

test("instructions and steps mention You, Link a computer and Make a link", () => {
  assert.match(signInInstructions(), /You, then Link a computer, then Make a link/);
  assert.equal(SIGN_IN_LINK_STEPS.length, 3);
  assert.match(SIGN_IN_LINK_STEPS[1], /Link a computer/);
});

test("countdown shows minutes and seconds and never goes negative", () => {
  assert.equal(countdownText(10 * 60 * 1000, 0), "10:00");
  assert.equal(countdownText(9 * 60 * 1000 + 5000, 0), "9:05");
  assert.equal(countdownText(0, 5000), "0:00");
});
