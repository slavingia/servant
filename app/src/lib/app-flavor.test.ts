import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

type ExpoConfig = Record<string, any>;
const configure = createRequire(import.meta.url)("../../app.config.js") as ({ config }: { config: ExpoConfig }) => ExpoConfig;
const base = JSON.parse(readFileSync(new URL("../../app.json", import.meta.url), "utf8")).expo as ExpoConfig;
const pluginName = (plugin: unknown) => Array.isArray(plugin) ? plugin[0] : plugin;

function forFlavor(flavor: "ux" | "core") {
  const previous = process.env.SERVANT_APP_FLAVOR;
  process.env.SERVANT_APP_FLAVOR = flavor;
  try { return configure({ config: base }); }
  finally {
    if (previous === undefined) delete process.env.SERVANT_APP_FLAVOR;
    else process.env.SERVANT_APP_FLAVOR = previous;
  }
}

test("the UX flavor is separately installable and carries no upstream push configuration", () => {
  const config = forFlavor("ux");
  assert.equal(config.name, "Servant UX");
  assert.equal(config.slug, "servant-ux");
  assert.equal(config.scheme, "servant-ux");
  assert.equal(config.ios.bundleIdentifier, "gov.irs.servant.ux");
  assert.equal(config.android.package, "gov.irs.servant.ux");
  assert.equal(config.ios.googleServicesFile, undefined);
  assert.equal(config.android.googleServicesFile, undefined);
  assert.equal(config.extra.nativePushConfigured, false);
  assert.equal(config.plugins.some((plugin: unknown) => pluginName(plugin) === "@react-native-firebase/app"), false);
  assert.equal(config.plugins.some((plugin: unknown) => pluginName(plugin) === "@react-native-firebase/crashlytics"), false);
  assert.equal(config.plugins.some((plugin: unknown) => pluginName(plugin) === "./plugins/with-call-screen"), false);
  const notifications = config.plugins.find((plugin: unknown) => Array.isArray(plugin) && plugin[0] === "expo-notifications");
  assert.equal(notifications?.[1]?.enableRemoteNotifications, false);
  assert.match(config.ios.runtimeVersion, /^servant-ux-/);
  assert.match(config.android.runtimeVersion, /^servant-ux-/);
});

test("the explicit core flavor retains upstream identifiers and native integrations", () => {
  const config = forFlavor("core");
  assert.equal(config.name, "Servant");
  assert.equal(config.slug, "servant");
  assert.equal(config.scheme, "servant");
  assert.equal(config.ios.bundleIdentifier, "gov.irs.servant");
  assert.equal(config.android.package, "gov.irs.servant");
  assert.equal(config.extra.nativePushConfigured, true);
  for (const expected of ["@react-native-firebase/app", "@react-native-firebase/crashlytics", "./plugins/with-call-screen"]) {
    assert.equal(config.plugins.some((plugin: unknown) => pluginName(plugin) === expected), true);
  }
});
