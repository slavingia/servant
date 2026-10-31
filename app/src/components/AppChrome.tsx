import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { useSession } from "../lib/session";
import { radius, createThemedStyles } from "../lib/theme";
import { Omnibar } from "./Omnibar";

const ChromeHeightContext = createContext(0);

export function useChromeHeight() {
  return useContext(ChromeHeightContext);
}

export function AppChrome({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  const { account } = useSession();
  const [barHeight, setBarHeight] = useState(insets.top + 64);
  const contentInsets = useMemo(() => enabled ? { ...insets, top: 0 } : insets, [enabled, insets]);

  return (
    <View style={[styles.root, enabled && styles.signedInRoot]}>
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

const useStyles = createThemedStyles(({ colors }) => StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.background },
  signedInRoot: { backgroundColor: colors.navy },
  header: { flexShrink: 0 },
  content: { flex: 1, minHeight: 0 },
  roundedContent: { backgroundColor: colors.background, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, overflow: "hidden" },
}));
