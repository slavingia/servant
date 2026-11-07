import { useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router } from "expo-router";
import { Band, PageTitle } from "../components/Band";
import { Button } from "../components/Button";
import { parseInvite } from "../lib/invite";
import { space, typography, useTheme, createThemedStyles } from "../lib/theme";
import { useSession } from "../lib/session";
import { getDesktopWorkspace, watchDesktopInvites } from "../lib/desktop";
import { DesktopSignIn } from "../components/DesktopSignIn";

export default function Welcome() {
  const styles = useStyles();
  const { colors } = useTheme();
  const { account } = useSession();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [useInvite, setUseInvite] = useState(false);
  const desktopWorkspace = getDesktopWorkspace();

  const join = () => {
    const invite = parseInvite(text);
    if (!invite) {
      setError("That isn't an invite link. Ask the person who invited you to send it again");
      return;
    }
    router.push({ pathname: "/pair", params: { code: invite.code, key: invite.serverKey ?? "", d: invite.discovery ?? "", server: invite.server ?? "" } });
  };

  // On the Mac, an invite link opened from Terminal, Mail or a browser (such as
  // the one `servant invite --owner` prints) signs in with no phone or QR code.
  useEffect(() => watchDesktopInvites(link => {
    const invite = parseInvite(link);
    if (!invite) return;
    router.push({ pathname: "/pair", params: { code: invite.code, key: invite.serverKey ?? "", d: invite.discovery ?? "", server: invite.server ?? "" } });
  }), []);

  if (desktopWorkspace && !useInvite) return <DesktopSignIn workspace={desktopWorkspace} onUseInvite={() => setUseInvite(true)} />;

  return (
    <View style={styles.root}>
      <Band />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <PageTitle description={account ? "Open a new invite from your admin to enable encrypted connections. Ask for an invite for your existing account to keep your conversations." : "Channels, direct messages, and your agent. Open an invite from a teammate to get started."}>{account ? "Reconnect securely" : "Join your workspace"}</PageTitle>

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
          {desktopWorkspace ? <Button label="Sign in with your phone" kind="secondary" onPress={() => setUseInvite(false)} style={[styles.action, { marginTop: space.sm }]} /> : null}
          {Platform.OS !== "web" ? <Button label="Scan an invite code" kind="secondary" onPress={() => router.push("/scan")} style={[styles.action, { marginTop: space.sm }]} /> : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

const useStyles = createThemedStyles(({ colors, controls }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  body: { paddingTop: space.sm, paddingBottom: space.xxl, width: "100%", maxWidth: 480, alignSelf: "center" },
  label: { ...typography.label, marginTop: space.sm, marginHorizontal: space.side, color: colors.ink },
  input: { ...controls.input, ...controls.inputMultiline, minHeight: 88, marginTop: space.xs, marginHorizontal: space.side },
  inputError: { borderColor: colors.red },
  action: { marginTop: space.md, marginHorizontal: space.side },
  error: { ...typography.caption, marginTop: space.xs, marginHorizontal: space.side, color: colors.red },
}));
