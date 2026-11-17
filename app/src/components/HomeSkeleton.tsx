import { StyleSheet, View } from "react-native";
import shape from "../../launch-skeleton.json";
import { onBrandTint, radius, space, createThemedStyles } from "../lib/theme";
import { Pulse } from "./Skeleton";

// The signed-in app's shape, drawn before its words arrive: the launch screen shows all of it
// (LaunchScreen.tsx), and Home, the sidebar and the wide Home show their part while their lists load, so each
// step from opening the app to reading it lands in the same places.
//
// The phone's shapes are data (launch-skeleton.json), measured from the top of the safe area, because the iOS
// launch screen (plugins/with-launch-skeleton.js) and the web page before its script runs (public/index.html)
// draw the same ones.

type Bar = { x: number; y: number; width: number; height: number };

export function Bars({ bars }: { bars: Bar[] }) {
  const styles = useStyles();
  return <>{bars.map((bar, i) => <View key={i} style={[styles.bar, { left: bar.x, top: bar.y, width: bar.width, height: bar.height }]} />)}</>;
}

/** The phone Home's sections and rows: each section's name, then a glyph and a name per row. */
export function HomeListBars() {
  const styles = useStyles();
  return <View style={styles.list}><Bars bars={shape.list} /></View>;
}

export function HomeListSkeleton({ label }: { label: string }) {
  return <Pulse label={label}><HomeListBars /></Pulse>;
}

/** The wide Home's Recent card: a picture and two lines per conversation. */
export function RecentBars({ count = 3 }: { count?: number }) {
  const styles = useStyles();
  return (
    <View style={styles.card}>
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={[styles.recentRow, i > 0 && styles.recentRule]}>
          <View style={styles.recentPicture} />
          <View style={styles.recentLines}>
            <View style={[styles.line, { width: 96 + ((i * 44) % 72) }]} />
            <View style={[styles.line, styles.short, { width: `${62 - ((i * 17) % 30)}%` }]} />
          </View>
        </View>
      ))}
    </View>
  );
}

export function RecentSkeleton({ label }: { label: string }) {
  return <Pulse label={label}><RecentBars /></Pulse>;
}

/** Rows of the wide layout's sidebar: a glyph and a name, on the brand color. */
export function SidebarRowBars({ count, offset = 0 }: { count: number; offset?: number }) {
  const styles = useStyles();
  return <>{Array.from({ length: count }, (_, i) => (
    <View key={i} style={styles.sidebarRow}>
      <View style={styles.sidebarGlyphBox}><View style={styles.sidebarGlyph} /></View>
      <View style={[styles.sidebarLine, { width: 64 + (((i + offset) * 38) % 84) }]} />
    </View>
  ))}</>;
}

export function SidebarRowsSkeleton({ label, count = 3 }: { label: string; count?: number }) {
  return <Pulse label={label}><SidebarRowBars count={count} /></Pulse>;
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  bar: { position: "absolute", borderRadius: radius.sm, backgroundColor: colors.line },
  list: { height: shape.listHeight },
  card: { borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, overflow: "hidden" },
  recentRow: { minHeight: 72, flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.md },
  recentRule: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line },
  recentPicture: { width: 40, height: 40, borderRadius: radius.pill, backgroundColor: colors.line },
  recentLines: { flex: 1, gap: space.xs },
  line: { height: 12, borderRadius: radius.sm, backgroundColor: colors.line },
  short: { height: 10 },
  // The sidebar's own row: 32 points, a 20-point glyph box, then the name (Sidebar.tsx `item`).
  sidebarRow: { height: 32, flexDirection: "row", alignItems: "center", gap: space.xs, paddingHorizontal: space.xs },
  sidebarGlyphBox: { width: 20, alignItems: "center" },
  sidebarGlyph: { width: 16, height: 16, borderRadius: radius.sm, backgroundColor: onBrandTint.field },
  sidebarLine: { height: 12, borderRadius: radius.sm, backgroundColor: onBrandTint.field },
}));
