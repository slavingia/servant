import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { usePathname } from "expo-router";
import { useSession } from "../lib/session";
import { isDesktop } from "../lib/desktop";
import { useWideLayout } from "../lib/layout";
import { createThemedStyles } from "../lib/theme";
import { Sidebar } from "./Sidebar";
import { ServerBanner } from "./ServerBanner";
import { OfflineBanner } from "./OfflineBanner";
import { useLiveList } from "../lib/live";
import { bannerShown } from "../lib/banner";
import { useHiddenBanner } from "../lib/banner-hidden";


const ChromeHeightContext = createContext(0);

export function useChromeHeight() {
  return useContext(ChromeHeightContext);
}

// Electron reads drag regions from CSS; React Native Web only forwards data attributes.
const dragCss = "[data-servant-drag=on]{-webkit-app-region:drag}[data-servant-drag=on] [role=button],[data-servant-drag=on] button{-webkit-app-region:no-drag}";

export function AppChrome({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const { account } = useSession();
  const wide = useWideLayout();
  // The You page sits on the grouped gray; the strip above it matches so no white band shows.
  const grouped = usePathname() === "/you";
  const [barHeight, setBarHeight] = useState(insets.top + 64);
  const contentInsets = useMemo(() => enabled ? { ...insets, top: 0 } : insets, [enabled, insets]);

  const { unreachable } = useLiveList();
  // A banner the person hid paints nothing, so the status bar strip must come back. Counting a hidden banner as
  // shown left the page under the clock and battery on phones.
  const hiddenBanner = useHiddenBanner();
  const hasBanner = bannerShown(account?.banner?.message, hiddenBanner) || unreachable;
  if (enabled && wide) {
    // Desktop: a persistent sidebar beside the navigator, like Slack or ChatGPT.
    return (
      <View style={styles.wideRoot}>
        {Platform.OS === "web" ? <style>{dragCss}</style> : null}
        <Sidebar key={`${account?.token ?? ""}:${account?.serverKey ?? ""}`} />
        <View style={[styles.content, styles.widePane]}><OfflineBanner /><ServerBanner />{children}</View>
      </View>
    );
  }

  return (
    <View style={[styles.root, enabled && styles.signedInRoot]}>
      {/* Signed-out Mac screens still need somewhere to drag the window. */}
      {isDesktop() ? <><style>{dragCss}</style><View {...({ dataSet: { servantDrag: "on" } } as object)} style={styles.titlebar} /></> : null}
      {enabled ? <View style={styles.header} onLayout={event => setBarHeight(event.nativeEvent.layout.height)}>
        {/* The banner sits at the very top and paints the status bar area itself. */}
        <OfflineBanner topInset={insets.top} />
        {/* Only the topmost bar pads for the status bar. */}
        <ServerBanner topInset={unreachable ? 0 : insets.top} />
        {/* Phones have no search bar: a white status bar area, then each page's own title. */}
        {hasBanner ? null : <View style={[styles.statusArea, grouped && styles.statusAreaGrouped, { height: insets.top }]} />}
      </View> : null}
      <ChromeHeightContext.Provider value={enabled ? barHeight : 0}>
        {/* The fixed bar has already consumed the top inset. Keep the bottom
            inset for native tabs and composers, and let the navigator measure
            its own remaining frame. */}
        <SafeAreaInsetsContext.Provider value={contentInsets}>
          <View style={[styles.content, enabled && styles.fullBleedContent]}>{children}</View>
        </SafeAreaInsetsContext.Provider>
      </ChromeHeightContext.Provider>
    </View>
  );
}

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  wideRoot: { flex: 1, flexDirection: "row", backgroundColor: colors.navy },
  // The white main pane meets the sidebar in a straight edge. It had rounded corners there, which drew the eye
  // to the join and showed nothing.
  widePane: { backgroundColor: colors.background },
  signedInRoot: { backgroundColor: colors.background },
  header: { flexShrink: 0 },
  statusArea: { backgroundColor: colors.background },
  statusAreaGrouped: { backgroundColor: colors.groupedBackground },
  titlebar: { position: "absolute", top: 0, left: 0, right: 0, height: 28, zIndex: 10 },
  content: { flex: 1, minHeight: 0, minWidth: 0 },
  fullBleedContent: { backgroundColor: colors.background },
}));
