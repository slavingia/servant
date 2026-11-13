// Guards the iOS Simulator call crash (Crashlytics 9a68c7c9): WebRTC's
// voice-processing audio unit aborts the app in the Simulator when a call
// connects. The config plugin turns call audio off in Simulator builds only.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const plugin = require("../../plugins/with-simulator-call-audio.js");

const appDelegate = `internal import Expo
import FirebaseCore
import React
import ReactAppDependencyProvider

@main
class AppDelegate: ExpoAppDelegate, ExpoReactNativeFactoryProvider {
  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    FirebaseApp.configure()
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}
`;

test("app.json applies the Simulator call-audio plugin after react-native-webrtc", () => {
  const plugins = JSON.parse(fs.readFileSync(new URL("../../app.json", import.meta.url), "utf8")).expo.plugins
    .map((p: string | [string, unknown]) => (Array.isArray(p) ? p[0] : p));
  const webrtc = plugins.indexOf("@config-plugins/react-native-webrtc");
  const guard = plugins.indexOf("./plugins/with-simulator-call-audio");
  assert.ok(webrtc >= 0, "react-native-webrtc plugin present");
  assert.ok(guard > webrtc, "Simulator call-audio plugin runs after the WebRTC plugin");
});

test("the guard turns call audio off only in Simulator builds, before launch finishes", () => {
  const out: string = plugin.addSimulatorAudioGuard(appDelegate);
  const guard = out.indexOf("useManualAudio = true");
  assert.ok(guard > 0);
  assert.ok(out.indexOf("isAudioEnabled = false") > guard);
  assert.ok(guard < out.indexOf("return super.application("), "runs before the app finishes launching");
  const before = out.slice(0, guard);
  assert.ok(before.lastIndexOf("#if targetEnvironment(simulator)") > before.lastIndexOf("#endif"), "inside a Simulator-only block");
  assert.match(out, /#if targetEnvironment\(simulator\)\nimport WebRTC\n#endif/);
});

test("the guard is added once, even when prebuild runs again", () => {
  const once: string = plugin.addSimulatorAudioGuard(appDelegate);
  assert.equal(plugin.addSimulatorAudioGuard(once), once);
});

test("an unexpected AppDelegate fails the build instead of silently skipping the guard", () => {
  assert.throws(() => plugin.addSimulatorAudioGuard("// not an app delegate"));
});
