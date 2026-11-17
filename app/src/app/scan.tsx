import { useRef, useState } from "react";
import { Linking, StyleSheet, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { router, useLocalSearchParams } from "expo-router";
import { Button } from "../components/Button";
import { parseInvite } from "../lib/invite";
import { parseDeviceLink } from "../lib/device-link";
import { scanOptions } from "../lib/scan-mode";
import { useSession } from "../lib/session";
import { radius, space, typography, createThemedStyles } from "../lib/theme";
import { ServeLoader } from "../components/ServeLoader";

export default function Scan() {
  const styles = useStyles();
  const [permission, request] = useCameraPermissions();
  const done = useRef(false);
  const { mode } = useLocalSearchParams<{ mode?: string }>();
  const { account } = useSession();
  const { computer, returnTo } = scanOptions(mode, account);
  const [scanError, setScanError] = useState<string | null>(null);

  if (!permission) return <View style={[styles.root, styles.center]}><ServeLoader accessibilityLabel="Checking camera access" /></View>;
  if (!permission.granted) {
    return (
      <View style={[styles.root, styles.center]}>
        <Text accessibilityRole="header" style={styles.title}>{computer ? "Link a computer" : "Scan your invite"}</Text>
        <Text style={styles.body}>{computer ? "Allow camera access to scan the sign-in QR code on your Mac." : "Allow camera access to read the QR code from your teammate."}</Text>
        <Button label={permission.canAskAgain ? "Allow camera" : "Open camera settings"} onPress={permission.canAskAgain ? request : () => Linking.openSettings()} style={{ marginTop: space.lg, alignSelf: "stretch" }} />
        <Button label={returnTo === "/you" ? "Back to Servant" : "Use an invite link instead"} kind="link" onPress={() => router.replace(returnTo)} style={{ marginTop: space.xs }} />
      </View>
    );
  }
  return (
    <View style={styles.root}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={({ data }) => {
          if (done.current) return;
          const link = parseDeviceLink(data);
          if (link) {
            done.current = true;
            router.replace({ pathname: "/link-device", params: { id: link.id, key: link.serverKey } });
            return;
          }
          if (computer) {
            setScanError("That isn't a computer sign-in code. Scan the QR code shown in Servant on your Mac.");
            return;
          }
          const invite = parseInvite(data);
          if (!invite) {
            setScanError("That isn't a Servant invite. Try another QR code.");
            return;
          }
          done.current = true;
          router.replace({ pathname: "/pair", params: { code: invite.code, key: invite.serverKey ?? "", d: invite.discovery ?? "", server: invite.server ?? "" } });
        }}
      />
      <View style={styles.hint}>
        <Text accessibilityRole={scanError ? "alert" : undefined} style={styles.hintText}>{scanError || (computer ? "Point your camera at the QR code on your Mac" : "Point your camera at the invite QR code")}</Text>
      </View>
    </View>
  );
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  center: { alignItems: "center", justifyContent: "center", padding: space.side, backgroundColor: colors.background },
  title: { ...typography.title, textAlign: "center", color: colors.ink, marginBottom: space.sm },
  body: { ...typography.body, color: colors.muted, textAlign: "center" },
  hint: { position: "absolute", bottom: 60, left: space.side, right: space.side, alignItems: "center" },
  hintText: { ...typography.bodyStrong, color: colors.white, textAlign: "center", backgroundColor: "rgba(0,0,0,0.7)", paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.md, overflow: "hidden" },
}));
