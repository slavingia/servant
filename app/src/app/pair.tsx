import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, StyleSheet, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Button } from "../components/Button";
import { pair, HubError } from "../lib/hub";
import { useSession } from "../lib/session";
import { colors } from "../lib/theme";

// Opened by servant://pair?code=…&d=… links, the QR scanner, or Welcome.
export default function Pair() {
  const params = useLocalSearchParams<{ code?: string; d?: string; hub?: string }>();
  const { account, setAccount } = useSession();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  const run = async () => {
    setError(null);
    try {
      const a = await pair({ code: String(params.code || ""), discovery: params.d || undefined, hub: params.hub || undefined });
      setAccount(a);
      router.replace("/channels");
    } catch (e) {
      setError(e instanceof HubError ? e.message : "Couldn't join. Try again");
    }
  };

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (!params.code || (!params.d && !params.hub)) {
      setError("That invite link is incomplete. Ask for a new one");
      return;
    }
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) {
    return (
      <View style={styles.root}>
        <Text style={styles.title}>Couldn't join</Text>
        <Text style={styles.body}>{error}</Text>
        <Button label="Try again" onPress={run} style={{ marginTop: 24, alignSelf: "stretch" }} />
        <Button label={account ? "Back to Servant" : "Back"} kind="link" onPress={() => router.replace(account ? "/channels" : "/welcome")} style={{ marginTop: 8 }} />
      </View>
    );
  }
  return (
    <View style={styles.root}>
      <ActivityIndicator color={colors.blue} size="large" />
      <Text style={[styles.body, { marginTop: 16 }]}>Joining…</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: "center", justifyContent: "center", padding: 20, backgroundColor: colors.white },
  title: { fontSize: 22, fontWeight: "700", color: colors.ink },
  body: { marginTop: 8, fontSize: 17, lineHeight: 24, color: colors.ink, textAlign: "center" },
});
