import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Button } from "../components/Button";
import { parseInvite } from "../lib/invite";
import { useSession } from "../lib/session";
import { signInInstructions } from "../lib/join-errors";
import { space, typography, useTheme, createThemedStyles } from "../lib/theme";

// "I already have an account": sign in on this device with a link made on a
// device that is already signed in. The team's invite link also works here when
// the account has a work email (the code signs in as that person).
export default function SignIn() {
  const styles = useStyles();
  const { colors } = useTheme();
  const { account } = useSession();
  const params = useLocalSearchParams<{ link?: string }>();
  const [text, setText] = useState(() => (params.link && parseInvite(params.link) ? params.link : ""));
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const go = (raw: string) => {
    const invite = parseInvite(raw);
    if (!invite) {
      setError("That isn't a Servant link. Copy the whole link from your other device and paste it here");
      return false;
    }
    router.push({ pathname: "/pair", params: { code: invite.code, key: invite.serverKey ?? "", d: invite.discovery ?? "", server: invite.server ?? "", mode: "existing" } });
    return true;
  };
  const paste = async () => {
    setError(null);
    try {
      const clip = (await Clipboard.getStringAsync()).trim();
      if (!clip) { setError("Nothing to paste yet. Copy the link on your other device first"); return; }
      setText(clip);
      go(clip);
    } catch {
      setError("Couldn't read the clipboard. Paste the link into the box instead");
    }
  };
  const copySteps = () => void Clipboard.setStringAsync(signInInstructions()).then(ok => setCopied(ok), () => setCopied(false));

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <Stack.Screen options={{ title: "Link this device" }} />
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        <Text style={styles.instructions}>On your other device, open You → Link a computer → Make a link.</Text>

        <Text style={styles.label} nativeID="signInLinkLabel">Device link</Text>
        <TextInput
          accessibilityLabelledBy="signInLinkLabel"
          accessibilityLabel="Device link"
          value={text}
          onChangeText={t => { setText(t); setError(null); }}
          placeholder="Paste link"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          style={[styles.input, error && styles.inputError]}
        />
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        <Button label="Continue" onPress={() => go(text)} disabled={!text.trim()} style={styles.action} />
        <View style={styles.row}>
          <Button label="Paste from clipboard" kind="secondary" onPress={() => void paste()} style={styles.half} />
          {Platform.OS !== "web" ? <Button label="Scan a code" kind="secondary" onPress={() => router.push("/scan")} style={styles.half} /> : null}
        </View>

        <Button label={copied ? "Steps copied" : "Copy these steps"} kind="link" onPress={copySteps} style={styles.action} />
        <Button label="Join a server" kind="link" onPress={() => router.replace(account ? "/join-server" : { pathname: "/welcome", params: { new: "1" } })} style={styles.gap} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const useStyles = createThemedStyles(({ colors, controls }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  body: { padding: space.side, paddingBottom: space.xxl, width: "100%", maxWidth: 520, alignSelf: "center" },
  instructions: { ...typography.body, color: colors.ink },
  label: { ...typography.label, marginTop: space.xl, color: colors.ink },
  input: { ...controls.input, ...controls.inputMultiline, minHeight: 88, marginTop: space.xs },
  inputError: { borderColor: colors.red },
  error: { ...typography.caption, marginTop: space.xs, color: colors.red },
  action: { marginTop: space.md },
  row: { flexDirection: "row", gap: space.sm, marginTop: space.sm },
  half: { flex: 1 },
  gap: { marginTop: space.lg },
}));
