// This checkout defaults to the separately installable UX client. Set
// SERVANT_APP_FLAVOR=core only when reproducing an upstream Servant build.
// Both flavors use the same encrypted server protocol, but never share native
// identifiers, URL handlers or OTA runtime versions.
const FLAVORS = {
  core: {
    name: "Servant",
    slug: "servant",
    scheme: "servant",
    iosBundleIdentifier: "gov.irs.servant",
    androidPackage: "gov.irs.servant",
    nativePushConfigured: true,
  },
  ux: {
    // People see the app as Servant. The slug, scheme and bundle IDs stay
    // servant-ux so this client installs beside upstream Servant, and installed
    // copies update in place and keep their sign-ins.
    name: "Servant",
    slug: "servant-ux",
    scheme: "servant-ux",
    iosBundleIdentifier: "gov.irs.servant.ux",
    androidPackage: "gov.irs.servant.ux",
    nativePushConfigured: false,
  },
};

const pluginName = plugin => Array.isArray(plugin) ? plugin[0] : plugin;
const UX_DISABLED_PLUGINS = new Set([
  "@react-native-firebase/app",
  "@react-native-firebase/crashlytics",
  // This declares VoIP and remote-notification background modes. The UX
  // bundle has no PushKit/APNs provisioning yet; foreground calls still work.
  "./plugins/with-call-screen",
]);
const rebrand = (value, name) => {
  if (typeof value === "string") return value.replace(/\bServant\b/g, name);
  if (Array.isArray(value)) return value.map(item => rebrand(item, name));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rebrand(item, name)]));
  return value;
};

// Over-the-air updates are off unless the build is told where the server's
// update address is. Set SERVANT_OTA_URL (for example https://servant.example/ota/manifest)
// when building. The address is fixed in the build; the app never changes it
// at runtime, so the version built into the app always remains as the fallback
// if the server is unreachable or has nothing for this build. See docs/ota.md.
module.exports = ({ config }) => {
  const flavorName = (process.env.SERVANT_APP_FLAVOR || "ux").trim();
  const flavor = FLAVORS[flavorName];
  if (!flavor) throw new Error(`SERVANT_APP_FLAVOR must be one of: ${Object.keys(FLAVORS).join(", ")}`);

  const { googleServicesFile: _iosFirebase, ...baseIos } = config.ios || {};
  const { googleServicesFile: _androidFirebase, ...baseAndroid } = config.android || {};
  const ux = flavorName === "ux";
  const plugins = (config.plugins || [])
    .filter(plugin => !ux || !UX_DISABLED_PLUGINS.has(pluginName(plugin)))
    .map(plugin => {
      if (!ux || !Array.isArray(plugin)) return plugin;
      const options = rebrand(plugin[1], flavor.name);
      // Keep the module available to the shared code, but do not add an APNs
      // entitlement to a build that has no UX-team push credentials.
      if (plugin[0] === "expo-notifications") return [plugin[0], { ...options, enableRemoteNotifications: false }];
      return [plugin[0], options];
    });

  let next = {
    ...config,
    name: flavor.name,
    slug: flavor.slug,
    scheme: flavor.scheme,
    extra: {
      ...config.extra,
      servantFlavor: flavorName,
      nativePushConfigured: flavor.nativePushConfigured,
    },
    ios: {
      ...(ux ? rebrand(baseIos, flavor.name) : config.ios),
      bundleIdentifier: flavor.iosBundleIdentifier,
      // Keep signed updates for the UX binary out of the core binary's runtime.
      ...(ux ? { runtimeVersion: `${flavor.slug}-${config.version}(${config.ios?.buildNumber})` } : {}),
    },
    android: {
      ...(ux ? rebrand(baseAndroid, flavor.name) : config.android),
      package: flavor.androidPackage,
      ...(ux ? { runtimeVersion: `${flavor.slug}-${config.version}(${config.android?.versionCode})` } : {}),
    },
    web: { ...config.web, name: flavor.name, shortName: flavor.name },
    plugins,
  };

  const url = (process.env.SERVANT_OTA_URL || "").trim();
  if (url) {
    if (!/^https:\/\/[^\s/]+\/ota\/manifest$/.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost|10\.0\.2\.2)(:\d+)?\/ota\/manifest$/.test(url)) {
      throw new Error("SERVANT_OTA_URL must be https://<host>/ota/manifest (http only for localhost or the Android emulator's 10.0.2.2)");
    }
    next = { ...next, updates: { ...next.updates, enabled: true, url } };
    // Android blocks plain http. Allow it only for a build pointed at a local test server.
    if (url.startsWith("http://")) {
      next.plugins = next.plugins.map(plugin => Array.isArray(plugin) && plugin[0] === "expo-build-properties"
        ? [plugin[0], { ...plugin[1], android: { ...plugin[1]?.android, usesCleartextTraffic: true } }]
        : plugin);
    }
  }
  return next;
};
