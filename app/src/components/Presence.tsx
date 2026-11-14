import { useEffect, useState } from "react";
import { StyleSheet, Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { useLivePresence } from "../lib/live";
import { presenceLabel, type PresenceDotState } from "../lib/message-status";
import type { Person } from "../lib/server";
import { radius, space, typography, useTheme, createThemedStyles } from "../lib/theme";
import { AppIcon } from "./AppIcon";

export function useStatusNow() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** The people whose presence has something to say; a bar above a DM hides when nobody's does. */
export function usePresentPeers(people: readonly Person[]) {
  const { presence, connected } = useLivePresence();
  const now = useStatusNow();
  return people.filter(person => !person.agent && presenceLabel(presence[person.id] ?? { ...person, online: false }, now, connected));
}

/**
 * The badge on an avatar's corner (message-status.ts presenceDot): a green dot for someone available, a moon on a
 * muted disc for someone in deep work (deep-work.ts), so quiet never looks like available; nothing for anyone else
 * unless `offColor` asks for a grey dot. `ring` is the colour behind the avatar; the navy sidebar passes its own
 * `disc` and `glyph` so the moon stays muted there too. Only the moon speaks: it is the one state a row's own
 * label may not already carry.
 */
export function PresenceDot({ status, size = 8, ring, disc, glyph, offColor, style }: {
  status: PresenceDotState; size?: number; ring: string; disc?: string; glyph?: string; offColor?: string; style?: StyleProp<ViewStyle>;
}) {
  const { colors } = useTheme();
  if (status === "deepWork") {
    const badge = size + 4;
    return <View accessibilityRole="image" accessibilityLabel="Deep work" testID="presence-deep-work"
      style={[{ position: "absolute", right: -3, bottom: -3, width: badge, height: badge, borderRadius: badge / 2, borderWidth: 1.5, borderColor: ring, backgroundColor: disc ?? colors.subtle, alignItems: "center", justifyContent: "center" }, style]}>
      <AppIcon name="moon" size={size} color={glyph ?? colors.muted} strokeWidth={2.8} />
    </View>;
  }
  if (status === "off" && !offColor) return null;
  return <View testID={status === "online" ? "presence-online" : "presence-off"}
    style={[{ position: "absolute", right: -2, bottom: -2, width: size, height: size, borderRadius: size / 2, borderWidth: 1.5, borderColor: ring, backgroundColor: status === "online" ? colors.green : offColor }, style]} />;
}

export function PresenceLine({ person, style }: { person: Person; style?: StyleProp<TextStyle> }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const { presence, connected } = useLivePresence();
  const now = useStatusNow();
  if (person.agent) return null;
  const label = presenceLabel(presence[person.id] ?? { ...person, online: false }, now, connected) ;
  if (!label) return null;
  // Deep work (deep-work.ts) is a chip with the moon: it is their choice, not a heartbeat, and the person about to call sees it.
  if (label === "Deep work") return <View accessible accessibilityLabel={`${person.name}, ${label}`} style={styles.deepWork}>
    <AppIcon name="moon" size={12} color={colors.blueDark} strokeWidth={2.4} />
    <Text style={[styles.deepWorkText, style]}>{label}</Text>
  </View>;
  return <Text accessibilityLabel={`${person.name}, ${label}`} style={[styles.status, style]}>{label === "Online" ? <Text style={styles.online}>● </Text> : null}{label}</Text>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  status: { ...typography.meta, color: colors.muted },
  online: { color: colors.green },
  deepWork: { flexDirection: "row", alignItems: "center", gap: space.xxs, backgroundColor: colors.blueSoft, paddingHorizontal: space.xs, paddingVertical: 2, borderRadius: radius.pill, alignSelf: "flex-start" },
  deepWorkText: { ...typography.meta, fontWeight: "600", color: colors.blueDark },
}));
