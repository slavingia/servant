import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WORDMARK_COLOR, space, typography, createThemedStyles } from "../lib/theme";
import { ServantWordmark } from "./ServantWordmark";

// Navy band under the status bar, on every screen without a back button.
export function Band({ right, wordmark = false }: { right?: React.ReactNode; wordmark?: boolean }) {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.band, wordmark && styles.brandBand, { paddingTop: insets.top }]}>
      <View style={wordmark ? styles.wordmarkRow : styles.row}>
        {wordmark ? <ServantWordmark /> : <Text style={styles.mark} accessibilityRole="header">
          Servant
        </Text>}
        {right ? wordmark ? <View style={styles.wordmarkRight}>{right}</View> : right : null}
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
  brandBand: { backgroundColor: WORDMARK_COLOR },
  wordmarkRow: { minHeight: 76, paddingVertical: 14, paddingHorizontal: space.side, alignItems: "center", justifyContent: "center" },
  wordmarkRight: { position: "absolute", right: space.side },
  row: { minHeight: 48, paddingVertical: space.xs, paddingHorizontal: space.side, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: space.sm },
  mark: { ...typography.bodyStrong, color: colors.onBrand, letterSpacing: 0.2 },
  pageHeader: { marginTop: space.md, marginHorizontal: space.side, marginBottom: space.md },
  titleRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: space.sm },
  title: { ...typography.title, color: colors.ink, flexShrink: 1 },
  action: { maxWidth: "100%" },
  description: { ...typography.caption, color: colors.muted, marginTop: space.xxs },
}));
