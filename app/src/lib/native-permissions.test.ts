import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { getPrebuildConfigAsync } = require("@expo/prebuild-config");
const { compileModsAsync } = require("@expo/config-plugins");

test("combined native plugins preserve scanner and dictation permissions without broad photo access", async () => {
  const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
  const platforms = ["ios", "android"];
  const { exp } = await getPrebuildConfigAsync(projectRoot, { platforms });
  // Firebase credentials are unrelated to permissions and are not needed in CI.
  delete exp.ios.googleServicesFile;
  delete exp.android.googleServicesFile;
  const config = await compileModsAsync(exp, {
    projectRoot,
    platforms,
    introspect: true,
    ignoreExistingNativeFiles: true,
  });
  const results = config._internal.modResults;
  const permissions: { $: Record<string, string> }[] =
    results.android.manifest.manifest["uses-permission"];
  const isEnabled = (name: string) => permissions.some(({ $: permission }) =>
    permission["android:name"] === name && permission["tools:node"] !== "remove"
  );
  assert.equal(isEnabled("android.permission.CAMERA"), true,
    "The QR scanner needs CAMERA after all plugins have been applied");
  assert.equal(permissions.some(({ $: permission }) =>
    permission["android:name"] === "android.permission.CAMERA" &&
    permission["tools:node"] === "remove"
  ), false, "No plugin may block the scanner's camera permission");
  assert.equal(isEnabled("android.permission.RECORD_AUDIO"), true,
    "Dictation must retain microphone permission");
  assert.equal(isEnabled("android.permission.READ_MEDIA_IMAGES"), false,
    "The system photo picker must not request broad photo access");
  assert.equal(permissions.some(({ $: permission }) =>
    permission["android:name"] === "android.permission.READ_MEDIA_IMAGES" &&
    permission["tools:node"] === "remove"
  ), true, "Library manifests must not reintroduce broad photo access");
  assert.equal(typeof results.ios.infoPlist.NSCameraUsageDescription, "string");
  assert.ok(results.ios.infoPlist.NSCameraUsageDescription.length > 0);
});
