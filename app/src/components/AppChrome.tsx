import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { Platform, StyleSheet, View } from "react-native";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { useSession } from "../lib/session";
import { isDesktop } from "../lib/desktop";
import { useWideLayout } from "../lib/layout";
import { radius, createThemedStyles } from "../lib/theme";
import { Omnibar } from "./Omnibar";
import { Sidebar } from "./Sidebar";

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
  const [barHeight, setBarHeight] = useState(insets.top + 64);
  const contentInsets = useMemo(() => enabled ? { ...insets, top: 0 } : insets, [enabled, insets]);

  if (enabled && wide) {
    // Desktop: a persistent sidebar beside the navigator, like Slack or ChatGPT.
    return (
      <View style={styles.wideRoot}>
        {Platform.OS === "web" ? <style>{dragCss}</style> : null}
        <Sidebar key={`${account?.token ?? ""}:${account?.serverKey ?? ""}`} />
        <View style={[styles.content, styles.widePane]}>{children}</View>
      </View>
    );
  }

  return (
    <View style={[styles.root, enabled && styles.signedInRoot]}>
      {/* Signed-out Mac screens still need somewhere to drag the window. */}
      {isDesktop() ? <><style>{dragCss}</style><View {...({ dataSet: { servantDrag: "on" } } as object)} style={styles.titlebar} /></> : null}
      {enabled ? <View style={styles.header} onLayout={event => setBarHeight(event.nativeEvent.layout.height)}>
        <Omnibar key={`${account?.token ?? ""}:${account?.serverKey ?? ""}`} />
      </View> : null}
      <ChromeHeightContext.Provider value={enabled ? barHeight : 0}>
        {/* The fixed bar has already consumed the top inset. Keep the bottom
            inset for native tabs and composers, and let the navigator measure
            its own remaining frame. */}
        <SafeAreaInsetsContext.Provider value={contentInsets}>
          <View style={[styles.content, enabled && styles.roundedContent]}>{children}</View>
        </SafeAreaInsetsContext.Provider>
      </ChromeHeightContext.Provider>
    </View>
  );
}

const useStyles = createThemedStyles(({ colors, scheme }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  wideRoot: { flex: 1, flexDirection: "row", backgroundColor: scheme === "dark" ? "#0D1116" : colors.navy },
  // The white main pane, rounded where it meets the sidebar.
  widePane: { backgroundColor: colors.background, borderTopLeftRadius: radius.xl, borderBottomLeftRadius: radius.xl, overflow: "hidden" },
  signedInRoot: { backgroundColor: colors.navy },
  header: { flexShrink: 0 },
  titlebar: { position: "absolute", top: 0, left: 0, right: 0, height: 28, zIndex: 10 },
  content: { flex: 1, minHeight: 0, minWidth: 0 },
  roundedContent: { backgroundColor: colors.background, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, overflow: "hidden" },
}));
