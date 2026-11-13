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
  return <Redirect href={account && validServerKey(account.serverKey) ? landing : "/welcome"} />;
}
