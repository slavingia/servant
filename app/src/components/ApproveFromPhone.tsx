import { useState } from "react";
import { StyleSheet, Text, View, useWindowDimensions } from "react-native";
import * as Clipboard from "expo-clipboard";
import QRCode from "react-native-qrcode-svg";
import { Button } from "./Button";
import type { DesktopWorkspace } from "../lib/desktop";
import { deviceLinkUrl } from "../lib/device-link";
import type { Account } from "../lib/server";
import { useDeviceLinkApproval } from "../lib/use-device-link";
import { createThemedStyles, radius, space, typography } from "../lib/theme";
import { ServeLoader } from "./ServeLoader";

// The code card plus the three steps: scan or paste on the phone, match the
// number, approve. Works for the Mac app and for a browser.
export function ApproveFromPhone({ workspace, device, onSignedIn, children, side }: { workspace: DesktopWorkspace; device: string; onSignedIn: (account: Account) => void; children?: React.ReactNode; side?: boolean }) {
  const styles = useStyles();
  // On a wide window the code sits beside its steps, so the choices under them stay on screen.
  const wide = useWindowDimensions().width >= 820 && side;
  const [copied, setCopied] = useState(false);
  const { session, error, connection, completing, seconds, expired, retry } = useDeviceLinkApproval(workspace, device, onSignedIn);
  const live = !!session && !error && !expired && !completing;
  const link = session ? deviceLinkUrl({ id: session.id, serverKey: workspace.serverKey }) : "";
  return (
    <View style={styles.root}>
      <View style={wide ? styles.sideBySide : undefined}>
      <View style={[styles.card, wide && styles.cardSide]}>
        {live ? <>
          <View accessibilityLabel="Sign-in QR code" style={styles.qr}>
            <QRCode value={link} size={180} backgroundColor="#FFFFFF" color="#111111" />
          </View>
          <Text style={styles.codeLabel}>Match this number on your phone</Text>
          <Text selectable style={styles.code}>{session.code}</Text>
          <Button label={copied ? "Link copied" : "Copy link for your phone"} kind="link" onPress={() => void Clipboard.setStringAsync(link).then(ok => setCopied(ok), () => {})} />
          <Text style={styles.expiry}>Expires in {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}</Text>
        </> : error || expired ? <>
          <Text accessibilityRole="alert" style={styles.error}>{error || "Code expired"}</Text>
          <Button label="Get a new code" onPress={retry} style={styles.retry} />
        </> : <View style={styles.loading}>
          <ServeLoader size="large" />
          <Text style={styles.lead}>{completing ? "Signing you in…" : "Getting your sign-in code…"}</Text>
        </View>}
      </View>
      <View style={[styles.steps, wide && styles.stepsSide]}>
        <Step n={1}>Open Servant on your signed-in device.</Step>
        <Step n={2}>You → Link a computer → scan or paste link</Step>
        <Step n={3}>Match the number, then Sign in.</Step>
      </View>
      </View>
      <Text accessibilityLiveRegion="polite" style={styles.status}>{connection || (live ? "Waiting for approval…" : "")}</Text>
      {children}
    </View>
  );
}

export function Step({ n, children }: { n: number; children: string }) {
  const styles = useStyles();
  return (
    <View style={styles.step}>
      <View style={styles.bullet}><Text style={styles.bulletText}>{n}</Text></View>
      <Text style={styles.stepText}>{children}</Text>
    </View>
  );
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { alignSelf: "stretch" },
  card: { alignItems: "center", justifyContent: "center", padding: space.md, marginTop: space.md, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.line, minHeight: 300 },
  sideBySide: { flexDirection: "row", alignItems: "center", gap: space.xl },
  cardSide: { flex: 1, minHeight: 0 },
  stepsSide: { flex: 1, marginTop: space.lg, alignSelf: "center" },
  qr: { backgroundColor: "#FFFFFF", padding: space.sm, borderRadius: radius.md },
  codeLabel: { ...typography.caption, color: colors.muted, marginTop: space.md },
  code: { ...typography.display, letterSpacing: 4, color: colors.ink, marginTop: space.xxs },
  expiry: { ...typography.caption, color: colors.muted, marginTop: space.xxs },
  lead: { ...typography.body, color: colors.muted, textAlign: "center", marginTop: space.sm },
  error: { ...typography.body, color: colors.red, textAlign: "center", maxWidth: 340 },
  retry: { marginTop: space.lg, alignSelf: "stretch" },
  loading: { alignItems: "center", paddingVertical: space.xxl },
  steps: { alignSelf: "stretch", gap: space.sm, marginTop: space.md },
  step: { flexDirection: "row", gap: space.sm, alignItems: "flex-start" },
  bullet: { width: 24, height: 24, borderRadius: radius.pill, backgroundColor: colors.blueSoft, alignItems: "center", justifyContent: "center", marginTop: -1 },
  bulletText: { ...typography.captionStrong, color: colors.blue },
  stepText: { ...typography.body, color: colors.ink, flex: 1 },
  status: { ...typography.caption, color: colors.muted, textAlign: "center", marginTop: space.md, minHeight: 22 },
}));
