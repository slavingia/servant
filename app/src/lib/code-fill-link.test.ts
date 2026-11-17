import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { codeFromLink, codeFromParams, codeLinkPath, describeCode, fitsRequest, planLink } from "./code-fill-link.ts";
import type { CodeRequest } from "./server.ts";

const request = (id: string, extra: Partial<CodeRequest> = {}): CodeRequest => ({
  id, label: "Login.gov sign-in", device: "QA runner", status: "pending", createdAt: 1, expiresAt: 2, ...extra,
});

test("a link can carry just the code", () => {
  assert.deepEqual(codeFromLink("554100"), { code: "554100" });
  assert.deepEqual(codeFromLink(" 554 100 "), { code: "554100" }, "digits in groups, as people type them");
  assert.deepEqual(codeFromLink("554-100"), { code: "554100" });
  assert.deepEqual(codeFromLink("AB12CD"), { code: "AB12CD" });
  assert.deepEqual(codeFromLink(["554100", "999999"]), { code: "554100" }, "the first when a link repeats it");
});

test("or the whole text, and a site-bound last line names the code", () => {
  const loginGov = "Login.gov: Your one-time code is 554100. It expires in 10 minutes. Don't share this code with anyone.\n\n@login.gov #554100";
  assert.deepEqual(codeFromLink(loginGov), { code: "554100", site: "login.gov" });
  assert.deepEqual(codeFromLink("Your code is 4821.\n\n@Example.gov #4821 %@app.example.gov"), { code: "4821", site: "example.gov" });
  assert.deepEqual(codeFromLink("@login.gov #554100"), { code: "554100", site: "login.gov" });
});

test("without one, the text's one code is found", () => {
  assert.deepEqual(codeFromLink("Your Example verification code is 812345. It is valid for 10 minutes."), { code: "812345" });
  assert.deepEqual(codeFromLink("Use 4821 to sign in"), { code: "4821" });
  assert.deepEqual(codeFromLink("Code 123456, sent 2026"), { code: "123456" }, "a six-digit number over a year");
  assert.deepEqual(codeFromLink("G-123456 is your verification code."), { code: "123456" });
  assert.deepEqual(codeFromLink("Your code is 554100. Again: 554100"), { code: "554100" }, "the same number twice is one code");
});

test("a link without exactly one code is turned down", () => {
  for (const bad of [undefined, null, 42, "", "   ", "abc", "1234567890123", "12 34 56 78 90 123",
    "Codes 123456 and 654321", "Call 555-0100 or 555-0199", "No code here, sorry.", "x".repeat(2001)]) {
    assert.equal(codeFromLink(bad), null, String(bad).slice(0, 40));
  }
});

test("a code is sent by itself only to the one request waiting, when it fits", () => {
  assert.deepEqual(planLink([], "554100"), { kind: "wait" });
  assert.deepEqual(planLink([request("a", { status: "answered" })], "554100"), { kind: "wait" }, "only waiting requests count");
  const one = request("a");
  assert.deepEqual(planLink([one], "554100"), { kind: "send", request: one });
  const eight = request("b", { length: 8 });
  assert.deepEqual(planLink([eight], "554100"), { kind: "length", request: eight, got: 6 });
  const two = [request("a"), request("b", { label: "Example sign-in" })];
  assert.deepEqual(planLink(two, "554100"), { kind: "choose", requests: two }, "several waiting: the person picks");
  assert.equal(fitsRequest({ length: undefined }, "AB12"), true);
  assert.equal(fitsRequest({ length: 6 }, "554100"), true);
  assert.equal(fitsRequest({ length: 6 }, "5541"), false);
});

test("a code link reaches the router as the code alone", () => {
  const text = "Login.gov: Your one-time code is 554100. It expires in 10 minutes. Don't share this code with anyone.\n\n@login.gov #554100";
  assert.equal(codeLinkPath(`servant://code?text=${encodeURIComponent(text)}`), "/code?code=554100&site=login.gov");
  assert.equal(codeLinkPath("servant://code?code=554100"), "/code?code=554100");
  assert.equal(codeLinkPath("servant://code/?text=Use%204821%20to%20sign%20in"), "/code?code=4821");
  assert.equal(codeLinkPath("SERVANT://CODE?text=554+100"), "/code?code=554100", "a + is a space in a query");
  assert.equal(codeLinkPath("exp+servant://expo-development-client/--/code?code=554100"), "/code?code=554100");
  assert.equal(codeLinkPath("/code?text=554100"), "/code?code=554100");
  assert.equal(codeLinkPath("com.example.servant://code?code=554100"), "/code?code=554100", "the app's own id as the scheme");
  assert.equal(codeLinkPath("servant://code?text=Use 4821 & go #now"), "/code?code=4821", "an unencoded text keeps what comes before #");
  assert.equal(codeLinkPath("servant://code"), "/code?invalid=1", "a link without a code says so");
  assert.equal(codeLinkPath("servant://code?text=Codes%20123456%20and%20654321"), "/code?invalid=1");
  for (const other of ["servant://code/code_abcdefghijkl", "servant://codes?text=1234", "servant://pair?code=1234", "servant://expo-sharing", "https://example.gov/code?text=1234", "", undefined, 42]) {
    assert.equal(codeLinkPath(other), null, String(other));
  }
});

test("the screen reads a rewritten link or a browser's ?text=", () => {
  assert.deepEqual(codeFromParams({ code: "554100", site: "login.gov" }), { code: "554100", site: "login.gov" });
  assert.deepEqual(codeFromParams({ text: "Your code is 554100.\n\n@login.gov #554100" }), { code: "554100", site: "login.gov" });
  assert.deepEqual(codeFromParams({ code: "554100", site: "<b>bad</b>" }), { code: "554100" }, "a site that is not a domain is dropped");
  assert.equal(codeFromParams({ invalid: "1" } as never), null);
  assert.equal(describeCode({ code: "554100", site: "login.gov" }), "6-digit code for login.gov");
  assert.equal(describeCode({ code: "AB12CD34" }), "8-character code");
});

test("the link's screen is only for a signed-in person", () => {
  const layout = fs.readFileSync(path.join(import.meta.dirname, "../app/_layout.tsx"), "utf8");
  const signedIn = layout.indexOf("<Stack.Protected guard={paired}");
  assert.ok(signedIn > 0);
  assert.ok(layout.indexOf('name="code/index"') > signedIn, "code/index sits inside the signed-in group");
});

test("links are rewritten before the router sees them", () => {
  const intent = fs.readFileSync(path.join(import.meta.dirname, "../app/+native-intent.tsx"), "utf8");
  assert.match(intent, /codeLinkPath\(path\)/);
});
