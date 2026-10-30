import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Platform, ScrollView, Share, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import QRCode from "react-native-qrcode-svg";
import { Button } from "../components/Button";
import { api, HubError } from "../lib/hub";
import { useSession } from "../lib/session";
import { colors } from "../lib/theme";

type Link = { code: string; link: string; expiresAt: number };

// One join link for the whole team. Anyone with it can join until it expires.
export default function Invite() {
  const { account } = useSession();
  const [invite, setInvite] = useState<Link | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const fetchLink = (fresh = false) =>
    api.joinLink(account!, fresh).then(
      (l) => {
        setInvite(l);
        setCopied(false);
      },
      (e) => setError(e instanceof HubError ? e.message : "Couldn't get the invite link"),
    );
  const load = (fresh = false) => {
    setError(null);
    fetchLink(fresh);
  };

  useEffect(() => {
    if (account) fetchLink();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!account) return null;
  if (error) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>{error}</Text>
        <Button label="Try again" onPress={() => load()} style={{ marginTop: 24, alignSelf: "stretch" }} />
      </View>
    );
  }
  if (!invite) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.blue} size="large" />
      </View>
    );
  }

  const until = new Date(invite.expiresAt).toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  const message = `Join ${account.hubName} on Servant. Open this on your phone: ${invite.link}`;
  const replace = () => {
    const go = () => load(true);
    if (Platform.OS === "web") return go();
    Alert.alert("Make a new link?", "The current link will stop working. People who already joined stay in", [
      { text: "Cancel", style: "cancel" },
      { text: "Make new link", style: "destructive", onPress: go },
    ]);
  };

  return (
    <ScrollView contentContainerStyle={styles.body}>
      <Text style={styles.lead}>Anyone with this link can join {account.hubName}</Text>
      <View style={styles.qr}>
        <QRCode value={invite.link} size={220} />
      </View>
      <Text style={styles.code} selectable>
        {invite.code}
      </Text>
      <Text style={styles.note}>Works until {until}</Text>
      <Text style={styles.note}>They'll talk to a limited agent with no access to your files, accounts or shell</Text>
      {Platform.OS !== "web" ? <Button label="Share link" onPress={() => Share.share({ message })} style={{ marginTop: 24 }} /> : null}
      <Button
        label={copied ? "Copied" : "Copy link"}
        kind={Platform.OS === "web" ? "primary" : "secondary"}
        onPress={async () => {
          await Clipboard.setStringAsync(invite.link);
          setCopied(true);
        }}
        style={{ marginTop: 12 }}
      />
      <Button label="Make a new link" kind="link" onPress={replace} style={{ marginTop: 8 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  body: { padding: 20 },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 20 },
  lead: { fontSize: 17, lineHeight: 24, color: colors.ink, textAlign: "center" },
  qr: { marginTop: 24, alignSelf: "center", padding: 16, backgroundColor: colors.white, borderRadius: 16, borderWidth: 1, borderColor: colors.line },
  code: { marginTop: 20, textAlign: "center", fontSize: 26, fontWeight: "700", letterSpacing: 2, color: colors.ink, fontVariant: ["tabular-nums"] },
  note: { marginTop: 8, fontSize: 15, lineHeight: 21, color: colors.muted, textAlign: "center" },
  error: { color: colors.red, fontSize: 17, textAlign: "center" },
});
