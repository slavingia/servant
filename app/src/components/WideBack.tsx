import { Pressable, StyleSheet, Text } from "react-native";
import { router, useGlobalSearchParams, usePathname, type Href } from "expo-router";
import { typography, createThemedStyles, useTheme } from "../lib/theme";
import { AppIcon } from "./AppIcon";

// Where Back lands when there's no history, e.g. after a reload or a deep link.
function parentOf(pathname: string, params: { id?: string; conv?: string; kind?: string }): Href {
  if (pathname === "/thread" && params.conv) return { pathname: "/c/[id]", params: { id: params.conv } };
  if (pathname === "/channel-info" && params.id) return { pathname: "/c/[id]", params: { id: params.id } };
  if (pathname === "/files" && params.id) return params.kind === "chat" ? { pathname: "/chat/[id]", params: { id: params.id } } : { pathname: "/c/[id]", params: { id: params.id } };
  if (pathname.startsWith("/chat/")) return "/agent";
  if (pathname === "/invite") return "/members";
  if (pathname === "/notifications" || pathname === "/leaderboard" || pathname === "/feedback") return "/you";
  return "/channels";
}

/** Top-left Back for wide-layout pages that sit below a sidebar destination. */
export function WideBack() {
  const styles = useStyles();
  const { colors } = useTheme();
  const pathname = usePathname();
  const params = useGlobalSearchParams<{ id?: string; conv?: string; kind?: string }>();
  const back = () => router.canGoBack() ? router.back() : router.replace(parentOf(pathname, params));
  return (
    <Pressable accessibilityRole="button" accessibilityLabel="Back" onPress={back} style={({ pressed }) => [styles.button, pressed && styles.pressed]}>
      <AppIcon name="back" size={18} color={colors.blue} strokeWidth={2.2} />
      <Text style={styles.label}>Back</Text>
    </Pressable>
  );
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  button: { flexDirection: "row", alignItems: "center", gap: 2, paddingVertical: 6, paddingLeft: 12, paddingRight: 8, marginRight: 4 },
  pressed: { opacity: 0.6 },
  label: { color: colors.blue, fontSize: typography.label.fontSize, fontWeight: "600" },
}));
