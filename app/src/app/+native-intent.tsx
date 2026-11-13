import { isShareLaunch } from "../lib/share-payload";

// Every address the app is opened with passes through here before the router sees it. The share
// extension (iOS) and the share intent (Android) open `servant://expo-sharing`, which is not a
// screen: send it to the Send to agent screen. Everything else is left alone. Must never throw.
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try { return isShareLaunch(path) ? "/share" : path; } catch { return path; }
}
