import { Redirect } from "expo-router";
import { View } from "react-native";
import { useSession } from "../lib/session";
import { useTheme } from "../lib/theme";
import { validServerKey } from "../lib/tunnel-crypto";
import { onboardingRequired } from "../lib/onboarding";

export default function Index() {
  const { colors } = useTheme();
  const { ready, account } = useSession();
  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.navy }} />
    );
  }
  if (!account || !validServerKey(account.serverKey)) return <Redirect href="/welcome" />;
  return <Redirect href={onboardingRequired(account.uxOnboarding) ? "/onboarding" : "/channels"} />;
}
