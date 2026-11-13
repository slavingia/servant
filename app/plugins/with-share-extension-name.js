// The iOS share sheet labels a share extension with the extension's own display name, not the
// app's. expo-sharing names its target "expo-sharing-extension" (fixed, see its config plugin), so
// that is what people would read under Servant's icon. This writes the app's name into the
// extension's Info.plist instead. expo-sharing writes that file in the dangerous phase, which runs
// before every Xcode-project mod. Mods of one kind run newest-first, so this plugin sits just
// BEFORE "expo-sharing" in app.json: then it also sees the extension's build settings.
const fs = require("node:fs");
const path = require("node:path");
const plistModule = require("@expo/plist");
const { withXcodeProject } = require("expo/config-plugins");

const plist = plistModule.default ?? plistModule;
const TARGET = "expo-sharing-extension";

const withShareExtensionName = config => withXcodeProject(config, cfg => {
  const name = cfg.name || "Servant";
  const file = path.join(cfg.modRequest.platformProjectRoot, TARGET, "Info.plist");
  if (fs.existsSync(file)) {
    const info = plist.parse(fs.readFileSync(file, "utf8"));
    info.CFBundleDisplayName = name;
    fs.writeFileSync(file, plist.build(info));
  }
  // The build setting Xcode would use if it ever generated the Info.plist itself.
  const configurations = cfg.modResults.pbxXCBuildConfigurationSection();
  for (const key of Object.keys(configurations)) {
    const settings = configurations[key]?.buildSettings;
    if (settings && String(settings.INFOPLIST_FILE ?? "").includes(`${TARGET}/Info.plist`)) settings.INFOPLIST_KEY_CFBundleDisplayName = `"${name}"`;
  }
  return cfg;
});
module.exports = withShareExtensionName;
