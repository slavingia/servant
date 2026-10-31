import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { Band, PageTitle } from "../components/Band";
import { Button } from "../components/Button";
import { parseInvite } from "../lib/invite";
import { colors, controls, space, typography } from "../lib/theme";
import { useSession } from "../lib/session";

export default function Welcome() {
  const { account } = useSession();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  const join = () => {
    const invite = parseInvite(text);
    if (!invite) {
      setError("That isn't an invite link. Ask the person who invited you to send it again");
      return;
    }
    router.push({ pathname: "/pair", params: { code: invite.code, key: invite.serverKey ?? "", d: invite.discovery ?? "", server: invite.server ?? "" } });
  };

  return (
    <View style={styles.root}>
      <Band />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <PageTitle description={account ? "Open a new invite from your admin to enable encrypted connections. Ask for an invite for your existing account to keep your conversations." : "A place for your team's conversations and agent. Join with an invite from someone at your agency."}>{account ? "Reconnect securely" : "Welcome to Servant"}</PageTitle>

          <Text style={styles.label} nativeID="inviteLabel">
            Invite link
          </Text>
          <TextInput
            accessibilityLabelledBy="inviteLabel"
            accessibilityLabel="Invite link"
            value={text}
            onChangeText={(t) => {
              setText(t);
              setError(null);
            }}
            placeholder="Paste your invite link"
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            style={[styles.input, error && styles.inputError]}
          />
          {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}

          <Button label="Continue" onPress={join} disabled={!text.trim()} style={styles.action} />
          {Platform.OS !== "web" ? <Button label="Scan an invite code" kind="secondary" onPress={() => router.push("/scan")} style={[styles.action, { marginTop: space.sm }]} /> : null}

          <Text style={styles.note}>For non-sensitive work only. Don't share taxpayer information here until your agency approves Servant for it</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.white },
  body: { paddingBottom: space.xxl },
  label: { ...typography.label, marginTop: space.sm, marginHorizontal: space.side, color: colors.ink },
  input: { ...controls.input, ...controls.inputMultiline, marginTop: space.xs, marginHorizontal: space.side },
  inputError: { borderColor: colors.red },
  action: { marginTop: space.md, marginHorizontal: space.side },
  error: { ...typography.caption, marginTop: space.xs, marginHorizontal: space.side, color: colors.red },
  note: { ...typography.caption, marginTop: space.xl, marginHorizontal: space.side, paddingTop: space.lg, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, color: colors.muted },
});
