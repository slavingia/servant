import { useEffect } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { router } from "expo-router";
import { IconButton } from "./Button";
import { dismissEmailNudge, refreshEmailNudge, useEmailNudge } from "../lib/email-nudge";
import { useSession } from "../lib/session";
import { createThemedStyles, radius, space, typography } from "../lib/theme";

// One line for people who joined before email codes: add the work email now,
// and signing in on the next device is a code away. Closing it waits a week.
// The pill is small and the close sits at the corner; each is drawn inside a 44-point control.
export function EmailNudge({ compact = false }: { compact?: boolean }) {
  const styles = useStyles();
  const { account } = useSession();
  const { visible } = useEmailNudge();
  useEffect(() => { if (account) void refreshEmailNudge(account); }, [account]);
  if (!account || !visible) return null;
  return (
    <View style={[styles.root, compact && styles.compact]} accessibilityRole="summary">
      <View style={styles.copy}>
        <Pressable accessibilityRole="button" onPress={() => router.push({ pathname: "/you", params: { email: "1" } })} style={({ pressed }) => [styles.actionTarget, pressed && { opacity: 0.7 }]}>
          <View style={styles.action}><Text style={styles.actionText}>Add work email</Text></View>
        </Pressable>
      </View>
      <IconButton icon="close" size={16} label="Not now" onPress={() => void dismissEmailNudge()} style={styles.close} />
    </View>
  );
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flexDirection: "row", alignItems: "flex-start", gap: space.sm, marginHorizontal: space.side, marginTop: space.xs, marginBottom: space.sm, padding: space.md, borderRadius: radius.md, backgroundColor: colors.blueSoft },
  compact: { marginHorizontal: space.xs, padding: space.sm },
  copy: { flex: 1, minWidth: 0 },
  actionTarget: { alignSelf: "flex-start", minHeight: 44, justifyContent: "center", marginBottom: -space.xxs },
  action: { minHeight: 32, justifyContent: "center", paddingHorizontal: space.sm, borderRadius: radius.sm, backgroundColor: colors.primary },
  actionText: { ...typography.captionStrong, color: colors.onPrimary },
  // The 44-point square overhangs the card's padding, so the mark sits at the corner as it did.
  close: { marginTop: -space.sm, marginRight: -space.sm, marginBottom: -space.sm },
}));
