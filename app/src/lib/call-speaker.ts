import { NativeModules, Platform } from "react-native";

// Phone calls play through the earpiece by default. This switches to the loudspeaker and back.
// Uses react-native-incall-manager; builds made before it was added don't have the native module,
// so speakerSupported() is false there and the call screen hides the button.
type Manager = { setForceSpeakerphoneOn(on: boolean): void };
let manager: Manager | null | undefined;

function load(): Manager | null {
  if (manager !== undefined) return manager;
  manager = null;
  if (Platform.OS === "web" || !NativeModules.InCallManager) return manager;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  try { manager = (require("react-native-incall-manager") as { default: Manager }).default; } catch { /* no native module */ }
  return manager;
}

export const speakerSupported = () => load() !== null;

export function setSpeaker(on: boolean) {
  try { load()?.setForceSpeakerphoneOn(on); } catch { /* keep the call going */ }
}
