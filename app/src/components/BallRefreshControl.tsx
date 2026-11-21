import type { ReactNode } from "react";
import { Platform, RefreshControl, StyleSheet, View, type RefreshControlProps, type StyleProp, type ViewStyle } from "react-native";
import { ServeLoader } from "./ServeLoader";
import { useTheme } from "../lib/theme";

// Pull to refresh with the app's tennis ball instead of the system spinner. Use it where RefreshControl went:
// `refreshControl={<BallRefreshControl refreshing={refreshing} onRefresh={reload} />}`.
//
// The system control still does the work (the pull, the release, holding the list open while it loads); its
// own spinner is made invisible and the ball is drawn where it was.
// - iOS: the system spinner in the app's blue (see below for why not the ball).
// - Android: the scroll view clones this element and hands it the list as children, so the ball is laid over
//   the top of the list while it refreshes.
// - Web has no pull to refresh; the list is passed through.

const BALL = 20;

type Props = Omit<RefreshControlProps, "tintColor" | "colors" | "progressBackgroundColor" | "title" | "titleColor"> & {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
};

export function BallRefreshControl({ refreshing, children, style, ...rest }: Props) {
  const { colors } = useTheme();
  if (Platform.OS === "ios") {
    // iOS: the system spinner in the app's blue. The ball used to be drawn as a view beside the control, but iOS
    // took that 60-point view for the list's content, so every tab list started 60 points high and its title sat
    // under the clock and battery. The control can't host the ball as a child either (it isn't drawn), so iOS keeps
    // the native spinner.
    return <RefreshControl {...rest} refreshing={refreshing} tintColor={colors.blue} />;
  }
  if (Platform.OS === "android") {
    return <View style={style}>
      <RefreshControl {...rest} refreshing={refreshing} colors={["transparent"]} progressBackgroundColor="transparent" style={styles.fill}>
        {children}
      </RefreshControl>
      {refreshing ? <View pointerEvents="none" style={styles.over}><ServeLoader size={BALL} immediate accessibilityLabel="Refreshing" /></View> : null}
    </View>;
  }
  return <RefreshControl {...rest} refreshing={refreshing} style={style}>{children}</RefreshControl>;
}

const styles = StyleSheet.create({
  over: { position: "absolute", top: 16, left: 0, right: 0, alignItems: "center" },
  fill: { flex: 1 },
});
