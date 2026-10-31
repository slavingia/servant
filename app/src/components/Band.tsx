import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { space, typography, createThemedStyles } from "../lib/theme";

// Navy band under the status bar, on every screen without a back button.
export function Band({ right }: { right?: React.ReactNode }) {
  const styles = useStyles();
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

export function PageTitle({ children, description, action }: { children: string; description?: string; action?: React.ReactNode }) {
  const styles = useStyles();
  return (
    <View style={styles.pageHeader}>
      <View style={styles.titleRow}>
        <Text style={styles.title} accessibilityRole="header">{children}</Text>
        {action ? <View style={styles.action}>{action}</View> : null}
      </View>
      {description ? <Text style={styles.description}>{description}</Text> : null}
    </View>
  );
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  band: { backgroundColor: colors.navy },
  row: { minHeight: 48, paddingVertical: space.xs, paddingHorizontal: space.side, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm },
  mark: { ...typography.bodyStrong, color: colors.onBrand, letterSpacing: 0.2 },
  pageHeader: { marginTop: space.md, marginHorizontal: space.side, marginBottom: space.md },
  titleRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: space.sm },
  title: { ...typography.title, color: colors.ink, flexShrink: 1 },
  action: { maxWidth: "100%" },
  description: { ...typography.caption, color: colors.muted, marginTop: space.xxs },
}));
