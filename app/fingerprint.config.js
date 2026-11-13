// The runtime version is a fingerprint of the app's native code (docs/ota.md). The version,
// build number, app name and bundle id are left out, so every build with the same native
// code shares one runtime and takes the same over-the-air updates, whatever its number.
/** @type {import('expo/fingerprint').Config} */
module.exports = {
  sourceSkips: [
    "ExpoConfigVersions",
    "ExpoConfigRuntimeVersionIfString",
    "ExpoConfigNames",
    "ExpoConfigIosBundleIdentifier",
    "ExpoConfigAndroidPackage",
  ],
};
