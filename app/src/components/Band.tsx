import { StyleSheet, Text, View } from "react-native";
import { space, typography, createThemedStyles } from "../lib/theme";

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
  pageHeader: { marginTop: space.md, marginHorizontal: space.side, marginBottom: space.md },
  titleRow: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: space.sm },
  title: { ...typography.title, color: colors.ink, flexShrink: 1 },
  action: { maxWidth: "100%" },
  description: { ...typography.caption, color: colors.muted, marginTop: space.xxs },
}));
