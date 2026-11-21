import { Platform, StyleSheet, Text, View } from "react-native";
import { isBannerHidden } from "../lib/banner";
import { hideBanner, useHiddenBanner } from "../lib/banner-hidden";
import { useSession } from "../lib/session";
import { space, typography, useTheme } from "../lib/theme";
import { ICON_TARGET, IconButton } from "./Button";

// The server-wide banner (server/banner.mjs). Amber with dark text in both appearances, announced
// to screen readers. Close hides it on this device until the operator changes the message.
export function ServerBanner({ topInset = 0 }: { topInset?: number }) {
  const { account } = useSession();
  const { colors } = useTheme();
  const ink = "#1B1B1B";
  const hidden = useHiddenBanner();
  const message = account?.banner?.message;
  if (!message || isBannerHidden(message, hidden)) return null;
  return (
    <View accessibilityRole="alert" style={[styles.root, { backgroundColor: colors.gold, paddingTop: space.sm + topInset }]}>
      <Text style={[styles.text, { color: ink }]}>{message}</Text>
      <IconButton icon="close" label="Hide this message" color={ink} onPress={() => hideBanner(message)} style={[styles.close, { top: topInset }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  // The close sits over the right edge so the bar keeps its height and the words stay centered.
  root: { paddingHorizontal: ICON_TARGET, paddingBottom: space.sm },
  // In a browser, words that wrap are split into lines of about the same length. Filled line by line, a message a
  // little wider than the bar left its last word alone on a second line under the rest.
  text: { ...typography.bodyStrong, textAlign: "center", ...(Platform.OS === "web" ? { textWrap: "balance" } as object : {}) },
  close: { position: "absolute", right: 0, bottom: 0, justifyContent: "center" },
});
