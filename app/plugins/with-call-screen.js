// Declares the VoIP push background mode on iPhone.
//
// Android used to set showWhenLocked and turnScreenOn on MainActivity here, so an incoming call
// could light up a locked screen. Those flags apply to the whole app, all the time: with Servant
// open, pressing the lock button and then again opened Servant without asking for the PIN
// (reported on a Pixel 6a). The native code that rings with a full-screen call is not in this
// repository, so nothing needed them. If a full-screen ring comes back, set the flags from code on
// the one activity launch that a call started, never in the manifest.
const { withInfoPlist, withEntitlementsPlist } = require("expo/config-plugins");

const withCallScreen = config => {
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
