import { Platform, StyleSheet, View } from "react-native";
import { AppIcon } from "./AppIcon";
import { prototypePageUrl } from "../lib/prototype-adjustments";
import { radius, createThemedStyles, useTheme } from "../lib/theme";

// react-native-web renders this as a real <iframe> (web and the Mac app only).
const Frame = "iframe" as never as React.ComponentType<Record<string, unknown>>;
// The page at phone width, so a small picture still shows its top readably.
const PAGE_WIDTH = 390;

/**
 * A small live picture of a design's published page, on web and the Mac app:
 * the top of the page at phone width, scaled down, loaded only when scrolled into view,
 * and not focusable or clickable. Anything else (an unpublished draft, a page
 * from another site, the phone apps) shows the design icon instead.
 */
export function DesignThumbnail({ url, origin, width = 72, height = 48 }: { url?: string | null; origin?: string | null; width?: number; height?: number }) {
  const styles = useStyles();
  const { colors } = useTheme();
  const page = Platform.OS === "web" ? prototypePageUrl(url, origin) : null;
  if (!page) return <View style={[styles.box, styles.icon, { width, height }]}><AppIcon name="brush" size={19} color={colors.blueDark} /></View>;
  const scale = width / PAGE_WIDTH;
  return <View style={[styles.box, { width, height }]} aria-hidden accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    <Frame src={page} title="" tabIndex={-1} loading="lazy" sandbox="allow-scripts" aria-hidden="true"
      style={{ width: PAGE_WIDTH, height: Math.ceil(height / scale), border: 0, backgroundColor: "#FFFFFF", transform: `scale(${scale})`, transformOrigin: "top left", pointerEvents: "none" }} />
  </View>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  box: { overflow: "hidden", borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, backgroundColor: colors.surface },
  icon: { alignItems: "center", justifyContent: "center", backgroundColor: colors.blueSoft, borderWidth: 0 },
}));
