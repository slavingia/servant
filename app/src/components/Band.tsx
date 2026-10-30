import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { colors } from "../lib/theme";

// Navy band under the status bar, on every screen without a back button.
export function Band({ right }: { right?: React.ReactNode }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.band, { paddingTop: insets.top }]}>
      <View style={styles.row}>
        <Text style={styles.mark} accessibilityRole="header">
          Servant
        </Text>
        {right}
      </View>
    </View>
  );
}

export function PageTitle({ children }: { children: string }) {
  return (
    <Text style={styles.title} accessibilityRole="header">
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  band: { backgroundColor: colors.navy },
  row: { height: 48, paddingHorizontal: 20, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  mark: { color: colors.white, fontSize: 17, fontWeight: "700", letterSpacing: 0.3 },
  title: { marginTop: 20, marginHorizontal: 20, fontSize: 30, fontWeight: "700", color: colors.ink },
});
