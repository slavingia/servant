import assert from "node:assert/strict";
import test from "node:test";
import { daysLabel, orderTokens, shellSetup, tokenLine, TOKEN_DAYS, type AccessToken } from "./access-tokens.ts";
import { DESTINATIONS } from "./destinations.ts";

const NOW = new Date(2026, 10, 20, 12).getTime();
const at = (month: number, day: number, year = 2026) => new Date(year, month, day, 9).getTime();
const token = (fields: Partial<AccessToken>): AccessToken => ({ id: "tok_1", name: "Work laptop", hint: "svt_abcd…wxyz", createdAt: at(10, 1), expiresAt: at(1, 18, 2027), state: "active", ...fields });

test("a token says where it stands in one line", () => {
  assert.equal(tokenLine(token({}), NOW), "Ends Feb 18, 2027 · never used");
  assert.equal(tokenLine(token({ expiresAt: at(11, 20), lastUsedAt: at(10, 19) }), NOW), "Ends Dec 20 · last used Nov 19");
  assert.equal(tokenLine(token({ state: "expired", expiresAt: at(10, 2) }), NOW), "Expired Nov 2");
  assert.equal(tokenLine(token({ state: "revoked", revokedAt: at(10, 20) }), NOW), "Revoked Nov 20");
});

test("live tokens come first, and the lengths on offer read plainly", () => {
  const list = [token({ id: "old", state: "revoked", createdAt: 5 }), token({ id: "a", createdAt: 1 }), token({ id: "gone", state: "expired", createdAt: 9 }), token({ id: "b", createdAt: 3 })];
  assert.deepEqual(orderTokens(list).map(t => t.id), ["b", "a", "gone", "old"]);
  assert.deepEqual(TOKEN_DAYS.map(daysLabel), ["1 week", "30 days", "90 days", "1 year"]);
});

test("the setup lines for a shell use the server's own address", () => {
  assert.equal(shellSetup("https://team.example.gov/api/v1", "svt_x"), '$env:SERVANT_TOKEN = "svt_x"\n$Servant = "https://team.example.gov/api/v1"\n$Headers = @{ Authorization = "Bearer $env:SERVANT_TOKEN" }\nInvoke-RestMethod "$Servant/me" -Headers $Headers');
  assert.match(shellSetup(null, "svt_x"), /\$Servant = "https:\/\/your-server\/api\/v1"/);
});

test("Access tokens is a place on You, found by what people would type", () => {
  const place = DESTINATIONS.find(item => item.id === "tokens")!;
  assert.deepEqual([place.label, place.path, place.you, place.sidebar], ["Access tokens", "/access-tokens", true, false]);
  assert.match(place.keywords, /powershell/);
});
