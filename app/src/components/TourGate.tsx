import { useEffect } from "react";
import { router, usePathname } from "expo-router";
import { useSession } from "../lib/session";
import { validServerKey } from "../lib/tunnel-crypto";
import { tourOpens } from "../lib/tour";
import { retryTourSeen, tourDismissed } from "../lib/tour-seen";

// Opens the onboarding tour once for someone who has just joined (lib/tour.ts). Joining goes straight to it;
// this covers every other way in: a linked computer, the Mac app's sign-in, and coming back to an app that was
// closed before the tour was finished or skipped.
export function TourGate() {
  const { account } = useSession();
  const pathname = usePathname();
  const open = !!account && tourOpens({ paired: validServerKey(account.serverKey), due: account.tourDue, dismissed: tourDismissed(account), pathname });
  useEffect(() => { if (open) router.push("/tour"); }, [open]);
  // Closed here while the server could not be told: tell it now.
  useEffect(() => { if (account?.tourClosed) retryTourSeen(account); }, [account]);
  return null;
}
