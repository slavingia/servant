import { StyleSheet, useWindowDimensions, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { ServantWordmark } from "./ServantWordmark";
import { ProjectCredit } from "./ProjectCredit";
import { LAUNCH_COLOR } from "../lib/theme";

// Keep the native splash and account-loading screen visually continuous.
export function LaunchScreen() {
  const { width } = useWindowDimensions();
  return (
    <View style={styles.root}>
      <StatusBar style="light" />
      <ServantWordmark width={Math.min(280, width - 32)} />
      <View style={styles.credit}>
        <ProjectCredit onBlue />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: LAUNCH_COLOR, alignItems: "center", justifyContent: "center" },
  credit: { position: "absolute", bottom: 0, left: 0, right: 0 },
});
