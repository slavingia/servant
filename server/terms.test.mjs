import { test } from "node:test";
import assert from "node:assert/strict";
import { TERMS_VERSION, TERMS_ITEMS, validTermsAcceptance } from "./terms.mjs";
import { termsAcceptance, termsLinks } from "../app/src/lib/terms.ts";

test("the current app consent matches the server and each required commitment is enforced", () => {
  assert.deepEqual(validTermsAcceptance(termsAcceptance()), { version: TERMS_VERSION, items: TERMS_ITEMS });
  for (const missing of TERMS_ITEMS) {
    assert.equal(validTermsAcceptance({ version: TERMS_VERSION, items: TERMS_ITEMS.filter(item => item !== missing) }), null);
  }
  for (const invalid of [undefined, {}, { version: "2026-01-01", items: TERMS_ITEMS }, { version: TERMS_VERSION, items: "terms,ai,sensitive" }]) {
    assert.equal(validTermsAcceptance(invalid), null);
  }
});

test("distributed clients retain their original consent version instead of being relabelled", () => {
  assert.deepEqual(validTermsAcceptance({ version: "2026-11-03", items: TERMS_ITEMS }), { version: "2026-11-03", items: TERMS_ITEMS });
  assert.equal(validTermsAcceptance({ version: "2026-11-03", items: ["terms", "ai"] }), null);
});

test("consent documents follow the invited server without credentials, tokens or fragments", () => {
  assert.deepEqual(termsLinks("https://team.example.gov/?code=private#token"), { terms: "https://team.example.gov/terms", privacy: "https://team.example.gov/privacy" });
  assert.deepEqual(termsLinks("https://team.example.gov/servant/"), { terms: "https://team.example.gov/servant/terms", privacy: "https://team.example.gov/servant/privacy" });
  assert.deepEqual(termsLinks("http://localhost:8787"), { terms: "http://localhost:8787/terms", privacy: "http://localhost:8787/privacy" });
  for (const invalid of [undefined, "", "javascript:alert(1)", "https://user:password@example.gov", "broken"]) assert.equal(termsLinks(invalid), null);
});
