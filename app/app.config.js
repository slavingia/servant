// The app's identity comes from one setting. Set SERVANT_BUNDLE_ID (a reverse-DNS id such as
// org.example.servant) when building; it defaults to com.example.servant. The iOS bundle id and
// the Android package use it as is, the iOS share extension is <id>.share and the app group
// shared with it is group.<id>. The server's VoIP push topic (<id>.voip) must use the same id.
// See "App identity" in app/AGENTS.md.
const DEFAULT_BUNDLE_ID = "com.example.servant";
const fs = require("fs");
const path = require("path");

function bundleId() {
  const id = (process.env.SERVANT_BUNDLE_ID || "").trim() || DEFAULT_BUNDLE_ID;
  // Two or more dot-separated parts, each starting with a letter: valid for both an iOS bundle
  // identifier and an Android package name.
  if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(id)) {
    throw new Error(`SERVANT_BUNDLE_ID must be a reverse-DNS id like com.example.servant (letters, digits and underscores, at least two dot-separated parts, each starting with a letter); got "${id}"`);
  }
  return id;
}

function withBundleId(config, id) {
  return {
    ...config,
    ios: { ...config.ios, bundleIdentifier: id },
    android: { ...config.android, package: id },
    plugins: (config.plugins || []).map(plugin => Array.isArray(plugin) && plugin[0] === "expo-sharing"
      ? [plugin[0], { ...plugin[1], ios: { ...plugin[1]?.ios, extensionBundleIdentifier: `${id}.share`, appGroupId: `group.${id}` } }]
      : plugin),
  };
}

// Crashlytics is optional. It is built in only when the Firebase config file for the platform is
// present (GoogleService-Info.plist for iOS, google-services.json for Android; both are git-ignored
// and must be registered for the same bundle id). Without a file, that platform builds without
// Firebase and the app sends no crash reports. The app code never imports Firebase directly.
function withOptionalFirebase(config) {
  const has = file => fs.existsSync(path.join(__dirname, file));
  const ios = has("GoogleService-Info.plist");
  const android = has("google-services.json");
  const plugins = (config.plugins || []).filter(plugin => {
    const name = Array.isArray(plugin) ? plugin[0] : plugin;
    return !(typeof name === "string" && name.startsWith("@react-native-firebase/")) || ios || android;
  });
  const next = { ...config, plugins, ios: { ...config.ios }, android: { ...config.android } };
  if (!ios) delete next.ios.googleServicesFile;
  if (!android) delete next.android.googleServicesFile;
  return next;
}

// Over-the-air updates are off unless the build is told where the server's
// update address is. Set SERVANT_OTA_URL (for example https://servant.example/ota/manifest)
// when building. The address is fixed in the build; the app never changes it
// at runtime, so the version built into the app always remains as the fallback
// if the server is unreachable or has nothing for this build. See docs/ota.md.
module.exports = ({ config: base }) => {
  const config = withOptionalFirebase(withBundleId(base, bundleId()));
  const url = (process.env.SERVANT_OTA_URL || "").trim();
  if (!url) return config;
  if (!/^https:\/\/[^\s/]+\/ota\/manifest$/.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost|10\.0\.2\.2)(:\d+)?\/ota\/manifest$/.test(url)) {
    throw new Error("SERVANT_OTA_URL must be https://<host>/ota/manifest (http only for localhost or the Android emulator's 10.0.2.2)");
  }
  const next = { ...config, updates: { ...config.updates, enabled: true, url } };
  // Android blocks plain http. Allow it only for a build pointed at a local test server.
  if (url.startsWith("http://")) {
    next.plugins = (config.plugins || []).map(plugin => Array.isArray(plugin) && plugin[0] === "expo-build-properties"
      ? [plugin[0], { ...plugin[1], android: { ...plugin[1]?.android, usesCleartextTraffic: true } }]
      : plugin);
  }
  return next;
};
