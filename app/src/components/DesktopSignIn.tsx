import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import QRCode from "react-native-qrcode-svg";
import { Band } from "./Band";
import { Button } from "./Button";
import type { DesktopWorkspace } from "../lib/desktop";
import { deviceLinkUrl } from "../lib/device-link";
import { pollDesktopLink, startDesktopLink, type DesktopLinkSession } from "../lib/device-link-api";
import { saveAccountIfCurrent, ServerError } from "../lib/server";
import { useSession } from "../lib/session";
import { createThemedStyles, radius, space, typography, useTheme } from "../lib/theme";

export function DesktopSignIn({ workspace, onUseInvite }: { workspace: DesktopWorkspace; onUseInvite: () => void }) {
  const [attempt, setAttempt] = useState(0);
  return <DesktopSignInAttempt key={`${workspace.server}:${workspace.serverKey}:${workspace.discovery}:${attempt}`} workspace={workspace} onUseInvite={onUseInvite} onRetry={() => setAttempt(value => value + 1)} />;
}

function DesktopSignInAttempt({ workspace, onUseInvite, onRetry }: { workspace: DesktopWorkspace; onUseInvite: () => void; onRetry: () => void }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { setAccount } = useSession();
  const [session, setSession] = useState<DesktopLinkSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connection, setConnection] = useState<string | null>(null);
  const [completing, setCompleting] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const { server, serverKey, discovery } = workspace;

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clock = setInterval(() => setNow(Date.now()), 1000);
    const poll = async (current: DesktopLinkSession) => {
      if (controller.signal.aborted) return;
      if (Date.now() >= current.expiresAt) {
        setError("This QR code expired. Get a new code to sign in.");
        return;
      }
      try {
        const account = await pollDesktopLink(current, controller.signal);
        if (controller.signal.aborted) return;
        setConnection(null);
        if (account) {
          setCompleting(true);
          if (!await saveAccountIfCurrent(account, () => !controller.signal.aborted)) return;
          setAccount(account);
          router.replace("/channels");
          return;
        }
      } catch (e) {
        if (controller.signal.aborted) return;
        if (e instanceof ServerError && (!e.status || e.status >= 500)) {
          setConnection("Reconnecting to your workspace…");
        } else {
          setError(e instanceof Error ? e.message : "Couldn't finish signing in. Get a new QR code.");
          setCompleting(false);
          return;
        }
      }
      timer = setTimeout(() => void poll(current), Math.max(2000, current.intervalMs || 2000));
    };
    startDesktopLink({ server, serverKey, discovery }, controller.signal).then(current => {
      if (controller.signal.aborted) return;
      setSession(current);
      setNow(Date.now());
      timer = setTimeout(() => void poll(current), Math.max(2000, current.intervalMs || 2000));
    }).catch(e => {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Couldn't create a sign-in code. Try again.");
    });
    return () => {
      controller.abort();
      clearTimeout(timer);
      clearInterval(clock);
    };
  }, [server, serverKey, discovery, setAccount]);

  const seconds = session ? Math.max(0, Math.ceil((session.expiresAt - now) / 1000)) : 0;
  const expired = !!session && seconds === 0;
  return (
    <View style={styles.root}>
      <Band />
      <ScrollView contentContainerStyle={styles.body}>
        <Text accessibilityRole="header" style={styles.title}>Your workspace, on your Mac</Text>
        <Text style={styles.lead}>Sign in with the Servant app on your phone, or paste an invite link.</Text>
        <View style={styles.card}>
          {session && !error && !expired && !completing ? <>
            <View accessibilityLabel="Computer sign-in QR code" style={styles.qr}>
              <QRCode value={deviceLinkUrl({ id: session.id, serverKey })} size={220} backgroundColor="#FFFFFF" color="#111111" />
            </View>
            <Text style={styles.codeLabel}>Match this code on your phone</Text>
            <Text selectable style={styles.code}>{session.code}</Text>
            <Text style={styles.expiry}>Expires in {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</Text>
          </> : error || expired ? <>
            <Text accessibilityRole="alert" style={styles.error}>{error || "This QR code expired. Get a new code to sign in."}</Text>
            <Button label="Get a new QR code" onPress={onRetry} style={styles.retry} />
          </> : <View style={styles.loading}>
            <ActivityIndicator size="large" color={colors.blue} />
            <Text style={styles.lead}>{completing ? "Signing you in…" : "Getting your sign-in code…"}</Text>
          </View>}
        </View>
        <View style={styles.steps}>
          <Text style={styles.step}>1. Open Servant on your phone.</Text>
          <Text style={styles.step}>2. Go to You → Link a computer and scan this code.</Text>
          <Text style={styles.step}>3. Check the matching number, then tap Sign in on Mac.</Text>
        </View>
        <Text accessibilityLiveRegion="polite" style={styles.status}>{connection || (session && !error && !expired && !completing ? "Waiting for approval on your phone…" : "")}</Text>
        <Button label="Paste an invite link" kind="link" disabled={completing} onPress={onUseInvite} />
        <Text style={styles.note}>No phone? Ask your admin for an invite link. On the server's own Mac, run servant invite --owner</Text>
      </ScrollView>
    </View>
  );
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  body: { width: "100%", maxWidth: 560, alignSelf: "center", paddingHorizontal: space.lg, paddingTop: space.xl, paddingBottom: space.xxl, alignItems: "center" },
  title: { ...typography.display, color: colors.ink, textAlign: "center" },
  lead: { ...typography.body, color: colors.muted, textAlign: "center", marginTop: space.sm },
  card: { alignItems: "center", justifyContent: "center", padding: space.lg, marginTop: space.lg, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, minWidth: 300, minHeight: 350 },
  qr: { backgroundColor: "#FFFFFF", padding: space.md, borderRadius: radius.md },
  codeLabel: { ...typography.caption, color: colors.muted, marginTop: space.md },
  code: { ...typography.display, letterSpacing: 4, color: colors.ink, marginTop: space.xs },
  expiry: { ...typography.caption, color: colors.muted, marginTop: space.xs },
  error: { ...typography.body, color: colors.red, textAlign: "center", maxWidth: 340 },
  retry: { marginTop: space.lg, alignSelf: "stretch" },
  loading: { alignItems: "center", paddingVertical: space.xxl },
  steps: { alignSelf: "stretch", gap: space.sm, marginTop: space.lg },
  step: { ...typography.body, color: colors.ink },
  status: { ...typography.caption, color: colors.muted, textAlign: "center", marginTop: space.lg, minHeight: 22 },
  note: { ...typography.caption, color: colors.muted, textAlign: "center", marginTop: space.xs },
}));
