import { useRef } from "react";
import { ActivityIndicator, Linking, StyleSheet, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { router } from "expo-router";
import { Button } from "../components/Button";
import { parseInvite } from "../lib/invite";
import { radius, space, typography, useTheme, createThemedStyles } from "../lib/theme";

export default function Scan() {
  const styles = useStyles();
  const { colors } = useTheme();
  const [permission, request] = useCameraPermissions();
  const done = useRef(false);

  if (!permission) return <View style={[styles.root, styles.center]}><ActivityIndicator color={colors.blue} accessibilityLabel="Checking camera access" /></View>;
  if (!permission.granted) {
    return (
      <View style={[styles.root, styles.center]}>
        <Text accessibilityRole="header" style={styles.title}>Scan your invite</Text>
        <Text style={styles.body}>Allow camera access to read the QR code from your teammate.</Text>
        <Button label={permission.canAskAgain ? "Allow camera" : "Open camera settings"} onPress={permission.canAskAgain ? request : () => Linking.openSettings()} style={{ marginTop: space.lg, alignSelf: "stretch" }} />
        <Button label="Use an invite link instead" kind="link" onPress={() => router.replace("/welcome")} style={{ marginTop: space.xs }} />
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
          const invite = parseInvite(data);
          if (!invite) return;
          done.current = true;
          router.replace({ pathname: "/pair", params: { code: invite.code, key: invite.serverKey ?? "", d: invite.discovery ?? "", server: invite.server ?? "" } });
        }}
      />
      <View style={styles.hint}>
        <Text style={styles.hintText}>Point your camera at the invite QR code</Text>
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
