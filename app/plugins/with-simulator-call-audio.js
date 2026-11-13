// Keeps calls from crashing the app in the iOS Simulator.
//
// When a call connects, WebRTC starts Apple's voice-processing audio unit. In
// the Simulator that unit asks the Mac's audio system for the microphone. If the
// Mac hasn't granted Simulator microphone access (an unattended or headless Mac,
// for example), the request times out and AudioToolbox aborts the whole app
// (SIGABRT in _ReportRPCTimeout under AURemoteIO::Initialize).
//
// In Simulator builds only, this switches WebRTC to manual audio with audio
// off, so the audio unit is never started. The call screen, signaling and
// video still work; there's just no sound. Device builds are unchanged: the
// code is compiled out by `#if targetEnvironment(simulator)`.
const { withAppDelegate } = require("expo/config-plugins");
const { mergeContents } = require("@expo/config-plugins/build/utils/generateCode");

const TAG = "servant-simulator-call-audio";

function addSimulatorAudioGuard(src) {
  if (!src.includes("class AppDelegate")) throw new Error(`${TAG}: expected a Swift AppDelegate`);
  let out = mergeContents({
    tag: `${TAG}-import`,
    src,
    newSrc: "#if targetEnvironment(simulator)\nimport WebRTC\n#endif",
    anchor: /^import React$/m,
    offset: 1,
    comment: "//",
  }).contents;
  out = mergeContents({
    tag: TAG,
    src: out,
    newSrc: [
      "#if targetEnvironment(simulator)",
      "    // The Simulator can't always start WebRTC's voice-processing audio unit and aborts the app.",
      "    RTCAudioSession.sharedInstance().useManualAudio = true",
      "    RTCAudioSession.sharedInstance().isAudioEnabled = false",
      "#endif",
    ].join("\n"),
    anchor: /return super\.application\(application, didFinishLaunchingWithOptions: launchOptions\)/,
    offset: 0,
    comment: "//",
  }).contents;
  if (!out.includes("useManualAudio = true")) throw new Error(`${TAG}: could not add the Simulator audio guard`);
  return out;
}

const withSimulatorCallAudio = config => withAppDelegate(config, cfg => {
  if (cfg.modResults.language !== "swift") throw new Error(`${TAG}: expected a Swift AppDelegate`);
  cfg.modResults.contents = addSimulatorAudioGuard(cfg.modResults.contents);
  return cfg;
});

module.exports = withSimulatorCallAudio;
module.exports.addSimulatorAudioGuard = addSimulatorAudioGuard;
