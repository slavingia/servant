import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { safeUrl } from "../lib/message-format";
import type { LinkPreview as Preview } from "../lib/server";
import { radius, space, typography, createThemedStyles, linkUnderline } from "../lib/theme";

// What a linked page says about itself, under the message that linked it. The server read the page once when
// the message was posted (server/link-preview.mjs); showing this contacts nobody. It is words only: no picture.
export function LinkPreview({ preview }: { preview: Preview }) {
  const styles = useStyles();
  const url = safeUrl(preview.url);
  if (!url || !preview.title) return null;
  return (
    <Pressable accessibilityRole="link" accessibilityLabel={`${preview.title}, ${preview.site}`} onPress={() => void Linking.openURL(url).catch(() => {})} style={styles.card}>
      <View style={styles.bar} />
      <View style={styles.copy}>
        {preview.site ? <Text style={styles.site}>{preview.site}</Text> : null}
        <Text style={styles.title}>{preview.title}</Text>
        {preview.description ? <Text style={styles.description}>{preview.description}</Text> : null}
      </View>
    </Pressable>
  );
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  card: { flexDirection: "row", gap: space.sm, marginTop: space.xs, maxWidth: 560, minHeight: 44 },
  bar: { width: 3, borderRadius: radius.pill, backgroundColor: colors.line },
  copy: { flex: 1, minWidth: 0, gap: space.xxs, paddingVertical: space.xxs },
  site: { ...typography.caption, color: colors.muted },
  title: { ...typography.bodyStrong, color: colors.blue, ...linkUnderline },
  description: { ...typography.caption, color: colors.ink },
}));
