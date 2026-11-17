import type { ReactNode } from "react";
import { Platform, RefreshControl, StyleSheet, View, type RefreshControlProps, type StyleProp, type ViewStyle } from "react-native";
import { ServeLoader } from "./ServeLoader";

// Pull to refresh with the app's tennis ball instead of the system spinner. Use it where RefreshControl went:
// `refreshControl={<BallRefreshControl refreshing={refreshing} onRefresh={reload} />}`.
//
// The system control still does the work (the pull, the release, holding the list open while it loads); its
// own spinner is made invisible and the ball is drawn where it was.
// - iOS: the control is a child of the scroll view, so the ball sits just above the list's first row and comes
//   into view with the pull, resting still, then serves while the list refreshes.
// - Android: the scroll view clones this element and hands it the list as children, so the ball is laid over
//   the top of the list while it refreshes.
// - Web has no pull to refresh; the list is passed through.

/** The room iOS holds open above the list while it refreshes. */
const GAP = 60;
const BALL = 20;

type Props = Omit<RefreshControlProps, "tintColor" | "colors" | "progressBackgroundColor" | "title" | "titleColor"> & {
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
};

const hiddenWhen = (off: boolean) => off
  ? { accessibilityElementsHidden: true, importantForAccessibility: "no-hide-descendants" } as const
  : {};

export function BallRefreshControl({ refreshing, children, style, ...rest }: Props) {
  if (Platform.OS === "ios") {
    return <>
      <RefreshControl {...rest} refreshing={refreshing} tintColor="transparent" />
      <View pointerEvents="none" style={styles.above} {...hiddenWhen(!refreshing)}>
        <ServeLoader size={BALL} immediate still={!refreshing} accessibilityLabel="Refreshing" />
      </View>
    </>;
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
  above: { position: "absolute", top: -GAP, left: 0, right: 0, height: GAP, alignItems: "center", justifyContent: "flex-end" },
  over: { position: "absolute", top: 16, left: 0, right: 0, alignItems: "center" },
  fill: { flex: 1 },
});
