import { Link } from "expo-router";
import { StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import author from "../../project-credit.json";
import { typography, useTheme } from "../lib/theme";

export function ProjectCredit({ onBlue = false }: { onBlue?: boolean }) {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const color = onBlue ? "#D2DFEC" : colors.muted;
  return (
    <View style={[styles.root, { paddingBottom: insets.bottom + 12 }]}>
      <Text style={[styles.text, { color }]}>Personal project of</Text>
      <Link
        href={author.url}
        target="_blank"
        rel="noopener noreferrer"
        accessibilityLabel={author.name}
        accessibilityHint="Opens the website in your browser"
        style={[styles.text, styles.link, { color }]}
      >
        <Text style={styles.name}>{author.name}</Text>{" "}<Text aria-hidden>↗</Text>
      </Link>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { paddingTop: 12, paddingHorizontal: 16, flexDirection: "row", flexWrap: "wrap", justifyContent: "center", alignItems: "center", columnGap: 4 },
  text: { ...typography.caption },
  link: { minHeight: 44, paddingVertical: 12, textDecorationLine: "none" },
  name: { textDecorationLine: "underline" },
});
