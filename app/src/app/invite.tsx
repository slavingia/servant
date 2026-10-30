import { useState } from "react";
import { ScrollView, StyleSheet, Text, TextInput, View, Share, Platform } from "react-native";
import * as Clipboard from "expo-clipboard";
import QRCode from "react-native-qrcode-svg";
import { Button } from "../components/Button";
import { api, HubError } from "../lib/hub";
import { useSession } from "../lib/session";
import { colors } from "../lib/theme";

export default function Invite() {
  const { account } = useSession();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState<{ code: string; link: string } | null>(null);
  const [copied, setCopied] = useState(false);
  if (!account) return null;

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      setInvite(await api.invite(account, name.trim() || "Guest"));
    } catch (e) {
      setError(e instanceof HubError ? e.message : "Couldn't make an invite");
    } finally {
      setBusy(false);
    }
  };

  if (invite) {
    const message = `You're invited to message ${account.hubName} on Servant. Open this on your phone: ${invite.link}`;
    return (
      <ScrollView contentContainerStyle={styles.body}>
        <Text style={styles.lead}>Have {name.trim() || "them"} scan this in Servant, or send the link</Text>
        <View style={styles.qr}>
          <QRCode value={invite.link} size={220} />
        </View>
        <Text style={styles.code} selectable>
          {invite.code}
        </Text>
        <Text style={styles.note}>Works once. Expires in seven days</Text>
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
        <Button
          label="Invite someone else"
          kind="link"
          onPress={() => {
            setInvite(null);
            setName("");
            setCopied(false);
          }}
          style={{ marginTop: 8 }}
        />
      </ScrollView>
    );
  }

  return (
    <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
      <Text style={styles.label} nativeID="nameLabel">
        Their name
      </Text>
      <TextInput accessibilityLabelledBy="nameLabel" value={name} onChangeText={setName} placeholder="Jordan Lee" placeholderTextColor="#8A8F96" style={styles.input} autoFocus />
      <Text style={styles.note}>They'll talk to a limited agent with no access to your files, accounts or shell</Text>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <Button label="Make invite" onPress={create} busy={busy} style={{ marginTop: 24 }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  body: { padding: 20 },
  lead: { fontSize: 17, lineHeight: 24, color: colors.ink, textAlign: "center" },
  qr: { marginTop: 24, alignSelf: "center", padding: 16, backgroundColor: colors.white, borderRadius: 16, borderWidth: 1, borderColor: colors.line },
  code: { marginTop: 20, textAlign: "center", fontSize: 26, fontWeight: "700", letterSpacing: 2, color: colors.ink, fontVariant: ["tabular-nums"] },
  note: { marginTop: 8, fontSize: 15, lineHeight: 21, color: colors.muted, textAlign: "center" },
  label: { fontSize: 15, fontWeight: "600", color: colors.ink },
  input: { marginTop: 8, height: 50, borderWidth: 1.5, borderColor: colors.line, borderRadius: 12, paddingHorizontal: 14, fontSize: 17, color: colors.ink },
  error: { marginTop: 12, color: colors.red, fontSize: 15 },
});
