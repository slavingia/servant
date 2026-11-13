import { test } from "node:test";
import assert from "node:assert/strict";
import { bannerFromServer } from "./banner.ts";

test("only a non-empty message makes a banner", () => {
  assert.equal(bannerFromServer(undefined), undefined);
  assert.equal(bannerFromServer(null), undefined);
  assert.equal(bannerFromServer("Do not use"), undefined);
  assert.equal(bannerFromServer([]), undefined);
  assert.equal(bannerFromServer({}), undefined);
  assert.equal(bannerFromServer({ message: "  " }), undefined);
  assert.equal(bannerFromServer({ message: 4 }), undefined);
  assert.deepEqual(bannerFromServer({ message: " Do not use this app. " }), { message: "Do not use this app." });
});
