import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Platform, ScrollView, Share, StyleSheet, Text, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import QRCode from "react-native-qrcode-svg";
import { Redirect } from "expo-router";
import { Button } from "../components/Button";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { api, ServerError } from "../lib/server";
import { useSession } from "../lib/session";
import { landingHref, useFeatures } from "../lib/features";
import { radius, space, typography, useTheme, createThemedStyles } from "../lib/theme";

type Link = { code: string; link: string; webLink?: string | null; expiresAt: number };

// One join link for the whole team. Anyone with it can join until it expires.
export default function Invite() {
  const styles = useStyles();
  const { colors } = useTheme();
  const { account } = useSession();
  // Deep work hides People and its invite (features.ts withDeepWork).
  const features = useFeatures();
  const [invite, setInvite] = useState<Link | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [replaceOpen, setReplaceOpen] = useState(false);
  const [replaceError, setReplaceError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const actionInFlight = useRef(false);

  const fetchLink = (fresh = false) =>
    api.joinLink(account!, fresh).then(
      (l) => {
        setInvite(l);
        setCopied(false);
        setActionError(null);
        setReplaceOpen(false);
      },
      (e) => {
        const message = e instanceof ServerError ? e.message : "Couldn't get the invite link. Try again.";
        if (fresh) setReplaceError(message);
        else setError(message);
      },
    );
  const load = async (fresh = false) => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setBusy(true);
    setError(null);
    setReplaceError(null);
    try {
      await fetchLink(fresh);
    } finally {
      setBusy(false);
      actionInFlight.current = false;
    }
  };

  useEffect(() => {
    if (account && features.people) fetchLink();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!account) return null;
  if (!features.people) return <Redirect href={landingHref(features)} />;
  if (error && !invite) {
    return (
      <View style={styles.center}>
        <Text accessibilityRole="alert" style={styles.error}>{error}</Text>
        <Button label="Try again" busy={busy} onPress={() => load()} style={{ marginTop: space.lg, alignSelf: "stretch" }} />
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
  const message = `Join ${account.serverName} on Servant. Tap to join: ${invite.webLink ?? invite.link}`;
  const copy = async () => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setCopying(true);
    setCopied(false);
    setActionError(null);
    try {
      const success = await Clipboard.setStringAsync(invite.webLink ?? invite.link);
      if (!success) throw new Error("Clipboard unavailable");
      setCopied(true);
    } catch {
      setActionError("Couldn't copy the link. Try again or ask your teammate to scan the QR code.");
    } finally {
      setCopying(false);
      actionInFlight.current = false;
    }
  };

  return (
    <>
    <ScrollView style={styles.root} contentContainerStyle={styles.body}>
      <Text accessibilityRole="header" style={styles.heading}>Invite to {account.serverName}</Text>
      <View style={styles.qr}>
        <QRCode value={invite.link} size={180} />
      </View>
      <Text style={styles.codeLabel}>Scan with Servant</Text>
      <Text style={styles.note}>Expires {until}</Text>
      {Platform.OS !== "web" ? <Button label="Share invite link" disabled={busy || copying} onPress={() => Share.share({ message }).catch(() => setActionError("Couldn't open sharing. Try copying the invite link."))} style={{ marginTop: space.lg }} /> : null}
      <Button
        label={copied ? "Link copied" : "Copy invite link"}
        kind={Platform.OS === "web" ? "primary" : "secondary"}
        busy={copying}
        disabled={busy}
        onPress={copy}
        style={{ marginTop: Platform.OS === "web" ? space.lg : space.sm }}
      />
      {actionError ? <Text accessibilityRole="alert" style={styles.actionError}>{actionError}</Text> : null}
      <View style={styles.details}>
        <Text style={styles.detailHeading}>Who can join?</Text>
        <Text style={styles.detail}>Anyone with this link can join. They'll have a limited agent with no access to your files, accounts, or shell.</Text>
        <Button label="Replace invite link" kind="link" disabled={busy || copying} onPress={() => { setReplaceError(null); setReplaceOpen(true); }} style={{ alignSelf: "flex-start", marginLeft: -space.side, marginTop: space.xs }} />
      </View>
    </ScrollView>
    <ConfirmDialog visible={replaceOpen} title="Replace invite link?" description="The current link will stop working. People who already joined will keep their access." confirmLabel="Replace link" onConfirm={() => load(true)} onCancel={() => setReplaceOpen(false)} busy={busy} error={replaceError} />
    </>
  );
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  body: { padding: space.side, paddingBottom: space.xxl, width: "100%", maxWidth: 680, alignSelf: "center" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.side, backgroundColor: colors.background },
  heading: { ...typography.heading, color: colors.ink },
  qr: { marginTop: space.md, alignSelf: "center", padding: space.md, backgroundColor: colors.white, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line },
  codeLabel: { ...typography.captionStrong, marginTop: space.sm, textAlign: "center", color: colors.ink },
  note: { ...typography.caption, marginTop: space.xs, color: colors.muted, textAlign: "center" },
  details: { marginTop: space.lg, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, paddingTop: space.md },
  detailHeading: { ...typography.bodyStrong, color: colors.ink },
  detail: { ...typography.caption, marginTop: space.xs, color: colors.muted },
  error: { ...typography.body, color: colors.red, textAlign: "center" },
  actionError: { ...typography.caption, marginTop: space.sm, color: colors.red },
}));
