import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { router, useLocalSearchParams } from "expo-router";
import { Button } from "../components/Button";
import { deviceLinkFromParams, deviceLinkMatchesAccount } from "../lib/device-link";
import { approveDeviceLink, denyDeviceLink, previewDeviceLink, type DeviceLinkPreview } from "../lib/device-link-api";
import { useSession } from "../lib/session";
import type { Account } from "../lib/server";
import { createThemedStyles, radius, space, typography, useTheme } from "../lib/theme";

export default function LinkDevice() {
  const { id, key } = useLocalSearchParams<{ id?: string; key?: string }>();
  const { account } = useSession();
  return <LinkDeviceRequest key={`${id}:${key}:${account?.token}`} id={id} serverKey={key} account={account} />;
}

function LinkDeviceRequest({ id, serverKey, account }: { id?: string; serverKey?: string; account: Account | null }) {
  const { colors } = useTheme();
  const styles = useStyles();
  const [preview, setPreview] = useState<DeviceLinkPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [approved, setApproved] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const inFlight = useRef(false);
  const link = deviceLinkFromParams(id, serverKey);
  const matches = !!link && deviceLinkMatchesAccount(link, account);

  useEffect(() => {
    const current = deviceLinkFromParams(id, serverKey);
    if (!account || !current || !deviceLinkMatchesAccount(current, account)) return;
    const controller = new AbortController();
    previewDeviceLink(account, current, controller.signal).then(result => {
      if (!controller.signal.aborted) setPreview(result);
    }).catch(e => {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Couldn't check this sign-in request.");
    });
    return () => controller.abort();
  }, [id, serverKey, account, attempt]);

  const act = async (approve: boolean) => {
    if (!account || !link || !matches || !preview || preview.id !== link.id || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      if (approve) {
        await approveDeviceLink(account, link);
        setApproved(true);
      } else {
        await denyDeviceLink(account, link);
        router.replace("/you");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't finish. Try again.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const invalid = !account ? "Sign in to Servant on your phone first, then scan the Mac's QR code again."
    : !link ? "This computer sign-in code is incomplete. Scan a new code from your Mac."
    : !matches ? "This Mac is connecting to a different workspace. Open the Mac app for your workspace and scan its code."
    : null;

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.body}>
      <Text accessibilityRole="header" style={styles.title}>{approved ? "Your Mac is approved" : "Sign in on your Mac"}</Text>
      {invalid ? <>
        <Text accessibilityRole="alert" style={styles.error}>{invalid}</Text>
        <Button label={account ? "Back to Servant" : "Sign in on phone"} onPress={() => router.replace(account ? "/you" : "/welcome")} style={styles.action} />
      </> : approved ? <>
        <Text style={styles.description}>Your Mac can now finish signing in. Your phone stays signed in, and your conversations stay with your existing account.</Text>
        <Button label="Done" onPress={() => router.replace("/you")} style={styles.action} />
      </> : preview ? <>
        <Text style={styles.description}>You're signing in as {account!.user.name} in {account!.serverName}.</Text>
        <View style={styles.codeCard}>
          <Text style={styles.label}>Check that this number matches your Mac</Text>
          <Text selectable style={styles.code}>{preview.code}</Text>
          <Text style={styles.device}>{preview.device}</Text>
          {preview.agent ? <Text style={styles.description}>This is an agent or other automation. Everything it posts shows as "Posted by agent" under your name.</Text> : null}
        </View>
        <Text style={styles.description}>Only approve a computer you control. It will be able to read your conversations and send messages as you.</Text>
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
        {preview.status === "approved" ? <Text style={styles.description}>This request is already approved. Return to your Mac to finish signing in.</Text> : <>
          <Button label="Sign in on Mac" onPress={() => void act(true)} busy={busy} style={styles.action} />
          <Button label="Cancel sign-in" kind="secondary" onPress={() => void act(false)} disabled={busy} style={styles.secondary} />
        </>}
        <Button label="Back to Servant" kind="link" disabled={busy} onPress={() => router.replace("/you")} style={styles.secondary} />
      </> : error ? <>
        <Text accessibilityRole="alert" style={styles.error}>{error}</Text>
        <Button label="Try again" onPress={() => { setError(null); setPreview(null); setAttempt(value => value + 1); }} style={styles.action} />
        <Button label="Scan a new code" kind="secondary" onPress={() => router.replace({ pathname: "/scan", params: { mode: "computer" } })} style={styles.secondary} />
      </> : <ActivityIndicator accessibilityLabel="Checking computer sign-in" color={colors.blue} size="large" style={styles.action} />}
    </ScrollView>
  );
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  body: { width: "100%", maxWidth: 480, alignSelf: "center", padding: space.lg, paddingBottom: space.xxl },
  title: { ...typography.title, color: colors.ink },
  description: { ...typography.body, color: colors.muted, marginTop: space.md },
  codeCard: { marginTop: space.lg, padding: space.lg, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, alignItems: "center" },
  label: { ...typography.caption, color: colors.muted, textAlign: "center" },
  code: { ...typography.display, color: colors.ink, letterSpacing: 4, marginTop: space.md },
  device: { ...typography.captionStrong, color: colors.muted, marginTop: space.sm },
  error: { ...typography.body, color: colors.red, marginTop: space.md },
  action: { marginTop: space.lg },
  secondary: { marginTop: space.sm },
}));
