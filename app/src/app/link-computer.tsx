import { useEffect, useRef, useState } from "react";
import { Linking, Platform, ScrollView, Share, StyleSheet, Text, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { router } from "expo-router";
import { AppIcon } from "../components/AppIcon";
import { Button } from "../components/Button";
import { parseDeviceLink } from "../lib/device-link";
import { countdownText } from "../lib/join-errors";
import { api, ServerError, type SignInLinkStatus } from "../lib/server";
import { useSession } from "../lib/session";
import { createThemedStyles, radius, space, typography, useTheme } from "../lib/theme";

type SignInLink = { code: string; link: string; expiresAt: number };

// Sign in on a computer (or any other device) from a phone that is already signed
// in. Make a link here, send it there, paste it under "I already have an account".
// The other way round also works: paste or scan the code the computer shows.
export default function LinkComputer() {
  const styles = useStyles();
  const { colors } = useTheme();
  const { account } = useSession();
  const [made, setMade] = useState<SignInLink | null>(null);
  const [status, setStatus] = useState<SignInLinkStatus | null>(null);
  const [now, setNow] = useState(() => Date.now());
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
      setMade(l);
      setStatus({ status: "live", createdAt: Date.now(), expiresAt: l.expiresAt });
      setNow(Date.now());
    } catch (e) {
      setError(e instanceof ServerError ? e.message : "Couldn't make a link. Check your connection and try again");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  // While a link is live: tick the countdown and ask the server whether it was used.
  const live = !!made && status?.status === "live" && made.expiresAt > now;
  useEffect(() => {
    if (!account || !made || !live) return;
    const controller = new AbortController();
    const clock = setInterval(() => setNow(Date.now()), 1000);
    const check = setInterval(() => {
      api.signInLinkStatus(account, controller.signal).then(s => { if (!controller.signal.aborted && s) setStatus(s); }).catch(() => {});
    }, 3000);
    return () => { controller.abort(); clearInterval(clock); clearInterval(check); };
  }, [account, made, live]);

  const copy = async () => {
    if (!made) return;
    try {
      const ok = await Clipboard.setStringAsync(made.link);
      setCopied(ok);
      if (!ok) setError("Couldn't copy the link. Select it and copy it by hand");
    } catch {
      setError("Couldn't copy the link. Select it and copy it by hand");
    }
  };
  const email = () => {
    if (!made) return;
    const body = `Open Servant on your computer, choose "I already have an account" and paste this link. It works once, for ten minutes.\n\n${made.link}`;
    Linking.openURL(`mailto:?subject=${encodeURIComponent("Your Servant sign-in link")}&body=${encodeURIComponent(body)}`)
      .catch(() => setError("Couldn't open your email. Copy the link instead"));
  };
  const share = () => Share.share({ message: made!.link }).catch(() => setError("Couldn't open sharing. Copy the link instead"));
  const approve = () => {
    const link = parseDeviceLink(text.match(/servant:\/\/link-device\?[^\s]+/i)?.[0] ?? text);
    if (!link) {
      setPasteError("That isn't a computer link. Copy it again from the computer's sign-in screen");
      return;
    }
    router.push({ pathname: "/link-device", params: { id: link.id, key: link.serverKey } });
  };

  const used = made && status?.status === "used";
  const expired = made && !used && !live;

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
      <Text accessibilityRole="header" style={styles.heading}>Sign in on a computer</Text>
      <Text style={styles.lead}>This link signs in another device as you.</Text>

      {!made ? <Button label="Make a link" busy={busy} onPress={make} style={styles.action} /> : used ? <View style={styles.card}>
        <View style={styles.doneRow}><AppIcon name="check" size={18} color={colors.green} /><Text style={styles.doneTitle}>Signed in on {status?.device ?? "your computer"}</Text></View>
        <Button label="Make another link" kind="secondary" busy={busy} onPress={make} style={styles.action} />
      </View> : expired ? <View style={styles.card}>
        <Text style={styles.doneTitle}>That link expired</Text>
        <Button label="Make a new link" busy={busy} onPress={make} style={styles.action} />
      </View> : <View style={styles.card}>
        <Text selectable accessibilityLabel="Sign-in link" style={styles.link}>{made.link}</Text>
        <Text accessibilityLiveRegion="polite" style={styles.countdown}>Works once, for {countdownText(made.expiresAt, now)} more</Text>
        <Button label={copied ? "Link copied" : "Copy link"} onPress={copy} style={styles.action} />
        <View style={styles.row}>
          {Platform.OS !== "web" ? <Button label="Share" kind="secondary" onPress={share} style={styles.half} /> : null}
          <Button label="Email" kind="secondary" onPress={email} style={styles.half} />
        </View>
        <Button label="Make a new link" kind="link" busy={busy} onPress={make} style={styles.gap} />
        <Text style={styles.replaceNote}>A new link cancels this one.</Text>
      </View>}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}

      <View style={styles.section}>
        <Text accessibilityRole="header" style={styles.heading}>Computer sign-in link</Text>
        <TextInput
          accessibilityLabel="Computer link"
          value={text}
          onChangeText={t => { setText(t); setPasteError(null); }}
          placeholder="Paste the link from the computer"
          placeholderTextColor={colors.muted}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          style={[styles.input, pasteError && styles.inputError]}
        />
        {pasteError ? <Text accessibilityRole="alert" style={styles.error}>{pasteError}</Text> : null}
        <Button label="Continue" kind="secondary" disabled={!text.trim()} onPress={approve} style={styles.action} />
        {Platform.OS !== "web" ? <Button label="Scan the code instead" kind="secondary" onPress={() => router.push({ pathname: "/scan", params: { mode: "computer" } })} style={styles.gap} /> : null}
      </View>
    </ScrollView>
  );
}

const useStyles = createThemedStyles(({ colors, controls }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  body: { padding: space.side, paddingBottom: space.xxl, width: "100%", maxWidth: 560, alignSelf: "center" },
  heading: { ...typography.heading, color: colors.ink },
  lead: { ...typography.body, marginTop: space.xs, color: colors.muted },
  card: { marginTop: space.lg, padding: space.md, borderWidth: 1, borderColor: colors.line, borderRadius: radius.lg },
  link: { ...typography.bodyStrong, color: colors.ink, padding: space.sm, borderRadius: radius.md, backgroundColor: colors.subtle },
  countdown: { ...typography.captionStrong, marginTop: space.sm, color: colors.muted },
  doneRow: { flexDirection: "row", alignItems: "center", gap: space.xs },
  doneTitle: { ...typography.bodyStrong, color: colors.ink },
  replaceNote: { ...typography.caption, color: colors.muted, textAlign: "center", marginTop: -space.xs },
  action: { marginTop: space.md },
  row: { flexDirection: "row", gap: space.sm, marginTop: space.sm },
  half: { flex: 1 },
  gap: { marginTop: space.sm },
  error: { ...typography.caption, marginTop: space.sm, color: colors.red },
  section: { marginTop: space.xl, paddingTop: space.lg, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  input: { ...controls.input, ...controls.inputMultiline, minHeight: 88, marginTop: space.md },
  inputError: { borderColor: colors.red },
}));
