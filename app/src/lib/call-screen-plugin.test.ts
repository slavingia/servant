import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const plugin = require(fileURLToPath(new URL("../../plugins/with-call-screen.js", import.meta.url)));
const { compileModsAsync } = require("expo/config-plugins");

// The call plugin must not make MainActivity show over the lock screen all the time: with Servant
// open, pressing lock twice opened the app without the PIN (Pixel 6a). iPhone keeps VoIP mode.
test("the call plugin leaves the Android lock screen alone and keeps iPhone VoIP", async () => {
  const exp = plugin({ name: "t", slug: "t", ios: { bundleIdentifier: "com.slavingia.servant" }, android: { package: "com.slavingia.servant" } });
  const config = await compileModsAsync(exp, {
    projectRoot: fileURLToPath(new URL("../..", import.meta.url)),
    platforms: ["android", "ios"],
    introspect: true,
    ignoreExistingNativeFiles: true,
  });
  const results = config._internal.modResults;
  const activities: { $: Record<string, string> }[] = results.android?.manifest?.manifest?.application?.[0]?.activity ?? [];
  for (const a of activities) {
    assert.notEqual(a.$["android:showWhenLocked"], "true", "no activity shows over the lock screen");
    assert.notEqual(a.$["android:turnScreenOn"], "true", "no activity turns the screen on");
  }
  const modes: string[] = results.ios.infoPlist.UIBackgroundModes ?? [];
  assert.ok(modes.includes("voip") && modes.includes("remote-notification"));
});
