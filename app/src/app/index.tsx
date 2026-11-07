import { Redirect } from "expo-router";
import { View } from "react-native";
import { useSession } from "../lib/session";
import { useTheme } from "../lib/theme";
import { validServerKey } from "../lib/tunnel-crypto";
import { onboardingRequired, roleIntroRequired } from "../lib/onboarding";

export default function Index() {
  const { colors } = useTheme();
  const { ready, account } = useSession();
  if (!ready) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.navy }} />
    );
  }
  if (!account || !validServerKey(account.serverKey)) return <Redirect href="/welcome" />;
  if (onboardingRequired(account.uxOnboarding)) return <Redirect href="/onboarding" />;
  return <Redirect href={roleIntroRequired(account.uxOnboarding) ? "/start" : "/channels"} />;
}
