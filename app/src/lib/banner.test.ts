import { test } from "node:test";
import assert from "node:assert/strict";
import { bannerFromServer, bannerShown } from "./banner.ts";

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

test("a banner this device hid is not on screen, so the status bar strip comes back", () => {
  assert.equal(bannerShown("Pilot in effect", null), true);
  assert.equal(bannerShown("Pilot in effect", "Pilot in effect"), false);
  assert.equal(bannerShown("A new message", "Pilot in effect"), true);
  assert.equal(bannerShown(undefined, null), false);
});

test("AppChrome counts only a banner that is on screen", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../components/AppChrome.tsx", import.meta.url), "utf8");
  assert.match(src, /hasBanner = bannerShown\(/, "a hidden banner must not remove the status bar strip");
});
