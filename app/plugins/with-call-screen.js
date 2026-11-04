// Lets an incoming call light up a locked screen on Android, and declares the VoIP push background mode on iPhone.
const { withAndroidManifest, withInfoPlist, withEntitlementsPlist } = require("expo/config-plugins");

const withCallScreen = config => {
  config = withAndroidManifest(config, cfg => {
    const app = cfg.modResults.manifest.application?.[0];
    const main = app?.activity?.find(a => a.$["android:name"] === ".MainActivity");
    if (!main) throw new Error("with-call-screen: MainActivity not found");
    main.$["android:showWhenLocked"] = "true";
    main.$["android:turnScreenOn"] = "true";
    return cfg;
  });
  config = withInfoPlist(config, cfg => {
    const modes = new Set(cfg.modResults.UIBackgroundModes || []);
    modes.add("voip");
    modes.add("remote-notification");
    cfg.modResults.UIBackgroundModes = [...modes];
    return cfg;
  });
  return config;
};
module.exports = withCallScreen;
