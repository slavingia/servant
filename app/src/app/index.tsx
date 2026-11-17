import { Redirect } from "expo-router";
import { useSession } from "../lib/session";
import { landingHref, useFeatures } from "../lib/features";
import { LaunchScreen } from "../components/LaunchScreen";
import { validServerKey } from "../lib/tunnel-crypto";

export default function Index() {
  const { ready, account } = useSession();
  // Home when the server has channels; otherwise the agent (features.ts).
  const landing = landingHref(useFeatures());
  if (!ready) {
    return <LaunchScreen />;
  }
  // The redirect takes a frame or more, and by itself draws nothing: the launch screen stays for it, so the
  // page is not empty between the app's shape and the screen it lands on.
  return <><LaunchScreen /><Redirect href={account && validServerKey(account.serverKey) ? landing : "/welcome"} /></>;
}
