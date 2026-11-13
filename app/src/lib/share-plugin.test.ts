import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const appJson = require("../../app.json");
const sharingModule = require("expo-sharing/app.plugin.js");
const withSharing = sharingModule.default ?? sharingModule;
const { compileModsAsync } = require("expo/config-plugins");

type Entry = [string, { ios: Record<string, any>; android: Record<string, any> }];
const entry = appJson.expo.plugins.find((p: unknown) => Array.isArray(p) && p[0] === "expo-sharing") as Entry | undefined;

test("app.json receives shares on both platforms, with the composer's limit of four files", () => {
  assert.ok(entry, "expo-sharing is configured in app.json");
  const { ios, android } = entry![1];
  assert.equal(ios.enabled, true);
  assert.equal(android.enabled, true);
  assert.equal(ios.extensionBundleIdentifier, "com.example.servant.share");
  assert.equal(ios.appGroupId, "group.com.example.servant");
  assert.equal(ios.activationRule.supportsText, true);
  assert.equal(ios.activationRule.supportsWebUrlWithMaxCount, 1);
  for (const key of ["supportsImageWithMaxCount", "supportsMovieWithMaxCount", "supportsFileWithMaxCount"]) assert.equal(ios.activationRule[key], 4, key);
  assert.deepEqual(android.singleShareMimeTypes, ["text/*", "image/*", "video/*", "audio/*", "application/*"]);
  assert.deepEqual(android.multipleShareMimeTypes, ["image/*", "video/*", "audio/*", "application/*"]);
  assert.ok(appJson.expo.plugins.includes("./plugins/with-share-extension-name"), "the extension is named Servant in the share sheet");
});

test("the plugin writes the Android intent filters, the iOS app group, and declares the extension the release chain must provision", async () => {
  const base = { name: "Servant", slug: "servant", version: "1.0.0", scheme: "servant", ios: { bundleIdentifier: "com.example.servant", buildNumber: "28" }, android: { package: "com.example.servant" }, _internal: { projectRoot } };
  const exp = withSharing(base, entry![1]);
  const config = await compileModsAsync(exp, { projectRoot, platforms: ["android", "ios"], introspect: true, ignoreExistingNativeFiles: true });
  const results = config._internal.modResults;
  const activity = results.android.manifest.manifest.application[0].activity.find((a: any) => a.$["android:name"] === ".MainActivity");
  const filters: any[] = activity["intent-filter"];
  const byAction = (name: string) => filters.filter(f => f.action?.some((a: any) => a.$["android:name"] === name));
  const mimes = (list: any[]) => list.flatMap(f => f.data.map((d: any) => d.$["android:mimeType"]));
  assert.deepEqual(mimes(byAction("android.intent.action.SEND")), ["text/*", "image/*", "video/*", "audio/*", "application/*"]);
  assert.deepEqual(mimes(byAction("android.intent.action.SEND_MULTIPLE")), ["image/*", "video/*", "audio/*", "application/*"]);
  for (const filter of [...byAction("android.intent.action.SEND"), ...byAction("android.intent.action.SEND_MULTIPLE")]) {
    assert.ok(filter.category.some((c: any) => c.$["android:name"] === "android.intent.category.DEFAULT"));
  }
  // The app opens on servant://expo-sharing, which +native-intent.tsx turns into /share.
  const strings = results.android.strings?.resources?.string ?? [];
  assert.equal(strings.find((s: any) => s.$.name === "share_into_scheme")?._, "servant");
  assert.deepEqual(results.ios.entitlements["com.apple.security.application-groups"], ["group.com.example.servant"]);
  assert.equal(results.ios.infoPlist.ExpoShareIntoAppGroupId, "group.com.example.servant");
  assert.deepEqual(config.ios?.entitlements, { "com.apple.security.application-groups": ["group.com.example.servant"] });
  assert.deepEqual(config.extra?.eas?.build?.experimental?.ios?.appExtensions, [{
    targetName: "expo-sharing-extension", bundleIdentifier: "com.example.servant.share", entitlements: { "com.apple.security.application-groups": ["group.com.example.servant"] },
  }]);
});

test("app.config.js derives every app id from SERVANT_BUNDLE_ID (default com.example.servant) and refuses a malformed one", () => {
  const configure = require("../../app.config.js");
  const saved = process.env.SERVANT_BUNDLE_ID;
  const ids = (value: string | undefined) => {
    if (value === undefined) delete process.env.SERVANT_BUNDLE_ID; else process.env.SERVANT_BUNDLE_ID = value;
    const c = configure({ config: appJson.expo });
    const sharing = c.plugins.find((p: unknown) => Array.isArray(p) && p[0] === "expo-sharing")[1].ios;
    return [c.ios.bundleIdentifier, c.android.package, sharing.extensionBundleIdentifier, sharing.appGroupId, sharing.activationRule.supportsText];
  };
  try {
    assert.deepEqual(ids(undefined), ["com.example.servant", "com.example.servant", "com.example.servant.share", "group.com.example.servant", true]);
    assert.deepEqual(ids("  org.acme.chat "), ["org.acme.chat", "org.acme.chat", "org.acme.chat.share", "group.org.acme.chat", true]);
    for (const bad of ["servant", "org.acme.", "org..acme", "1org.acme", "org.acme-chat", "org.acme chat"]) assert.throws(() => ids(bad), /SERVANT_BUNDLE_ID/, bad);
  } finally {
    if (saved === undefined) delete process.env.SERVANT_BUNDLE_ID; else process.env.SERVANT_BUNDLE_ID = saved;
  }
});

test("app.config.js builds Crashlytics in only when a Firebase config file is present", () => {
  const configure = require("../../app.config.js");
  const fs = require("node:fs");
  const plist = new URL("../../GoogleService-Info.plist", import.meta.url).pathname;
  const hadPlist = fs.existsSync(plist);
  const firebase = (c: any) => (c.plugins || []).filter((p: unknown) => String(Array.isArray(p) ? p[0] : p).startsWith("@react-native-firebase/")).length;
  try {
    if (hadPlist) fs.renameSync(plist, plist + ".hold");
    const without = configure({ config: appJson.expo });
    if (!fs.existsSync(new URL("../../google-services.json", import.meta.url).pathname)) {
      assert.equal(firebase(without), 0);
      assert.equal(without.android.googleServicesFile, undefined);
    }
    assert.equal(without.ios.googleServicesFile, undefined);
    fs.writeFileSync(plist, "<plist/>");
    const withFile = configure({ config: appJson.expo });
    assert.equal(firebase(withFile), 2);
    assert.equal(withFile.ios.googleServicesFile, "./GoogleService-Info.plist");
  } finally {
    fs.rmSync(plist, { force: true });
    if (hadPlist) fs.renameSync(plist + ".hold", plist);
  }
});
