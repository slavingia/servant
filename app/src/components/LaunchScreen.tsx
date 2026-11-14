import { Platform, StyleSheet, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import shape from "../../launch-skeleton.json";
import { isDesktop } from "../lib/desktop";
import { useWideLayout } from "../lib/layout";
import { onBrandTint, radius, space, createThemedStyles, useTheme } from "../lib/theme";
import { Bars, HomeListBars, RecentBars, SidebarRowBars } from "./HomeSkeleton";
import { SIDEBAR_WIDTH } from "./Sidebar";
import { Pulse } from "./Skeleton";

// What shows while the saved account is read: the signed-in app's shape, not a logo, so opening Servant
// looks like Servant already there. The native launch screen and the web page draw the same shapes before
// this (HomeSkeleton.tsx says where), and Home's own loading rows take over from it.
export function LaunchScreen() {
  const wide = useWideLayout();
  const { scheme } = useTheme();
  return (
    <View accessible accessibilityRole="progressbar" accessibilityLabel="Opening Servant" accessibilityState={{ busy: true }} style={styles.fill}>
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
      {wide ? <WideLaunch /> : <PhoneLaunch />}
    </View>
  );
}

const TABS = 5;

// The phone's Home: its title, the All and Unread filters, the rule under them, then sections of rows. A
// browser also gets the tab bar, which is the app's own there (WebTabBar.tsx); a phone's is the system's.
function PhoneLaunch() {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.phone, { paddingTop: insets.top }]}>
      <View style={styles.phoneBody}>
        <Pulse style={styles.phoneHeader}><Bars bars={shape.header} /></Pulse>
        <View style={styles.rule} />
        <Pulse><HomeListBars /></Pulse>
      </View>
      {Platform.OS === "web" ? <View style={[styles.tabs, { height: 54 + Math.max(insets.bottom, space.xs) }]}>
        {Array.from({ length: TABS }, (_, i) => <Pulse key={i} style={styles.tab}><View style={styles.tabIcon} /><View style={styles.tabLabel} /></Pulse>)}
      </View> : null}
    </View>
  );
}

const PLACES = 9;

// The wide layout: the sidebar on the brand color (its workspace, search, places and sections, then you at
// the foot), beside Home's title, its three ways to start, and Recent.
function WideLaunch() {
  const styles = useStyles();
  return (
    <View style={styles.wide}>
      <View style={styles.sidebar}>
        {/* The Mac app's window controls sit over the sidebar's first 38 points (Sidebar.tsx `titlebar`). */}
        <View style={isDesktop() ? styles.titlebar : styles.browserTop} />
        <Pulse style={styles.workspace}><View style={styles.workspaceMark} /><View style={[styles.onBrandLine, styles.workspaceName]} /></Pulse>
        <Pulse style={styles.search} />
        <Pulse style={styles.places}>
          <SidebarRowBars count={PLACES} />
          <View style={[styles.onBrandLine, styles.sectionName]} />
          <SidebarRowBars count={1} offset={3} />
          <View style={[styles.onBrandLine, styles.sectionName]} />
          <SidebarRowBars count={3} offset={5} />
        </Pulse>
        <Pulse style={styles.you}>
          <View style={styles.youPicture} />
          <View style={styles.youLines}><View style={[styles.onBrandLine, styles.youName]} /><View style={[styles.onBrandLine, styles.youRole]} /></View>
        </Pulse>
      </View>
      <View style={styles.pane}>
        <View style={styles.column}>
          <Pulse style={styles.titleBox}><View style={styles.title} /></Pulse>
          <Pulse style={styles.actions}>
            {[0, 1, 2].map(i => <View key={i} style={styles.action}><View style={styles.actionIcon} /><View style={styles.actionTitleBox}><View style={[styles.line, styles.actionTitle]} /></View></View>)}
          </Pulse>
          <Pulse style={styles.recentTitleBox}><View style={[styles.line, styles.recentTitle]} /></Pulse>
          <Pulse><RecentBars /></Pulse>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  phone: { flex: 1, backgroundColor: colors.background },
  phoneBody: { flex: 1, overflow: "hidden" },
  phoneHeader: { height: shape.dividerY },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: colors.line },
  // WebTabBar.tsx: 6 points above 48-point tabs, an icon over a label.
  tabs: { flexDirection: "row", borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.line, backgroundColor: colors.background },
  tab: { flex: 1, alignItems: "center" },
  tabIcon: { position: "absolute", top: 9, width: 24, height: 24, borderRadius: radius.sm, backgroundColor: colors.line },
  tabLabel: { position: "absolute", top: 38, width: 32, height: 10, borderRadius: radius.sm, backgroundColor: colors.line },

  wide: { flex: 1, flexDirection: "row", backgroundColor: colors.navy },
  sidebar: { width: SIDEBAR_WIDTH, flexShrink: 0 },
  titlebar: { height: 38 },
  browserTop: { height: space.sm },
  onBrandLine: { height: 12, borderRadius: radius.sm, backgroundColor: onBrandTint.field },
  // Sidebar.tsx `workspace` and the server menu's 30-point mark.
  workspace: { height: 44, flexDirection: "row", alignItems: "center", gap: space.sm, paddingLeft: space.sm, marginBottom: space.xs },
  workspaceMark: { width: 30, height: 30, borderRadius: radius.sm, backgroundColor: onBrandTint.field },
  workspaceName: { width: 84, height: 14 },
  search: { height: 34, marginHorizontal: space.sm, marginBottom: space.sm, borderRadius: radius.pill, backgroundColor: onBrandTint.field },
  places: { flex: 1, paddingHorizontal: space.xs, overflow: "hidden" },
  // A section's name: 16 points above it, a 26-point line, 2 below (Sidebar.tsx `section`).
  sectionName: { width: 56, height: 10, marginTop: space.lg, marginBottom: space.sm, marginLeft: space.xs },
  // You at the foot, under the Deep work switch's 40 points.
  you: { flexDirection: "row", alignItems: "center", gap: space.sm, margin: space.xs, padding: space.xs },
  youPicture: { width: 30, height: 30, borderRadius: radius.pill, backgroundColor: onBrandTint.field },
  youLines: { gap: space.xs },
  youName: { width: 76, height: 10 },
  youRole: { width: 44, height: 8 },

  // AppChrome.tsx `widePane`, which meets the sidebar in a straight edge, and DesktopHome.tsx.
  pane: { flex: 1, minWidth: 0, alignItems: "center", paddingHorizontal: space.lg, paddingTop: space.xxl, backgroundColor: colors.background, overflow: "hidden" },
  column: { width: "100%", maxWidth: 680 },
  line: { height: 12, borderRadius: radius.sm, backgroundColor: colors.line },
  titleBox: { height: 34, justifyContent: "center" },
  title: { width: 132, height: 24, borderRadius: radius.sm, backgroundColor: colors.line },
  actions: { flexDirection: "row", gap: space.sm, marginTop: space.lg },
  action: { flex: 1, minWidth: 0, padding: space.md, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  actionIcon: { width: 32, height: 32, borderRadius: radius.md, backgroundColor: colors.line, marginBottom: space.sm },
  actionTitleBox: { height: 22, justifyContent: "center" },
  actionTitle: { width: "58%" },
  recentTitleBox: { height: 18, justifyContent: "center", marginTop: space.xl, marginBottom: space.xs },
  recentTitle: { width: 48, height: 10 },
}));
