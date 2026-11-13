import { useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Band, PageTitle } from "../components/Band";
import { Button } from "../components/Button";
import { INVITE_EXAMPLE, parseInvite } from "../lib/invite";
import { space, typography, useTheme, createThemedStyles } from "../lib/theme";
import { useSession } from "../lib/session";
import { getDesktopWorkspace, getWebWorkspace, watchDesktopInvites } from "../lib/desktop";
import { DesktopSignIn } from "../components/DesktopSignIn";
import { ProjectCredit } from "../components/ProjectCredit";

// Start with the invite itself. Existing accounts have a separate sign-in path.
export default function Welcome() {
  const styles = useStyles();
  const { colors } = useTheme();
  const { account } = useSession();
  const params = useLocalSearchParams<{ new?: string }>();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [useInvite, setUseInvite] = useState(false);
  const desktopWorkspace = getDesktopWorkspace();
  const webWorkspace = desktopWorkspace ? null : getWebWorkspace();
  // A saved account from before encryption needs a fresh invite for the same person.
  const reconnect = !!account;

  const join = () => {
    const invite = parseInvite(text);
    if (!invite) {
      setError("That isn't an invite link. Ask for the complete link.");
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
  if (webWorkspace && !useInvite && !reconnect) return <DesktopSignIn workspace={webWorkspace} device="Browser" onUseInvite={() => setUseInvite(true)} />;

  return (
    <View style={styles.root}>
      <Band wordmark />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
          <PageTitle description={reconnect ? "Ask your admin for a new invite for your existing account to enable encryption and keep your conversations." : undefined}>{reconnect ? "Reconnect securely" : "Join a server"}</PageTitle>
          <View style={styles.form}>
            <Text style={styles.label} nativeID="inviteLabel">Invite link</Text>
            {/* What one looks like, so the link can be told from the message around it. */}
            <Text nativeID="inviteExample" style={styles.hint}>Example: {INVITE_EXAMPLE}</Text>
            <TextInput
              accessibilityLabelledBy="inviteLabel"
              accessibilityLabel="Invite link"
              aria-describedby="inviteExample"
              accessibilityHint={`Example: ${INVITE_EXAMPLE}`}
              value={text}
              onChangeText={(t) => {
                setText(t);
                setError(null);
              }}
              placeholder="Paste your invite link"
              placeholderTextColor={colors.muted}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus={params.new === "1" && Platform.OS !== "web"}
              multiline
              style={[styles.input, error && styles.inputError]}
            />
            {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
            <Button label="Continue" onPress={join} disabled={!text.trim()} style={styles.action} />
            {Platform.OS !== "web" ? <Button label="Scan a code" kind="secondary" onPress={() => router.push("/scan")} style={styles.scan} /> : null}
            {!reconnect ? <View style={styles.signIn}>
              <Button label="Link this device" kind="secondary" onPress={() => router.push("/sign-in")} />
              <Text style={styles.signInHint}>Use an account you’re already signed into on another device.</Text>
            </View> : null}
            {desktopWorkspace || webWorkspace ? <Button label="Sign in with phone" kind="link" onPress={() => setUseInvite(false)} /> : null}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
      <ProjectCredit />
    </View>
  );
}

const useStyles = createThemedStyles(({ colors, controls }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  body: { paddingTop: space.lg, paddingBottom: space.xxl, width: "100%", maxWidth: 440, alignSelf: "center" },
  form: { marginHorizontal: space.side },
  label: { ...typography.label, marginTop: space.xs, color: colors.ink },
  hint: { ...typography.caption, color: colors.muted, marginTop: space.xxs },
  input: { ...controls.input, ...controls.inputMultiline, minHeight: 88, marginTop: space.xs },
  inputError: { borderColor: colors.red },
  action: { marginTop: space.md },
  scan: { marginTop: space.sm },
  signIn: { marginTop: space.lg, paddingTop: space.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  signInHint: { ...typography.caption, color: colors.muted, marginTop: space.xs },
  error: { ...typography.caption, marginTop: space.xs, color: colors.red },
}));
