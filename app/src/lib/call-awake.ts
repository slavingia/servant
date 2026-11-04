import { useEffect } from "react";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";

// Keep the screen on during a call. One tag for the whole app (call screen and the call bar), and
// failures are ignored: a browser may refuse or not have released the lock yet, which is harmless.
const TAG = "servant-call";
let holders = 0;
export function useCallAwake(on = true) {
  useEffect(() => {
    if (!on) return;
    if (holders++ === 0) activateKeepAwakeAsync(TAG).catch(() => {});
    return () => { if (--holders === 0) Promise.resolve().then(() => deactivateKeepAwake(TAG)).catch(() => {}); };
  }, [on]);
}
