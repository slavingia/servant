import { codeLinkPath } from "../lib/code-fill-link";
import { isShareLaunch } from "../lib/share-payload";

// Every address the app is opened with passes through here before the router sees it. The share
// extension (iOS) and the share intent (Android) open `servant://expo-sharing`, which is not a
// screen: send it to the Send to agent screen. A code link (`servant://code?text=…`) goes on as the
// code alone (lib/code-fill-link.ts). Everything else is left alone. Must never throw.
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try { return isShareLaunch(path) ? "/share" : codeLinkPath(path) ?? path; } catch { return path; }
}
