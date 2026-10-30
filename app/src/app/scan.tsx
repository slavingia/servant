import { useRef } from "react";
import { StyleSheet, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { router } from "expo-router";
import { Button } from "../components/Button";
import { parseInvite } from "../lib/invite";
import { colors } from "../lib/theme";

export default function Scan() {
  const [permission, request] = useCameraPermissions();
  const done = useRef(false);

  if (!permission) return <View style={styles.root} />;
  if (!permission.granted) {
    return (
      <View style={[styles.root, styles.center]}>
        <Text style={styles.body}>Servant needs the camera to read an invite code</Text>
        <Button label="Allow camera" onPress={request} style={{ marginTop: 24, alignSelf: "stretch" }} />
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
          router.replace({ pathname: "/pair", params: { code: invite.code, d: invite.discovery ?? "", hub: invite.hub ?? "" } });
        }}
      />
      <View style={styles.hint}>
        <Text style={styles.hintText}>Point at the invite code</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#000" },
  center: { alignItems: "center", justifyContent: "center", padding: 20, backgroundColor: colors.white },
  body: { fontSize: 17, lineHeight: 24, color: colors.ink, textAlign: "center" },
  hint: { position: "absolute", bottom: 60, left: 20, right: 20, alignItems: "center" },
  hintText: { color: colors.white, fontSize: 17, fontWeight: "600", backgroundColor: "rgba(0,0,0,0.55)", paddingHorizontal: 16, paddingVertical: 10, borderRadius: 20, overflow: "hidden" },
});
