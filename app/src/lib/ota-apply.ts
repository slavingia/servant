// When a downloaded over-the-air update may restart the app (see useApplyUpdates in ota.ts).

export const APPLY_WINDOW_MS = 8000;

/** Whether a downloaded update may restart the app now. Pure, so it can be tested. */
export function shouldApplyNow(o: { msSinceLaunch: number; onCall: boolean; returningToApp: boolean }): boolean {
  if (o.onCall) return false;
  // Right after launch the person has barely started, so switching to the new version is
  // nearly invisible. Later, wait until they leave and come back.
  return o.msSinceLaunch < APPLY_WINDOW_MS || o.returningToApp;
}
