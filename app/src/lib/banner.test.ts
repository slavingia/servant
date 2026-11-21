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

// A message a little wider than the bar was filled line by line, which left its last word alone on a second line
// under the rest ("...within the" / "team."). In a browser the lines are balanced: the same number of them, of
// about the same length. Measured in Chromium at 521 points: 422 + 40 before, 203 + 260 after.
test("the banner's words wrap into lines of about the same length in a browser", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../components/ServerBanner.tsx", import.meta.url), "utf8");
  const text = src.match(/\n  text:\s*\{([^\n]*)\},\n/)?.[1];
  assert.ok(text, "the message's style is found");
  assert.match(text, /textAlign: "center"/, "the words stay centered");
  assert.match(text, /Platform\.OS === "web" \? \{ textWrap: "balance" \}/, "balanced lines, where a browser can do it");
  assert.doesNotMatch(src, /numberOfLines/, "and the whole message still shows");
});
