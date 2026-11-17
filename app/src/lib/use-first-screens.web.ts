import { useEffect, useState } from "react";
import { ctx } from "expo-router/_ctx";
import { FIRST_SCREENS_WAIT_MS, firstScreens } from "./first-screens";

// Asking the router's own list for a screen loads its code (as preload-screens.web.ts does). A failure is left
// alone: the screen then loads the usual way when the navigator asks for it.
const load = (key: string) => { try { return Promise.resolve(ctx(key)).then(() => undefined, () => undefined); } catch { return Promise.resolve(); } };

/**
 * Has the code for the first screen arrived? False only while a signed-in app is opening: the launch screen
 * stays up for that long instead of an empty page (first-screens.ts). Decided once, when the saved account has
 * been read; signing in later never brings the launch screen back over the screens already open.
 */
export function useFirstScreens(ready: boolean, signedIn: boolean, pathname: string, landing: string): boolean {
  const [state, setState] = useState<"reading" | "loading" | "in">("reading");
  if (state === "reading" && ready) setState(signedIn ? "loading" : "in");
  useEffect(() => {
    if (state !== "loading") return;
    let live = true;
    const done = () => { if (live) setState("in"); };
    const timer = setTimeout(done, FIRST_SCREENS_WAIT_MS);
    void Promise.all(firstScreens(pathname, landing, ctx.keys()).map(load)).then(done);
    return () => { live = false; clearTimeout(timer); };
    // The address and the landing place as they were when the app opened: this runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);
  return state !== "loading";
}
