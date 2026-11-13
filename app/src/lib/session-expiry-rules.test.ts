import { test } from "node:test";
import assert from "node:assert/strict";
import { canResend, cleanCode, expiryLead, formatHours, isSessionExpired, isSignedOut, parseSessionInfo, sessionLapsed } from "./session-expiry-rules.ts";

test("only a 401 that is not session_expired means signed out", () => {
  const expired = { status: 401, code: "session_expired" };
  const revoked = { status: 401, code: "unauthorized" };
  const oldBuildStyle = { status: 403, code: "session_expired" };
  assert.equal(isSessionExpired(expired), true);
  assert.equal(isSignedOut(expired), false);
  assert.equal(isSignedOut(revoked), true);
  assert.equal(isSessionExpired(revoked), false);
  assert.equal(isSessionExpired(oldBuildStyle), true);
  assert.equal(isSignedOut(oldBuildStyle), false);
  assert.equal(isSignedOut({ status: 500 }), false);
  assert.equal(isSignedOut(null), false);
  assert.equal(isSessionExpired("session_expired"), false);
});

test("the session info from /v1/me is parsed strictly and drives the resume check", () => {
  assert.equal(parseSessionInfo(null), null);
  assert.equal(parseSessionInfo({}), null);
  assert.equal(parseSessionInfo({ expiresAt: "soon" }), null);
  const info = parseSessionInfo({ expiresAt: 1000, maxHours: 12, emailNeeded: false, email: "j***@example.gov" });
  assert.deepEqual(info, { expiresAt: 1000, maxHours: 12, emailNeeded: false, email: "j***@example.gov" });
  assert.deepEqual(parseSessionInfo({ expiresAt: 5 }), { expiresAt: 5, maxHours: 0, emailNeeded: false, email: null });
  assert.equal(sessionLapsed(info, 999), false);
  assert.equal(sessionLapsed(info, 1000), true);
  assert.equal(sessionLapsed(null, 1e15), false, "servers without expiry never lapse");
});

test("the lead says what happens and where the code goes, without a countdown", () => {
  assert.equal(expiryLead(12, "j***@example.gov"), "For safety, Servant asks you to confirm it's you every 12 hours. We'll email a code to j***@example.gov.");
  assert.match(expiryLead(12, null, true), /Add your work email/);
  assert.match(expiryLead(12, null), /the work email on your account/);
  assert.match(expiryLead(null, "a***@example.gov"), /now and then/);
  assert.equal(formatHours(1), "hour");
  assert.equal(formatHours(0.5), "30 minutes");
  assert.equal(formatHours(1.5), "1.5 hours");
  assert.ok(!/\d+:\d+/.test(expiryLead(12, "x***@example.gov")), "no clock");
});

test("resend waits quietly, and the code field keeps six digits from anything pasted", () => {
  assert.equal(canResend(null, 0), true);
  assert.equal(canResend(1000, 20000), false);
  assert.equal(canResend(1000, 31000), true);
  assert.equal(cleanCode("Your code is 12 34 56!"), "123456");
  assert.equal(cleanCode("1234567"), "123456");
  assert.equal(cleanCode(""), "");
});
