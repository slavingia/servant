import { Redirect } from "expo-router";
import { ActivityIndicator, View } from "react-native";
import { useSession } from "../lib/session";
import { colors } from "../lib/theme";
import { validServerKey } from "../lib/tunnel-crypto";

export default function Index() {
  const { ready, account } = useSession();
  if (!ready) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: colors.navy }}>
        <ActivityIndicator color={colors.white} />
      </View>
    );
  }
  return <Redirect href={account && validServerKey(account.serverKey) ? "/channels" : "/welcome"} />;
}
