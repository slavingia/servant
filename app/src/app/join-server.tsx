import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { Button } from "../components/Button";
import { INVITE_EXAMPLE, parseInvite } from "../lib/invite";
import { accountId } from "../lib/accounts-store";
import { useSession } from "../lib/session";
import { space, typography, createThemedStyles, useTheme } from "../lib/theme";

export default function JoinServer() {
  const { accounts, switchAccount, supportsMultipleServers } = useSession();
  const { colors } = useTheme();
  const styles = useStyles();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const join = async () => {
    const invite = parseInvite(text);
    if (!invite) { setError("That isn't an invite link. Ask your teammate to send the whole link."); return; }
    const existing = accounts.find(account => invite.serverKey && account.serverKey === invite.serverKey);
    setError(null);
    if (existing) {
      setBusy(true);
      try { await switchAccount(accountId(existing)); }
      catch (e) { setError(e instanceof Error ? e.message : "Couldn't open this server. Try again."); }
      finally { setBusy(false); }
      return;
    }
    router.push({ pathname: "/pair", params: { code: invite.code, key: invite.serverKey ?? "", d: invite.discovery ?? "", server: invite.server ?? "" } });
  };
  return <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === "ios" ? "padding" : undefined}>
    <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
      <Text accessibilityRole="header" style={styles.title}>Join another server</Text>
      <Text style={styles.description}>{supportsMultipleServers ? "Paste an invite from the team you want to join. Your other servers stay signed in." : "Update the Servant Mac app to join more than one server. Your current server stays signed in."}</Text>
      {supportsMultipleServers ? <>
        <Text style={styles.label}>Invite link</Text>
        <Text nativeID="joinInviteExample" style={styles.hint}>Example: {INVITE_EXAMPLE}</Text>
        <TextInput accessibilityLabel="Invite link" aria-describedby="joinInviteExample" accessibilityHint={`Example: ${INVITE_EXAMPLE}`} value={text} onChangeText={value => { setText(value); setError(null); }} placeholder="Paste your invite link" placeholderTextColor={colors.muted} autoCapitalize="none" autoCorrect={false} multiline style={styles.input} />
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        <Button label="Continue" onPress={() => void join()} busy={busy} disabled={!text.trim()} style={styles.action} />
        {Platform.OS !== "web" ? <Button label="Scan an invite code" kind="secondary" onPress={() => router.push("/scan")} style={styles.action} /> : null}
        <Button label="I already have an account there" kind="link" onPress={() => router.push("/sign-in")} style={styles.action} />
      </> : null}
      <View style={styles.action}><Button label="Cancel" kind="link" onPress={() => router.back()} /></View>
    </ScrollView>
  </KeyboardAvoidingView>;
}
const useStyles = createThemedStyles(({ colors, controls }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  body: { width: "100%", maxWidth: 520, alignSelf: "center", padding: space.side },
  title: { ...typography.heading, color: colors.ink },
  description: { ...typography.body, color: colors.muted, marginTop: space.sm },
  label: { ...typography.label, color: colors.ink, marginTop: space.lg },
  hint: { ...typography.caption, color: colors.muted, marginTop: space.xxs },
  input: { ...controls.input, ...controls.inputMultiline, minHeight: 88, marginTop: space.xs },
  error: { ...typography.caption, color: colors.red, marginTop: space.sm },
  action: { marginTop: space.md },
}));
