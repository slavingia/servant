import { useRef, useState } from "react";
import { Platform, ScrollView, Share, StyleSheet, Text, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { Button } from "../components/Button";
import { parseDeviceLink } from "../lib/device-link";
import { api, ServerError } from "../lib/server";
import { useSession } from "../lib/session";
import { createThemedStyles, space, typography, useTheme } from "../lib/theme";

type SignInLink = { code: string; link: string; expiresAt: number; minutes: number };

// Two ways to sign in a computer, either from here: make a link and paste it
// where you sign in on the computer, or paste (or scan) the one the computer shows.
export default function LinkComputer() {
  const styles = useStyles();
  const { colors } = useTheme();
  const { account } = useSession();
  const [made, setMade] = useState<SignInLink | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const make = async () => {
    if (!account || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const l = await api.signInLink(account);
      setMade({ ...l, minutes: Math.max(1, Math.round((l.expiresAt - Date.now()) / 60000)) });
    } catch (e) {
      setError(e instanceof ServerError ? e.message : "Couldn't make a link. Try again");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const copy = async () => {
    if (!made) return;
    try {
      setCopied(await Clipboard.setStringAsync(made.link));
      if (!copied) setError(null);
    } catch {
      setError("Couldn't copy the link. Try again");
    }
  };
  const approve = () => {
    const link = parseDeviceLink(text.match(/servant:\/\/link-device\?[^\s]+/i)?.[0] ?? text);
    if (!link) {
      setPasteError("That isn't a computer link. Copy it again from your computer");
      return;
    }
    router.push({ pathname: "/link-device", params: { id: link.id, key: link.serverKey } });
  };
  const minutes = made?.minutes ?? 0;

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
      <Text accessibilityRole="header" style={styles.heading}>Get a link for your computer</Text>
      <Text style={styles.lead}>Paste it where you sign in to Servant on your computer. It works once, and you stay signed in here.</Text>
      {made ? <>
        <Text selectable accessibilityLabel="Sign-in link" style={styles.link} numberOfLines={3}>{made.link}</Text>
        <Text style={styles.note}>Works for {minutes} {minutes === 1 ? "minute" : "minutes"}</Text>
        <Button label={copied ? "Link copied" : "Copy link"} busy={false} onPress={copy} style={styles.action} />
        {Platform.OS !== "web" ? <Button label="Share link" kind="secondary" onPress={() => Share.share({ message: made.link }).catch(() => setError("Couldn't open sharing"))} style={styles.gap} /> : null}
        <Button label="Make a new link" kind="link" busy={busy} onPress={make} style={styles.gap} />
      </> : <Button label="Make a link" busy={busy} onPress={make} style={styles.action} />}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}

      <View style={styles.section}>
        <Text accessibilityRole="header" style={styles.heading}>Or use your computer's link</Text>
        <Text style={styles.lead}>Your computer shows a code and a link. Paste the link here, or scan the code.</Text>
        <TextInput
          accessibilityLabel="Computer link"
          value={text}
          onChangeText={t => { setText(t); setPasteError(null); }}
          placeholder="Paste the link from your computer"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          style={[styles.input, pasteError && styles.inputError]}
        />
        {pasteError ? <Text accessibilityRole="alert" style={styles.error}>{pasteError}</Text> : null}
        <Button label="Continue" disabled={!text.trim()} onPress={approve} style={styles.action} />
        {Platform.OS !== "web" ? <Button label="Scan a code instead" kind="secondary" onPress={() => router.push({ pathname: "/scan", params: { mode: "computer" } })} style={styles.gap} /> : null}
      </View>
    </ScrollView>
  );
}

const useStyles = createThemedStyles(({ colors, controls }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  body: { padding: space.side, paddingBottom: space.xxl, width: "100%", maxWidth: 560, alignSelf: "center" },
  heading: { ...typography.heading, color: colors.ink },
  lead: { ...typography.caption, marginTop: space.xs, color: colors.muted },
  link: { ...typography.caption, marginTop: space.md, padding: space.md, color: colors.ink, borderWidth: 1, borderColor: colors.line, borderRadius: 12 },
  note: { ...typography.caption, marginTop: space.xs, color: colors.muted },
  action: { marginTop: space.md },
  gap: { marginTop: space.sm },
  error: { ...typography.caption, marginTop: space.sm, color: colors.red },
  section: { marginTop: space.xl, paddingTop: space.lg, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  input: { ...controls.input, ...controls.inputMultiline, minHeight: 88, marginTop: space.md },
  inputError: { borderColor: colors.red },
}));
